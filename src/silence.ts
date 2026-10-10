import { lstat, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { segmentHandle, segmentPath, validateSegmentWav } from './export.js';
import { FRAME_BYTES, type Metadata, type Segment } from './model.js';
import { atomicJson, sessionId, snowflake, syncDirectory } from './storage.js';

type Cleanup = NonNullable<Metadata['silenceCleanup']>;
type Identity = Cleanup['entries'][number]['identity'];
function identity(stat: Stats): Identity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
function sameFile(stat: Stats, expected: Identity): boolean {
  return stat.isFile() && !stat.isSymbolicLink() &&
    Object.entries(expected).every(([key, value]) => stat[key as keyof Identity] === value);
}
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

// 正常なPCM_S16LEでは全バイト0と全サンプル0は同値。ヘッダーは検査に含めない。
async function zeroPcm(handle: FileHandle, segment: Segment): Promise<boolean> {
  await validateSegmentWav(handle, segment);
  const buffer = Buffer.alloc(64 * 1024);
  for (let position = 44; position < segment.bytes;) {
    const count = Math.min(buffer.length, segment.bytes - position);
    const { bytesRead } = await handle.read(buffer, 0, count, position);
    if (bytesRead === 0) throw new Error('PCMが途中で切れています。');
    if (buffer.subarray(0, bytesRead).some((byte) => byte !== 0)) return false;
    position += bytesRead;
  }
  return true;
}

/** 判定不能は例外。呼び出し元は必ず保持する。非ゼロの発見で読み取りを終了する。 */
export async function inspectDigitalSilence(directory: string, segment: Segment): Promise<Identity | null> {
  if (!segment.complete) throw new Error('未確定のセグメントです。');
  const handle = await segmentHandle(directory, segment);
  try {
    const before = identity(await handle.stat());
    if (!await zeroPcm(handle, segment)) return null;
    if (!sameFile(await handle.stat(), before) ||
      !sameFile(await lstat(await segmentPath(directory, segment)), before)) throw new Error('検査中にファイルが変化しました。');
    return before;
  } finally { await handle.close(); }
}

function validateJournal(metadata: Metadata, cleanup: Cleanup): void {
  if (cleanup.version !== 1 || !Array.isArray(cleanup.entries) || cleanup.entries.length > 10_000 ||
    !Array.isArray(cleanup.retained)) throw new Error('無音削除記録が不正です。');
  const files = new Set<string>();
  for (const entry of cleanup.entries) {
    const segment = entry.segment;
    if (!segment || !segment.complete || !['pending', 'deleted'].includes(entry.state) ||
      !Number.isSafeInteger(segment.samples) || segment.samples < 0 || segment.bytes !== 44 + segment.samples * FRAME_BYTES ||
      !entry.identity || !['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => Number.isFinite(entry.identity[key as keyof Identity])) ||
      entry.identity.size !== segment.bytes || files.has(segment.file)) throw new Error('無音削除記録が不正です。');
    files.add(segment.file);
    const referenced = metadata.segments.find((s) => s.file === segment.file);
    if (referenced && JSON.stringify(referenced) !== JSON.stringify(segment)) throw new Error('無音削除記録とセグメントが一致しません。');
    if (entry.state === 'pending' && !referenced) throw new Error('削除予定の参照がありません。');
  }
}

function validateMetadata(metadata: Metadata): void {
  if (!Array.isArray(metadata.segments) || metadata.segments.length > 10_000 ||
    !metadata.users || typeof metadata.users !== 'object') throw new Error('セグメント情報が不正です。');
  const files = new Set<string>();
  for (const segment of metadata.segments) {
    if (!segment || typeof segment.file !== 'string' || typeof segment.complete !== 'boolean' ||
      !Number.isSafeInteger(segment.bytes) || segment.bytes < 0 ||
      !Number.isSafeInteger(segment.samples) || segment.samples < 0 ||
      !Number.isFinite(segment.durationMs) || segment.durationMs < 0 || files.has(segment.file) ||
      !metadata.users[segment.userId]) throw new Error('セグメント情報が不正です。');
    files.add(segment.file);
  }
  for (const metrics of Object.values(metadata.users)) {
    if (!metrics || typeof metrics !== 'object') throw new Error('保存統計が不正です。');
  }
}

function updateSavedMetrics(metadata: Metadata): void {
  const saved = metadata.segments.filter((segment) => segment.bytes >= 44);
  metadata.savedFiles = saved.length;
  metadata.savedBytes = saved.reduce((sum, segment) => sum + segment.bytes, 0);
  for (const [userId, metrics] of Object.entries(metadata.users)) {
    const segments = saved.filter((segment) => segment.userId === userId);
    metrics.segments = segments.length;
    metrics.bytes = segments.reduce((sum, segment) => sum + segment.bytes, 0);
    metrics.audioDurationMs = segments.reduce((sum, segment) => sum + segment.durationMs, 0);
    metrics.savedSamples = segments.reduce((sum, segment) => sum + segment.samples, 0);
  }
  const removed = metadata.silenceCleanup!.entries.filter((entry) => entry.state === 'deleted');
  metadata.silenceCleanup!.deletedSegments = removed.length;
  metadata.silenceCleanup!.deletedBytes = removed.reduce((sum, entry) => sum + entry.segment.bytes, 0);
}

const running = new Set<string>();
/** recoverOnlyは既に保存された削除予定だけを復旧し、過去ファイルの新規検査・削除はしない。 */
export async function cleanupSilentSegments(directory: string, metadata: Metadata, recoverOnly = false): Promise<void> {
  directory = resolve(directory);
  if (!['stopping', 'completed', 'failed'].includes(metadata.state) || !metadata.endedAt ||
    basename(directory) !== sessionId(metadata.sessionId) || basename(dirname(directory)) !== snowflake(metadata.guildId)) {
    throw new Error('終了処理後のセッション専用保存先ではありません。');
  }
  if (running.has(directory)) throw new Error('無音削除処理が重複しています。');
  running.add(directory);
  try {
    for (const part of [dirname(directory), directory]) {
      const stat = await lstat(part);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('セッション保存先が不正です。');
    }
    validateMetadata(metadata);
    if (!metadata.silenceCleanup) {
      if (recoverOnly) return;
      const cleanup: Cleanup = { version: 1, entries: [], retained: [], deletedSegments: 0, deletedBytes: 0 };
      for (const segment of metadata.segments) {
        if (!segment.complete) continue;
        try {
          const inspected = await inspectDigitalSilence(directory, segment);
          if (inspected) cleanup.entries.push({ segment: { ...segment }, identity: inspected, state: 'pending' });
        } catch { cleanup.retained.push({ file: segment.file, reason: 'inspection_failed' }); }
      }
      metadata.silenceCleanup = cleanup;
    }
    const cleanup = metadata.silenceCleanup;
    validateJournal(metadata, cleanup);
    // この保存に失敗した場合は一切削除しない。途中障害時の参照と復旧根拠を先に確定する。
    await atomicJson(directory, metadata);
    for (const entry of cleanup.entries) {
      if (entry.state === 'deleted') continue;
      let path: string;
      try { path = await segmentPath(directory, entry.segment); }
      catch { entry.error = 'inspection_failed'; continue; }
      const exists = await lstat(path).catch((error: unknown) => {
        if (missing(error)) return undefined;
        throw error;
      }).catch(() => null);
      if (exists === null) { entry.error = 'inspection_failed'; continue; }
      if (exists) {
        if (!sameFile(exists, entry.identity)) { entry.error = 'file_changed'; continue; }
        // 再実行時もPCMを再検査。置換・更新・読み取り失敗は保持する。
        let inspected: Identity | null;
        try { inspected = await inspectDigitalSilence(directory, entry.segment); }
        catch { entry.error = 'inspection_failed'; continue; }
        if (!inspected || !Object.entries(entry.identity).every(([key, value]) => inspected[key as keyof Identity] === value)) {
          entry.error = 'file_changed'; continue;
        }
        try {
          // 非同期検査後も保存先とファイルの同一性を確認する。
          if (!sameFile(await lstat(await segmentPath(directory, entry.segment)), entry.identity)) {
            entry.error = 'file_changed'; continue;
          }
          await unlink(path);
        } catch { entry.error = 'delete_failed'; continue; }
      }
      // 削除後のsync失敗からの再実行でも、参照を除く前にディレクトリを確定する。
      try { await syncDirectory(dirname(path)); }
      catch { entry.error = 'delete_failed'; continue; }
      // pendingでファイルだけが消えていれば、削除後の保存前に停止した処理を回収する。
      entry.state = 'deleted';
      delete entry.error;
      metadata.segments = metadata.segments.filter((segment) => segment.file !== entry.segment.file);
    }
    updateSavedMetrics(metadata);
    // 失敗してもディスク上のpending記録から復旧できる。後続の混合処理には失敗を返す。
    await atomicJson(directory, metadata);
  } finally { running.delete(directory); }
}
