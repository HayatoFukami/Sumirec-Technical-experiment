import { expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import { handleCommand, recordCommand } from '../src/commands.js';
import { SessionManager } from '../src/session.js';
import { A, GUILD, config } from './helpers.js';

it('同意コマンドを含まない3つのギルド用コマンドを登録する', () => {
  const command = recordCommand.toJSON();
  expect(command.name).toBe('record');
  expect(command.contexts).toEqual([0]);
  expect(command.options?.map((option) => option.name)).toEqual(['start', 'stop', 'status']);
});

it('再登録前の古い同意コマンドを録音開始として扱わない', async () => {
  const manager = new SessionManager(await config());
  const start = vi.spyOn(manager, 'start');
  const editReply = vi.fn();
  const interaction = {
    commandName: 'record', guildId: GUILD, inCachedGuild: () => true,
    deferReply: vi.fn(), editReply, options: { getSubcommand: () => 'consent' },
    user: { id: A }, guild: { members: { fetch: vi.fn(async () => ({})) } },
  } as unknown as ChatInputCommandInteraction;
  await handleCommand(interaction, manager);
  expect(start).not.toHaveBeenCalled();
  expect(editReply).toHaveBeenCalledWith(expect.stringContaining('pnpm register'));
});
