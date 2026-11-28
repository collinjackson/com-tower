// A messaging backend is how the bot reaches a chat platform: it sends messages, lists the
// groups the bot is in, and delivers what people write to the bot.
//
// The bot's command and notification code only talks to this interface, so supporting another
// platform means adding an implementation here, not touching the bot. One worker runs one
// backend; each platform runs its own worker against the same Firestore, and `platform` keeps
// them apart (a group game is watched by the worker whose platform bound it).
//
// Incoming events use signal-cli's envelope shape ({ envelope: { sourceUuid, sourceName,
// dataMessage: { message, groupInfo, mentions, reaction, ... } } }), because that's what the bot
// was written against. A backend for a platform that speaks something else translates its
// events into that shape.
//
// Group and person ids are the backend's own. Discord's and Slack's carry their platform
// ("discord:<channel>", "slack:<team>:<channel>"), so they can't collide with Signal's in
// Firestore (groupGames/<groupId>) or analytics.

export type Mention = { author: string; start: number; length: number };

export type Attachment = { dataB64: string; contentType: string; filename: string };

export type OutgoingMessage = {
  message: string;
  mentions?: Mention[];
  attachment?: Attachment;
};

export type SendOptions = { timeoutMs?: number; signal?: AbortSignal };

/** A group the bot is in, as the platform describes it. `id` is what sendToGroup accepts. */
export type BackendGroup = { id: string; name?: string; [key: string]: unknown };

/** One received event: { envelope, account } in signal-cli's shape (see above). */
export type IncomingItem = { envelope?: any; account?: string; [key: string]: unknown };

export type ReceiverDiagnostics = {
  mode: string;
  lastError: string | null;
};

export interface MessagingBackend {
  /** Stored on group games this worker binds, e.g. "signal". Lowercase, stable. */
  readonly platform: string;
  /** The bot's own id on the platform (for Signal, its phone number). */
  readonly botId: string;

  /** Send to a group. Resolves to the platform's timestamp for the message, when it gives one. */
  sendToGroup(groupId: string, msg: OutgoingMessage, opts?: SendOptions): Promise<number | undefined>;
  /** Send to one person. */
  sendToPerson(personId: string, msg: OutgoingMessage, opts?: SendOptions): Promise<number | undefined>;
  listGroups(opts?: { timeoutMs?: number }): Promise<BackendGroup[]>;

  /** Start delivering incoming events to `onItem`, until stopReceiving. */
  startReceiving(onItem: (item: IncomingItem) => Promise<void>): Promise<void>;
  stopReceiving(): void;
  receiverDiagnostics(): ReceiverDiagnostics;

  /** Whether the bot may post in this group on its own (turn pings), when the platform makes
   *  that a per-group permission. Undefined, or absent, when it always may or can't tell. */
  postsUnprompted?(groupId: string): Promise<boolean | undefined>;
  /** What a group must change before postsUnprompted can be true, said after "I can't post turn
   *  pings here yet:". */
  readonly cantPostHint?: string;
}

/** The platform a stored group game belongs to. Games bound before platforms were recorded are
 *  all Signal's. */
export function platformOf(doc: { platform?: string } | undefined): string {
  return doc?.platform || 'signal';
}

/** The backend implementation (MESSAGING_BACKEND). Unset, it's "signal-cli-rest" as always,
 *  unless no Signal bridge is configured and a Discord or Slack token is: then that platform's. */
export function backendKind(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.MESSAGING_BACKEND || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (!env.SIGNAL_CLI_URL) {
    if (env.DISCORD_TOKEN) return 'discord';
    if (env.SLACK_BOT_TOKEN) return 'slack';
  }
  return 'signal-cli-rest';
}

/** The platform this worker serves: MESSAGING_PLATFORM, default "peachy" for the peachy-bot
 *  backend, "discord" or "slack" for theirs, and "signal" otherwise. */
export function messagingPlatform(env: NodeJS.ProcessEnv = process.env): string {
  const kind = backendKind(env);
  const fallback = kind === 'peachy-bot' ? 'peachy' : kind === 'discord' || kind === 'slack' ? kind : 'signal';
  return (env.MESSAGING_PLATFORM || fallback).trim().toLowerCase();
}
