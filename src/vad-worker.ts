import { read } from 'node:fs';
import { parentPort } from 'node:worker_threads';
import type { VadConfig } from './config.js';
import type { SpeechRange } from './model.js';
import type { InferenceSession, Tensor } from 'onnxruntime-node';

// 63-tap対称Hamming窓sinc、7.2kHzローパス。遅延を相殺した3:1間引き。
const radius = 31;
const coefficients = Array.from({ length: radius * 2 + 1 }, (_, i) => {
  const x = i - radius;
  const cutoff = 7200 / 48000;
  return (x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)) *
    (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (radius * 2)));
});
const normalization = coefficients.reduce((a, b) => a + b, 0);
export function resampleFrame(pcm: Buffer, firstInput: number, firstOutput: number, totalSamples: number): Float32Array {
  const frame = new Float32Array(512);
  for (let i = 0; i < 512 && (firstOutput + i) * 3 < totalSamples; i++) {
    const center = (firstOutput + i) * 3;
    let value = 0;
    for (let j = -radius; j <= radius; j++) {
      const index = center + j;
      const offset = (index - firstInput) * 4;
      if (index < 0 || index >= totalSamples) continue;
      if (offset < 0 || offset + 4 > pcm.length) throw new Error('PCM buffer boundary');
      const mono = (pcm.readInt16LE(offset) + pcm.readInt16LE(offset + 2)) / 65536;
      value += mono * coefficients[j + radius]! / normalization;
    }
    frame[i] = value;
  }
  return frame;
}

// 確率のヒステリシス＋終了猶予。最小時間は余白と終了猶予を除く区間へ適用。
export class SpeechTracker {
  private start?: number;
  private low?: number;
  readonly ranges: SpeechRange[] = [];
  readonly config: VadConfig;
  constructor(config: VadConfig) { this.config = config; }
  frame(probability: number, startMs: number, endMs: number): void {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Invalid VAD probability');
    if (probability >= this.config.positiveThreshold) {
      this.start ??= startMs;
      this.low = undefined;
    } else if (this.start !== undefined && probability < this.config.negativeThreshold) {
      this.low ??= startMs;
      if (endMs - this.low >= this.config.redemptionMs) this.end(this.low);
    }
  }
  private end(endMs: number): void {
    if (this.start !== undefined && endMs > this.start && endMs - this.start >= this.config.minSpeechMs) {
      const startMs = Math.max(0, this.start - this.config.preSpeechPadMs);
      const previous = this.ranges.at(-1);
      if (previous && previous.endMs >= startMs) previous.endMs = endMs;
      else this.ranges.push({ startMs, endMs });
    }
    this.start = this.low = undefined;
  }
  finish(durationMs: number): SpeechRange[] {
    this.end(this.low ?? durationMs);
    return this.ranges;
  }
}
async function readPcm(fd: number, size: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  for (let offset = 0; offset < size;) {
    const count = await new Promise<number>((resolve, reject) => {
      read(fd, buffer, offset, size - offset, position + offset, (error, bytes) => error ? reject(error) : resolve(bytes));
    });
    if (!count) throw new Error('Unexpected PCM EOF');
    offset += count;
  }
  return buffer;
}
let model: InferenceSession | undefined;
parentPort?.on('message', async (job: { fd: number; samples: number; config: VadConfig; modelPath: string }) => {
  let stage = 'model_load_error';
  try {
    const ort = await import('onnxruntime-node');
    model ??= await ort.InferenceSession.create(job.modelPath, {
      executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1,
    });
    stage = 'inference_error';
    // RNN状態・64サンプルの文脈はファイルごとに初期化し、モデルだけ再利用する。
    let state: Tensor = new ort.Tensor('float32', new Float32Array(256), [2, 1, 128]);
    let context = new Float32Array(64);
    const tracker = new SpeechTracker(job.config);
    for (let output = 0; output < Math.ceil(job.samples / 3); output += 512) {
      const first = Math.max(0, output * 3 - radius);
      const last = Math.min(job.samples, (output + 511) * 3 + radius + 1);
      const pcm = await readPcm(job.fd, (last - first) * 4, 44 + first * 4);
      const frame = resampleFrame(pcm, first, output, job.samples);
      const input = new Float32Array(576);
      input.set(context); input.set(frame, 64);
      const result = await model.run({ input: new ort.Tensor('float32', input, [1, 576]),
        state, sr: new ort.Tensor('int64', BigInt64Array.from([16000n]), []) });
      if (!result.stateN || result.stateN.type !== 'float32') throw new Error('Invalid RNN state');
      state = result.stateN;
      context = frame.slice(-64);
      const probability = Number(result.output?.data[0]);
      tracker.frame(probability, output / 16, Math.min((output + 512) / 16, job.samples / 48));
    }
    parentPort!.postMessage({ ranges: tracker.finish(job.samples / 48) });
  } catch { parentPort!.postMessage({ error: stage }); }
});
