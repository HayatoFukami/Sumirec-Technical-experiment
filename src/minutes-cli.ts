import { minutesConfig } from './processing-config.js';
import { generateMinutes } from './minutes.js';
import { ApiError } from './api-http.js';

try {
  const [guild, session, ...flags] = process.argv.slice(2);
  if (!guild || !session || flags.some(f => !['--dry-run','--force'].includes(f)) || new Set(flags).size !== flags.length) throw new Error('引数が不正です。');
  const result = await generateMinutes(guild, session, minutesConfig(), { dryRun: flags.includes('--dry-run'), force: flags.includes('--force') });
  console.info(JSON.stringify({ event: result.dryRun ? 'minutes_dry_run' : 'minutes_completed', ...result.summary,
    ...(result.dryRun ? { disabled: result.disabled } : { cached: result.cached, tokenUsage: result.artifact.usage }) }));
} catch (error) {
  const code = error instanceof ApiError ? error.code : 'configuration_or_storage_error';
  console.error(`議事録生成に失敗しました (${code})。使い方: pnpm minutes <guildId> <sessionId> [--dry-run] [--force]。設定・最新の文字起こし結果・ロック・保存先を確認してください。`);
  process.exitCode = 1;
}
