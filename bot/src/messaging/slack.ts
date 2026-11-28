// A messaging backend for Slack: a Slack app (Bolt) in a workspace's channels.
//
// Receiving is Socket Mode (SLACK_APP_TOKEN): like the Discord Gateway, a connection the worker
// opens itself, so there is no public request URL to expose and sign-check, and it runs on the
// one receiver replica (ownership.ts). Sends go over the Web API from any replica.
//
// Ids are namespaced so they can't collide with Signal's or Discord's in Firestore or analytics:
//   a channel is "slack:<team>:<channel>" (its group id), a person is "slack:<team>:<user>".
//
// What comes in, in signal-cli's envelope shape:
//   - The slash command (SLACK_COMMAND, default /comtower): "/comtower game <link>" is read as
//     "/game <link>"; a bare "/comtower" is "/help". Slack command names are workspace-wide, so
//     one command carries them all rather than a /game that could clash with another app.
//   - A mention of the app: "@Com Tower game <link>" (or "@Com Tower /game <link>").
//   Mentions in the text (<@U123|name>, which the slash command sends when "escape" is on) become
//   "@name" plus a mention of that person; links (<https://…>) become plain URLs.
//   A slash command in a DM has no groupInfo, so the bot treats it as a DM command.
//
// What goes out:
//   - Messages with chat.postMessage, an attachment with files.uploadV2 (the text as its comment).
//   - A mention is the person's <@U123>; the rest of the text is escaped (&, <, >).
//   - A channel the app isn't in: a public one it joins (channels:join) and tries again. While
//     a slash command is being handled, a private one it can't post in gets the answer through
//     the command's response_url instead, with a note to /invite the app.

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  BackendGroup,
  IncomingItem,
  MessagingBackend,
  OutgoingMessage,
  ReceiverDiagnostics,
  SendOptions,
} from './backend.js';

export const SLACK_PREFIX = 'slack:';
export const slackGroupId = (team: string, channel: string) => `${SLACK_PREFIX}${team}:${channel}`;
export const slackPersonId = (team: string, user: string) => `${SLACK_PREFIX}${team}:${user}`;
/** The raw Slack id (channel or user) inside a namespaced one; an id without the prefix is raw. */
export function slackRawId(id: string): string {
  if (!id.startsWith(SLACK_PREFIX)) return id;
  const rest = id.slice(SLACK_PREFIX.length);
  return rest.slice(rest.indexOf(':') + 1);
}
export const DEFAULT_SLACK_COMMAND = '/comtower';

// ── What the backend needs from Bolt (slack-live.ts), so tests can mock it ───────────────────

/** The Web API client (Bolt's WebClient), as far as this backend uses it. */
export interface SlackClient {
  chat: { postMessage(args: { channel: string; text: string; unfurl_links?: boolean; unfurl_media?: boolean }): Promise<{ ts?: string }> };
  files: { uploadV2(args: { channel_id: string; initial_comment?: string; file: Buffer; filename: string; title?: string }): Promise<unknown> };
  conversations: {
    join(args: { channel: string }): Promise<unknown>;
    info(args: { channel: string }): Promise<{ channel?: { is_member?: boolean; is_private?: boolean; is_im?: boolean } }>;
    open(args: { users: string }): Promise<{ channel?: { id?: string } }>;
  };
  auth: { test(): Promise<{ user_id?: string; team_id?: string }> };
}
export type SlackCommandPayload = { team_id: string; channel_id: string; user_id: string; user_name?: string; text: string };
export type SlackMentionEvent = { team?: string; channel: string; user?: string; text: string; ts?: string; bot_id?: string };
export type SlackRespond = (msg: { text: string; response_type?: 'in_channel' | 'ephemeral' }) => Promise<unknown>;
/** The Socket Mode connection (a Bolt App), started only on the receiver replica. Bolt acks a
 *  command before calling `command`. */
export interface SlackReceiver {
  start(
    on: { command: (p: SlackCommandPayload, respond: SlackRespond) => Promise<void>; mention: (e: SlackMentionEvent) => Promise<void> },
    commandName: string
  ): Promise<void>;
  stop(): void;
  connected(): boolean;
}

// ── Text in and out ──────────────────────────────────────────────────────────

const unescapeSlack = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeSlack = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Slack's text as the bot reads it: <@U1|ann> -> "@ann" plus a mention, <https://x|label> ->
 *  the URL, <#C1|general> -> "#general"; the app's own mention is dropped, and the first word gets
 *  its "/" (a slash command's text, or a mention, has none). Empty -> "/help". */
export function parseSlackText(
  raw: string,
  team: string,
  botUserId?: string
): { text: string; mentions: Array<{ uuid: string; number: null; name: string; start: number; length: number }> } {
  const pieces: Array<string | { user: string; name: string }> = [];
  const re = /<([^<>]+)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    pieces.push(unescapeSlack(raw.slice(last, m.index)));
    last = m.index + m[0].length;
    const [ref, label] = m[1].split('|', 2);
    if (ref.startsWith('@')) {
      const user = ref.slice(1);
      if (user !== botUserId) pieces.push({ user, name: label || user });
    } else if (ref.startsWith('#')) pieces.push(`#${label || ref.slice(1)}`);
    else if (ref.startsWith('!')) pieces.push(label ? `@${label}` : '');
    else pieces.push(unescapeSlack(ref));
  }
  pieces.push(unescapeSlack(raw.slice(last)));

  // Lay out "/cmd args…" and place each mention in it.
  let text = '';
  const mentions: Array<{ uuid: string; number: null; name: string; start: number; length: number }> = [];
  for (const p of pieces) {
    if (typeof p === 'string') text += p;
    else {
      const at = `@${p.name}`;
      mentions.push({ uuid: slackPersonId(team, p.user), number: null, name: p.name, start: text.length, length: at.length });
      text += at;
    }
  }
  const lead = text.length - text.trimStart().length;
  text = text.trim();
  for (const x of mentions) x.start -= lead;
  if (!text) return { text: '/help', mentions: [] };
  if (!text.startsWith('/')) {
    text = `/${text}`;
    for (const x of mentions) x.start += 1;
  }
  return { text: text.replace(/\s+$/, ''), mentions };
}

/** A message as Slack takes it: each mention placeholder becomes <@U…>, the rest escaped. */
export function renderSlack(msg: OutgoingMessage): string {
  const spans = [...(msg.mentions || [])].sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const s of spans) {
    if (s.start < at) continue;
    out += escapeSlack(msg.message.slice(at, s.start));
    const id = slackRawId(s.author);
    if (/^[UW][A-Z0-9]+$/.test(id)) out += `<@${id}>`;
    at = s.start + s.length;
  }
  return out + escapeSlack(msg.message.slice(at));
}

// ── The backend ──────────────────────────────────────────────────────────────

export type SlackConfig = {
  platform: string;
  client: SlackClient;
  /** Made on the receiver replica only (needs SLACK_APP_TOKEN). */
  receiver?: () => SlackReceiver;
  /** The slash command's name (default /comtower). */
  command?: string;
};

type Handling = { channel: string; user: string; respond?: SlackRespond; helpNote?: string };

const errCode = (err: unknown): string =>
  (err as { data?: { error?: string } })?.data?.error || (err instanceof Error ? err.message : String(err));

export class SlackBackend implements MessagingBackend {
  readonly platform: string;
  readonly cantPostHint = 'invite Com Tower to this channel (/invite @Com Tower).';
  private readonly client: SlackClient;
  private readonly makeReceiver?: () => SlackReceiver;
  private readonly command: string;
  private readonly handling = new AsyncLocalStorage<Handling>();
  private receiver?: SlackReceiver;
  private onItem?: (item: IncomingItem) => Promise<void>;
  private lastError: string | null = null;
  private botUserId = '';

  constructor(cfg: SlackConfig) {
    this.platform = cfg.platform;
    this.client = cfg.client;
    this.makeReceiver = cfg.receiver;
    const c = cfg.command || DEFAULT_SLACK_COMMAND;
    this.command = c.startsWith('/') ? c : `/${c}`;
  }

  get botId(): string {
    return this.botUserId || 'slack-bot';
  }

  // ── Receiving ──────────────────────────────────────────────────────────────

  async startReceiving(onItem: (item: IncomingItem) => Promise<void>): Promise<void> {
    this.onItem = onItem;
    if (!this.botUserId) {
      const me = await this.client.auth.test().catch((err) => {
        this.lastError = `auth.test: ${errCode(err)}`;
        return undefined;
      });
      this.botUserId = me?.user_id || '';
    }
    if (!this.makeReceiver) return;
    this.receiver ??= this.makeReceiver();
    try {
      await this.receiver.start(
        { command: (p, respond) => this.handleCommand(p, respond), mention: (e) => this.handleMention(e) },
        this.command
      );
    } catch (err) {
      this.lastError = `socket mode: ${errCode(err)}`;
      throw err;
    }
  }

  stopReceiving(): void {
    this.onItem = undefined;
    this.receiver?.stop();
    this.receiver = undefined;
  }

  receiverDiagnostics(): ReceiverDiagnostics {
    const mode = !this.onItem ? 'off' : !this.receiver ? 'slack (no app token)' : this.receiver.connected() ? 'slack-socket' : 'slack-socket (connecting)';
    return { mode, lastError: this.lastError };
  }

  /** The slash command (already acked). */
  async handleCommand(p: SlackCommandPayload, respond?: SlackRespond): Promise<void> {
    const { text, mentions } = parseSlackText(p.text || '', p.team_id, this.botUserId);
    await this.deliver({ team: p.team_id, channel: p.channel_id, user: p.user_id, name: p.user_name, text, mentions, respond });
  }

  /** A message that mentions the app. */
  async handleMention(e: SlackMentionEvent): Promise<void> {
    if (e.bot_id || !e.user || !e.team) return;
    const { text, mentions } = parseSlackText(e.text || '', e.team, this.botUserId);
    const ts = e.ts ? Math.round(parseFloat(e.ts) * 1000) : undefined;
    await this.deliver({ team: e.team, channel: e.channel, user: e.user, text, mentions, at: ts });
  }

  private async deliver(m: {
    team: string; channel: string; user: string; name?: string; text: string; at?: number;
    mentions: ReturnType<typeof parseSlackText>['mentions']; respond?: SlackRespond;
  }): Promise<void> {
    const onItem = this.onItem;
    if (!onItem) return;
    const from = slackPersonId(m.team, m.user);
    const at = m.at || Date.now();
    const dm = m.channel.startsWith('D');
    const item: IncomingItem = {
      account: this.botId,
      envelope: {
        source: from,
        sourceUuid: from,
        sourceNumber: null,
        sourceName: m.name || null,
        timestamp: at,
        dataMessage: {
          timestamp: at,
          message: m.text,
          ...(dm ? {} : { groupInfo: { groupId: slackGroupId(m.team, m.channel) } }),
          ...(m.mentions.length ? { mentions: m.mentions } : {}),
        },
      },
    };
    await this.handling
      .run({ channel: m.channel, user: m.user, respond: m.respond, helpNote: this.helpNoteFor(m.text) }, () => onItem(item))
      .catch((err) => console.error(`[${this.platform}] Error handling a command:`, err));
  }

  /** The bot's help lists its commands as "/game …"; on Slack they're typed after the one slash
   *  command, so a help answer says so (once). */
  private helpNoteFor(text: string): string | undefined {
    const cmd = text.split(/\s+/, 1)[0].toLowerCase();
    if (['/game', '/iam', '/language', '/lang', '/setplayer', '/unsetplayer', '/forget', '/players', '/who', '/addmod',
      '/removemod', '/fun', '/stats', '/turntime', '/clock', '/thinktime', '/remind', '/status', '/sync', '/catchup',
      '/reel', '/retry', '/recap', '/stop', '/unwatch', '/ping'].includes(cmd)) return undefined;
    return `\n\nOn Slack, type these after ${this.command} (${this.command} game <link>), or mention me: @Com Tower game <link>.`;
  }

  /** The message with the pending help note, if any, added once. */
  private withHelpNote(msg: OutgoingMessage): OutgoingMessage {
    const st = this.handling.getStore();
    if (!st?.helpNote) return msg;
    const note = st.helpNote;
    st.helpNote = undefined;
    return { ...msg, message: msg.message + note };
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  async sendToGroup(groupId: string, msg: OutgoingMessage, opts: SendOptions = {}): Promise<number | undefined> {
    if (opts.signal?.aborted) throw new Error('Request aborted');
    const channel = slackRawId(groupId);
    msg = this.withHelpNote(msg);
    const text = renderSlack(msg);
    try {
      return await this.postOrJoin(channel, text, msg);
    } catch (err) {
      const st = this.handling.getStore();
      if (st?.respond && st.channel === channel) {
        // A private channel the app isn't in: answer the slash command where it was typed.
        await st.respond({ response_type: 'in_channel', text: `${text}\n_(${this.cantPostHint.replace(/\.$/, '')} so I can post turn pings here.)_` });
        return Date.now();
      }
      throw err;
    }
  }

  async sendToPerson(personId: string, msg: OutgoingMessage, opts: SendOptions = {}): Promise<number | undefined> {
    if (opts.signal?.aborted) throw new Error('Request aborted');
    const user = slackRawId(personId);
    msg = this.withHelpNote(msg);
    const im = await this.client.conversations.open({ users: user });
    const channel = im.channel?.id;
    if (!channel) throw new Error(`[${this.platform}] couldn't open a DM`);
    return this.post(channel, renderSlack({ ...msg, mentions: undefined }), msg);
  }

  async listGroups(): Promise<BackendGroup[]> {
    return [];
  }

  /** Whether the app is in the channel (joining a public one if not), or undefined if unknown. */
  async postsUnprompted(groupId: string): Promise<boolean | undefined> {
    const channel = slackRawId(groupId);
    const info = await this.client.conversations.info({ channel }).catch(() => undefined);
    const c = info?.channel;
    if (!c) return undefined;
    if (c.is_member || c.is_im) return true;
    if (c.is_private) return false;
    return this.client.conversations.join({ channel }).then(() => true, () => false);
  }

  private async postOrJoin(channel: string, text: string, msg: OutgoingMessage): Promise<number | undefined> {
    try {
      return await this.post(channel, text, msg);
    } catch (err) {
      if (errCode(err) !== 'not_in_channel') throw err;
      await this.client.conversations.join({ channel });
      return this.post(channel, text, msg);
    }
  }

  private async post(channel: string, text: string, msg: OutgoingMessage): Promise<number | undefined> {
    const a = msg.attachment;
    if (a?.dataB64) {
      await this.client.files.uploadV2({
        channel_id: channel,
        initial_comment: text,
        file: Buffer.from(a.dataB64, 'base64'),
        filename: a.filename,
        title: a.filename,
      });
      return Date.now();
    }
    const res = await this.client.chat.postMessage({ channel, text, unfurl_links: false, unfurl_media: false });
    const t = res?.ts ? Math.round(parseFloat(res.ts) * 1000) : NaN;
    return Number.isFinite(t) ? t : undefined;
  }
}
