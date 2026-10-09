import Opus = require('@discordjs/opus');
import { join } from 'node:path';
import { CHANNELS, FRAME_BYTES, SAMPLE_RATE, type Metadata, type Segment, Timeline, type UserMetrics } from './model.js';
import { privateDirectory, snowflake, WavWriter } from './storage.js';
import type { RecordingConfig } from './config.js';

export interface Decoder { decode(packet: Buffer): Buffer; delete(): void }
export const createDecoder = (): Decoder => {
  let native: Opus.OpusEncoder | undefined = new Opus.OpusEncoder(SAMPLE_RATE, CHANNELS);
  return {
    decode(packet) {
      if (!native) throw new Error('デコーダーは終了済みです。');
      return native.decode(packet);
    },
    // 公開APIに明示disposeがないため参照を解放する。native資源はGCで破棄される。
    delete() { native = undefined; },
  };
};
interface ActiveSegment { data: Segment; writer?: WavWriter; failed: boolean }

// 全音声を蓄積せず、サイズ制限された書き込みキューから順次ファイルへ流す。
export class UserCapture {
  private tail: Promise<void> = Promise.resolve();
  private current?: ActiveSegment;
  private pendingBytes = 0;
  private closed = false;
  private lastArrival?: number;
  constructor(
    readonly userId: string,
    private readonly directory: string,
    private readonly metadata: Metadata,
    private readonly timeline: Timeline,
    private readonly config: RecordingConfig,
    private readonly metrics: UserMetrics,
    private readonly reserve: (bytes: number) => boolean,
    private readonly fail: (code: string) => void,
    private readonly decoder: Decoder = createDecoder(),
  ) { snowflake(userId); }

  packet(packet: Buffer): void {
    if (this.closed) return;
    this.metrics.packets++;
    // Discord/voiceの標準Opus無音終端パケット。VADによる無音判定ではない。
    if (packet.equals(Buffer.from([0xf8, 0xff, 0xfe]))) {
      this.metrics.silencePackets++;
      this.endSegment();
      this.lastArrival = undefined;
      return;
    }
    const arrival = this.timeline.offset();
    let pcm: Buffer;
    try {
      pcm = this.decoder.decode(packet);
      if (!pcm.length || pcm.length % FRAME_BYTES !== 0) throw new Error('不正なPCM');
    } catch {
      this.metrics.decodeFailures++;
      this.fail('decode_error');
      return;
    }
    const samples = pcm.length / FRAME_BYTES;
    const duration = samples / SAMPLE_RATE * 1000;
    if (this.lastArrival !== undefined && arrival - this.lastArrival > this.config.segmentGapMs) this.endSegment();
    if (this.lastArrival !== undefined && Math.abs(arrival - this.lastArrival - duration) > 80) {
      this.metrics.gapAnomalies++;
      this.endSegment();
    }
    // 累積ドリフトも分割し、欠落した時間を単純連結で押し詰めない。
    if (this.current && Math.abs(arrival - duration - this.current.data.endOffsetMs) > 80) this.endSegment();
    this.lastArrival = arrival;
    if (this.pendingBytes + pcm.length > this.config.maxPendingBytes) { this.fail('pending_buffer_limit'); return; }
    if (!this.reserve(pcm.length + (this.current ? 0 : 44))) { this.fail('session_size_limit'); return; }
    if (!this.current) {
      if (this.metadata.segments.length >= 10_000) { this.fail('segment_count_limit'); return; }
      const index = this.metadata.segments.filter((s) => s.userId === this.userId).length + 1;
      const file = `users/${this.userId}/segment-${String(index).padStart(4, '0')}.wav`;
      const start = Math.max(0, arrival - duration);
      const data: Segment = {
        userId: this.userId, file, startOffsetMs: start, endOffsetMs: start,
        startAt: this.timeline.at(start), endAt: this.timeline.at(start),
        firstPacketOffsetMs: arrival, lastPacketOffsetMs: arrival,
        durationMs: 0, samples: 0, bytes: 0, packets: 0, complete: false, timing: 'arrival-estimate',
      };
      const segment: ActiveSegment = { data, failed: false };
      this.current = segment;
      this.metadata.segments.push(data);
      this.enqueue(async () => {
        const userDirectory = await privateDirectory(this.directory, ['users', this.userId]);
        segment.writer = await WavWriter.create(join(userDirectory, `segment-${String(index).padStart(4, '0')}.wav`));
      }, segment);
    }
    const segment = this.current;
    segment.data.samples += samples;
    segment.data.packets++;
    segment.data.durationMs = segment.data.samples / SAMPLE_RATE * 1000;
    segment.data.endOffsetMs = segment.data.startOffsetMs + segment.data.durationMs;
    segment.data.endAt = this.timeline.at(segment.data.endOffsetMs);
    segment.data.lastPacketOffsetMs = arrival;
    this.pendingBytes += pcm.length;
    this.enqueue(async () => {
      try { if (!segment.failed && segment.writer) await segment.writer.append(pcm); }
      finally { this.pendingBytes -= pcm.length; }
    }, segment);
  }

  private enqueue(task: () => Promise<void>, segment: ActiveSegment): void {
    this.tail = this.tail.then(task).catch(() => { segment.failed = true; this.fail('storage_error'); });
  }
  idle(): void {
    if (this.current && this.lastArrival !== undefined && this.timeline.offset() - this.lastArrival >= this.config.segmentGapMs) this.endSegment();
  }
  private endSegment(): void {
    const segment = this.current;
    if (!segment) return;
    this.current = undefined;
    this.enqueue(async () => {
      if (!segment.writer) return;
      const bytes = await segment.writer.finish();
      segment.data.bytes = bytes + 44;
      segment.data.samples = bytes / FRAME_BYTES;
      segment.data.durationMs = segment.data.samples / SAMPLE_RATE * 1000;
      segment.data.endOffsetMs = segment.data.startOffsetMs + segment.data.durationMs;
      segment.data.endAt = this.timeline.at(segment.data.endOffsetMs);
      segment.data.complete = !segment.failed;
      this.metrics.segments++;
      this.metrics.audioDurationMs += segment.data.durationMs;
      this.metrics.bytes += segment.data.bytes;
      this.metadata.savedFiles++;
      this.metadata.savedBytes += segment.data.bytes;
    }, segment);
  }
  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.endSegment();
      this.decoder.delete();
    }
    return this.tail;
  }
}
