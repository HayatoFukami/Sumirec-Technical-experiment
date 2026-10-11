import { resolve } from 'node:path';
import type { VadClass } from './model.js';

function flag(env: NodeJS.ProcessEnv, key: string): boolean {
  if (env[key] !== undefined && !['true', 'false'].includes(env[key]!)) throw new Error(`${key}はtrue/falseで指定してください。`);
  return env[key] === 'true';
}
function number(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key}の設定が不正です。`);
  return value;
}
function choice<T extends string>(env: NodeJS.ProcessEnv, key: string, fallback: T, choices: readonly T[]): T {
  const value = env[key] ?? fallback;
  if (!choices.includes(value as T)) throw new Error(`${key}の設定が不正です。`);
  return value as T;
}
export interface HttpConfig { maxRetries: number; timeoutMs: number }
export interface SttConfig extends HttpConfig {
  root: string; enabled: boolean; provider: 'azure-mai'; model: 'MAI-Transcribe-2';
  language: string; style: 'verbatim' | 'clean'; timestamps: 'segment' | 'word'; phrases: string[];
  classes: VadClass[]; maxChunkSeconds: number; maxGapMs: number; maxConcurrency: number;
  maxRequests: number; maxAudioSeconds: number; endpoint: string; key: string;
}
export function sttConfig(env: NodeJS.ProcessEnv = process.env): SttConfig {
  const language = env.STT_LANGUAGE ?? 'ja';
  if (!/^(auto|[a-z]{2,3})$/.test(language)) throw new Error('STT_LANGUAGEはja等の言語コード、またはautoで指定してください。');
  let phrases: unknown;
  try { phrases = JSON.parse(env.STT_PHRASES_JSON ?? '[]'); } catch { throw new Error('STT_PHRASES_JSONはJSON配列で指定してください。'); }
  if (!Array.isArray(phrases) || phrases.length > 100 || !phrases.every(p => typeof p === 'string' && p.trim().length > 0 && p.length <= 200)) throw new Error('専門用語リストが不正です。');
  const classes = (env.STT_CLASSES ?? 'speech').split(',');
  if (!classes.length || !classes.every(c => ['speech', 'non-speech', 'unclassified'].includes(c)) || new Set(classes).size !== classes.length) throw new Error('STT_CLASSESの設定が不正です。');
  return {
    root: resolve(env.RECORDINGS_DIR ?? './recordings'), enabled: flag(env, 'STT_ENABLED'),
    provider: choice(env, 'STT_PROVIDER', 'azure-mai', ['azure-mai']), model: choice(env, 'STT_MODEL', 'MAI-Transcribe-2', ['MAI-Transcribe-2']),
    language, style: choice(env, 'STT_STYLE', 'verbatim', ['verbatim', 'clean']), timestamps: choice(env, 'STT_TIMESTAMPS', 'segment', ['segment', 'word']), phrases,
    classes: classes as VadClass[], maxChunkSeconds: number(env, 'STT_CHUNK_SECONDS', 20, 1, 120), maxGapMs: number(env, 'STT_CHUNK_GAP_MS', 1000, 0, 2000),
    maxConcurrency: number(env, 'STT_MAX_CONCURRENCY', 2, 1, 4), maxRequests: number(env, 'STT_MAX_REQUESTS', 100, 1, 10_000),
    maxAudioSeconds: number(env, 'STT_MAX_AUDIO_SECONDS', 900, 1, 36_000), maxRetries: number(env, 'STT_MAX_RETRIES', 2, 0, 5),
    timeoutMs: number(env, 'STT_TIMEOUT_MS', 120_000, 100, 600_000), endpoint: env.AZURE_SPEECH_ENDPOINT ?? '', key: env.AZURE_SPEECH_KEY ?? '',
  };
}
export interface MinutesConfig extends HttpConfig {
  root: string; enabled: boolean; provider: 'openai'; model: string; key: string;
  maxInputChars: number; maxOutputTokens: number;
}
export function minutesConfig(env: NodeJS.ProcessEnv = process.env): MinutesConfig {
  const model = env.MINUTES_MODEL ?? 'gpt-5.6-terra';
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model)) throw new Error('MINUTES_MODELが不正です。');
  return {
    root: resolve(env.RECORDINGS_DIR ?? './recordings'), enabled: flag(env, 'MINUTES_ENABLED'), provider: choice(env, 'MINUTES_PROVIDER', 'openai', ['openai']), model, key: env.OPENAI_API_KEY ?? '',
    maxRetries: number(env, 'MINUTES_MAX_RETRIES', 2, 0, 5), timeoutMs: number(env, 'MINUTES_TIMEOUT_MS', 120_000, 100, 600_000),
    maxInputChars: number(env, 'MINUTES_MAX_INPUT_CHARS', 200_000, 100, 1_000_000), maxOutputTokens: number(env, 'MINUTES_MAX_OUTPUT_TOKENS', 16_000, 1000, 64_000),
  };
}
export function azureUrl(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('AZURE_SPEECH_ENDPOINTを設定してください。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname) ||
    !/^[a-z0-9-]+\.(?:cognitiveservices\.azure\.com|api\.cognitive\.microsoft\.com)$/.test(url.hostname)) throw new Error('Azure SpeechのHTTPSリソースURLを指定してください。');
  return `${url.origin}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`;
}
