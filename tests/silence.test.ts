import Opus = require('@discordjs/opus');
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDecoder } from '../src/capture.js';
import { exportMix } from '../src/export.js';
import { emptyMetrics, type Metadata, type Segment } from '../src/model.js';
import { RecordingSession, SessionManager } from '../src/session.js';
import { cleanupSilentSegments, inspectDigitalSilence } from '../src/silence.js';
import * as storage from '../src/storage.js';
import { A, B, C, config, fixture } from './helpers.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) };
});
afterEach(() => { vi.restoreAllMocks(); vi.mocked(fs.open).mockReset(); vi.mocked(fs.unlink).mockReset(); });
async function storedSession() {
  const cfg = await config();
  const session = new RecordingSession(cfg, fixture().options);
  const metadata = session.metadata;
  metadata.state = 'stopping'; metadata.endedAt = '2026-10-08T00:00:01.000Z'; metadata.durationMs = 1000;
  const directory = await storage.privateDirectory(cfg.root, [metadata.guildId, metadata.sessionId]);
  return { directory, metadata, cfg };
}
async function addWav(directory: string, metadata: Metadata, pcm: Buffer, userId = A, start = 0): Promise<Segment> {
  const index = metadata.segments.filter((s) => s.userId === userId).length + 1;
  const file = `users/${userId}/segment-${String(index).padStart(4, '0')}.wav`;
  const parent = await storage.privateDirectory(directory, ['users', userId]);
  const writer = await storage.WavWriter.create(join(parent, `segment-${String(index).padStart(4, '0')}.wav`));
  await writer.append(pcm); await writer.finish();
  const samples = pcm.length / 4;
  const durationMs = samples / 48;
  const segment: Segment = { userId, file, samples, bytes: pcm.length + 44, durationMs,
    startOffsetMs: start, endOffsetMs: start + durationMs, startAt: 'start', endAt: 'end',
    firstPacketOffsetMs: start, lastPacketOffsetMs: start + durationMs, packets: 1, complete: true, timing: 'arrival-estimate' };
  metadata.segments.push(segment); metadata.savedFiles++; metadata.savedBytes += segment.bytes;
  const metrics = metadata.users[userId] ??= emptyMetrics();
  metrics.packets++; metrics.decodeSuccesses!++; metrics.segments++;
  metrics.savedSamples! += samples; metrics.audioDurationMs += durationMs; metrics.bytes += segment.bytes;
  return segment;
}
async function load(directory: string): Promise<Metadata> {
  return JSON.parse(await fs.readFile(join(directory, 'metadata.json'), 'utf8')) as Metadata;
}
async function absent(path: string) { await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' }); }

describe('PCM完全ゼロのみを検査・削除する', () => {
  it.each([0, 960 * 4, 256 * 1024 + 4])('正常なゼロPCM %i バイトを削除する', async (bytes) => {
    const { directory, metadata } = await storedSession();
    const segment = await addWav(directory, metadata, Buffer.alloc(bytes));
    expect(await inspectDigitalSilence(directory, segment)).not.toBeNull();
    await cleanupSilentSegments(directory, metadata);
    await absent(join(directory, segment.file));
    expect(metadata.segments).toEqual([]);
    expect(metadata.savedFiles).toBe(0); expect(metadata.savedBytes).toBe(0);
    expect(metadata.silenceCleanup).toMatchObject({ deletedSegments: 1, deletedBytes: bytes + 44 });
  });
  it.each([
    ['1サンプルだけ1', 1, 0, 960], ['1サンプルだけ-1', -1, 959 * 4 + 2, 960],
    ['極小の音声', 2, 42, 4800], ['20msの短い音声', 8, 4, 960],
    ['環境ノイズ', -17, 200, 4800], ['大半が無音で最終サンプルだけ非ゼロ', 1, 96000 * 4 - 2, 96000],
    ['64KiB境界の非ゼロ', -1, 65536, 20000],
  ])('%sを必ず保持する', async (_name, value, offset, frames) => {
    const { directory, metadata } = await storedSession();
    const pcm = Buffer.alloc(Number(frames) * 4); pcm.writeInt16LE(Number(value), Number(offset));
    const segment = await addWav(directory, metadata, pcm);
    const original = await fs.readFile(join(directory, segment.file));
    expect(await inspectDigitalSilence(directory, segment)).toBeNull();
    await cleanupSilentSegments(directory, metadata);
    expect(await fs.readFile(join(directory, segment.file))).toEqual(original);
    expect(metadata.savedFiles).toBe(1); expect(metadata.savedBytes).toBe(original.length);
    expect(metadata.segments).toEqual([segment]);
    expect(metadata.silenceCleanup?.deletedSegments).toBe(0);
  });
  it.each(['header', 'truncated', 'extra', 'format', 'metadata'])('不整合WAV (%s)を保持して検査失敗を記録する', async (kind) => {
    const { directory, metadata } = await storedSession();
    const segment = await addWav(directory, metadata, Buffer.alloc(3840));
    const path = join(directory, segment.file);
    const wav = await fs.readFile(path);
    if (kind === 'header') wav[0] = 0;
    if (kind === 'format') wav.writeUInt16LE(8, 34);
    if (kind === 'metadata') segment.samples++;
    await fs.writeFile(path, kind === 'truncated' ? wav.subarray(0, -4) : kind === 'extra' ? Buffer.concat([wav, Buffer.alloc(4)]) : wav);
    await expect(inspectDigitalSilence(directory, segment)).rejects.toThrow();
    await cleanupSilentSegments(directory, metadata);
    expect((await fs.lstat(path)).isFile()).toBe(true);
    expect(metadata.segments).toHaveLength(1);
    expect(metadata.silenceCleanup?.retained).toEqual([{ file: segment.file, reason: 'inspection_failed' }]);
  });
  it('読み取り失敗と途中EOFを保持する', async () => {
    const { directory, metadata } = await storedSession();
    const segment = await addWav(directory, metadata, Buffer.alloc(3840));
    const realOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    const spy = vi.spyOn(fs, 'open').mockRejectedValueOnce(new Error('read denied'));
    await expect(inspectDigitalSilence(directory, segment)).rejects.toThrow();
    spy.mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      const read = handle.read.bind(handle) as (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }>;
      vi.spyOn(handle, 'read').mockImplementation(async (...args: unknown[]) => {
        const readArgs = args as [Buffer, number, number, number];
        if (readArgs[3] === 44) throw new Error('read failed');
        return read(...readArgs);
      });
      return handle;
    });
    await cleanupSilentSegments(directory, metadata);
    expect(metadata.silenceCleanup?.retained).toHaveLength(1);
    expect((await fs.lstat(join(directory, segment.file))).size).toBe(segment.bytes);
    spy.mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      const read = handle.read.bind(handle) as (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }>;
      vi.spyOn(handle, 'read').mockImplementation(async (...args: unknown[]) => {
        const readArgs = args as [Buffer, number, number, number];
        if (readArgs[3] === 44) return { bytesRead: 0, buffer: readArgs[0] };
        return read(...readArgs);
      });
      return handle;
    });
    await expect(inspectDigitalSilence(directory, segment)).rejects.toThrow('途中');
  });
  it('64KiB以下のバッファで走査し、先頭の非ゼロで読み取りを止める', async () => {
    const { directory, metadata } = await storedSession();
    const segment = await addWav(directory, metadata, Buffer.alloc(2 * 1024 * 1024));
    const realOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    const lengths: number[] = [];
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const read = handle.read.bind(handle) as (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }>;
      vi.spyOn(handle, 'read').mockImplementation(async (...args: unknown[]) => {
        const readArgs = args as [Buffer, number, number, number];
        lengths.push(Number(readArgs[2])); return read(...readArgs);
      });
      return handle;
    });
    expect(await inspectDigitalSilence(directory, segment)).not.toBeNull();
    expect(Math.max(...lengths)).toBe(65536); expect(lengths.length).toBe(33);
    const nonzero = Buffer.alloc(2 * 1024 * 1024); nonzero.writeInt16LE(1);
    await fs.writeFile(join(directory, segment.file), Buffer.concat([storage.wavHeader(nonzero.length), nonzero]));
    lengths.length = 0;
    expect(await inspectDigitalSilence(directory, segment)).toBeNull();
    expect(lengths).toEqual([44, 65536]);
  });
  it('短い読み取りを繰り返しても末尾の非ゼロサンプルを見落とさない', async () => {
    const { directory, metadata } = await storedSession();
    const pcm = Buffer.alloc(3840); pcm.writeInt16LE(-1, pcm.length - 2);
    const segment = await addWav(directory, metadata, pcm);
    const realOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const read = handle.read.bind(handle) as (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }>;
      vi.spyOn(handle, 'read').mockImplementation(async (...args: unknown[]) => {
        const [buffer, offset, length, position] = args as [Buffer, number, number, number];
        return read(buffer, offset, Math.min(length, 7), position);
      });
      return handle;
    });
    expect(await inspectDigitalSilence(directory, segment)).toBeNull();
    await cleanupSilentSegments(directory, metadata);
    expect(metadata.savedFiles).toBe(1); expect(metadata.silenceCleanup?.deletedSegments).toBe(0);
  });
  it('未確定・partial・mix・metadata・範囲外・symlinkを削除しない', async () => {
    const { directory, metadata, cfg } = await storedSession();
    const segment = await addWav(directory, metadata, Buffer.alloc(4));
    segment.complete = false;
    await fs.writeFile(join(directory, segment.file + '.partial'), Buffer.alloc(4));
    await cleanupSilentSegments(directory, metadata);
    expect((await fs.lstat(join(directory, segment.file))).isFile()).toBe(true);
    expect((await fs.lstat(join(directory, segment.file + '.partial'))).isFile()).toBe(true);
    for (const file of [segment.file + '.partial', 'exports/mix.wav', 'metadata.json', '../../escape.wav']) {
      await expect(inspectDigitalSilence(directory, { ...segment, complete: true, file })).rejects.toThrow();
    }
    segment.complete = true;
    const outside = join(cfg.root, 'outside.wav');
    await fs.rename(join(directory, segment.file), outside);
    await fs.symlink(outside, join(directory, segment.file));
    await expect(inspectDigitalSilence(directory, segment)).rejects.toThrow();
    expect((await fs.lstat(outside)).size).toBe(48);
    await fs.unlink(join(directory, segment.file));
    await fs.unlink(join(directory, segment.file + '.partial'));
    await fs.rmdir(join(directory, 'users', A));
    await fs.symlink(cfg.root, join(directory, 'users', A));
    await expect(inspectDigitalSilence(directory, segment)).rejects.toThrow('ディレクトリ');
  });
});

describe('終了処理、保存統計、混合音声、復旧', () => {
  it('複数ユーザーと同一ユーザーの無音・有音混在を整理し、元の時刻に混合する', async () => {
    const f = fixture();
    f.options.decoderFactory = () => ({ decode: (packet) => {
      const pcm = Buffer.alloc(3840); if (packet[0]) pcm.writeInt16LE(packet[0]!); return pcm;
    }, delete() {} });
    const session = await new SessionManager(await config()).start(f.options);
    f.clock.now = 100; f.voice.callbacks!.packet(A, Buffer.from([0])); f.voice.callbacks!.packet(B, Buffer.from([0]));
    f.clock.now = 1000; f.voice.callbacks!.packet(A, Buffer.from([1])); f.voice.callbacks!.packet(B, Buffer.from([2]));
    f.clock.now = 1500; await session.stop();
    const metadata = await load(session.directory!);
    expect(metadata.state).toBe('completed'); expect(metadata.savedFiles).toBe(2); expect(metadata.savedBytes).toBe(7768);
    expect(metadata.silenceCleanup).toMatchObject({ deletedSegments: 2, deletedBytes: 7768 });
    expect(metadata.segments.map((s) => s.startOffsetMs)).toEqual([980, 980]);
    expect(metadata.segments.map((s) => s.endOffsetMs)).toEqual([1000, 1000]);
    expect(metadata.durationMs).toBe(1500);
    for (const user of [A, B]) {
      expect(metadata.users[user]).toMatchObject({ segments: 1, audioDurationMs: 20, savedSamples: 960, bytes: 3884, packets: 2, decodeSuccesses: 2 });
      await absent(join(session.directory!, `users/${user}/segment-0001.wav`));
      expect((await fs.lstat(join(session.directory!, `users/${user}/segment-0002.wav`))).isFile()).toBe(true);
    }
    const mix = await fs.readFile(join(session.directory!, 'exports/mix.wav'));
    expect(mix.length).toBe(44 + 1500 * 192);
    expect(mix.subarray(44, 44 + 980 * 192).every((byte) => byte === 0)).toBe(true);
    expect(mix.readInt16LE(44 + 980 * 192)).toBe(2);
    expect(mix.readInt16LE(44 + 1000 * 192)).toBe(0);
    for (const segment of metadata.segments) expect((await fs.lstat(join(session.directory!, segment.file))).isFile()).toBe(true);
  });
  it('全セグメントが無音でも正常終了して会議長の混合WAVを生成する', async () => {
    const f = fixture(); f.options.decoderFactory = () => ({ decode: () => Buffer.alloc(3840), delete() {} });
    const session = await new SessionManager(await config()).start(f.options);
    f.clock.now = 100; f.voice.emit(A); f.voice.emit(B);
    f.clock.now = 200; const stop = session.stop(); expect(session.stop()).toBe(stop); await stop;
    expect(session.metadata.state).toBe('completed'); expect(session.metadata.segments).toEqual([]);
    expect(session.metadata.savedFiles).toBe(0); expect(session.metadata.savedBytes).toBe(0);
    expect(session.metadata.exportFile).toBe('exports/mix.wav');
    const mix = await fs.readFile(join(session.directory!, 'exports/mix.wav'));
    expect(mix.length).toBe(38444); expect(mix.subarray(44).every((byte) => byte === 0)).toBe(true);
    expect(session.metadata.silenceCleanup?.deletedSegments).toBe(2);
  });
  it('一方のギルドの無音削除が別ギルドの音声と状態に影響しない', async () => {
    const manager = new SessionManager(await config()); const f = fixture([A]); const g = fixture([B]);
    f.options.decoderFactory = () => ({ decode: () => Buffer.alloc(3840), delete() {} }); g.options.guildId = C;
    const [s, t] = await Promise.all([manager.start(f.options), manager.start(g.options)]);
    f.clock.now = 100; g.clock.now = 100; f.voice.emit(A); g.voice.emit(B);
    await s.stop(); expect(t.metadata.state).toBe('recording'); await t.stop();
    expect(s.metadata.savedFiles).toBe(0); expect(t.metadata.savedFiles).toBe(1);
    expect(t.metadata.silenceCleanup?.deletedSegments).toBe(0);
    expect((await fs.lstat(join(t.directory!, t.metadata.segments[0]!.file))).isFile()).toBe(true);
  });
  it('実Opusデコードで生じた非ゼロPCMをWAV生成後も保持する', async () => {
    const { directory, metadata } = await storedSession();
    const encoder = new Opus.OpusEncoder(48000, 2); const decoder = createDecoder();
    try {
      const pcm = Buffer.alloc(3840);
      for (let frame = 0; frame < 960; frame++) {
        pcm.writeInt16LE(Math.round(Math.sin(frame * Math.PI / 24) * 8), frame * 4);
      }
      const decoded = decoder.decode(encoder.encode(pcm));
      expect(decoded.some((byte) => byte !== 0)).toBe(true);
      const segment = await addWav(directory, metadata, decoded);
      await cleanupSilentSegments(directory, metadata);
      expect(metadata.savedFiles).toBe(1);
      expect((await fs.lstat(join(directory, segment.file))).isFile()).toBe(true);
    } finally { decoder.delete(); }
  });
  it('削除前のメタデータ保存失敗ではファイルを一切削除しない', async () => {
    const { directory, metadata } = await storedSession();
    const segment = await addWav(directory, metadata, Buffer.alloc(3840));
    vi.spyOn(storage, 'atomicJson').mockRejectedValueOnce(new Error('save failed'));
    await expect(cleanupSilentSegments(directory, metadata)).rejects.toThrow('save failed');
    expect((await fs.lstat(join(directory, segment.file))).size).toBe(segment.bytes);
    expect(metadata.segments).toEqual([segment]); expect(metadata.savedFiles).toBe(1);
    await cleanupSilentSegments(directory, metadata);
    expect(metadata.savedFiles).toBe(0);
  });
  it('unlink失敗を記録して参照を保持し、復旧の再実行で一度だけ削除する', async () => {
    const { directory, metadata } = await storedSession();
    const segment = await addWav(directory, metadata, Buffer.alloc(3840));
    vi.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('unlink failed'));
    await cleanupSilentSegments(directory, metadata);
    expect(metadata.silenceCleanup?.entries[0]).toMatchObject({ state: 'pending', error: 'delete_failed' });
    expect(metadata.savedFiles).toBe(1); expect(metadata.segments).toEqual([segment]);
    expect((await fs.lstat(join(directory, segment.file))).size).toBe(segment.bytes);
    await expect(exportMix(directory, metadata)).rejects.toThrow('復旧');
    const recovered = await load(directory); await cleanupSilentSegments(directory, recovered, true);
    await cleanupSilentSegments(directory, recovered, true);
    expect(recovered.savedFiles).toBe(0); expect(recovered.savedBytes).toBe(0);
    expect(recovered.silenceCleanup).toMatchObject({ deletedSegments: 1, deletedBytes: 3884 });
    expect(recovered.users[A]).toMatchObject({ segments: 0, savedSamples: 0, bytes: 0, audioDurationMs: 0, packets: 1 });
  });
  it('削除後の保存失敗を検出し、ディスク上のpending記録から参照と統計を回復する', async () => {
    const { directory, metadata } = await storedSession();
    const silent = await addWav(directory, metadata, Buffer.alloc(3840));
    const pcm = Buffer.alloc(3840); pcm.writeInt16LE(-1);
    const voiced = await addWav(directory, metadata, pcm, B, 980);
    const realSave = storage.atomicJson;
    vi.spyOn(storage, 'atomicJson').mockImplementationOnce(realSave).mockRejectedValueOnce(new Error('final save failed'));
    await expect(cleanupSilentSegments(directory, metadata)).rejects.toThrow('final save failed');
    await absent(join(directory, silent.file));
    const interrupted = await load(directory);
    expect(interrupted.segments).toHaveLength(2); expect(interrupted.silenceCleanup?.entries[0]?.state).toBe('pending');
    await expect(exportMix(directory, interrupted)).rejects.toThrow('復旧');
    await cleanupSilentSegments(directory, interrupted, true);
    expect(interrupted.segments).toEqual([voiced]); expect(interrupted.savedBytes).toBe(3884);
    await cleanupSilentSegments(directory, interrupted, true);
    expect(await load(directory)).toEqual(interrupted);
    expect(interrupted.silenceCleanup).toMatchObject({ deletedSegments: 1, deletedBytes: 3884 });
    await exportMix(directory, interrupted);
    const mix = await fs.readFile(join(directory, 'exports/mix.wav'));
    expect(mix.readInt16LE(44 + 980 * 192)).toBe(-1);
  });
  it('unlink後のディレクトリsync失敗もpendingとして検出・復旧する', async () => {
    const { directory, metadata } = await storedSession();
    const segment = await addWav(directory, metadata, Buffer.alloc(3840));
    vi.spyOn(storage, 'syncDirectory').mockRejectedValueOnce(new Error('directory sync failed'));
    await cleanupSilentSegments(directory, metadata);
    await absent(join(directory, segment.file));
    expect(metadata.silenceCleanup?.entries[0]).toMatchObject({ state: 'pending', error: 'delete_failed' });
    await cleanupSilentSegments(directory, metadata, true);
    expect(metadata.savedFiles).toBe(0); expect(metadata.segments).toEqual([]);
    expect(metadata.silenceCleanup?.deletedSegments).toBe(1);
  });
  it('削除予定を保存した後の更新や置換を検出し、非ゼロPCMを保持する', async () => {
    const { directory, metadata } = await storedSession();
    const segment = await addWav(directory, metadata, Buffer.alloc(3840));
    const realSave = storage.atomicJson;
    vi.spyOn(storage, 'atomicJson').mockImplementationOnce(async (...args) => {
      await realSave(...args);
      const pcm = Buffer.alloc(3840); pcm.writeInt16LE(1);
      await fs.writeFile(join(directory, segment.file), Buffer.concat([storage.wavHeader(pcm.length), pcm]));
    });
    await cleanupSilentSegments(directory, metadata);
    expect(metadata.silenceCleanup?.entries[0]).toMatchObject({ state: 'pending', error: 'file_changed' });
    await cleanupSilentSegments(directory, metadata, true);
    expect(metadata.savedFiles).toBe(1); expect(metadata.segments).toEqual([segment]);
    expect((await fs.readFile(join(directory, segment.file))).readInt16LE(44)).toBe(1);
  });
  it('セッションの削除失敗を通知し、混合を開始せず復旧可能な記録を保存する', async () => {
    const f = fixture([A]); f.options.decoderFactory = () => ({ decode: () => Buffer.alloc(3840), delete() {} });
    const session = await new SessionManager(await config()).start(f.options);
    f.clock.now = 100; f.voice.emit(A);
    vi.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('denied'));
    await session.stop();
    expect(session.metadata.state).toBe('failed'); expect(session.active).toBe(false);
    expect(session.metadata.errorCode).toBe('silence_cleanup_error');
    expect(session.metadata.exportFile).toBeNull(); expect(session.metadata.exportError).toBe('silence_cleanup_pending');
    expect(f.notices.at(-1)).toContain('混合出力に失敗');
    const persisted = await load(session.directory!);
    expect(persisted.silenceCleanup?.entries[0]).toMatchObject({ state: 'pending', error: 'delete_failed' });
    await cleanupSilentSegments(session.directory!, persisted, true);
    expect(persisted.savedFiles).toBe(0);
  });
  it('セッションの削除後保存失敗を成功扱いせず、最終保存で参照の不整合を解消する', async () => {
    const f = fixture([A]); f.options.decoderFactory = () => ({ decode: () => Buffer.alloc(3840), delete() {} });
    const session = await new SessionManager(await config()).start(f.options);
    f.clock.now = 100; f.voice.emit(A);
    const realSave = storage.atomicJson;
    let failed = false;
    vi.spyOn(storage, 'atomicJson').mockImplementation(async (directory, value) => {
      const metadata = value as Metadata;
      if (!failed && metadata.state === 'stopping' && metadata.silenceCleanup?.deletedSegments === 1) {
        failed = true; throw new Error('save failed after unlink');
      }
      await realSave(directory, value);
    });
    await session.stop();
    expect(failed).toBe(true); expect(session.metadata.state).toBe('failed');
    expect(session.metadata.errorCode).toBe('silence_cleanup_error'); expect(session.metadata.exportFile).toBeNull();
    const persisted = await load(session.directory!);
    expect(persisted.segments).toEqual([]); expect(persisted.savedFiles).toBe(0);
    expect(persisted.silenceCleanup?.deletedSegments).toBe(1);
    await cleanupSilentSegments(session.directory!, persisted, true);
    expect(persisted.savedBytes).toBe(0);
  });
  it('同じセッションへの並行削除を拒否し、統計を二重更新しない', async () => {
    const { directory, metadata } = await storedSession();
    await addWav(directory, metadata, Buffer.alloc(3840));
    const first = cleanupSilentSegments(directory, metadata);
    await expect(cleanupSilentSegments(directory, metadata)).rejects.toThrow('重複');
    await first; expect(metadata.silenceCleanup?.deletedSegments).toBe(1); expect(metadata.savedBytes).toBe(0);
  });
  it('復旧CLIで途中削除を回復して混合CLIへ渡し、削除記録のない過去セッションは拒否する', async () => {
    const { directory, metadata, cfg } = await storedSession();
    const silent = await addWav(directory, metadata, Buffer.alloc(3840));
    const pcm = Buffer.alloc(3840); pcm.writeInt16LE(1);
    await addWav(directory, metadata, pcm, B, 980);
    const realUnlink = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).unlink;
    vi.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('interrupted'));
    await cleanupSilentSegments(directory, metadata);
    await realUnlink(join(directory, silent.file)); // 保存済みpendingのまま削除後に停止した状況
    const tsx = createRequire(import.meta.url).resolve('tsx/cli');
    const run = (script: string, data: Metadata, root: string) => promisify(execFile)(process.execPath,
      [tsx, join(import.meta.dirname, '..', 'src', script), data.guildId, data.sessionId],
      { env: { ...process.env, RECORDINGS_DIR: root } });
    const result = await run('recover-silence-cli.ts', metadata, cfg.root);
    expect(JSON.parse(result.stdout)).toMatchObject({ event: 'silence_cleanup_recovered', deletedSegments: 1, deletedBytes: 3884 });
    const recovered = await load(directory);
    expect(recovered.state).toBe('failed'); expect(recovered.errorCode).toBe('interrupted_stop');
    expect(recovered.segments).toHaveLength(1); expect(recovered.savedFiles).toBe(1);
    await run('recover-silence-cli.ts', metadata, cfg.root);
    const exported = await run('export-cli.ts', recovered, cfg.root);
    expect(JSON.parse(exported.stdout).event).toBe('mix_exported');
    const mix = await fs.readFile(join(directory, 'exports/mix.wav'));
    expect(mix.readInt16LE(44 + 980 * 192)).toBe(1);
    const old = await storedSession(); old.metadata.state = 'completed';
    const oldSegment = await addWav(old.directory, old.metadata, Buffer.alloc(3840));
    await storage.atomicJson(old.directory, old.metadata);
    await expect(run('recover-silence-cli.ts', old.metadata, old.cfg.root)).rejects.toMatchObject({ code: 1 });
    expect((await fs.lstat(join(old.directory, oldSegment.file))).isFile()).toBe(true);
  });
  it('復旧モードで過去の無音を新たに削除せず、録音中・保存先違い・壊れた記録を拒否する', async () => {
    const { directory, metadata } = await storedSession();
    const segment = await addWav(directory, metadata, Buffer.alloc(3840));
    await cleanupSilentSegments(directory, metadata, true);
    expect(metadata.silenceCleanup).toBeUndefined();
    expect((await fs.lstat(join(directory, segment.file))).isFile()).toBe(true);
    metadata.state = 'recording'; await expect(cleanupSilentSegments(directory, metadata)).rejects.toThrow('終了');
    metadata.state = 'stopping'; await expect(cleanupSilentSegments(join(directory, 'wrong'), metadata)).rejects.toThrow('保存先');
    metadata.silenceCleanup = { version: 1, entries: [{ segment, identity: { dev: 0, ino: 0, size: 1, mtimeMs: 0, ctimeMs: 0 }, state: 'pending' }], retained: [], deletedSegments: 0, deletedBytes: 0 };
    await expect(cleanupSilentSegments(directory, metadata, true)).rejects.toThrow('不正');
    expect((await fs.lstat(join(directory, segment.file))).isFile()).toBe(true);
  });
});
