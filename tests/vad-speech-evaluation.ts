// 許諾を確認したWAVを明示指定する、読み取り専用の実モデル評価。
import { strict as assert } from 'node:assert';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vadConfig } from '../src/config.js';
import type { Segment } from '../src/model.js';
import { wavHeader } from '../src/storage.js';
import { VadPool } from '../src/vad-engine.js';

const [input, ...extra] = process.argv.slice(2);
if (!input || extra.length) throw new Error('使い方：pnpm test:vad:speech <44バイトヘッダーの48kHz・2ch・16bit PCM WAV>');
const sourceHandle = await open(input, 'r');
let source: Buffer;
try {
  const stat = await sourceHandle.stat();
  if (!stat.isFile() || stat.size < 48 || stat.size > 44 + 60 * 192000) throw new Error('評価入力は60秒以内の通常WAVに限定します。');
  source = await sourceHandle.readFile();
  assert(source.subarray(0, 44).equals(wavHeader(source.length - 44)), '生成形式と同じ44バイトヘッダーが必要です。');
} finally { await sourceHandle.close(); }
const pcm = source.subarray(44);
const scale = (gain: number) => {
  const result = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 2) result.writeInt16LE(Math.round(pcm.readInt16LE(i) * gain), i);
  return result;
};
let seed = 42;
const noise = Buffer.alloc(pcm.length);
for (let i = 0; i < noise.length; i += 2) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  noise.writeInt16LE(Math.round((seed / 0x100000000 * 2 - 1) * 1500), i);
}
const mixed = Buffer.alloc(pcm.length);
for (let i = 0; i < pcm.length; i += 2) mixed.writeInt16LE(Math.max(-32768, Math.min(32767, pcm.readInt16LE(i) + noise.readInt16LE(i))), i);
const cases: [string, Buffer][] = [['human', pcm], ['human-minus30dB', scale(10 ** (-30 / 20))], ['human-minus50dB', scale(10 ** (-50 / 20))],
  ['human-crop250ms', pcm.subarray(400 * 192, 650 * 192)], ['synthetic-white-noise', noise], ['human-with-noise', mixed],
  ['human-with-silence', Buffer.concat([Buffer.alloc(48000 * 4), pcm, Buffer.alloc(48000 * 4)])], ['silence', Buffer.alloc(pcm.length)]];
const config = vadConfig();
if (!config.enabled) throw new Error('このモデル評価にはVAD_ENABLED=trueが必要です。');
const directory = await mkdtemp(join(tmpdir(), 'sumirec-vad-eval-'));
const pool = new VadPool(config.maxConcurrency);
try {
  for (const [label, data] of cases) {
    const path = join(directory, `${label}.wav`);
    const wav = Buffer.concat([wavHeader(data.length), data]); await writeFile(path, wav);
    const handle = await open(path, 'r'); const start = performance.now();
    const segment: Segment = { userId: '123456789012345678', file: path, samples: data.length / 4, bytes: wav.length,
      durationMs: data.length / 192, startOffsetMs: 0, endOffsetMs: data.length / 192, startAt: 'test', endAt: 'test',
      firstPacketOffsetMs: 0, lastPacketOffsetMs: 0, packets: 0, complete: true, timing: 'arrival-estimate' };
    let ranges;
    try { ranges = await pool.detect(handle, segment, config); } finally { await handle.close(); }
    const after = await readFile(path); assert(after.equals(wav), '評価用WAVの内容が変化しました。');
    console.info(JSON.stringify({ label, durationMs: segment.durationMs, classification: ranges.length ? 'speech' : 'non-speech', ranges,
      elapsedMs: Math.round(performance.now() - start), bytesUnchanged: true }));
  }
  assert((await readFile(input)).equals(source), '指定された元WAVの内容が変化しました。');
} finally { await pool.close(); await rm(directory, { recursive: true, force: true }); }
