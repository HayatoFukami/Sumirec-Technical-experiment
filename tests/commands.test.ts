import { expect, it } from 'vitest';
import { recordCommand } from '../src/commands.js';

it('4つのギルド用コマンドと、撤回にも使える必須boolean同意項目を登録する', () => {
  const command = recordCommand.toJSON();
  expect(command.name).toBe('record');
  expect(command.contexts).toEqual([0]);
  expect(command.options?.map((option) => option.name)).toEqual(['start', 'stop', 'status', 'consent']);
  expect(command.options?.[3]).toMatchObject({ options: [{ type: 5, name: 'agree', required: true }] });
});
