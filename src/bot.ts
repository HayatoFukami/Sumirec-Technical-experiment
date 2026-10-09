import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { getCiphers } from 'node:crypto';
import { createDecoder } from './capture.js';
import { handleCommand, humanParticipants, recordingChannel } from './commands.js';
import { recordingConfig, required } from './config.js';
import { SessionManager } from './session.js';
import { snowflake } from './storage.js';

const log = (event: string): void => { console.info(JSON.stringify({ at: new Date().toISOString(), event })); };
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
let manager: SessionManager | undefined;
let allowedGuilds = new Set<string>();
let shutdownPromise: Promise<void> | undefined;
function shutdown(code?: string): Promise<void> {
  shutdownPromise ??= (async () => {
    try { await manager?.stopAll(code); }
    catch { log('shutdown_finalize_error'); process.exitCode = 1; }
    finally { client.destroy(); log('bot_stopped'); }
  })();
  return shutdownPromise;
}
client.once(Events.ClientReady, () => { log('bot_ready'); });
client.on(Events.Error, () => { log('discord_client_error'); });
client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand() || !manager) return;
  if (!interaction.guildId || !allowedGuilds.has(interaction.guildId)) {
    void interaction.reply({ content: '設定されたテストサーバーで実行してください。', flags: MessageFlags.Ephemeral }).catch(() => log('interaction_error')); return;
  }
  void handleCommand(interaction, manager).catch(() => log('interaction_error'));
});
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const session = manager?.get(newState.guild.id);
  if (!session?.active) return;
  if (newState.id === client.user?.id && newState.channelId !== session.metadata.channelId && oldState.channelId === session.metadata.channelId) {
    void session.stop('bot_removed_or_moved').catch(() => log('stop_error')); return;
  }
  if (oldState.channelId !== session.metadata.channelId && newState.channelId !== session.metadata.channelId) return;
  const channel = recordingChannel(newState.guild, session.metadata.channelId);
  if (channel) void session.participants(humanParticipants(channel)).catch(() => log('participant_update_error'));
  else void session.stop('channel_unavailable').catch(() => log('stop_error'));
});
client.on(Events.ChannelDelete, (channel) => {
  if (!('guild' in channel)) return;
  const session = manager?.get(channel.guild.id);
  if (session?.active && session.metadata.channelId === channel.id) void session.stop('channel_deleted').catch(() => log('stop_error'));
});
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('uncaughtException', () => { log('uncaught_exception'); process.exitCode = 1; void shutdown('uncaught_exception'); });
process.on('unhandledRejection', () => { log('unhandled_rejection'); process.exitCode = 1; void shutdown('unhandled_rejection'); });

try {
  snowflake(required(process.env, 'DISCORD_APPLICATION_ID'));
  required(process.env, 'DISCORD_GUILD_IDS').split(',').forEach((id) => snowflake(id.trim()));
  if (!getCiphers().includes('aes-256-gcm')) throw new Error('必要な暗号処理がありません。');
  allowedGuilds = new Set(required(process.env, 'DISCORD_GUILD_IDS').split(',').map((id) => snowflake(id.trim())));
  // native Opusを実際に初期化して起動時に不足依存を検出する。
  createDecoder().delete();
  manager = new SessionManager(recordingConfig());
  await client.login(required(process.env, 'DISCORD_TOKEN'));
} catch {
  log('bot_start_failed'); process.exitCode = 1; await shutdown('bot_start_failed');
}
