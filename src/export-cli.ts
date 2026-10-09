import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { recordingConfig } from './config.js';
import { exportMix, type ExportInput } from './export.js';
import { privateDirectory, sessionId, snowflake } from './storage.js';

try {
  const [guild, session, ...extra] = process.argv.slice(2);
  if (!guild || !session || extra.length) throw new Error('引数が不正です。');
  const directory = await privateDirectory(recordingConfig().root, [snowflake(guild), sessionId(session)]);
  const handle = await open(join(directory, 'metadata.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let input: ExportInput;
  try {
    if ((await handle.stat()).size > 16_777_216) throw new Error('メタデータが大きすぎます。');
    const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
    if (!parsed || typeof parsed !== 'object' || !('state' in parsed) || !['completed', 'failed'].includes(String(parsed.state)) ||
      !('guildId' in parsed) || parsed.guildId !== guild || !('sessionId' in parsed) || parsed.sessionId !== session ||
      !('durationMs' in parsed) || typeof parsed.durationMs !== 'number' || !('segments' in parsed) || !Array.isArray(parsed.segments)) throw new Error('終了済みのメタデータではありません。');
    input = parsed as ExportInput;
  } finally { await handle.close(); }
  const output = await exportMix(directory, input);
  console.info(JSON.stringify({ event: 'mix_exported', bytes: output.bytes, gain: output.gain, clippedSamples: output.clippedSamples }));
} catch {
  console.error('混合出力に失敗しました。使い方：pnpm export <guildId> <sessionId>（設定保存先内の終了済みセッションのみ）。mix.wavが既にある場合は管理者が退避してください。');
  process.exitCode = 1;
}
