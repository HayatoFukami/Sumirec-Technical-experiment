import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { CHANNELS, FRAME_BYTES, SAMPLE_RATE, type Segment } from './model.js';
import { contained, privateDirectory, snowflake, WavWriter, wavHeader } from './storage.js';

export interface ExportInput { durationMs: number; segments: Segment[] }
export async function readFully(handle: FileHandle, size: number, position: number): Promise<Buffer> {
  const data = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(data, offset, size - offset, position + offset);
    if (!bytesRead) throw new Error('音声ファイルが途中で切れています。');
    offset += bytesRead;
  }
  return data;
}
async function segmentHandle(directory: string, segment: Segment): Promise<FileHandle> {
  snowflake(segment.userId);
  if (!new RegExp(`^users/${segment.userId}/segment-\\d{4,5}\\.wav$`).test(segment.file)) throw new Error('音声ファイル参照が不正です。');
  for (const part of [directory, join(directory, 'users'), join(directory, 'users', segment.userId)]) {
    const stat = await lstat(part);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('音声ディレクトリが不正です。');
  }
  return open(contained(directory, segment.file), constants.O_RDONLY | constants.O_NOFOLLOW);
}
export async function inspectSegment(directory: string, segment: Segment): Promise<void> {
  const handle = await segmentHandle(directory, segment);
  try {
    const stat = await handle.stat();
    const bytes = segment.samples * FRAME_BYTES;
    if (!stat.isFile() || stat.size !== bytes + 44 || segment.bytes !== stat.size ||
      !(await readFully(handle, 44, 0)).equals(wavHeader(bytes))) throw new Error('WAV形式・サイズが一致しません。');
  } finally { await handle.close(); }
}

// 1秒ごとのブロックで混合する。録音全体や全入力をメモリへ読み込まない。
export async function exportMix(directory: string, input: ExportInput): Promise<{ file: string; bytes: number; gain: number; clippedSamples: number }> {
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0 || input.durationMs > 3_601_000 ||
    !Array.isArray(input.segments) || input.segments.length > 10_000) throw new Error('混合出力の上限を超えています。');
  const segments = input.segments.filter((s) => s.complete);
  for (const segment of segments) {
    if (!Number.isFinite(segment.startOffsetMs) || segment.startOffsetMs < 0 ||
      !Number.isSafeInteger(segment.samples) || segment.samples < 1 ||
      !Number.isFinite(segment.endOffsetMs) ||
      Math.abs(segment.endOffsetMs - segment.startOffsetMs - segment.samples / SAMPLE_RATE * 1000) > 0.01 ||
      segment.endOffsetMs > 3_601_000) throw new Error('セグメント時刻・長さが不正です。');
    await inspectSegment(directory, segment);
  }
  const users = new Set(segments.map((s) => s.userId)).size;
  const gain = 1 / Math.max(1, users);
  const frames = Math.ceil(Math.max(input.durationMs, ...segments.map((s) => s.endOffsetMs)) * SAMPLE_RATE / 1000);
  const outputDirectory = await privateDirectory(directory, ['exports']);
  const writer = await WavWriter.create(join(outputDirectory, 'mix.wav'));
  let clippedSamples = 0;
  try {
    for (let first = 0; first < frames; first += SAMPLE_RATE) {
      const count = Math.min(SAMPLE_RATE, frames - first);
      const mixed = new Float64Array(count * CHANNELS);
      for (const segment of segments) {
        const start = Math.round(segment.startOffsetMs * SAMPLE_RATE / 1000);
        const low = Math.max(first, start);
        const high = Math.min(first + count, start + segment.samples);
        if (high <= low) continue;
        const handle = await segmentHandle(directory, segment);
        try {
          const pcm = await readFully(handle, (high - low) * FRAME_BYTES, 44 + (low - start) * FRAME_BYTES);
          const destination = (low - first) * CHANNELS;
          for (let i = 0; i < pcm.length / 2; i++) mixed[destination + i] = mixed[destination + i]! + pcm.readInt16LE(i * 2) * gain;
        } finally { await handle.close(); }
      }
      const pcm = Buffer.alloc(count * FRAME_BYTES);
      for (let i = 0; i < mixed.length; i++) {
        const sample = Math.round(mixed[i]!);
        if (sample < -32768 || sample > 32767) clippedSamples++;
        pcm.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
      }
      await writer.append(pcm);
    }
  } catch (error) {
    // 回収可能なWAVを確定するが、呼び出し元へ失敗を返す。
    await writer.finish(false).catch(() => undefined);
    throw error;
  }
  const bytes = await writer.finish();
  return { file: 'exports/mix.wav', bytes: bytes + 44, gain, clippedSamples };
}
