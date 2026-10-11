import { sttConfig } from './processing-config.js';
import { transcribeSession } from './transcribe.js';
import { ApiError } from './api-http.js';

try {
  const [guild, session, ...flags] = process.argv.slice(2);
  if (!guild || !session || flags.some(f => !['--dry-run','--force'].includes(f)) || new Set(flags).size !== flags.length) throw new Error('引数が不正です。');
  const options = { dryRun: flags.includes('--dry-run'), force: flags.includes('--force') };
  const result = await transcribeSession(guild, session, sttConfig(), options);
  console.info(JSON.stringify({ event: result.dryRun ? 'transcription_dry_run' : 'transcription_completed', ...result.summary,
    ...(result.dryRun ? { disabled: result.disabled } : { incomplete: result.bundle.incomplete, usage: result.bundle.usage }) }));
  if (!result.dryRun && result.bundle.chunks.some(c => c.status !== 'succeeded')) process.exitCode = 1;
} catch (error) {
  // 外部例外の本文・APIキー・パス・会議内容をコンソールへ出さない。
  const code = error instanceof ApiError ? error.code : 'configuration_or_storage_error';
  console.error(`文字起こしに失敗しました (${code})。使い方: pnpm transcribe <guildId> <sessionId> [--dry-run] [--force]。設定・終了済みメタデータ・ロック・保存先を確認してください。`);
  process.exitCode = 1;
}
