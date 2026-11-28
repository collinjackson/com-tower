// The Bolt side of the Slack backend (slack.ts): a WebClient for sends, from any replica, and a
// Socket Mode App for the slash command and app mentions, on the receiver replica only. Kept
// apart so the backend's tests run without Bolt or a network.

import { App, LogLevel, SocketModeReceiver } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import type { SlackClient, SlackReceiver } from './slack.js';

export function slackClient(token: string): SlackClient {
  return new WebClient(token) as unknown as SlackClient;
}

export function slackReceiver(token: string, appToken: string, platform = 'slack'): SlackReceiver {
  let app: App | null = null;
  let connected = false;
  return {
    async start(on, commandName) {
      const receiver = new SocketModeReceiver({ appToken, logLevel: LogLevel.WARN });
      receiver.client.on('connected', () => { connected = true; });
      receiver.client.on('disconnected', () => { connected = false; });
      receiver.client.on('reconnecting', () => { connected = false; });
      const a = new App({ token, receiver, logLevel: LogLevel.WARN });
      app = a;
      a.command(commandName, async ({ ack, command, respond }) => {
        // Slack wants the ack within 3 s; the answer follows as messages.
        await ack();
        void on.command(command, (msg) => respond(msg));
      });
      a.event('app_mention', async ({ event, body }) => {
        const team = (body as { team_id?: string }).team_id || (event as { team?: string }).team;
        void on.mention({ ...(event as unknown as { channel: string; text: string; user?: string; ts?: string; bot_id?: string }), team });
      });
      a.error(async (err) => {
        console.error(`[${platform}] Bolt error:`, err.message);
      });
      await a.start();
      console.log(`[${platform}] Socket Mode started; listening for ${commandName} and mentions`);
    },
    stop() {
      void app?.stop().catch(() => undefined);
      app = null;
      connected = false;
    },
    connected() {
      return connected;
    },
  };
}
