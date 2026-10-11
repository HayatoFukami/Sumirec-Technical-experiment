import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Metadata, Segment } from './model.js';
import { contained, sessionId, snowflake, syncDirectory } from './storage.js';

export function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export async function existingSession(root: string, guild: string, session: string): Promise<string> {
  snowflake(guild); sessionId(session);
  let directory = resolve(root);
  for (const part of ['', guild, session]) {
    if (part) directory = join(directory, part);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('保存ディレクトリが不正です。');
  }
  return realpath(directory);
}
export async function readJson(directory: string, file: string): Promise<unknown> {
  const path = contained(directory, file);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16_777_216) throw new Error('JSONファイルが不正です。');
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally { await handle.close(); }
}
export async function writeArtifact(directory: string, name: string, value: unknown, markdown = false): Promise<void> {
  if (!/^[a-zA-Z0-9-]+\.(json|md)$/.test(name)) throw new Error('成果物名が不正です。');
  const temporary = join(directory, `${name}.${randomUUID()}.partial`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(markdown ? String(value) : JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, join(directory, name));
  await syncDirectory(directory);
}
export async function withProcessingLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const path = join(directory, '.processing.lock');
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const vadLock = await lstat(join(directory, '.vad.lock')).catch((e: unknown) => {
      if (record(e) && e.code === 'ENOENT') return undefined;
      throw e;
    });
    if (vadLock) throw new Error('VAD分類・復旧が終了してから実行してください。');
    return await work();
  } finally { await handle.close(); await unlink(path); }
}
export async function loadRecording(directory: string, guild: string, session: string): Promise<Metadata> {
  const input = await readJson(directory, 'metadata.json');
  if (!record(input) || input.guildId !== guild || input.sessionId !== session || !['completed', 'failed'].includes(String(input.state)) ||
    !Array.isArray(input.segments) || input.segments.length > 10_000 || !record(input.format) || input.format.sampleRate !== 48_000 || input.format.channels !== 2 || input.format.container !== 'WAV' || input.format.encoding !== 'PCM_S16LE' ||
    !Number.isFinite(input.durationMs) || Number(input.durationMs) < 0 || Number(input.durationMs) > 3_601_000) throw new Error('終了済みの録音メタデータが必要です。');
  if (record(input.vad) && (input.vad.state === 'processing' || !Array.isArray(input.vad.moves) || input.vad.moves.some(m => !record(m) || m.state === 'pending'))) throw new Error('VAD分類の復旧が必要です。');
  if (record(input.silenceCleanup) && (!Array.isArray(input.silenceCleanup.entries) || input.silenceCleanup.entries.some(e => !record(e) || e.state === 'pending'))) throw new Error('旧削除処理の復旧が必要です。');
  const seen = new Set<string>();
  for (const s of input.segments) {
    if (!record(s) || typeof s.userId !== 'string' || typeof s.file !== 'string' || typeof s.complete !== 'boolean' ||
      !Number.isSafeInteger(s.samples) || Number(s.samples) < 0 || !Number.isSafeInteger(s.bytes) ||
      !Number.isFinite(s.startOffsetMs) || Number(s.startOffsetMs) < 0 || !Number.isFinite(s.endOffsetMs) ||
      Math.abs(Number(s.endOffsetMs) - Number(s.startOffsetMs) - Number(s.samples) / 48) > 0.01 || Number(s.endOffsetMs) > 3_601_000 || seen.has(s.file)) throw new Error('録音セグメントが不正です。');
    snowflake(s.userId); seen.add(s.file);
    if (s.vad !== undefined && (!record(s.vad) || !['speech', 'non-speech', 'unclassified'].includes(String(s.vad.classification)) || typeof s.vad.completed !== 'boolean')) throw new Error('VAD分類が不正です。');
  }
  return input as unknown as Metadata;
}
export function segmentIdentity(s: Segment): string { return `${s.userId}:${s.file.split('/').at(-1)}`; }
export function escapeMarkdown(text: string): string { return text.replace(/[\\`*_{}\[\]<>()#!|]/g, '\\$&').replace(/\r?\n/g, ' '); }
