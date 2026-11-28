// A messaging backend for Discord: a bot in a server's text channels, driven by slash commands.
//
// Why the Gateway (discord.js) and not interactions over HTTP: the worker is already a
// long-running process (min one instance) that holds AWBW websockets, and the receiver runs on
// exactly one replica (ownership.ts). A Gateway connection fits that as is: no public endpoint to
// expose and verify (Ed25519) on Cloud Run, and a self-hoster behind NAT works too. Slash commands
// arrive over the Gateway as interactions, with no privileged intents (the bot never reads
// ordinary messages, so MESSAGE_CONTENT isn't needed).
//
// Ids are namespaced so they can't collide with Signal's in Firestore or analytics:
//   a channel is "discord:<channelId>" (its group id), a person is "discord:<userId>".
//
// What comes in: each slash command (registered at start from DISCORD_COMMANDS) becomes the text
// "/<name> <args>" in signal-cli's envelope shape; a user option becomes "@name" plus a mention of
// that person. A command in the bot's DM has no groupInfo, so the bot treats it as a DM command.
//
// What goes out:
//   - While the bot handles a command, sends to that command's channel answer the interaction
//     (deferred at once, since Discord wants an answer within 3 s): the first edits the deferred
//     reply, the rest are follow-ups. A command that sends nothing has its "thinking" reply
//     removed. Anything later (a recap that took minutes, a turn ping) is a channel message,
//     which needs View Channel + Send Messages (+ Attach Files) there.
//   - A mention is the person's <@id>, and allowed_mentions names only the people meant, so an
//     "@everyone" in a game's name pings no one.
//   - An attachment over DISCORD_MAX_UPLOAD_BYTES (default 10 MiB, Discord's limit for a server
//     without boosts) is left off, with a line saying so; the text (the game link) still goes.

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  BackendGroup,
  IncomingItem,
  MessagingBackend,
  OutgoingMessage,
  ReceiverDiagnostics,
  SendOptions,
} from './backend.js';

export const DISCORD_PREFIX = 'discord:';
export const discordGroupId = (channelId: string) => `${DISCORD_PREFIX}${channelId}`;
export const discordPersonId = (userId: string) => `${DISCORD_PREFIX}${userId}`;
/** The raw Discord id inside a namespaced one (an id without the prefix is taken as raw). */
export function discordRawId(id: string): string {
  return id.startsWith(DISCORD_PREFIX) ? id.slice(DISCORD_PREFIX.length) : id;
}

/** Discord's upload limit for a server without boosts. */
export const DISCORD_DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Discord's message length limit. */
export const DISCORD_MAX_CONTENT = 2000;

// ── What the backend needs from discord.js (discord-live.ts), so tests can mock it ──────────

export type DiscordFile = { name: string; data: Buffer; contentType?: string };
/** discord.js's REST client, as far as this backend uses it. */
export interface DiscordRest {
  post(route: `/${string}`, opts: { body?: unknown; files?: DiscordFile[] }): Promise<unknown>;
  put(route: `/${string}`, opts: { body?: unknown }): Promise<unknown>;
}
export type DiscordUser = { id: string; username: string; globalName?: string | null; bot?: boolean };
export type DiscordOption = { name: string; type: number; value?: string | number | boolean; user?: DiscordUser };
export type DiscordReply = {
  content: string;
  files?: Array<{ attachment: Buffer; name: string }>;
  allowedMentions: { parse: []; users: string[] };
};
/** A chat-input (slash) command interaction, as discord.js hands it over. */
export interface DiscordCommandInteraction {
  commandName: string;
  channelId: string;
  guildId: string | null;
  createdTimestamp: number;
  user: DiscordUser;
  /** GuildMember (displayName) or the raw API member (nick); null in a DM. */
  member?: { displayName?: string; nick?: string | null } | null;
  options: { data: readonly DiscordOption[] };
  deferReply(): Promise<unknown>;
  editReply(reply: DiscordReply): Promise<unknown>;
  followUp(reply: DiscordReply): Promise<unknown>;
  deleteReply(): Promise<unknown>;
}
/** The Gateway connection (a discord.js Client), started only on the receiver replica. */
export interface DiscordGateway {
  start(onInteraction: (i: DiscordCommandInteraction) => Promise<void>): Promise<void>;
  stop(): void;
  connected(): boolean;
  /** Whether the bot may post (and attach files) in a channel, from the Gateway's cache;
   *  undefined when it can't tell. */
  canPost?(channelId: string): boolean | undefined;
}

// ── Slash commands ───────────────────────────────────────────────────────────

const OPT_STRING = 3;
const OPT_BOOLEAN = 5;
const OPT_USER = 6;
const CONTEXT_GUILD = 0;
const CONTEXT_BOT_DM = 1;

type OptSpec = {
  name: string;
  description: string;
  kind: 'text' | 'user' | 'flag';
  required?: boolean;
  /** flag: the word it adds to the command when true (e.g. "fresh"). */
  word?: string;
  choices?: string[];
  /** Only passed on in a DM (a group's commands use its bound game). */
  dmOnly?: boolean;
};
type CmdSpec = { name: string; description: string; options?: OptSpec[]; dm?: boolean };

const member = (description: string): OptSpec => ({ name: 'member', description, kind: 'user', required: true });
const dmGame: OptSpec = { name: 'game', description: 'In a DM: the AWBW game link or id', kind: 'text', dmOnly: true };

/** Com Tower's commands as Discord slash commands. Aliases (/who, /clock…) aren't registered. */
export const DISCORD_COMMANDS: readonly CmdSpec[] = [
  { name: 'game', description: 'Watch an AWBW game in this channel (mod)', options: [{ name: 'link', description: 'AWBW game link or id', kind: 'text', required: true }] },
  { name: 'iam', description: 'Get pinged on your turn', options: [{ name: 'awbw_name', description: 'Your AWBW username', kind: 'text', required: true }] },
  { name: 'language', description: "List everyone's caption language, or set yours (after /iam)", options: [{ name: 'language', description: 'e.g. Spanish, Pirate, off', kind: 'text' }] },
  { name: 'setplayer', description: 'Map a member to an AWBW player (mod)', options: [member('The member'), { name: 'awbw_name', description: 'Their AWBW username', kind: 'text', required: true }] },
  { name: 'unsetplayer', description: "Remove a member's player mapping (mod)", options: [member('The member')] },
  { name: 'players', description: 'Show who plays whom' },
  { name: 'addmod', description: 'Make someone a mod (mod)', options: [member('The new mod')] },
  { name: 'removemod', description: 'Remove a mod (mod)', options: [member('The mod to remove')] },
  { name: 'fun', description: 'Unit and CO image on turn pings (mod)', options: [{ name: 'state', description: 'on or off', kind: 'text', choices: ['on', 'off'] }] },
  { name: 'remind', description: 'Nudge the player who sits on their turn (mod)', options: [{ name: 'after', description: '12h, 2d, off or default', kind: 'text' }] },
  { name: 'stats', description: 'Chart the game so far', dm: true, options: [
    dmGame,
    { name: 'metric', description: 'What to chart', kind: 'text', choices: ['armyValue', 'unitValue', 'funds', 'income', 'properties', 'unitCount'] },
    { name: 'log', description: 'Log scale', kind: 'flag', word: 'log' },
  ] },
  { name: 'turntime', description: 'How long each player takes per turn', dm: true, options: [dmGame] },
  { name: 'status', description: 'What Com Tower is watching here' },
  { name: 'sync', description: 'Check AWBW now and post a missed turn' },
  { name: 'reel', description: "Record the last turn's video again and post it" },
  { name: 'recap', description: 'The game so far in its biggest moments, as one video', options: [{ name: 'fresh', description: 'Cut it again from scratch', kind: 'flag', word: 'fresh' }] },
  { name: 'stop', description: 'Stop watching (mod)' },
  { name: 'ping', description: 'Check that Com Tower hears you', dm: true },
  { name: 'help', description: 'All commands', dm: true },
];

/** The JSON body for PUT /applications/{app}/commands. */
export function discordCommandBodies(): unknown[] {
  return DISCORD_COMMANDS.map((c) => ({
    name: c.name,
    description: c.description,
    type: 1,
    contexts: c.dm ? [CONTEXT_GUILD, CONTEXT_BOT_DM] : [CONTEXT_GUILD],
    integration_types: [0],
    options: (c.options || []).map((o) => ({
      name: o.name,
      description: o.description,
      type: o.kind === 'user' ? OPT_USER : o.kind === 'flag' ? OPT_BOOLEAN : OPT_STRING,
      required: !!o.required,
      ...(o.choices ? { choices: o.choices.map((v) => ({ name: v, value: v })) } : {}),
    })),
  }));
}

const displayName = (u: DiscordUser) => u.globalName || u.username;

/** A slash command as the text the bot reads ("/setplayer @Ann ann_awbw") and the people its
 *  user options mention, in signal-cli's mention shape. */
export function commandText(i: DiscordCommandInteraction): {
  text: string;
  mentions: Array<{ uuid: string; number: null; name: string; start: number; length: number }>;
} {
  const spec = DISCORD_COMMANDS.find((c) => c.name === i.commandName);
  let text = `/${i.commandName}`;
  const mentions: Array<{ uuid: string; number: null; name: string; start: number; length: number }> = [];
  for (const o of spec?.options || []) {
    if (o.dmOnly && i.guildId) continue;
    const got = i.options.data.find((d) => d.name === o.name);
    if (!got) continue;
    if (o.kind === 'user') {
      if (!got.user) continue;
      const name = displayName(got.user);
      const at = `@${name}`;
      mentions.push({ uuid: discordPersonId(got.user.id), number: null, name, start: text.length + 1, length: at.length });
      text += ` ${at}`;
    } else if (o.kind === 'flag') {
      if (got.value === true && o.word) text += ` ${o.word}`;
    } else {
      const v = String(got.value ?? '').trim();
      if (v) text += ` ${v}`;
    }
  }
  return { text, mentions };
}

/** A message as Discord takes it: each mention placeholder becomes <@id>, only those people may
 *  be pinged, and an attachment over the limit is left off with a line saying so. */
export function renderDiscord(
  msg: OutgoingMessage,
  maxUploadBytes = DISCORD_DEFAULT_MAX_UPLOAD_BYTES
): { content: string; users: string[]; file?: DiscordFile } {
  let content = msg.message;
  const users: string[] = [];
  for (const m of [...(msg.mentions || [])].sort((a, b) => b.start - a.start)) {
    const id = discordRawId(m.author);
    const ok = /^\d+$/.test(id);
    if (ok && !users.includes(id)) users.unshift(id);
    content = content.slice(0, m.start) + (ok ? `<@${id}>` : '') + content.slice(m.start + m.length);
  }
  let file: DiscordFile | undefined;
  const a = msg.attachment;
  if (a?.dataB64) {
    const data = Buffer.from(a.dataB64, 'base64');
    if (data.length <= maxUploadBytes) file = { name: a.filename, data, contentType: a.contentType };
    else {
      const mb = (n: number) => (n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
      content += `\n(The ${a.contentType.startsWith('video/') || a.contentType === 'image/gif' ? 'video' : 'file'} is ${mb(data.length)} MB, `
        + `over Discord's ${mb(maxUploadBytes)} MB upload limit, so it isn't attached.)`;
    }
  }
  if (content.length > DISCORD_MAX_CONTENT) content = content.slice(0, DISCORD_MAX_CONTENT - 1) + '…';
  return { content, users: users.slice(0, 100), file };
}

// ── The backend ──────────────────────────────────────────────────────────────

export type DiscordConfig = {
  platform: string;
  /** The application id (DISCORD_APP_ID): the bot's id, and where commands are registered. */
  appId: string;
  rest: DiscordRest;
  /** Made on the receiver replica only; sends from any replica go over REST. */
  gateway?: () => DiscordGateway;
  /** Register the slash commands in this server only (DISCORD_GUILD_ID): instant, for testing.
   *  Unset: globally. */
  guildId?: string;
  /** false: don't register commands at start (DISCORD_REGISTER_COMMANDS=0). */
  registerCommands?: boolean;
  maxUploadBytes?: number;
};

type Handling = { interaction: DiscordCommandInteraction; deferred: boolean; answered: boolean; done: boolean };

export class DiscordBackend implements MessagingBackend {
  readonly platform: string;
  readonly botId: string;
  readonly cantPostHint =
    'give Com Tower View Channel, Send Messages and Attach Files in this channel (Send Messages in Threads, in a thread).';
  private readonly rest: DiscordRest;
  private readonly makeGateway?: () => DiscordGateway;
  private readonly guildId?: string;
  private readonly registerCommands: boolean;
  private readonly maxUploadBytes: number;
  private readonly handling = new AsyncLocalStorage<Handling>();
  private gateway?: DiscordGateway;
  private onItem?: (item: IncomingItem) => Promise<void>;
  private lastError: string | null = null;
  private registered = false;

  constructor(cfg: DiscordConfig) {
    this.platform = cfg.platform;
    this.botId = cfg.appId;
    this.rest = cfg.rest;
    this.makeGateway = cfg.gateway;
    this.guildId = cfg.guildId;
    this.registerCommands = cfg.registerCommands ?? true;
    this.maxUploadBytes = cfg.maxUploadBytes ?? DISCORD_DEFAULT_MAX_UPLOAD_BYTES;
  }

  // ── Receiving ──────────────────────────────────────────────────────────────

  async startReceiving(onItem: (item: IncomingItem) => Promise<void>): Promise<void> {
    this.onItem = onItem;
    if (this.registerCommands && !this.registered) {
      const route = this.guildId
        ? (`/applications/${this.botId}/guilds/${this.guildId}/commands` as const)
        : (`/applications/${this.botId}/commands` as const);
      try {
        await this.rest.put(route, { body: discordCommandBodies() });
        this.registered = true;
        console.log(`[${this.platform}] registered ${DISCORD_COMMANDS.length} slash commands${this.guildId ? ' in one server' : ''}`);
      } catch (err) {
        // Commands registered earlier still work; say so and carry on.
        this.lastError = `register commands: ${errText(err)}`;
        console.error(`[${this.platform}] couldn't register slash commands:`, errText(err));
      }
    }
    if (!this.makeGateway) return;
    this.gateway ??= this.makeGateway();
    try {
      await this.gateway.start((i) => this.handleInteraction(i));
    } catch (err) {
      this.lastError = `gateway: ${errText(err)}`;
      throw err;
    }
  }

  stopReceiving(): void {
    this.onItem = undefined;
    this.gateway?.stop();
    this.gateway = undefined;
  }

  receiverDiagnostics(): ReceiverDiagnostics {
    const mode = !this.onItem ? 'off' : this.gateway?.connected() ? 'discord-gateway' : 'discord-gateway (connecting)';
    return { mode, lastError: this.lastError };
  }

  /** One slash command: answer within Discord's 3 s (defer), hand it to the bot, tidy up. */
  async handleInteraction(i: DiscordCommandInteraction): Promise<void> {
    const onItem = this.onItem;
    if (!onItem || i.user.bot) return;
    if (!DISCORD_COMMANDS.some((c) => c.name === i.commandName)) return;
    const state: Handling = { interaction: i, deferred: false, answered: false, done: false };
    try {
      await i.deferReply();
      state.deferred = true;
    } catch (err) {
      console.warn(`[${this.platform}] couldn't defer /${i.commandName}:`, errText(err));
    }
    const { text, mentions } = commandText(i);
    const from = discordPersonId(i.user.id);
    const name = i.member?.displayName || i.member?.nick || displayName(i.user);
    const at = i.createdTimestamp || Date.now();
    const item: IncomingItem = {
      account: this.botId,
      envelope: {
        source: from,
        sourceUuid: from,
        // No phone numbers here. null, not undefined: the bot stores it in Firestore.
        sourceNumber: null,
        sourceName: name,
        timestamp: at,
        dataMessage: {
          timestamp: at,
          message: text,
          ...(i.guildId ? { groupInfo: { groupId: discordGroupId(i.channelId) } } : {}),
          ...(mentions.length ? { mentions } : {}),
        },
      },
    };
    // Errors stay here: Discord doesn't retry, and a retry would run the command twice.
    await this.handling
      .run(state, () => onItem(item))
      .catch((err) => console.error(`[${this.platform}] Error handling /${i.commandName}:`, err));
    state.done = true;
    if (state.deferred && !state.answered) await i.deleteReply().catch(() => undefined);
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  async sendToGroup(groupId: string, msg: OutgoingMessage, opts: SendOptions = {}): Promise<number | undefined> {
    if (opts.signal?.aborted) throw new Error('Request aborted');
    const channelId = discordRawId(groupId);
    const out = renderDiscord(msg, this.maxUploadBytes);
    const st = this.handling.getStore();
    if (st && st.interaction.guildId && st.interaction.channelId === channelId) {
      const t = await this.answer(st, out);
      if (t !== undefined) return t;
    }
    return this.post(channelId, out);
  }

  async sendToPerson(personId: string, msg: OutgoingMessage, opts: SendOptions = {}): Promise<number | undefined> {
    if (opts.signal?.aborted) throw new Error('Request aborted');
    const userId = discordRawId(personId);
    const out = renderDiscord({ ...msg, mentions: undefined }, this.maxUploadBytes);
    const st = this.handling.getStore();
    if (st && !st.interaction.guildId && st.interaction.user.id === userId) {
      const t = await this.answer(st, out);
      if (t !== undefined) return t;
    }
    const dm = (await this.rest.post('/users/@me/channels', { body: { recipient_id: userId } })) as { id?: string };
    if (!dm?.id) throw new Error(`[${this.platform}] couldn't open a DM`);
    return this.post(dm.id, out);
  }

  async listGroups(): Promise<BackendGroup[]> {
    // Channels aren't joined one by one on Discord; a game's channel is whichever ran /game.
    return [];
  }

  async postsUnprompted(groupId: string): Promise<boolean | undefined> {
    return this.gateway?.canPost?.(discordRawId(groupId));
  }

  /** Answer the interaction being handled; undefined when it can't (then post to the channel). */
  private async answer(st: Handling, out: ReturnType<typeof renderDiscord>): Promise<number | undefined> {
    if (st.done || !st.deferred) return undefined;
    const reply: DiscordReply = {
      content: out.content,
      allowedMentions: { parse: [], users: out.users },
      ...(out.file ? { files: [{ attachment: out.file.data, name: out.file.name }] } : {}),
    };
    try {
      if (!st.answered) await st.interaction.editReply(reply);
      else await st.interaction.followUp(reply);
      st.answered = true;
      return Date.now();
    } catch (err) {
      console.warn(`[${this.platform}] interaction reply failed; posting to the channel:`, errText(err));
      return undefined;
    }
  }

  private async post(channelId: string, out: ReturnType<typeof renderDiscord>): Promise<number | undefined> {
    const body: Record<string, unknown> = { content: out.content, allowed_mentions: { parse: [], users: out.users } };
    if (out.file) body.attachments = [{ id: 0, filename: out.file.name }];
    const res = (await this.rest.post(`/channels/${channelId}/messages`, {
      body,
      ...(out.file ? { files: [out.file] } : {}),
    })) as { timestamp?: string } | undefined;
    const t = res?.timestamp ? Date.parse(res.timestamp) : NaN;
    return Number.isFinite(t) ? t : undefined;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
