// A messaging backend for Peachy's bot SDK, @peachysocial/bot (https://pchy.app/developers).
//
// The bot is its own Peachy account with no phone number. The SDK holds its one encrypted device
// in a store sealed with a store key, so it runs as exactly one process: this backend needs
// SCALING_MODE=singleton and one replica, and the store on storage that outlives the process.
//
// What comes in: the SDK hands over messages in the bot's DM (via "dm") and in groups that added
// it (via "chat"). Only commands are passed on to the bot (a registered command, or any message
// whose words start with "/"), translated into signal-cli's envelope shape; ordinary chat never
// leaves this file.
//
// What goes out follows Peachy's rules for bots:
//   - A send made while the bot handles a message, to that message's chat, is a reply to it: in
//     a group in its thread and also in the main chat (alsoSendToChat). A reply to a message that
//     mentions the bot (picking a command from the picker does) always goes; a reply to a bare
//     "/cmd" needs the group's `post` grant, and without it nothing can be said there.
//   - Any other group send (a turn ping, a reminder) is the bot posting on its own: it needs the
//     group's `post` grant and a group where everyone may send messages, else it throws.
//   - The SDK has no outgoing mentions. A mention becomes the person's @handle as plain text.
//   - A DM to someone who has never written to the bot lands as a message request.
//   - The SDK has no "list my chats", so listGroups lists the chats this backend has seen (added
//     to, or heard from), remembered in a small file of chat ids when it is given one.

import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { Bot, Chat, CommandOptions, Message, Person } from '@peachysocial/bot';
import type {
  BackendGroup,
  IncomingItem,
  MessagingBackend,
  OutgoingMessage,
  ReceiverDiagnostics,
  SendOptions,
} from './backend.js';

/** Com Tower's commands, as Peachy's command picker lists them. Aliases (/who, /clock…) aren't
 *  listed; typed, they still reach the bot as words starting with "/". */
export const PEACHY_COMMANDS: ReadonlyArray<readonly [string, CommandOptions]> = [
  ['game', { description: 'Watch an AWBW game in this group (mod)', blanks: '<AWBW game link>' }],
  ['iam', { description: 'Get pinged on your turn', blanks: '<your AWBW username>' }],
  ['language', { description: 'Captions on your turn videos in another language', blanks: '<language | off>' }],
  ['setplayer', { description: "Map a member to an AWBW player (mod)", blanks: '@member <AWBW username>' }],
  ['unsetplayer', { description: "Remove a member's player mapping (mod)", blanks: '@member' }],
  ['players', { description: 'Show who plays whom' }],
  ['addmod', { description: 'Make someone a mod (mod)', blanks: '@member' }],
  ['removemod', { description: 'Remove a mod (mod)', blanks: '@member' }],
  ['fun', { description: 'Unit and CO image on turn pings (mod)', blanks: '[on | off]' }],
  ['remind', { description: 'Nudge the player who sits on their turn (mod)', blanks: '<12h | 2d | off | default>' }],
  ['stats', { description: 'Chart the game so far', blanks: '[game] [metric] [log]', worksInDm: true }],
  ['turntime', { description: 'How long each player takes per turn', blanks: '[game]', worksInDm: true }],
  ['status', { description: "What Com Tower is watching here" }],
  ['sync', { description: 'Check AWBW now and post a missed turn' }],
  ['stop', { description: 'Stop watching (mod)' }],
  ['ping', { description: 'Check that Com Tower hears you', worksInDm: true }],
  ['help', { description: 'All commands', worksInDm: true }],
];

export type PeachyBotConfig = {
  platform: string;
  /** A Bot not started yet. The backend registers its commands and handlers on it. */
  bot: Bot;
  /** Where to remember the chats the bot is in (chat ids only), for listGroups across restarts. */
  chatsFile?: string;
  /** The bot can't run any more (its store is locked, its token revoked…): exit so the host
   *  restarts it or says so. */
  onFatal?: (err: Error) => void;
};

type Handling = { message: Message };

export class PeachyBotBackend implements MessagingBackend {
  readonly platform: string;
  private readonly bot: Bot;
  private readonly chatsFile?: string;
  private readonly onFatal?: (err: Error) => void;
  private readonly handling = new AsyncLocalStorage<Handling>();
  private readonly chats = new Set<string>();
  private handle = '';
  private started?: Promise<void>;
  private onItem?: (item: IncomingItem) => Promise<void>;
  private lastError: string | null = null;

  constructor(cfg: PeachyBotConfig) {
    this.platform = cfg.platform;
    this.bot = cfg.bot;
    this.chatsFile = cfg.chatsFile;
    this.onFatal = cfg.onFatal;
    this.loadChats();

    for (const [name, options] of PEACHY_COMMANDS) this.bot.command(name, options, (m) => this.receive(m));
    this.bot.on('message', (m) => this.receive(m));
    this.bot.on('added', (chat) => this.rememberChat(chat.id));
    this.bot.on('removed', (chat) => this.forgetChat(chat.id));
    this.bot.on('lockedOut', ({ chat, reason }) => {
      console.warn(`[${this.platform}] locked out of chat ${chat.id.slice(0, 12)}: ${reason}`);
    });
    this.bot.on('status', (s) => {
      if (s.kind === 'connected') this.handle = s.profile.handle;
      if (s.kind === 'botsOff' || s.kind === 'paused' || s.kind === 'disconnected') {
        this.lastError = `status: ${s.kind}`;
        console.warn(`[${this.platform}] ${s.kind}`);
      }
      if (s.kind === 'resumed' || s.kind === 'reconnected' || s.kind === 'botsWereOff') this.lastError = null;
    });
    this.bot.on('error', (err, { fatal }) => {
      this.lastError = `${fatal ? 'fatal: ' : ''}${err.message}`;
      console.error(`[${this.platform}] ${fatal ? 'fatal ' : ''}error:`, err.message);
      if (fatal) this.onFatal?.(err);
    });
  }

  /** The bot's @handle once it has started (Peachy accounts have no number). */
  get botId(): string {
    return this.handle || 'peachy-bot';
  }

  /** Start the bot once. Sends wait for it; it resolves once Peachy has the bot live. */
  private ready(): Promise<void> {
    this.started ??= this.bot.start().then(
      (me) => {
        this.handle = me.handle;
        console.log(`[${this.platform}] @${me.handle} is running`);
      },
      (err: Error) => {
        this.started = undefined;
        this.lastError = `start: ${err.message}`;
        throw err;
      }
    );
    return this.started;
  }

  // ── Receiving ──────────────────────────────────────────────────────────────

  async startReceiving(onItem: (item: IncomingItem) => Promise<void>): Promise<void> {
    this.onItem = onItem;
    try {
      await this.ready();
    } catch (err) {
      this.onFatal?.(err as Error);
      throw err;
    }
  }

  /** Stops handing messages to the bot. The SDK keeps running, since sends need it. */
  stopReceiving(): void {
    this.onItem = undefined;
  }

  receiverDiagnostics(): ReceiverDiagnostics {
    const mode = !this.onItem ? 'off' : this.bot.connected ? 'peachy-sdk' : 'peachy-sdk (connecting)';
    return { mode, lastError: this.lastError };
  }

  private async receive(m: Message): Promise<void> {
    if (m.chat) this.rememberChat(m.chat.id);
    const onItem = this.onItem;
    if (!onItem) return;
    const text = m.command ? `/${m.command}${m.args ? ` ${m.args}` : ''}` : this.withoutOwnHandle(m.text);
    // Only commands go on: Com Tower ignores everything else, so nothing else leaves the SDK.
    if (!text.startsWith('/')) return;
    const mentions = m.chat ? await this.mentionsIn(m.chat, text) : [];
    const at = m.at.getTime();
    const item: IncomingItem = {
      account: this.botId,
      envelope: {
        source: m.from.actorId,
        sourceUuid: m.from.actorId,
        // No phone numbers on Peachy. null, not undefined: the bot stores it in Firestore.
        sourceNumber: null,
        sourceName: m.from.name,
        timestamp: at,
        dataMessage: {
          timestamp: at,
          message: text,
          ...(m.chat ? { groupInfo: { groupId: m.chat.id, groupName: m.chat.name ?? undefined } } : {}),
          ...(mentions.length ? { mentions } : {}),
        },
      },
    };
    // Sends the bot makes while it handles this message are replies to it (see sendToGroup).
    // Errors stay here: a retry would run the command twice.
    await this.handling
      .run({ message: m }, () => onItem(item))
      .catch((err) => console.error(`[${this.platform}] Error handling incoming message:`, err));
  }

  private withoutOwnHandle(text: string): string {
    let t = text.trim();
    if (!this.handle) return t;
    const own = new RegExp(`^@${escapeRegExp(this.handle)}\\b\\s*`, 'i');
    while (own.test(t)) t = t.replace(own, '');
    return t;
  }

  /** The members a command names with @handle, in signal-cli's mention shape. The SDK hands
   *  over only the words, so a mention is found by the handle (or a one-word name) it shows. */
  private async mentionsIn(chat: Chat, text: string) {
    const out: Array<{ uuid: string; number: null; name: string; handle: string; start: number; length: number }> = [];
    const tokens = [...text.matchAll(/@([\p{L}\p{N}_.]+)/gu)];
    if (tokens.length === 0) return out;
    const members = await chat.members().catch(() => [] as readonly Person[]);
    for (const t of tokens) {
      const word = t[1].toLowerCase();
      if (word === this.handle.toLowerCase()) continue;
      const p =
        members.find((x) => x.handle.toLowerCase() === word) ||
        members.find((x) => x.name.toLowerCase() === word);
      if (p) out.push({ uuid: p.actorId, number: null, name: p.name, handle: p.handle, start: t.index!, length: t[0].length });
    }
    return out;
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  async sendToGroup(groupId: string, msg: OutgoingMessage, opts: SendOptions = {}): Promise<number | undefined> {
    await this.ready();
    if (opts.signal?.aborted) throw new Error('Request aborted');
    const now = this.handling.getStore()?.message;
    const chat = now?.chat?.id === groupId ? now.chat : await this.bot.chat(groupId);
    if (!chat) {
      this.forgetChat(groupId);
      throw new Error(`[${this.platform}] the bot isn't in chat ${groupId.slice(0, 12)}`);
    }
    const text = await renderMentions(msg, () => chat.members());
    const files = filesOf(msg);
    if (now && now.chat?.id === groupId) {
      if (!now.mentioned && !chat.grants.has('post')) {
        throw new Error(
          `[${this.platform}] can't reply to a bare /command in a group without the post grant; ` +
            'pick the command from the picker (@bot /command) or grant the bot Post'
        );
      }
      const r = await now.reply(text, { files, alsoSendToChat: true });
      return r.at.getTime();
    }
    const r = await chat.post(text, { files });
    return r.at.getTime();
  }

  async sendToPerson(personId: string, msg: OutgoingMessage, opts: SendOptions = {}): Promise<number | undefined> {
    await this.ready();
    if (opts.signal?.aborted) throw new Error('Request aborted');
    // The bot's callers put a "+" in front of ids that look like numbers; Peachy ids have none.
    const id = personId.replace(/^\+/, '');
    const files = filesOf(msg);
    const now = this.handling.getStore()?.message;
    if (now?.dm && now.from.actorId === id) {
      const r = await now.reply(msg.message, { files });
      return r.at.getTime();
    }
    const { dm, reason } = await this.bot.dm(id);
    if (!dm) throw new Error(`[${this.platform}] can't DM ${id.slice(0, 12)}: ${reason}`);
    const r = await dm.post(msg.message, { files });
    return r.at.getTime();
  }

  /** Whether the bot may post in this group on its own (turn pings), or undefined if unknown. */
  async postsUnprompted(groupId: string): Promise<boolean | undefined> {
    const now = this.handling.getStore()?.message;
    const chat = now?.chat?.id === groupId ? now.chat : await this.bot.chat(groupId).catch(() => null);
    if (!chat) return undefined;
    return chat.grants.has('post') && chat.mayPost;
  }

  async listGroups(): Promise<BackendGroup[]> {
    await this.ready();
    const out: BackendGroup[] = [];
    for (const id of [...this.chats]) {
      const chat = await this.bot.chat(id);
      if (!chat) {
        this.forgetChat(id);
        continue;
      }
      out.push({
        id: chat.id,
        name: chat.name ?? undefined,
        grants: [...chat.grants],
        mayPost: chat.mayPost,
      });
    }
    return out;
  }

  // ── The chats the bot is in ────────────────────────────────────────────────

  private loadChats(): void {
    if (!this.chatsFile) return;
    try {
      const ids = JSON.parse(readFileSync(this.chatsFile, 'utf8'));
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') this.chats.add(id);
    } catch {
      /* none yet */
    }
  }

  private saveChats(): void {
    if (!this.chatsFile) return;
    try {
      const tmp = `${this.chatsFile}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.chats]), { mode: 0o600 });
      renameSync(tmp, this.chatsFile);
    } catch (err) {
      console.warn(`[${this.platform}] couldn't save the chat list:`, (err as Error).message);
    }
  }

  private rememberChat(id: string): void {
    if (this.chats.has(id)) return;
    this.chats.add(id);
    this.saveChats();
  }

  private forgetChat(id: string): void {
    if (this.chats.delete(id)) this.saveChats();
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function filesOf(msg: OutgoingMessage) {
  const a = msg.attachment;
  if (!a?.dataB64) return undefined;
  return [{ data: Buffer.from(a.dataB64, 'base64'), contentType: a.contentType, name: a.filename }];
}

/** The text with each mention's placeholder replaced by the person's @handle. Peachy's SDK sends
 *  words only, so the person sees their handle but their phone isn't told it's a mention. */
export async function renderMentions(
  msg: OutgoingMessage,
  members: () => Promise<readonly Person[]>
): Promise<string> {
  if (!msg.mentions?.length) return msg.message;
  const people = await members().catch(() => [] as readonly Person[]);
  let text = msg.message;
  for (const m of [...msg.mentions].sort((a, b) => b.start - a.start)) {
    const p = people.find((x) => x.actorId === m.author);
    const name = p ? `@${p.handle || p.name}` : '';
    text = text.slice(0, m.start) + name + text.slice(m.start + m.length);
  }
  return text.replace(/[ \t]+$/gm, '').replace(/^ +/, '');
}
