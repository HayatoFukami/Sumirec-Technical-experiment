import Opus = require('@discordjs/opus');
import { appendFile, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecoder } from '../src/capture.js';
import { recordingConfig } from '../src/config.js';
import { exportMix, inspectSegment } from '../src/export.js';
import { SAMPLE_RATE, Timeline, assertTransition } from '../src/model.js';
import { SessionManager } from '../src/session.js';
import { contained, privateDirectory, sessionId, snowflake, WavWriter, wavHeader } from '../src/storage.js';
import { A, B, config, fixture, TestClock } from './helpers.js';
const { OpusEncoder } = Opus;

describe('時刻と音声ファイル', () => {
  it('壁時計が逆行しても単調時計で相対時刻を測る', () => {
    const clock = new TestClock(); const timeline = new Timeline(clock);
    clock.now = 1200; clock.wall -= 60_000;
    expect(timeline.offset()).toBe(1200);
    expect(timeline.at(1200)).toBe('2026-10-08T00:00:01.200Z');
    expect(() => assertTransition('completed', 'recording')).toThrow();
    expect(() => assertTransition('awaiting_consent', 'completed')).toThrow();
  });
  it('WAVのヘッダー・長さを確定し、既存ファイルを上書きしない', async () => {
    const cfg = await config(); const path = join(cfg.root, 'audio.wav');
    const writer = await WavWriter.create(path);
    await writer.append(Buffer.alloc(480 * 4, 1));
    await appendFile(`${path}.partial`, Buffer.alloc(8)); // 途中のappendで残った末尾を模擬
    expect(await writer.finish()).toBe(1920);
    expect(await writer.finish()).toBe(1920);
    const wav = await readFile(path);
    expect(wav.length).toBe(1964);
    expect(wav.subarray(0, 44)).toEqual(wavHeader(1920));
    await expect(writer.append(Buffer.alloc(4))).rejects.toThrow();
    await expect(WavWriter.create(path)).rejects.toThrow('上書き');
    expect(() => wavHeader(3)).toThrow();
    expect(() => wavHeader(0xffffffff)).toThrow();
  });
  it('実Opusを10/20/40/60msでエンコード・デコードし、サンプル数から長さを得る', () => {
    const encoder = new OpusEncoder(48_000, 2);
    const decoder = createDecoder();
    try {
      for (const ms of [10, 20, 40, 60]) {
        const frames = ms * 48;
        const pcm = Buffer.alloc(frames * 4);
        for (let i = 0; i < frames; i++) {
          const sample = Math.round(Math.sin(i * 2 * Math.PI * 440 / SAMPLE_RATE) * 10000);
          pcm.writeInt16LE(sample, i * 4); pcm.writeInt16LE(sample, i * 4 + 2);
        }
        const decoded = decoder.decode(encoder.encode(pcm));
        expect(decoded.length).toBe(frames * 4);
        expect(decoded.some((byte) => byte !== 0)).toBe(true);
      }
    } finally { decoder.delete(); }
  });
  it('実Opusから参加者WAV・時刻情報・混合音声まで生成する', async () => {
    const cfg = await config(); const f = fixture([A]); f.options.decoderFactory = createDecoder;
    const session = await new SessionManager(cfg).start(f.options);
    const encoder = new OpusEncoder(48_000, 2);
    try {
      await session.consent(A, true);
      f.clock.now = 100;
      const pcm = Buffer.alloc(960 * 4);
      for (let i = 0; i < 960; i++) {
        const sample = Math.round(Math.sin(i * Math.PI * 880 / SAMPLE_RATE) * 10000);
        pcm.writeInt16LE(sample, i * 4); pcm.writeInt16LE(sample, i * 4 + 2);
      }
      f.voice.callbacks!.packet(A, encoder.encode(pcm));
      f.clock.now = 200;
      await session.stop();
      expect(session.metadata.state).toBe('completed');
      expect(session.metadata.segments[0]?.durationMs).toBe(20);
      await inspectSegment(session.directory!, session.metadata.segments[0]!);
      const mix = await readFile(join(session.directory!, 'exports/mix.wav'));
      expect(mix.length).toBe(44 + 200 * 48 * 4);
      expect(mix.subarray(44, 44 + 80 * 48 * 4).every((byte) => byte === 0)).toBe(true);
    } finally { await session.stop(); }
  });
  it('同時発言・10秒の無音・可変長パケット・同一話者の発話再開を配置する', async () => {
    const cfg = await config(); const f = fixture();
    const session = await new SessionManager(cfg).start(f.options);
    await session.consent(A, true); await session.consent(B, true);
    f.clock.now = 100; f.voice.emit(A, 20); f.voice.emit(B, 20);
    f.clock.now = 120; f.voice.emit(A, 20);
    f.voice.callbacks!.packet(A, Buffer.from([0xf8, 0xff, 0xfe]));
    f.clock.now = 10_160; f.voice.emit(A, 40);
    f.clock.now = 10_200; await session.stop();
    expect(session.metadata.segments.map((s) => s.startOffsetMs)).toEqual([80, 80, 10_120]);
    expect(session.metadata.users[A]?.audioDurationMs).toBe(80);
    const mix = await readFile(join(session.directory!, 'exports/mix.wav'));
    const sample = (ms: number) => mix.readInt16LE(44 + ms * 48 * 4);
    expect(sample(0)).toBe(0);
    expect(sample(90)).toBe(257); // 同時発言、各入力257を1/2で混合
    expect(sample(110)).toBe(129);
    expect(sample(1000)).toBe(0);
    expect(sample(10_100)).toBe(0);
    expect(sample(10_140)).toBe(129);
    expect(sample(10_180)).toBe(0);
    expect(mix.length).toBe(44 + 10_200 * 48 * 4);
  });
  it('受信間隔の異常を数え、ジッターによる大きなずれを分割する', async () => {
    const f = fixture([A]); const session = await new SessionManager(await config()).start(f.options);
    await session.consent(A, true);
    f.clock.now = 100; f.voice.emit(A);
    f.clock.now = 300; f.voice.emit(A);
    await session.stop();
    expect(session.metadata.users[A]?.gapAnomalies).toBe(1);
    expect(session.metadata.segments.map((s) => s.startOffsetMs)).toEqual([80, 280]);
  });
  it('壊れたWAV・範囲外の時刻・危険な参照パス・symlinkを拒否する', async () => {
    const f = fixture([A]); const session = await new SessionManager(await config()).start(f.options);
    await session.consent(A, true); f.clock.now = 100; f.voice.emit(A); await session.stop();
    const segment = session.metadata.segments[0]!;
    await expect(inspectSegment(session.directory!, { ...segment, file: '../../escape.wav' })).rejects.toThrow('参照');
    await expect(exportMix(session.directory!, { durationMs: Infinity, segments: [] })).rejects.toThrow('上限');
    await expect(exportMix(session.directory!, { durationMs: 100, segments: [{ ...segment, startOffsetMs: -1 }] })).rejects.toThrow('時刻');
    await writeFile(join(session.directory!, segment.file), Buffer.alloc(segment.bytes));
    await expect(inspectSegment(session.directory!, segment)).rejects.toThrow('WAV');
    const cfg = await config();
    await symlink(session.directory!, join(cfg.root, 'linked'));
    await expect(privateDirectory(cfg.root, ['linked'])).rejects.toThrow('安全');
    expect(() => contained(cfg.root, '../escape')).toThrow();
    expect(() => contained(cfg.root, '/tmp/escape')).toThrow();
    expect(() => snowflake('../123')).toThrow();
    expect(() => sessionId('../test')).toThrow();
  });
  it('設定値を制限し、空の会議も無音WAVとして復元できる', async () => {
    expect(() => recordingConfig({ MAX_DURATION_MS: '0' })).toThrow();
    expect(() => recordingConfig({ MAX_PENDING_BYTES: 'NaN' })).toThrow();
    const cfg = await config();
    const result = await exportMix(cfg.root, { durationMs: 100, segments: [] });
    const wav = await readFile(join(cfg.root, result.file));
    expect(wav.length).toBe(44 + 4800 * 4);
    expect(wav.subarray(44).every((byte) => byte === 0)).toBe(true);
  });
});
