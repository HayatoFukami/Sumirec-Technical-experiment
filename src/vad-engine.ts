import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { FileHandle } from 'node:fs/promises';
import type { VadConfig } from './config.js';
import type { Segment, SpeechRange, VadResult } from './model.js';

export const VAD_MODEL = 'Silero VAD v5.1';
export const VAD_RUNTIME = 'onnxruntime-node@1.30.0';
export const VAD_MODEL_SHA256 = '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f';
const modelPath = fileURLToPath(new URL('../assets/silero-vad/silero_vad_v5.1.onnx', import.meta.url));
export type VadDetector = (handle: FileHandle, segment: Segment, config: VadConfig) => Promise<SpeechRange[]>;
export class VadError extends Error {
  readonly category: NonNullable<VadResult['error']>;
  constructor(category: NonNullable<VadResult['error']>) { super(category); this.category = category; }
}
interface Slot { worker: Worker; busy: boolean }
export class VadPool {
  private readonly slots: Slot[] = [];
  private readonly waiting: (() => void)[] = [];
  private verification?: Promise<void>;
  readonly limit: number;
  readonly timeoutMs: number;
  constructor(limit: number, timeoutMs = 120_000) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new Error('VAD worker limit');
    this.limit = limit; this.timeoutMs = timeoutMs;
  }
  private async acquire(): Promise<Slot> {
    for (;;) {
      const idle = this.slots.find((slot) => !slot.busy);
      if (idle) { idle.busy = true; return idle; }
      if (this.slots.length < this.limit) {
        // Node 24の型消去でソースTSを直接実行。ビルド後は同じWorkerのJSを使う。
        const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './vad-worker.ts' : './vad-worker.js', import.meta.url), { execArgv: [] });
        worker.unref();
        const slot = { worker, busy: true };
        this.slots.push(slot);
        return slot;
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }
  readonly detect: VadDetector = async (handle, segment, config) => {
    this.verification ??= readFile(modelPath).then((data) => {
      if (createHash('sha256').update(data).digest('hex') !== VAD_MODEL_SHA256) throw new Error('Model checksum');
    }).catch(() => { throw new VadError('model_load_error'); });
    await this.verification;
    const slot = await this.acquire();
    slot.worker.ref();
    let failed = false;
    try {
      return await new Promise<SpeechRange[]>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); slot.worker.off('message', message); slot.worker.off('error', error); slot.worker.off('exit', exit); };
        const error = () => { failed = true; cleanup(); reject(new VadError('inference_error')); };
        const exit = () => error();
        const message = (result: { ranges?: SpeechRange[]; error?: string }) => {
          cleanup();
          if (result.error) reject(new VadError(result.error === 'model_load_error' ? 'model_load_error' : 'inference_error'));
          else if (!Array.isArray(result.ranges)) reject(new VadError('inference_error'));
          else resolve(result.ranges);
        };
        const timer = setTimeout(() => { failed = true; cleanup(); reject(new VadError('timeout')); }, this.timeoutMs);
        slot.worker.once('message', message); slot.worker.once('error', error); slot.worker.once('exit', exit);
        slot.worker.postMessage({ fd: handle.fd, samples: segment.samples, config, modelPath });
      });
    } finally {
      if (failed) {
        await slot.worker.terminate(); // 終了を待ってからFD・同時実行枠を解放する。
        this.slots.splice(this.slots.indexOf(slot), 1);
      } else { slot.busy = false; slot.worker.unref(); }
      this.waiting.shift()?.();
    }
  };
  async close(): Promise<void> { await Promise.all(this.slots.map((s) => s.worker.terminate())); this.slots.length = 0; }
}
let sharedPool: VadPool | undefined;
export const detectSpeech: VadDetector = (handle, segment, config) => {
  sharedPool ??= new VadPool(config.maxConcurrency);
  if (sharedPool.limit !== config.maxConcurrency) throw new Error('VAD_MAX_CONCURRENCYの変更にはBot再起動が必要です。');
  return sharedPool.detect(handle, segment, config);
};
