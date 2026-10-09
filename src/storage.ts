import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { FRAME_BYTES, SAMPLE_RATE } from './model.js';

export function snowflake(id: string): string {
  if (!/^[1-9]\d{16,19}$/.test(id)) throw new Error('Discord IDが不正です。');
  return id;
}
export function sessionId(id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new Error('セッションIDが不正です。');
  return id;
}
export function contained(root: string, file: string): string {
  if (isAbsolute(file)) throw new Error('絶対パスは指定できません。');
  const target = resolve(root, file);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('保存先の範囲外です。');
  return target;
}
// 設定ルートは管理者が所有する専用ディレクトリ。配下の既存symlinkを拒否する。
export async function privateDirectory(root: string, parts: string[]): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('保存ルートのsymlinkは禁止です。');
  let path = await realpath(root);
  for (const part of parts) {
    if (!/^[a-zA-Z0-9-]+$/.test(part)) throw new Error('ディレクトリ名が不正です。');
    path = join(path, part);
    await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    });
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('保存先が安全なディレクトリではありません。');
  }
  return path;
}
export async function atomicJson(directory: string, value: unknown): Promise<void> {
  const path = join(directory, 'metadata.json.partial');
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(path, join(directory, 'metadata.json'));
}
export function wavHeader(bytes: number): Buffer {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes % FRAME_BYTES !== 0 || bytes > 0xffffffff - 36) throw new Error('WAVサイズが不正です。');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + bytes, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22); header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * FRAME_BYTES, 28); header.writeUInt16LE(FRAME_BYTES, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes, 40);
  return header;
}
export async function writeFully(handle: FileHandle, data: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset, position + offset);
    if (bytesWritten === 0) throw new Error('書き込みが停止しました。');
    offset += bytesWritten;
  }
}
export class WavWriter {
  private bytes = 0;
  private closed = false;
  private constructor(private readonly handle: FileHandle, private readonly path: string) {}
  static async create(path: string): Promise<WavWriter> {
    const existing = await lstat(path).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) throw new Error('既存の音声ファイルは上書きできません。');
    const handle = await open(`${path}.partial`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await writeFully(handle, wavHeader(0), 0); }
    catch (error) { await handle.close(); throw error; }
    return new WavWriter(handle, path);
  }
  async append(pcm: Buffer): Promise<void> {
    if (this.closed || pcm.length % FRAME_BYTES !== 0) throw new Error('PCMの書き込み状態が不正です。');
    await writeFully(this.handle, pcm, 44 + this.bytes);
    this.bytes += pcm.length;
  }
  async finish(commit = true): Promise<number> {
    if (this.closed) return this.bytes;
    this.closed = true;
    try {
      // 途中で失敗したappendの末尾を除き、完了済みPCMとヘッダーを一致させる。
      await this.handle.truncate(44 + this.bytes);
      await writeFully(this.handle, wavHeader(this.bytes), 0); await this.handle.sync();
    }
    finally { await this.handle.close(); }
    if (commit) await rename(`${this.path}.partial`, this.path);
    return this.bytes;
  }
}
