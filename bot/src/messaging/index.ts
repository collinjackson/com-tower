// Choose this worker's messaging backend from the environment.
//
//   MESSAGING_PLATFORM  the platform this worker serves; stored on the group games it binds.
//                       Default "peachy" for the peachy-bot backend, else "signal".
//   MESSAGING_BACKEND   the implementation. Default "signal-cli-rest", which serves any bridge
//                       answering signal-cli-rest-api's HTTP API (Signal, or Peachy's older
//                       `peachy daemon`). "peachy-bot" runs Peachy's bot SDK in this process.
//
// signal-cli-rest settings:
//   SIGNAL_CLI_URL      bridge base URL
//   SIGNAL_BOT_NUMBER   the bot's id on the bridge (for Signal, its phone number)
//   SIGNAL_CLI_TOKEN    optional; sent as a Bearer token
//   SIGNAL_CLI_NO_AUTH  "1" to skip Google OIDC for an https bridge on a private network
//
// peachy-bot settings (see deploy/peachy/README.md):
//   PEACHY_BOT_STORE_KEY       the store key (a secret), or
//   PEACHY_BOT_STORE_KEY_FILE  a 0600 file holding it
//   PEACHY_BOT_DB              the SQLite store's path (default ./data/bot.db), or
//   PEACHY_BOT_DATABASE_URL    a Postgres store instead (needs the optional `pg` package)
//   PEACHY_CONNECT_CODE        a one-time Connect code, for a first start with an empty store
//
// To add a platform with its own API, write a MessagingBackend and add a case below.

import { Bot } from '@peachysocial/bot';
import { messagingPlatform, type MessagingBackend } from './backend.js';
import { PeachyBotBackend } from './peachy-bot.js';
import { SignalCliRestBackend } from './signal-cli-rest.js';

export * from './backend.js';
export { SignalCliRestBackend } from './signal-cli-rest.js';
export { PeachyBotBackend } from './peachy-bot.js';

/** The configured backend, or null when it isn't configured (the worker then only watches
 *  games and can't send). */
export function createBackendFromEnv(env: NodeJS.ProcessEnv = process.env): MessagingBackend | null {
  const platform = messagingPlatform(env);
  const kind = (env.MESSAGING_BACKEND || 'signal-cli-rest').trim().toLowerCase();
  switch (kind) {
    case 'signal-cli-rest': {
      if (!env.SIGNAL_CLI_URL || !env.SIGNAL_BOT_NUMBER) return null;
      return new SignalCliRestBackend({
        platform,
        url: env.SIGNAL_CLI_URL,
        botId: env.SIGNAL_BOT_NUMBER,
        token: env.SIGNAL_CLI_TOKEN,
        noAuth: env.SIGNAL_CLI_NO_AUTH === '1',
      });
    }
    case 'peachy-bot': {
      if (!env.PEACHY_BOT_STORE_KEY && !env.PEACHY_BOT_STORE_KEY_FILE) return null;
      if ((env.SCALING_MODE || 'singleton') !== 'singleton') {
        throw new Error('MESSAGING_BACKEND=peachy-bot runs one bot device: use SCALING_MODE=singleton and one replica');
      }
      const dbPath = env.PEACHY_BOT_DB || './data/bot.db';
      const bot = new Bot({
        store: env.PEACHY_BOT_DATABASE_URL ? Bot.postgres(env.PEACHY_BOT_DATABASE_URL) : Bot.sqlite(dbPath),
        storeKey: env.PEACHY_BOT_STORE_KEY_FILE
          ? Bot.keyFile(env.PEACHY_BOT_STORE_KEY_FILE)
          : env.PEACHY_BOT_STORE_KEY!,
        connectCode: env.PEACHY_CONNECT_CODE || undefined,
        logContent: false,
        // Com Tower answers in its own words; in a group the sender's phone says it didn't answer.
        failureReply: null,
        // A slow chart shouldn't count as a failed try: a retry would run the command again.
        handlerTimeoutMs: 600_000,
      });
      return new PeachyBotBackend({
        platform,
        bot,
        onFatal: (err) => {
          console.error(`[${platform}] the Peachy bot stopped: ${err.message}`);
          // Let the host restart the process (or say so): nothing more arrives.
          process.exit(1);
        },
      });
    }
    default:
      throw new Error(`Unknown MESSAGING_BACKEND "${kind}"`);
  }
}
