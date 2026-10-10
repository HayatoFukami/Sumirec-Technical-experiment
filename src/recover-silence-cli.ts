import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { recordingConfig } from './config.js';
import type { Metadata } from './model.js';
import { cleanupSilentSegments } from './silence.js';
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
    if (!metadata || metadata.schemaVersion !== 2 || metadata.guildId !== guild || metadata.sessionId !== session ||
      !metadata.silenceCleanup) throw new Error('復旧用の削除記録がありません。');
  } finally { await handle.close(); }
  // 保存済みの削除予定だけを復旧する。古いセッションを新たに検査して削除しない。
  await cleanupSilentSegments(directory, metadata, true);
  if (metadata.silenceCleanup!.entries.some((entry) => entry.state === 'pending')) throw new Error('削除予定を解決できません。');
  if (metadata.state === 'stopping') {
    metadata.state = 'failed';
    metadata.errorCode ??= 'interrupted_stop';
  }
  if (metadata.exportError === 'silence_cleanup_pending') metadata.exportError = null;
  await atomicJson(directory, metadata);
  console.info(JSON.stringify({ event: 'silence_cleanup_recovered',
    deletedSegments: metadata.silenceCleanup!.deletedSegments, deletedBytes: metadata.silenceCleanup!.deletedBytes }));
} catch {
  console.error('無音削除の復旧に失敗しました。使い方：pnpm recover-silence <guildId> <sessionId>。Bot停止後、保存済みの削除記録があるセッションのみ復旧できます。ファイルは手動削除せず、保存先・権限・metadata.jsonの削除記録を確認してください。');
  process.exitCode = 1;
}
