import { resolve } from 'node:path';

export interface RecordingConfig {
  root: string;
  maxDurationMs: number;
  maxSessionBytes: number;
  maxParticipants: number;
  maxPendingBytes: number;
  consentTimeoutMs: number;
  reconnectTimeoutMs: number;
  segmentGapMs: number;
}
function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, max: number): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${key}の設定が不正です。`);
  return value;
}
export function recordingConfig(env: NodeJS.ProcessEnv = process.env): RecordingConfig {
  return {
    root: resolve(env.RECORDINGS_DIR ?? './recordings'),
    maxDurationMs: integer(env, 'MAX_DURATION_MS', 900_000, 3_600_000),
    maxSessionBytes: integer(env, 'MAX_SESSION_BYTES', 536_870_912, 2_000_000_000),
    maxParticipants: integer(env, 'MAX_PARTICIPANTS', 10, 50),
    maxPendingBytes: integer(env, 'MAX_PENDING_BYTES', 4_194_304, 67_108_864),
    consentTimeoutMs: integer(env, 'CONSENT_TIMEOUT_MS', 300_000, 900_000),
    reconnectTimeoutMs: integer(env, 'RECONNECT_TIMEOUT_MS', 15_000, 60_000),
    segmentGapMs: integer(env, 'SEGMENT_GAP_MS', 250, 2000),
  };
}
export function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.startsWith('replace_')) throw new Error(`${name}を設定してください。`);
  return value;
}
