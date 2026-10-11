import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { recordingConfig } from './config.js';
import type { Metadata } from './model.js';
import { classifySegments } from './vad.js';
import { atomicJson, privateDirectory, sessionId, snowflake } from './storage.js';

try {
  const [guild, session, ...extra] = process.argv.slice(2);
  if (!guild || !session || extra.length) throw new Error('引数が不正です。');
  const directory = await privateDirectory(recordingConfig().root, [snowflake(guild), sessionId(session)]);
  const handle = await open(join(directory, 'metadata.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let metadata: Metadata;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16_777_216) throw new Error('メタデータが不正です。');
    metadata = JSON.parse(await handle.readFile('utf8')) as Metadata;
    if (!metadata || metadata.schemaVersion !== 2 || metadata.guildId !== guild || metadata.sessionId !== session || !metadata.vad) throw new Error('VAD移動記録がありません。');
  } finally { await handle.close(); }
  await classifySegments(directory, metadata, metadata.vad!.config, undefined, true);
  if (metadata.vad!.moves.some((m) => m.state === 'pending')) throw new Error('移動予定を解決できません。');
  if (metadata.state === 'stopping') { metadata.state = 'failed'; metadata.errorCode ??= 'interrupted_stop'; }
  await atomicJson(directory, metadata);
  console.info(JSON.stringify({ event: 'vad_moves_recovered', files: metadata.savedFiles, bytes: metadata.savedBytes }));
} catch {
  console.error('VAD移動の復旧に失敗しました。使い方：pnpm recover-vad <guildId> <sessionId>。Bot停止後、VAD移動記録のあるセッションだけを指定してください。残った.vad.lockは他プロセスが停止したことを確認してから解除し、音声は手動削除しないでください。');
  process.exitCode = 1;
}
