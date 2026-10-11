import type { HttpConfig } from './processing-config.js';

export type ApiErrorCode = 'network_error' | 'http_error' | 'request_limit' | 'audio_limit' | 'invalid_response' | 'empty_transcript' | 'unmapped_timestamp' | 'input_changed' | 'grounding_error' | 'refusal' | 'incomplete_response';
export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode, readonly status?: number) { super(code); }
}
export interface ApiDependencies { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }
export interface ApiStats { requests: number; submittedAudioSeconds: number; retries: number }
export class RequestBudget {
  readonly stats: ApiStats = { requests: 0, submittedAudioSeconds: 0, retries: 0 };
  constructor(private readonly maxRequests: number, private readonly maxAudioSeconds = Infinity) {}
  reserve(audioSeconds: number): void {
    if (this.stats.requests >= this.maxRequests) throw new ApiError('request_limit');
    if (this.stats.submittedAudioSeconds + audioSeconds > this.maxAudioSeconds + 1e-9) throw new ApiError('audio_limit');
    this.stats.requests++; this.stats.submittedAudioSeconds += audioSeconds;
  }
}
// 生のエラー本文・URL・鍵は呼び出し側へ渡さない。リトライも予算に計上する。
export async function requestJson(url: string, makeRequest: () => RequestInit, config: HttpConfig, budget: RequestBudget, audioSeconds: number, dependencies: ApiDependencies = {}): Promise<unknown> {
  const send = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    budget.reserve(audioSeconds);
    if (attempt > 0) budget.stats.retries++;
    let response: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let retryAfter: string | null = null;
    let failure: ApiError | undefined;
    try {
      response = await send(url, { ...makeRequest(), signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        failure = new ApiError('http_error', response.status);
        retryAfter = response.headers.get('retry-after');
        await response.body?.cancel();
        if (response.status !== 429 && response.status < 500) throw failure;
      } else {
        // 応答全体にもタイムアウトと8MiBの上限を適用する。
        const reader = response.body?.getReader();
        if (!reader) throw new ApiError('invalid_response');
        const blocks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 8_388_608) { await reader.cancel(); throw new ApiError('invalid_response'); }
            blocks.push(value);
          }
          try { return JSON.parse(Buffer.concat(blocks).toString('utf8')) as unknown; }
          catch { throw new ApiError('invalid_response'); }
        } finally { reader.releaseLock(); }
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      failure = new ApiError('network_error');
    } finally { clearTimeout(timer); }
    if (attempt >= config.maxRetries) throw failure ?? new ApiError('network_error');
    const after = retryAfter === null ? 0 : (/^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now());
    await sleep(Math.min(30_000, Math.max(500 * 2 ** attempt + Math.floor(Math.random() * 250), Number.isFinite(after) ? after : 0)));
  }
}
