import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/session.js';
import { atomicJson, syncDirectory } from '../src/storage.js';
import { A, config, fixture } from './helpers.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  vi.mocked(fs.open).mockReset(); vi.mocked(fs.rename).mockReset();
});
function windows(): void { vi.stubGlobal('process', { ...process, platform: 'win32' }); }

describe('OS別の保存と準備失敗', () => {
  it('Windowsのディレクトリ同期不可を回避し、開始・個別WAV・mix・停止メタデータを確定する', async () => {
    const cfg = await config(); const f = fixture([A]);
    windows();
    const fileSyncs: string[] = [];
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const path = String(args[0]);
      const handle = await actualFs.open(...args);
      const sync = handle.sync.bind(handle);
      const isDirectory = (await handle.stat()).isDirectory();
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        // WindowsのFlushFileBuffersに読み取り専用ディレクトリを渡す失敗を模擬。
        if (isDirectory) throw Object.assign(new Error('directory flush denied'), { code: 'EPERM' });
        fileSyncs.push(path); await sync();
      });
      return handle;
    });
    const session = await new SessionManager(cfg).start(f.options);
    try {
      expect(session.metadata.state).toBe('recording');
      expect(session.metadata.limitations.some((value) => value.startsWith('Windowsでは'))).toBe(true);
      f.clock.now = 100; f.voice.emit(A);
    } finally { await session.stop(); }
    expect(session.metadata.state).toBe('completed');
    expect(session.metadata.errorCode).toBeNull();
    expect(session.metadata.savedFiles).toBe(1);
    expect(session.metadata.exportFile).toBe('exports/mix.wav');
    const stored = JSON.parse(await fs.readFile(join(session.directory!, 'metadata.json'), 'utf8'));
    expect(stored.state).toBe('completed');
    const wav = await fs.readFile(join(session.directory!, session.metadata.segments[0]!.file));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(40)).toBe(960 * 4);
    expect(fileSyncs).toContain(join(session.directory!, 'metadata.json.partial'));
    expect(fileSyncs.some((value) => value.endsWith('segment-0001.wav.partial'))).toBe(true);
  });

  it.each(['open', 'sync', 'rename'] as const)('Windowsでもメタデータの%s失敗を隠さず、音声接続前に停止する', async (operation) => {
    const cfg = await config(); const f = fixture([A]);
    windows();
    const failure = Object.assign(new Error('secret external error'), { code: 'EACCES' });
    if (operation === 'open') vi.mocked(fs.open).mockRejectedValueOnce(failure);
    if (operation === 'rename') vi.mocked(fs.rename).mockRejectedValueOnce(failure);
    if (operation === 'sync') vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actualFs.open(...args);
      vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
      return handle;
    });
    const manager = new SessionManager(cfg);
    await expect(manager.start(f.options)).rejects.toThrow('録音準備に失敗しました（metadata_write_error）');
    const session = manager.get(f.options.guildId)!;
    expect(session.metadata.state).toBe('failed');
    expect(session.metadata.errorCode).toBe('metadata_write_error');
    expect(session.active).toBe(false);
    expect(f.voice.connects).toBe(0);
    expect(f.voice.users).toEqual([]);
    expect(f.notices.some((value) => value.startsWith('録音準備'))).toBe(false);
    expect(JSON.stringify(session.metadata)).not.toContain('secret external error');
  });

  it('保存ディレクトリ作成の失敗を通知失敗と区別する', async () => {
    const cfg = await config(); const f = fixture([A]);
    cfg.root = join(cfg.root, 'file');
    await fs.writeFile(cfg.root, 'not a directory');
    const manager = new SessionManager(cfg);
    await expect(manager.start(f.options)).rejects.toThrow('録音準備に失敗しました（storage_directory_error）');
    expect(manager.get(f.options.guildId)?.metadata.errorCode).toBe('storage_directory_error');
    expect(f.voice.connects).toBe(0);
  });

  it('Windowsでも存在しないディレクトリ・通常ファイル・junctionを同期対象として許可しない', async () => {
    const cfg = await config();
    const file = join(cfg.root, 'file'); await fs.writeFile(file, 'file');
    const link = join(cfg.root, 'linked'); await fs.symlink(cfg.root, link, 'junction');
    windows();
    await expect(syncDirectory(join(cfg.root, 'missing'))).rejects.toThrow();
    await expect(syncDirectory(file)).rejects.toThrow('安全');
    await expect(syncDirectory(link)).rejects.toThrow('安全');
    expect(fs.open).not.toHaveBeenCalled();
  });

  it('POSIXのディレクトリ同期失敗を握りつぶさず、handleを閉じる', async () => {
    const cfg = await config();
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    const sync = vi.fn(async () => { throw new Error('directory sync failed'); });
    const close = vi.fn(async () => undefined);
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      if ((await handle.stat()).isDirectory()) {
        vi.spyOn(handle, 'sync').mockImplementation(sync);
        const realClose = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); await realClose(); });
      }
      return handle;
    });
    await expect(atomicJson(cfg.root, { state: 'preparing' })).rejects.toThrow('directory sync failed');
    expect(sync).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
});
