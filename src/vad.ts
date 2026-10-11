import { constants, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { link, lstat, open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { segmentHandle, segmentPath, validateSegmentWav } from './export.js';
import { vadConfig, type VadConfig } from './config.js';
import type { Metadata, Segment, VadResult } from './model.js';
import { atomicJson, privateDirectory, sessionId, snowflake, syncDirectory } from './storage.js';
import { detectSpeech, VadError, VAD_MODEL, VAD_MODEL_SHA256, VAD_RUNTIME, type VadDetector } from './vad-engine.js';

type Journal = NonNullable<Metadata['vad']>;
type Move = Journal['moves'][number];
const running = new Set<string>();
export async function hashFile(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  for (let position = 0;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
  }
  return hash.digest('hex');
}
function same(stat: Stats, move: Pick<Move, 'dev' | 'ino' | 'size'>): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.dev === move.dev && stat.ino === move.ino && stat.size === move.size;
}
async function exists(path: string): Promise<Stats | undefined> {
  return lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
}
function summarize(metadata: Metadata): void {
  const vad = metadata.vad!;
  vad.speechFiles = vad.nonSpeechFiles = vad.unclassifiedFiles = 0;
  vad.errors = vad.error ? 1 : 0;
  for (const segment of metadata.segments) {
    const result = segment.vad;
    if (result?.classification === 'speech') vad.speechFiles++;
    else if (result?.classification === 'non-speech') vad.nonSpeechFiles++;
    else vad.unclassifiedFiles++;
    if (result?.error && !['disabled', 'incomplete'].includes(result.error)) vad.errors++;
  }
  vad.state = vad.error || vad.errors || vad.moves.some((m) => m.state === 'pending') ? 'failed' : 'completed';
}
function newJournal(config: VadConfig): Journal {
  return { version: 1, model: VAD_MODEL, modelSha256: VAD_MODEL_SHA256, runtime: VAD_RUNTIME,
    config: { ...config }, state: 'processing', speechFiles: 0, nonSpeechFiles: 0, unclassifiedFiles: 0, errors: 0, moves: [] };
}
export function markClassificationFailure(metadata: Metadata, config: VadConfig): void {
  metadata.vad ??= newJournal(config);
  metadata.vad.error ??= 'classification_error';
  for (const segment of metadata.segments) segment.vad ??= { classification: 'unclassified', completed: false, ranges: [], error: metadata.vad.error };
  summarize(metadata);
}
async function inspectMoveFile(directory: string, segment: Segment, file: string, move: Move): Promise<Stats | undefined> {
  const path = await segmentPath(directory, { ...segment, file });
  const stat = await exists(path);
  if (!stat) return;
  if (!same(stat, move)) throw new Error('移動対象が変更されています。');
  const handle = await segmentHandle(directory, { ...segment, file });
  try {
    if (!same(await handle.stat(), move) || await hashFile(handle) !== move.sha256 || !same(await lstat(path), move)) throw new Error('移動対象の内容が一致しません。');
  } finally { await handle.close(); }
  return stat;
}
// linkは宛先が存在すると必ず失敗する。同一inodeを照合してから元の名前だけ除く。
// pendingを先行保存するため、両方の名前が残った途中状態も再実行で回収できる。
async function finishMove(directory: string, segment: Segment, move: Move): Promise<void> {
  if (!new RegExp(`^users/${segment.userId}/segment-\\d{4,5}\\.wav$`).test(move.from) || move.from === move.to ||
    move.userId !== segment.userId || !['speech', 'non-speech', 'unclassified'].includes(move.result.classification) ||
    move.to !== `users/${segment.userId}/${move.result.classification}/${basename(move.from)}` ||
    ![move.from, move.to].includes(segment.file) || !/^[a-f0-9]{64}$/.test(move.sha256)) throw new Error('分類移動記録が不正です。');
  await privateDirectory(directory, ['users', segment.userId, move.result.classification]);
  const from = await segmentPath(directory, { ...segment, file: move.from });
  const to = await segmentPath(directory, { ...segment, file: move.to });
  let source = await inspectMoveFile(directory, segment, move.from, move);
  let destination = await inspectMoveFile(directory, segment, move.to, move);
  if (!source && !destination) throw new Error('移動ファイルがありません。');
  if (!destination) {
    await link(from, to); // 上書き・コピー・ファイル内容変更なし。
    destination = await inspectMoveFile(directory, segment, move.to, move);
    if (!destination) throw new Error('移動先を確認できません。');
  }
  // 既存の移動先も、link直後・sync前に停止した可能性がある。
  await syncDirectory(dirname(to));
  if (source) {
    source = await inspectMoveFile(directory, segment, move.from, move);
    if (!source) throw new Error('移動元が変更されました。');
    await unlink(from);
    await syncDirectory(dirname(from));
  }
  segment.file = move.to;
  segment.vad = { ...move.result, sha256: move.sha256 };
  move.state = 'moved';
}

/** recoverOnlyでは既存のpendingだけ回収。旧録音やsilenceCleanupは変更しない。 */
export async function classifySegments(directory: string, metadata: Metadata, config: VadConfig = vadConfig({}),
  detector: VadDetector = detectSpeech, recoverOnly = false): Promise<void> {
  directory = resolve(directory);
  if (!['stopping', 'completed', 'failed'].includes(metadata.state) || !metadata.endedAt ||
    basename(directory) !== sessionId(metadata.sessionId) || basename(dirname(directory)) !== snowflake(metadata.guildId) ||
    !Array.isArray(metadata.segments) || metadata.segments.length > 10_000) throw new Error('分類対象のセッションが不正です。');
  if (running.has(directory)) throw new Error('VAD分類処理が重複しています。');
  running.add(directory);
  let lock: FileHandle | undefined;
  try {
    for (const parent of [directory, dirname(directory), dirname(dirname(directory))]) {
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('保存先のsymlinkは禁止です。');
    }
    lock = await open(join(directory, '.vad.lock'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await lock.writeFile(String(process.pid)); await lock.sync();
    if (metadata.silenceCleanup && !metadata.vad) throw new Error('旧無音削除セッションは分類対象にしません。');
    if (recoverOnly && !metadata.vad) throw new Error('VAD移動記録がありません。');
    metadata.vad ??= newJournal(config);
    const journal = metadata.vad;
    if (journal.version !== 1 || !Array.isArray(journal.moves) || journal.moves.length > 10_000) throw new Error('VAD移動記録が不正です。');
    const save = async () => {
      try { await atomicJson(directory, metadata); }
      catch (error) { journal.state = 'failed'; journal.error = 'metadata_write_error'; throw error; }
    };
    config = journal.config; // 再実行で適用設定を書き換えない。
    const files = new Set<string>();
    for (const segment of metadata.segments) {
      snowflake(segment.userId);
      if (files.has(segment.file)) throw new Error('セグメント参照が重複しています。');
      files.add(segment.file);
    }
    const journalFiles = new Set<string>();
    for (const move of journal.moves) {
      if (journalFiles.has(move.from) || journalFiles.has(move.to)) throw new Error('移動記録が重複しています。');
      journalFiles.add(move.from); journalFiles.add(move.to);
    }
    for (const move of journal.moves) {
      if (!['pending', 'moved'].includes(move.state)) throw new Error('移動状態が不正です。');
      const segment = metadata.segments.find((s) => s.userId === move.userId && [move.from, move.to].includes(s.file));
      if (!segment) throw new Error('移動対象の参照がありません。');
      if (move.state === 'pending') {
        try { await finishMove(directory, segment, move); }
        catch { segment.vad = { classification: 'unclassified', completed: false, ranges: [], error: 'move_error' }; }
        await save();
      }
    }
    if (!recoverOnly) for (const segment of metadata.segments) {
      if (segment.vad || journal.moves.some((m) => m.userId === segment.userId && [m.from, m.to].includes(segment.file))) continue;
      let handle: FileHandle | undefined;
      let stat: Stats | undefined;
      let sha256: string | undefined;
      let result: VadResult = { classification: 'unclassified', completed: false, ranges: [] };
      try {
        handle = await segmentHandle(directory, segment);
        stat = await handle.stat();
        if (!stat.isFile()) throw new Error('Not a regular file');
        sha256 = await hashFile(handle);
        try {
          if (!segment.complete) result.error = 'incomplete';
          else if (!config.enabled) result.error = 'disabled';
          else {
            await validateSegmentWav(handle, segment);
            const ranges = await detector(handle, segment, config).catch((error: unknown) => { throw error instanceof VadError ? error : new VadError('inference_error'); });
            if (ranges.some((r) => !Number.isFinite(r.startMs) || !Number.isFinite(r.endMs) || r.startMs < 0 || r.endMs <= r.startMs || r.endMs > segment.durationMs + 0.001)) throw new VadError('inference_error');
            result = { classification: ranges.length ? 'speech' : 'non-speech', completed: true, ranges };
          }
        } catch (error) { result.error = error instanceof VadError ? error.category : 'wav_read_error'; }
        const after = await handle.stat();
        if (!same(after, stat) || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || await hashFile(handle) !== sha256) throw new Error('File changed');
      } catch { result = { classification: 'unclassified', completed: false, ranges: [], error: 'wav_read_error' }; stat = undefined; }
      finally { await handle?.close(); }
      segment.vad = { ...result, ...(sha256 ? { sha256 } : {}) };
      if (stat && sha256) {
        const move: Move = { from: segment.file, to: `users/${segment.userId}/${result.classification}/${basename(segment.file)}`,
          userId: segment.userId, sha256, dev: stat.dev, ino: stat.ino, size: stat.size, result: segment.vad, state: 'pending' };
        // 既に分類パスで、移動記録がない不整合は元の場所に保持する。
        if (move.from === move.to || segment.file.split('/').length !== 3) {
          segment.vad = { classification: 'unclassified', completed: false, ranges: [], error: 'move_error', sha256 };
        } else {
          journal.moves.push(move);
          await save(); // 失敗したら移動しない。
          try { await finishMove(directory, segment, move); }
          catch { segment.vad = { classification: 'unclassified', completed: false, ranges: [], error: 'move_error', sha256 }; }
        }
      }
      summarize(metadata);
      await save();
    }
    summarize(metadata);
    await save();
  } catch (error) {
    if (metadata.vad) markClassificationFailure(metadata, config);
    throw error;
  } finally {
    try { if (lock) { await lock.close(); await unlink(join(directory, '.vad.lock')); } }
    finally { running.delete(directory); }
  }
}
