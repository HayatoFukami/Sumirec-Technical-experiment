import { resolve } from 'node:path';

export interface VadConfig {
  enabled: boolean;
  positiveThreshold: number;
  negativeThreshold: number;
  minSpeechMs: number;
  redemptionMs: number;
  preSpeechPadMs: number;
  maxConcurrency: number;
}
export function vadConfig(env: NodeJS.ProcessEnv = process.env): VadConfig {
  if (env.VAD_ENABLED !== undefined && !['true', 'false'].includes(env.VAD_ENABLED)) throw new Error('VAD_ENABLEDはtrueまたはfalseで指定してください。');
  const number = (key: string, fallback: number, max: number, integer = false) => {
    const raw = env[key];
    const value = raw === undefined ? fallback : Number(raw);
    if (raw?.trim() === '' || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isSafeInteger(value))) throw new Error(`${key}の設定が不正です。`);
    return value;
  };
  const config = {
    enabled: env.VAD_ENABLED !== 'false',
    positiveThreshold: number('VAD_POSITIVE_THRESHOLD', 0.40, 1),
    negativeThreshold: number('VAD_NEGATIVE_THRESHOLD', 0.30, 1),
    minSpeechMs: number('VAD_MIN_SPEECH_MS', 100, 60_000, true),
    redemptionMs: number('VAD_REDEMPTION_MS', 200, 60_000, true),
    preSpeechPadMs: number('VAD_PRE_SPEECH_PAD_MS', 100, 60_000, true),
    maxConcurrency: number('VAD_MAX_CONCURRENCY', 1, 4, true),
  };
  if (config.negativeThreshold >= config.positiveThreshold) throw new Error('VAD_NEGATIVE_THRESHOLDはVAD_POSITIVE_THRESHOLDより小さくしてください。');
  if (config.maxConcurrency < 1) throw new Error('VAD_MAX_CONCURRENCYは1〜4の整数で指定してください。');
  return config;
}
export interface RecordingConfig {
  root: string;
  maxDurationMs: number;
  maxSessionBytes: number;
  maxParticipants: number;
  maxPendingBytes: number;
  reconnectTimeoutMs: number;
  segmentGapMs: number;
  diagnostics?: boolean;
  vad?: VadConfig;
}
function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, max: number): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${key}の設定が不正です。`);
  return value;
}
export function recordingConfig(env: NodeJS.ProcessEnv = process.env): RecordingConfig {
  if (env.RECORDING_DIAGNOSTICS !== undefined && !['true', 'false'].includes(env.RECORDING_DIAGNOSTICS)) throw new Error('RECORDING_DIAGNOSTICSはtrueまたはfalseで指定してください。');
  return {
    vad: vadConfig(env),
    diagnostics: env.RECORDING_DIAGNOSTICS === 'true',
    root: resolve(env.RECORDINGS_DIR ?? './recordings'),
    maxDurationMs: integer(env, 'MAX_DURATION_MS', 900_000, 3_600_000),
    maxSessionBytes: integer(env, 'MAX_SESSION_BYTES', 536_870_912, 2_000_000_000),
    maxParticipants: integer(env, 'MAX_PARTICIPANTS', 10, 50),
    maxPendingBytes: integer(env, 'MAX_PENDING_BYTES', 4_194_304, 67_108_864),
    reconnectTimeoutMs: integer(env, 'RECONNECT_TIMEOUT_MS', 15_000, 60_000),
    segmentGapMs: integer(env, 'SEGMENT_GAP_MS', 250, 2000),
  };
}
export function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.startsWith('replace_')) throw new Error(`${name}を設定してください。`);
  return value;
}
