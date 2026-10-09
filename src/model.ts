export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
export const FRAME_BYTES = CHANNELS * 2;
export type SessionState = 'preparing' | 'paused' | 'recording' | 'stopping' | 'completed' | 'failed';

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
}
export interface UserMetrics {
  packets: number;
  silencePackets: number;
  decodeFailures: number;
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
  return { packets: 0, silencePackets: 0, decodeFailures: 0, gapAnomalies: 0, segments: 0, audioDurationMs: 0, bytes: 0 };
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
