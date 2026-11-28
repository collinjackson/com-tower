// The discord.js side of the Discord backend (discord.ts): its REST client for sends, from any
// replica, and a Gateway Client for slash commands, on the receiver replica only. Kept apart so
// the backend's tests run without discord.js or a network.

import { Client, Events, GatewayIntentBits, PermissionFlagsBits, REST } from 'discord.js';
import type { DiscordCommandInteraction, DiscordGateway, DiscordRest } from './discord.js';

export function discordRest(token: string): DiscordRest {
  return new REST({ version: '10' }).setToken(token) as unknown as DiscordRest;
}

export function discordGateway(token: string, platform = 'discord'): DiscordGateway {
  let client: Client | null = null;
  return {
    async start(onInteraction) {
      // Guilds only: slash commands come regardless of intents, and the channel cache answers
      // canPost. No privileged intents.
      const c = new Client({ intents: [GatewayIntentBits.Guilds] });
      client = c;
      c.on(Events.InteractionCreate, (i) => {
        if (!i.isChatInputCommand()) return;
        void onInteraction(i as unknown as DiscordCommandInteraction);
      });
      c.on(Events.Error, (err) => console.error(`[${platform}] gateway error:`, err.message));
      c.once(Events.ClientReady, (ready) => console.log(`[${platform}] ${ready.user.tag} is connected`));
      await c.login(token);
    },
    stop() {
      void client?.destroy();
      client = null;
    },
    connected() {
      return !!client?.isReady();
    },
    canPost(channelId) {
      const me = client?.user;
      const ch = client?.channels.cache.get(channelId);
      if (!me || !ch || !('permissionsFor' in ch) || typeof ch.permissionsFor !== 'function') return undefined;
      const perms = ch.permissionsFor(me);
      if (!perms) return undefined;
      const send = ch.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
      return perms.has([PermissionFlagsBits.ViewChannel, send, PermissionFlagsBits.AttachFiles]);
    },
  };
}
