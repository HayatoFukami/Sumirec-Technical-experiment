import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { vadConfig } from '../src/config.js';
import { exportMix } from '../src/export.js';
import { classifySegments } from '../src/vad.js';
import { VadError, type VadDetector } from '../src/vad-engine.js';
import { SpeechTracker, resampleFrame } from '../src/vad-worker.js';
import * as storage from '../src/storage.js';
import { RecordingSession, SessionManager } from '../src/session.js';
import type { Metadata, Segment } from '../src/model.js';
import { A, B, C, config, fixture } from './helpers.js';
import { addWav, storedSession } from './vad-helpers.js';
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), unlink: vi.fn(actual.unlink) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
afterEach(() => { vi.restoreAllMocks(); vi.mocked(fs.link).mockReset(); vi.mocked(fs.unlink).mockReset(); });
const enabled = vadConfig({});
async function load(directory: string): Promise<Metadata> { return JSON.parse(await fs.readFile(join(directory, 'metadata.json'), 'utf8')); }
const silent = async () => [];
const speech = async () => [{ startMs: 0, endMs: 10 }];

describe('VAD設定と発話区間', () => {
  it('環境変数の既定値と変更値を検出器へ渡す', async () => {
    expect(enabled).toEqual({ enabled: true, positiveThreshold: .4, negativeThreshold: .3, minSpeechMs: 100, redemptionMs: 200, preSpeechPadMs: 100, maxConcurrency: 1 });
    const cfg = vadConfig({ VAD_POSITIVE_THRESHOLD: '.7', VAD_NEGATIVE_THRESHOLD: '.2', VAD_MIN_SPEECH_MS: '5', VAD_REDEMPTION_MS: '64', VAD_PRE_SPEECH_PAD_MS: '32', VAD_MAX_CONCURRENCY: '4' });
    const { directory, metadata } = await storedSession(); await addWav(directory, metadata);
    const detector = vi.fn<VadDetector>(silent); await classifySegments(directory, metadata, cfg, detector);
    expect(detector.mock.calls[0]?.[2]).toEqual(cfg); expect(metadata.vad?.config).toEqual(cfg);
  });
  it.each([
    { VAD_ENABLED: '1' }, { VAD_POSITIVE_THRESHOLD: '' }, { VAD_POSITIVE_THRESHOLD: 'NaN' },
    { VAD_POSITIVE_THRESHOLD: '1.1' }, { VAD_NEGATIVE_THRESHOLD: '-.1' }, { VAD_NEGATIVE_THRESHOLD: '.4' },
    { VAD_MIN_SPEECH_MS: '-1' }, { VAD_MIN_SPEECH_MS: '1.1' }, { VAD_REDEMPTION_MS: '60001' },
    { VAD_PRE_SPEECH_PAD_MS: 'Infinity' }, { VAD_MAX_CONCURRENCY: '0' }, { VAD_MAX_CONCURRENCY: '5' },
  ])('不正設定を黙って補正しない：%j', (env) => { expect(() => vadConfig(env)).toThrow(/VAD_/); });
  it('しきい値、最小時間、終了猶予、開始余白が判定と区間へ作用する', () => {
    const cfg = { ...enabled, minSpeechMs: 64, redemptionMs: 64, preSpeechPadMs: 32 };
    const run = (overrides = {}) => {
      const t = new SpeechTracker({ ...cfg, ...overrides });
      [.1, .5, .5, .1, .1].forEach((p, i) => t.frame(p, i * 32, (i + 1) * 32));
      return t.finish(160);
    };
    expect(run()).toEqual([{ startMs: 0, endMs: 96 }]);
    expect(run({ positiveThreshold: .6 })).toEqual([]);
    expect(run({ minSpeechMs: 100 })).toEqual([]);
    expect(run({ preSpeechPadMs: 0 })).toEqual([{ startMs: 32, endMs: 96 }]);
    const t = new SpeechTracker({ ...cfg, redemptionMs: 64 });
    [.5, .5, .1, .35, .5, .1, .1].forEach((p, i) => t.frame(p, i * 32, (i + 1) * 32));
    expect(t.finish(224)).toEqual([{ startMs: 0, endMs: 160 }]);
  });
  it('末尾ゼロ埋めを実発話時間へ加算せず短い相づちを設定で判定する', () => {
    const t = new SpeechTracker({ ...enabled, minSpeechMs: 15 });
    t.frame(.9, 0, 20); expect(t.finish(20)).toEqual([{ startMs: 0, endMs: 20 }]);
    const rejected = new SpeechTracker(enabled); rejected.frame(.9, 0, 20); expect(rejected.finish(20)).toEqual([]);
  });
  it('モノラル化、Int16正規化、リサンプリングの時間・振幅・高域抑制を検証する', () => {
    const samples = 1536 + 62; const pcm = Buffer.alloc(samples * 4);
    for (let i = 0; i < samples; i++) { pcm.writeInt16LE(32767, i * 4); pcm.writeInt16LE(-32768, i * 4 + 2); }
    const mono = resampleFrame(pcm, 0, 0, samples);
    expect(mono.length).toBe(512); expect(mono[100]).toBeCloseTo(-1 / 65536, 8);
    const rms = (frequency: number) => {
      for (let i = 0; i < samples; i++) {
        const v = Math.round(Math.sin(i * 2 * Math.PI * frequency / 48000) * 16000);
        pcm.writeInt16LE(v, i * 4); pcm.writeInt16LE(v, i * 4 + 2);
      }
      const frame = resampleFrame(pcm, 0, 0, samples);
      return Math.sqrt(frame.slice(32).reduce((sum, v) => sum + v * v, 0) / 480);
    };
    expect(rms(1000)).toBeCloseTo(16000 / 32768 / Math.sqrt(2), 2);
    expect(rms(12000)).toBeLessThan(.003); // 正弦波は変換試験に限定。
  });
});

describe('非破壊分類と混合', () => {
  it('3分類・複数ユーザーを振り分け、内容・時刻・容量・混合のバイト一致を保持する', async () => {
    const { directory, metadata } = await storedSession();
    const segments = [await addWav(directory, metadata, Buffer.alloc(3840, 1)), await addWav(directory, metadata), await addWav(directory, metadata, Buffer.alloc(3840, 2), B)];
    const originals = await Promise.all(segments.map((s) => fs.readFile(join(directory, s.file))));
    const prior = structuredClone(metadata); await exportMix(directory, metadata);
    const mix = await fs.readFile(join(directory, 'exports/mix.wav')); await fs.rename(join(directory, 'exports/mix.wav'), join(directory, 'exports/before.wav'));
    const detector = vi.fn().mockResolvedValueOnce([{ startMs: 0, endMs: 10 }]).mockResolvedValueOnce([]).mockRejectedValueOnce(new VadError('inference_error'));
    const noDelete = vi.spyOn(fs, 'unlink');
    await classifySegments(directory, metadata, enabled, detector);
    expect(metadata.vad).toMatchObject({ speechFiles: 1, nonSpeechFiles: 1, unclassifiedFiles: 1, errors: 1, state: 'failed' });
    expect(metadata.savedBytes).toBe(prior.savedBytes); expect(metadata.savedFiles).toBe(3); expect(metadata.users).toEqual(prior.users); expect(metadata.durationMs).toBe(prior.durationMs);
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]!;
      expect(await fs.readFile(join(directory, s.file))).toEqual(originals[i]);
      expect({ ...s, file: prior.segments[i]!.file, vad: undefined }).toEqual({ ...prior.segments[i], vad: undefined });
    }
    expect(noDelete.mock.calls.every(([path]) => String(path).endsWith('.vad.lock') || prior.segments.some((s) => String(path) === join(directory, s.file)))).toBe(true);
    await exportMix(directory, metadata); expect(await fs.readFile(join(directory, 'exports/mix.wav'))).toEqual(mix);
    expect((await load(directory)).segments).toEqual(metadata.segments);
    expect(metadata.silenceCleanup).toBeUndefined();
    const repeated = vi.fn(silent); await classifySegments(directory, metadata, enabled, repeated); expect(repeated).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'corrupt', 'model_load_error', 'inference_error', 'timeout', 'incomplete'])('判定不能を保持する：%s', async (failure) => {
    const { directory, metadata } = await storedSession(); const segment = await addWav(directory, metadata);
    if (failure === 'corrupt') await fs.writeFile(join(directory, segment.file), Buffer.alloc(segment.bytes, 2));
    if (failure === 'incomplete') segment.complete = false;
    const before = await fs.readFile(join(directory, segment.file));
    const detector = vi.fn(async () => { throw new VadError(failure === 'model_load_error' ? 'model_load_error' : failure === 'timeout' ? 'timeout' : 'inference_error'); });
    await classifySegments(directory, metadata, { ...enabled, enabled: failure !== 'disabled' }, detector);
    expect(segment.vad?.classification).toBe('unclassified'); expect(segment.vad?.completed).toBe(false);
    expect(segment.file).toContain('/unclassified/'); expect(await fs.readFile(join(directory, segment.file))).toEqual(before);
    if (['disabled', 'corrupt', 'incomplete'].includes(failure)) expect(detector).not.toHaveBeenCalled();
  });
  it('不正な範囲・推論例外を発話検出なしとして扱わない', async () => {
    const { directory, metadata } = await storedSession(); const segment = await addWav(directory, metadata);
    await classifySegments(directory, metadata, enabled, async () => [{ startMs: 0, endMs: Infinity }]);
    expect(segment.vad?.error).toBe('inference_error');
  });
  it('既存宛先を上書きせず元WAVを残し、復旧前のmixを拒否する', async () => {
    const { directory, metadata } = await storedSession(); const segment = await addWav(directory, metadata);
    const original = segment.file; const target = await storage.privateDirectory(directory, ['users', A, 'speech']);
    await fs.writeFile(join(target, 'segment-0001.wav'), 'existing');
    await classifySegments(directory, metadata, enabled, speech);
    expect(segment.file).toBe(original); expect(segment.vad?.error).toBe('move_error');
    expect(await fs.readFile(join(target, 'segment-0001.wav'), 'utf8')).toBe('existing');
    expect((await fs.stat(join(directory, original))).size).toBe(segment.bytes);
    await expect(exportMix(directory, metadata)).rejects.toThrow('復旧');
  });
  it.each(['file', 'user', 'destination', 'root', 'escape'])('symlinkと範囲外アクセスを拒否して原音声を保持する：%s', async (kind) => {
    const { directory, metadata, cfg } = await storedSession(); const segment = await addWav(directory, metadata);
    const original = await fs.readFile(join(directory, segment.file));
    const safe = join(cfg.root, 'safe.wav'); await fs.writeFile(safe, original);
    if (kind === 'file') { await fs.rename(join(directory, segment.file), join(directory, 'original.wav')); await fs.symlink(safe, join(directory, segment.file)); }
    if (kind === 'user') { await fs.rename(join(directory, 'users', A), join(directory, 'users', 'backup')); await fs.symlink(cfg.root, join(directory, 'users', A)); }
    if (kind === 'destination') await fs.symlink(cfg.root, join(directory, 'users', A, 'speech'));
    if (kind === 'escape') segment.file = '../../safe.wav';
    if (kind === 'root') {
      const moved = `${cfg.root}-moved`; await fs.rename(cfg.root, moved); await fs.symlink(moved, cfg.root);
      try { await expect(classifySegments(directory, metadata, enabled, speech)).rejects.toThrow('symlink'); }
      finally { await fs.unlink(cfg.root); await fs.rename(moved, cfg.root); }
    } else await classifySegments(directory, metadata, enabled, speech);
    expect(await fs.readFile(safe)).toEqual(original);
    if (kind !== 'root') expect(segment.vad?.classification).toBe('unclassified');
  });
  it('読み取り不能・未確定partialでは元の場所に保持する', async () => {
    const { directory, metadata } = await storedSession(); const segment = await addWav(directory, metadata);
    const original = segment.file; await fs.rename(join(directory, original), join(directory, `${original}.partial`)); segment.complete = false;
    await classifySegments(directory, metadata, enabled, silent);
    expect(segment.file).toBe(original); expect(segment.vad?.error).toBe('wav_read_error');
    expect((await fs.stat(join(directory, `${original}.partial`))).size).toBe(segment.bytes);
  });
});

describe('移動ジャーナルと録音停止の統合', () => {
  it.each(['link', 'unlink', 'post-save', 'pre-save', 'dest-sync', 'source-sync'])('移動・保存失敗後にデータを保持し再実行で回収する：%s', async (failure) => {
    const { directory, metadata } = await storedSession(); const segment = await addWav(directory, metadata);
    const original = segment.file; const bytes = await fs.readFile(join(directory, original));
    if (failure === 'link') vi.spyOn(fs, 'link').mockRejectedValueOnce(new Error('denied'));
    if (failure === 'unlink') {
      const real = actualFs.unlink; let once = true;
      vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
        if (once && path === join(directory, original)) { once = false; throw new Error('denied'); }
        return real(path);
      });
    }
    if (failure.endsWith('sync')) {
      const real = storage.syncDirectory; let once = true;
      const target = failure === 'dest-sync' ? join(directory, 'users', A, 'speech') : join(directory, 'users', A);
      vi.spyOn(storage, 'syncDirectory').mockImplementation(async (path) => {
        if (once && path === target) { once = false; throw new Error('sync'); }
        return real(path);
      });
    }
    if (failure.includes('save')) {
      const real = storage.atomicJson; let once = true;
      vi.spyOn(storage, 'atomicJson').mockImplementation(async (dir, value) => {
        const m = value as Metadata;
        if (once && m.vad?.moves.length && m.vad.moves[0]?.state === (failure === 'pre-save' ? 'pending' : 'moved')) { once = false; throw new Error('disk'); }
        return real(dir, value);
      });
    }
    if (failure.includes('save')) await expect(classifySegments(directory, metadata, enabled, speech)).rejects.toThrow('disk');
    else await classifySegments(directory, metadata, enabled, speech);
    if (failure === 'pre-save') {
      expect(await fs.readFile(join(directory, original))).toEqual(bytes);
      await classifySegments(directory, metadata, enabled, speech);
    } else {
      const disk = await load(directory);
      if (failure === 'dest-sync') vi.mocked(storage.syncDirectory).mockClear();
      await classifySegments(directory, disk, enabled, undefined, true);
      if (failure === 'dest-sync') expect(storage.syncDirectory).toHaveBeenCalledWith(join(directory, 'users', A, 'speech'));
      expect(disk.vad?.moves[0]?.state).toBe('moved');
      expect(await fs.readFile(join(directory, disk.segments[0]!.file))).toEqual(bytes);
      expect(disk.savedFiles).toBe(1); expect(disk.savedBytes).toBe(bytes.length);
    }
  });
  it('独立した復旧CLIで移動後・保存前のpendingを回収する', async () => {
    const { directory, metadata, cfg } = await storedSession(); const segment = await addWav(directory, metadata);
    const before = await fs.readFile(join(directory, segment.file));
    const realSave = storage.atomicJson; let saved = false;
    vi.spyOn(storage, 'atomicJson').mockImplementation(async (dir, value) => {
      if (!saved && (value as Metadata).vad?.moves[0]?.state === 'moved') { saved = true; throw new Error('crash'); }
      return realSave(dir, value);
    });
    await expect(classifySegments(directory, metadata, enabled, speech)).rejects.toThrow('crash');
    const pending = await load(directory); expect(pending.vad?.moves[0]?.state).toBe('pending');
    const require = createRequire(import.meta.url);
    const result = await promisify(execFile)(process.execPath, [require.resolve('tsx/cli'), 'src/recover-vad-cli.ts', metadata.guildId, metadata.sessionId],
      { cwd: process.cwd(), env: { ...process.env, RECORDINGS_DIR: cfg.root } });
    expect(JSON.parse(result.stdout)).toMatchObject({ event: 'vad_moves_recovered', files: 1, bytes: before.length });
    const recovered = await load(directory);
    expect(recovered.vad?.moves[0]?.state).toBe('moved'); expect(recovered.state).toBe('failed'); expect(recovered.errorCode).toBe('interrupted_stop');
    expect(await fs.readFile(join(directory, recovered.segments[0]!.file))).toEqual(before);
    const other = await storedSession(); await addWav(other.directory, other.metadata); await realSave(other.directory, other.metadata);
    await expect(promisify(execFile)(process.execPath, [require.resolve('tsx/cli'), 'src/recover-vad-cli.ts', other.metadata.guildId, other.metadata.sessionId],
      { cwd: process.cwd(), env: { ...process.env, RECORDINGS_DIR: other.cfg.root } })).rejects.toMatchObject({ code: 1 });
    expect((await load(other.directory)).vad).toBeUndefined();
  });
  it('VADメタデータ保存の失敗と録音成功を分離し、最終保存で参照を確定する', async () => {
    const cfg = await config(); cfg.vad = enabled; const f = fixture([A]); f.options.vadDetector = speech;
    const session = await new SessionManager(cfg).start(f.options); f.clock.now = 100; f.voice.emit(A);
    const realSave = storage.atomicJson; let once = true;
    vi.spyOn(storage, 'atomicJson').mockImplementation(async (dir, value) => {
      if (once && (value as Metadata).vad?.moves[0]?.state === 'moved') { once = false; throw new Error('save'); }
      return realSave(dir, value);
    });
    await session.stop();
    expect(session.metadata.state).toBe('completed'); expect(session.metadata.errorCode).toBeNull();
    expect(session.metadata.vad).toMatchObject({ state: 'failed', error: 'metadata_write_error' });
    expect(session.metadata.exportFile).toBe('exports/mix.wav'); expect(f.notices.at(-1)).toContain('分類処理に失敗');
    const disk = await load(session.directory!); expect(disk.segments[0]!.file).toBe(session.metadata.segments[0]!.file);
    expect((await fs.stat(join(session.directory!, disk.segments[0]!.file))).size).toBe(disk.segments[0]!.bytes);
  });
  it('同じプロセス・別プロセスの競合を拒否する', async () => {
    const { directory, metadata } = await storedSession(); await addWav(directory, metadata);
    let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>((r) => { entered = r; }); const wait = new Promise<void>((r) => { release = r; });
    const first = classifySegments(directory, metadata, enabled, async () => { entered(); await wait; return []; });
    await ready; await expect(classifySegments(directory, metadata)).rejects.toThrow('重複'); release(); await first;
    await fs.writeFile(join(directory, '.vad.lock'), '99999');
    await expect(classifySegments(directory, metadata)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(join(directory, '.vad.lock'), 'utf8')).toBe('99999');
  });
  it('偽造・重複・同一パスのジャーナルから音声を消さない', async () => {
    const { directory, metadata } = await storedSession(); const segment = await addWav(directory, metadata);
    await classifySegments(directory, metadata, enabled, silent);
    const bytes = await fs.readFile(join(directory, segment.file)); const journal = metadata.vad!; const move = journal.moves[0]!;
    move.from = move.to; move.state = 'pending';
    await classifySegments(directory, metadata, enabled, undefined, true);
    expect(await fs.readFile(join(directory, segment.file))).toEqual(bytes); expect(move.state).toBe('pending');
    journal.moves.push(structuredClone(move));
    await expect(classifySegments(directory, metadata, enabled, undefined, true)).rejects.toThrow('重複');
    expect(await fs.readFile(join(directory, segment.file))).toEqual(bytes);
  });
  it.each(['mixed', 'silent', 'partial-error', 'disabled'])('録音停止→分類→全入力mix→通知を検証する：%s', async (kind) => {
    const cfg = await config(); cfg.vad = { ...enabled, enabled: kind !== 'disabled' }; const f = fixture();
    f.options.decoderFactory = () => ({ decode: (p) => Buffer.alloc(3840, p[0]!), delete() {} });
    f.options.vadDetector = vi.fn(async (_h, s: Segment) => {
      if (kind === 'partial-error' && s.userId === B) throw new VadError('inference_error');
      return kind === 'silent' || s.userId === B ? [] : [{ startMs: 0, endMs: 10 }];
    });
    const session = await new SessionManager(cfg).start(f.options);
    f.clock.now = 100; f.voice.callbacks!.packet(A, Buffer.from([0])); f.voice.callbacks!.packet(B, Buffer.from([1]));
    f.clock.now = 1000; f.voice.callbacks!.packet(A, Buffer.from([2])); f.voice.callbacks!.packet(B, Buffer.from([3]));
    f.clock.now = 1500; const stop = session.stop(); expect(session.stop()).toBe(stop); await stop;
    expect(session.metadata.state).toBe('completed'); expect(session.metadata.errorCode).toBeNull();
    expect(session.metadata.savedFiles).toBe(4); expect(session.metadata.savedBytes).toBe(15536);
    expect(session.metadata.segments.map((s) => s.startOffsetMs)).toEqual([80, 80, 980, 980]);
    expect(session.metadata.segments.map((s) => s.endOffsetMs)).toEqual([100, 100, 1000, 1000]);
    expect(session.metadata.durationMs).toBe(1500); expect(session.metadata.exportFile).toBe('exports/mix.wav');
    expect(session.metadata.silenceCleanup).toBeUndefined();
    const mix = await fs.readFile(join(session.directory!, 'exports/mix.wav'));
    expect(mix.readInt16LE(44 + 80 * 192)).toBe(129); expect(mix.readInt16LE(44 + 980 * 192)).toBe(643); expect(mix.length).toBe(44 + 1500 * 192);
    expect(f.notices.at(-1)).toContain('音声の自動削除は行いません');
    if (kind === 'partial-error') expect(session.metadata.vad?.state).toBe('failed');
    if (kind === 'disabled') expect(f.options.vadDetector).not.toHaveBeenCalled();
  });
  it('分類開始前のロック障害も失敗として記録し、WAVと混合を保持する', async () => {
    const f = fixture([A]); const session = await new SessionManager(await config()).start(f.options);
    await fs.writeFile(join(session.directory!, '.vad.lock'), 'other-process');
    f.clock.now = 100; f.voice.emit(A); await session.stop();
    expect(session.metadata.state).toBe('completed');
    expect(session.metadata.vad).toMatchObject({ state: 'failed', error: 'classification_error', unclassifiedFiles: 1 });
    expect(session.metadata.segments[0]!.vad?.classification).toBe('unclassified');
    expect(session.metadata.segments[0]!.file).toBe(`users/${A}/segment-0001.wav`);
    expect(session.metadata.exportFile).toBe('exports/mix.wav'); expect(f.notices.at(-1)).toContain('分類処理に失敗');
    expect(await fs.readFile(join(session.directory!, '.vad.lock'), 'utf8')).toBe('other-process');
  });
  it('複数ギルドの終了処理を独立して扱う', async () => {
    const cfg = await config(); cfg.vad = enabled; const manager = new SessionManager(cfg); const f = fixture([A]); const g = fixture([B]); g.options.guildId = C;
    f.options.vadDetector = speech; g.options.vadDetector = silent;
    const [s, t] = await Promise.all([manager.start(f.options), manager.start(g.options)]);
    f.clock.now = g.clock.now = 100; f.voice.emit(A); g.voice.emit(B);
    await Promise.all([s.stop(), t.stop()]);
    expect(s.metadata.vad?.speechFiles).toBe(1); expect(t.metadata.vad?.nonSpeechFiles).toBe(1);
    expect(s.metadata.guildId).not.toBe(t.metadata.guildId); expect(s.metadata.savedFiles).toBe(1); expect(t.metadata.savedFiles).toBe(1);
  });
  it('旧silenceCleanupを勝手に変更・復旧・再分類しない', async () => {
    const { directory, metadata } = await storedSession(); const segment = await addWav(directory, metadata);
    metadata.silenceCleanup = { version: 1, entries: [], retained: [], deletedSegments: 0, deletedBytes: 0 };
    const before = structuredClone(metadata);
    await expect(classifySegments(directory, metadata)).rejects.toThrow('旧無音');
    expect(metadata).toEqual(before); expect((await fs.stat(join(directory, segment.file))).size).toBe(segment.bytes);
    await exportMix(directory, metadata); // 旧パスも引き続き読み込める。
  });
});
