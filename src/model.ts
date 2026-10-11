import type { RecordingDiagnostics } from './diagnostics.js';
export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
export const FRAME_BYTES = CHANNELS * 2;
export type SessionState = 'preparing' | 'paused' | 'recording' | 'stopping' | 'completed' | 'failed';
export type VadClass = 'speech' | 'non-speech' | 'unclassified';
export interface SpeechRange { startMs: number; endMs: number }
export interface VadResult {
  classification: VadClass;
  completed: boolean;
  ranges: SpeechRange[];
  error?: 'disabled' | 'incomplete' | 'wav_read_error' | 'model_load_error' | 'inference_error' | 'timeout' | 'move_error' | 'metadata_write_error' | 'classification_error';
  sha256?: string;
}

export interface Segment {
  userId: string;
  file: string;
  startOffsetMs: number;
  endOffsetMs: number;
  startAt: string;
  endAt: string;
  firstPacketOffsetMs: number;
  lastPacketOffsetMs: number;
  durationMs: number;
  samples: number;
  bytes: number;
  packets: number;
  complete: boolean;
  timing: 'arrival-estimate';
  vad?: VadResult;
}
export interface UserMetrics {
  packets: number;
  silencePackets: number;
  decodeFailures: number;
  decodeSuccesses?: number;
  savedSamples?: number;
  gapAnomalies: number;
  segments: number;
  audioDurationMs: number;
  bytes: number;
}
export interface Metadata {
  schemaVersion: 2;
  sessionId: string;
  guildId: string;
  channelId: string;
  ownerId: string;
  preparedAt: string;
  recordingStartedAt: string | null;
  endedAt: string | null;
  durationMs: number;
  state: SessionState;
  format: { container: 'WAV'; encoding: 'PCM_S16LE'; sampleRate: number; channels: number };
  participants: Record<string, { present: boolean }>;
  users: Record<string, UserMetrics>;
  segments: Segment[];
  events: { at: string; offsetMs: number | null; type: string; userId?: string; value?: string }[];
  reconnects: number;
  peakParticipants: number;
  savedFiles: number;
  savedBytes: number;
  memoryAtEnd: NodeJS.MemoryUsage | null;
  errorCode: string | null;
  exportFile: string | null;
  exportError: string | null;
  limitations: string[];
  diagnostics?: RecordingDiagnostics;
  vad?: {
    version: 1;
    model: string;
    modelSha256: string;
    runtime: string;
    config: import('./config.js').VadConfig;
    state: 'processing' | 'completed' | 'failed';
    error?: 'metadata_write_error' | 'classification_error';
    speechFiles: number;
    nonSpeechFiles: number;
    unclassifiedFiles: number;
    errors: number;
    moves: {
      from: string; to: string; userId: string; sha256: string;
      dev: number; ino: number; size: number;
      result: VadResult;
      state: 'pending' | 'moved';
    }[];
  };
  silenceCleanup?: {
    version: 1;
    entries: {
      segment: Segment;
      identity: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
      state: 'pending' | 'deleted';
      error?: 'inspection_failed' | 'delete_failed' | 'file_changed';
    }[];
    retained: { file: string; reason: 'inspection_failed' }[];
    deletedSegments: number;
    deletedBytes: number;
  };
}

export interface Clock {
  monotonicMs(): number;
  wallNow(): Date;
}
export const systemClock: Clock = {
  monotonicMs: () => performance.now(),
  wallNow: () => new Date(),
};
export class Timeline {
  readonly wallStart: Date;
  private readonly monotonicStart: number;
  constructor(private readonly clock: Clock = systemClock) {
    this.wallStart = clock.wallNow();
    this.monotonicStart = clock.monotonicMs();
  }
  offset(): number { return Math.max(0, this.clock.monotonicMs() - this.monotonicStart); }
  at(offset: number): string { return new Date(this.wallStart.getTime() + offset).toISOString(); }
}
export function emptyMetrics(): UserMetrics {
  return { packets: 0, silencePackets: 0, decodeFailures: 0, decodeSuccesses: 0, savedSamples: 0, gapAnomalies: 0, segments: 0, audioDurationMs: 0, bytes: 0 };
}
const transitions: Record<SessionState, SessionState[]> = {
  preparing: ['recording', 'stopping'],
  paused: ['recording', 'stopping'],
  recording: ['paused', 'stopping'],
  stopping: ['completed', 'failed'], completed: [], failed: [],
};
export function assertTransition(from: SessionState, to: SessionState): void {
  if (!transitions[from].includes(to)) throw new Error('不正なセッション状態遷移です。');
}
