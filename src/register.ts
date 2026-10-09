import { REST, Routes } from 'discord.js';
import { recordCommand } from './commands.js';
import { required } from './config.js';
import { snowflake } from './storage.js';

try {
  const applicationId = snowflake(required(process.env, 'DISCORD_APPLICATION_ID'));
  const guildIds = required(process.env, 'DISCORD_GUILD_IDS').split(',').map((id) => snowflake(id.trim()));
  const rest = new REST({ version: '10' }).setToken(required(process.env, 'DISCORD_TOKEN'));
  for (const guildId of new Set(guildIds)) {
    // このPoCアプリ専用のギルドコマンド一覧を置換する。
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: [recordCommand.toJSON()] });
  }
  console.info(JSON.stringify({ event: 'commands_registered', guildCount: new Set(guildIds).size }));
} catch {
  console.error(JSON.stringify({ event: 'command_registration_failed' }));
  process.exitCode = 1;
}
