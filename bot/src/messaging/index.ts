// Choose this worker's messaging backend from the environment.
//
//   MESSAGING_PLATFORM  the platform this worker serves; stored on the group games it binds.
//                       Default "signal".
//   MESSAGING_BACKEND   the implementation. Default "signal-cli-rest", which serves any bridge
//                       answering signal-cli-rest-api's HTTP API.
//
// signal-cli-rest settings:
//   SIGNAL_CLI_URL      bridge base URL
//   SIGNAL_BOT_NUMBER   the bot's id on the bridge (for Signal, its phone number)
//   SIGNAL_CLI_TOKEN    optional; sent as a Bearer token
//   SIGNAL_CLI_NO_AUTH  "1" to skip Google OIDC for an https bridge on a private network
//
// To add a platform with its own API, write a MessagingBackend and add a case below.

import { messagingPlatform, type MessagingBackend } from './backend.js';
import { SignalCliRestBackend } from './signal-cli-rest.js';

export * from './backend.js';
export { SignalCliRestBackend } from './signal-cli-rest.js';

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
    default:
      throw new Error(`Unknown MESSAGING_BACKEND "${kind}"`);
  }
}
