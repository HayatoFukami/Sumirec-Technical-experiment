import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { vadConfig } from '../src/config.js';
import { segmentHandle, exportMix } from '../src/export.js';
import { VadPool } from '../src/vad-engine.js';
import { classifySegments } from '../src/vad.js';
import { storedSession, addWav } from './vad-helpers.js';

describe('実Silero ONNXモデル', () => {
  it('実モデルをロードし48kHz stereo無音WAVを分類、状態を初期化して再利用する', async () => {
    const { directory, metadata } = await storedSession();
    const segments = [await addWav(directory, metadata, Buffer.alloc(48000 * 4)),
      await addWav(directory, metadata, Buffer.alloc(7 * 4)), await addWav(directory, metadata, Buffer.alloc(0))];
    const before = await Promise.all(segments.map((s) => readFile(join(directory, s.file))));
    const pool = new VadPool(1);
    try {
      await classifySegments(directory, metadata, vadConfig({}), pool.detect);
      expect(metadata.vad).toMatchObject({ state: 'completed', speechFiles: 0, nonSpeechFiles: 3, errors: 0 });
      await exportMix(directory, metadata); // 正常な空PCMも保持して全入力を混合できる。
      for (let i = 0; i < segments.length; i++) {
        expect(segments[i]!.vad).toMatchObject({ classification: 'non-speech', completed: true, ranges: [] });
        expect(await readFile(join(directory, segments[i]!.file))).toEqual(before[i]);
      }
    } finally { await pool.close(); }
  }, 30_000);
  it('Workerのタイムアウトで推論を終了し、音声を保持して枠を解放する', async () => {
    const { directory, metadata } = await storedSession();
    const segment = await addWav(directory, metadata, Buffer.alloc(48000 * 4));
    const pool = new VadPool(1, 1);
    try {
      await classifySegments(directory, metadata, vadConfig({}), pool.detect);
      expect(segment.vad).toMatchObject({ classification: 'unclassified', error: 'timeout' });
      expect((await readFile(join(directory, segment.file))).length).toBe(segment.bytes);
    } finally { await pool.close(); }
  }, 30_000);
  it('同時リクエストを上限内で待機し、ファイルごとの状態を分離する', async () => {
    const { directory, metadata } = await storedSession();
    const segment = await addWav(directory, metadata, Buffer.alloc(48000 * 4));
    const pool = new VadPool(2);
    const handles = await Promise.all(Array.from({ length: 5 }, () => segmentHandle(directory, segment)));
    try {
      const result = await Promise.all(handles.map((h) => pool.detect(h, segment, vadConfig({ VAD_MAX_CONCURRENCY: '2' }))));
      expect(result).toEqual([[], [], [], [], []]);
    } finally { await pool.close(); await Promise.all(handles.map((h) => h.close())); }
  }, 30_000);
});
