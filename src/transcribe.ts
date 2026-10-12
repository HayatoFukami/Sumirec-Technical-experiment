import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { ApiError, RequestBudget, requestJson, type ApiDependencies, type ApiStats, type ApiErrorCode } from './api-http.js';
import { azureUrl, type SttConfig } from './processing-config.js';
import { existingSession, loadRecording, hash, record, readJson, writeArtifact, withProcessingLock, segmentIdentity, escapeMarkdown } from './processing-storage.js';
import { readFully, segmentHandle, segmentPath, validateSegmentWav } from './export.js';
import { SAMPLE_RATE, FRAME_BYTES, type Metadata, type Segment, type VadClass } from './model.js';
import { privateDirectory, wavHeader } from './storage.js';

export interface AudioMapping {
  segmentId: string; file: string; sourceStartSample: number; samples: number;
  chunkStartSample: number; meetingStartMs: number; meetingEndMs: number;
}
export interface AudioChunk {
  id: string; userId: string; samples: number; audioSha256: string; mappings: AudioMapping[];
}
export interface SourceStatus { segmentId: string; userId: string; file: string; classification: VadClass; status: 'selected' | 'excluded' | 'needs_review'; reason?: string }
export interface TranscriptionPlan {
  schemaVersion: 1; guildId: string; sessionId: string; recordingStartedAt: string | null;
  recordingIncomplete: boolean; settings: ReturnType<typeof transcriptionSettings>; chunks: AudioChunk[]; sources: SourceStatus[];
}
export interface SourceReference extends AudioMapping { startOffsetMs: number; endOffsetMs: number }
export interface Utterance {
  id: string; userId: string; startOffsetMs: number; endOffsetMs: number; text: string;
  sourceSegments: SourceReference[]; model: string; status: 'succeeded'; chunkId: string;
}
export interface ChunkResult {
  chunk: AudioChunk; status: 'succeeded' | 'failed' | 'needs_review'; utterances: Utterance[];
  error?: ApiErrorCode; httpStatus?: number; apiDurationMs?: number; apiDurationDifferenceMs?: number; combinedText?: string;
  processedAt: string; usage: ApiStats; cached: boolean;
  response?: AzureTranscript;
  responseReprocessed?: boolean;
}
export interface AzureTranscript {
  durationMilliseconds: number; combinedPhrases: { text: string }[];
  phrases: { text: string; offsetMilliseconds: number; durationMilliseconds: number }[];
}
export interface TranscriptBundle {
  schemaVersion: 1; guildId: string; sessionId: string; recordingStartedAt: string | null; model: string;
  runId: string; generatedAt: string; incomplete: boolean; warnings: string[]; utterances: Utterance[];
  sources: SourceStatus[]; chunks: ChunkResult[]; usage: ApiStats; settings: ReturnType<typeof transcriptionSettings>;
}
export function transcriptionSettings(config: SttConfig) {
  return { pipelineVersion: 1, provider: config.provider, model: config.model, apiVersion: '2025-10-15',
    language: config.language, style: config.style, timestamps: config.timestamps, phrases: config.phrases,
    classes: config.classes, maxChunkSeconds: config.maxChunkSeconds, maxGapMs: config.maxGapMs };
}
export function azureDefinition(config: SttConfig) {
  return { enhancedMode: { enabled: true, model: config.model, modelOptions: { transcribeStyle: config.style, timestamps: config.timestamps } },
    diarization: { enabled: false }, ...(config.language === 'auto' ? {} : { locales: [config.language] }),
    ...(config.phrases.length ? { phraseList: { phrases: config.phrases } } : {}) };
}
async function chunkAudio(directory: string, chunk: Pick<AudioChunk, 'samples' | 'mappings'>, segments: Segment[]): Promise<Buffer> {
  // 最大120秒・約23MB。長い音声を一括でメモリへ読み込まない。
  if (!Number.isSafeInteger(chunk.samples) || chunk.samples < 1 || chunk.samples > 120 * SAMPLE_RATE) throw new Error('チャンク音声長が不正です。');
  const pcm = Buffer.alloc(chunk.samples * FRAME_BYTES);
  for (const mapping of chunk.mappings) {
    const segment = segments.find(s => s.file === mapping.file);
    if (!segment) throw new Error('元セグメントが存在しません。');
    const handle = await segmentHandle(directory, segment);
    try {
      await validateSegmentWav(handle, segment);
      const data = await readFully(handle, mapping.samples * FRAME_BYTES, 44 + mapping.sourceStartSample * FRAME_BYTES);
      data.copy(pcm, mapping.chunkStartSample * FRAME_BYTES);
    } finally { await handle.close(); }
  }
  return Buffer.concat([wavHeader(pcm.length), pcm]);
}
export async function planTranscription(directory: string, metadata: Metadata, config: SttConfig): Promise<TranscriptionPlan> {
  const sources: SourceStatus[] = [];
  const selected: Segment[] = [];
  for (const segment of metadata.segments) {
    await segmentPath(directory, segment); // 対象外であってもユーザー・パスの不整合を拒否。
    const classification = segment.vad?.completed ? segment.vad.classification : 'unclassified';
    if (segment.vad?.completed && !segment.file.includes(`/${classification}/`)) throw new Error('VAD分類と音声パスが一致しません。');
    const base = { segmentId: segmentIdentity(segment), file: segment.file, userId: segment.userId, classification };
    if (!segment.complete || !segment.samples) sources.push({ ...base, status: 'needs_review', reason: 'incomplete_or_empty_audio' });
    else if (config.classes.includes(classification)) { sources.push({ ...base, status: 'selected' }); selected.push(segment); }
    else sources.push({ ...base, status: classification === 'unclassified' ? 'needs_review' : 'excluded', reason: classification === 'unclassified' ? 'vad_review_required' : 'not_selected' });
  }
  const chunks: AudioChunk[] = [];
  const maxSamples = config.maxChunkSeconds * SAMPLE_RATE;
  const sorted = selected.sort((a, b) => a.userId.localeCompare(b.userId) || a.startOffsetMs - b.startOffsetMs || a.file.localeCompare(b.file));
  let current: AudioChunk | undefined;
  async function flush() {
    if (!current) return;
    current.audioSha256 = hash(await chunkAudio(directory, current, metadata.segments));
    current.id = hash(JSON.stringify({ guildId: metadata.guildId, sessionId: metadata.sessionId, settings: transcriptionSettings(config),
      userId: current.userId, samples: current.samples, audioSha256: current.audioSha256, mappings: current.mappings }));
    chunks.push(current); current = undefined;
  }
  for (const segment of sorted) {
    let sourceStartSample = 0;
    while (sourceStartSample < segment.samples) {
      const start = segment.startOffsetMs + sourceStartSample / SAMPLE_RATE * 1000;
      const last = current?.mappings.at(-1);
      const gap = last ? start - last.meetingEndMs : 0;
      const silence = Math.round(Math.max(0, gap) * SAMPLE_RATE / 1000);
      if (current && (current.userId !== segment.userId || gap < 0 || gap > config.maxGapMs || current.samples + silence >= maxSamples)) await flush();
      current ??= { id: '', userId: segment.userId, samples: 0, audioSha256: '', mappings: [] };
      const chunkStartSample = current.samples + (current.mappings.length ? silence : 0);
      const samples = Math.min(segment.samples - sourceStartSample, maxSamples - chunkStartSample);
      current.mappings.push({ segmentId: segmentIdentity(segment), file: segment.file, sourceStartSample, samples, chunkStartSample,
        meetingStartMs: start, meetingEndMs: start + samples / SAMPLE_RATE * 1000 });
      current.samples = chunkStartSample + samples;
      sourceStartSample += samples;
      if (current.samples === maxSamples) await flush();
    }
  }
  await flush();
  return { schemaVersion: 1, guildId: metadata.guildId, sessionId: metadata.sessionId, recordingStartedAt: metadata.recordingStartedAt,
    recordingIncomplete: metadata.state === 'failed' || metadata.segments.some(s => !s.complete), settings: transcriptionSettings(config), chunks, sources };
}
function azureTranscript(value: unknown): AzureTranscript {
  if (!record(value) || !Number.isFinite(value.durationMilliseconds) || Number(value.durationMilliseconds) < 0 ||
    !Array.isArray(value.phrases) || value.phrases.length > 1000 || !Array.isArray(value.combinedPhrases) || value.combinedPhrases.length > 2 ||
    !value.combinedPhrases.every(p => record(p) && typeof p.text === 'string' && p.text.length <= 100_000)) throw new ApiError('invalid_response');
  if (!value.phrases.every(p => record(p) && typeof p.text === 'string' && p.text.length <= 20_000 && Number.isFinite(p.offsetMilliseconds) && Number.isFinite(p.durationMilliseconds))) throw new ApiError('invalid_response');
  const input = value as unknown as AzureTranscript;
  return { durationMilliseconds: input.durationMilliseconds, combinedPhrases: input.combinedPhrases.map(p => ({text:p.text})),
    phrases: input.phrases.map(p => ({text:p.text,offsetMilliseconds:p.offsetMilliseconds,durationMilliseconds:p.durationMilliseconds})) };
}
export function parseAzureResult(value: unknown, chunk: AudioChunk, model: string): Pick<ChunkResult, 'utterances' | 'apiDurationMs' | 'apiDurationDifferenceMs' | 'combinedText'> {
  const response = azureTranscript(value);
  // 実APIでWAV実長との差±約2.6msを観測。総長だけ10msまで許容し、時刻配置は元サンプルを使う。
  const apiDurationDifferenceMs = response.durationMilliseconds - chunk.samples / 48;
  if (Math.abs(apiDurationDifferenceMs) > 10) throw new ApiError('invalid_response');
  const combinedText = response.combinedPhrases.map(p => p.text).join('\n');
  const utterances: Utterance[] = [];
  for (const phrase of response.phrases) {
    if (!record(phrase) || typeof phrase.text !== 'string' || phrase.text.length > 20_000 || !Number.isFinite(phrase.offsetMilliseconds) || !Number.isFinite(phrase.durationMilliseconds) ||
      Number(phrase.offsetMilliseconds) < 0 || Number(phrase.durationMilliseconds) <= 0 ||
      Number(phrase.offsetMilliseconds) + Number(phrase.durationMilliseconds) > chunk.samples / 48 + 1) throw new ApiError('invalid_response');
    if (!phrase.text.trim()) continue;
    const start = Number(phrase.offsetMilliseconds); const end = start + Number(phrase.durationMilliseconds);
    const sourceSegments = chunk.mappings.flatMap(mapping => {
      const mappingStart = mapping.chunkStartSample / 48;
      const low = Math.max(start, mappingStart); const high = Math.min(end, mappingStart + mapping.samples / 48);
      return high > low ? [{ ...mapping, startOffsetMs: mapping.meetingStartMs + low - mappingStart, endOffsetMs: mapping.meetingStartMs + high - mappingStart }] : [];
    });
    if (!sourceSegments.length) throw new ApiError('unmapped_timestamp');
    const startOffsetMs = Math.min(...sourceSegments.map(s => s.startOffsetMs));
    const endOffsetMs = Math.max(...sourceSegments.map(s => s.endOffsetMs));
    const text = phrase.text.trim();
    utterances.push({ id: `u-${hash(JSON.stringify([chunk.id, start, end, text])).slice(0,24)}`, userId: chunk.userId, startOffsetMs, endOffsetMs,
      text, sourceSegments, model, status: 'succeeded', chunkId: chunk.id });
  }
  if (!utterances.length || !combinedText.trim()) throw new ApiError('empty_transcript');
  return { utterances, apiDurationMs: response.durationMilliseconds, apiDurationDifferenceMs, combinedText };
}
export function mergeUtterances(results: ChunkResult[]): Utterance[] {
  const seen = new Set<string>();
  return results.flatMap(r => r.status === 'succeeded' ? r.utterances : []).filter(u => {
    // 同一ユーザー・同一元音声区間・同一テキストだけ排除。相づちや他ユーザーの同文を消さない。
    const key = JSON.stringify([u.userId, u.text, u.sourceSegments.map(s => [s.segmentId, s.startOffsetMs, s.endOffsetMs])]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a, b) => a.startOffsetMs - b.startOffsetMs || a.endOffsetMs - b.endOffsetMs || a.userId.localeCompare(b.userId) || a.id.localeCompare(b.id));
}
async function cachedResult(directory: string, chunk: AudioChunk, model: string, persistRecovery = false): Promise<ChunkResult | undefined> {
  let value: unknown;
  try { value = await readJson(directory, `${chunk.id}.json`); }
  catch (error) { if (record(error) && error.code === 'ENOENT') return undefined; throw error; }
  if (!record(value) || !(value.status === 'succeeded' || (value.status === 'failed' && value.error === 'invalid_response')) || !record(value.chunk) || JSON.stringify(value.chunk) !== JSON.stringify(chunk)) return undefined;
  let parsed: ReturnType<typeof parseAzureResult>;
  try {
    parsed = parseAzureResult(value.response, chunk, model);
    if (value.status === 'succeeded' && JSON.stringify(parsed.utterances) !== JSON.stringify(value.utterances)) return undefined;
  } catch { return undefined; }
  const result: ChunkResult = { ...(value as unknown as ChunkResult), ...parsed, status: 'succeeded', error: undefined, httpStatus: undefined, cached: true };
  if (value.status !== 'succeeded') {
    result.responseReprocessed = true;
    if (persistRecovery) await writeArtifact(directory, `${chunk.id}.json`, result);
  }
  return result;
}
export async function transcribeSession(guild: string, session: string, config: SttConfig, options: { dryRun?: boolean; force?: boolean } = {}, dependencies: ApiDependencies = {}) {
  const directory = await existingSession(config.root, guild, session);
  return withProcessingLock(directory, async () => {
    const metadata = await loadRecording(directory, guild, session);
    const plan = await planTranscription(directory, metadata, config);
    let cacheDirectory: string | undefined;
    // privateDirectoryは既存symlinkを拒否する。dry-runは出力ファイルを作らない。
    const transcriptsExists = await lstat(join(directory, 'transcripts')).catch((e: unknown) => { if (record(e) && e.code === 'ENOENT') return undefined; throw e; });
    if (transcriptsExists) {
      const transcripts = await privateDirectory(directory, ['transcripts']);
      const cacheExists = await lstat(join(transcripts, 'cache')).catch((e: unknown) => { if (record(e) && e.code === 'ENOENT') return undefined; throw e; });
      if (cacheExists) cacheDirectory = await privateDirectory(transcripts, ['cache']);
    }
    const cached = new Map<string, ChunkResult>();
    if (!options.force && cacheDirectory) for (const chunk of plan.chunks) {
      const result = await cachedResult(cacheDirectory, chunk, config.model, config.enabled && !options.dryRun); if (result) cached.set(chunk.id, result);
    }
    const pending = plan.chunks.filter(c => !cached.has(c.id));
    const pendingSeconds = pending.reduce((sum, c) => sum + c.samples / SAMPLE_RATE, 0);
    const summary = { files: plan.sources.filter(s => s.status === 'selected').length, chunks: plan.chunks.length, cachedChunks: cached.size,
      requests: pending.length, audioSeconds: pendingSeconds, selectedAudioSeconds: plan.chunks.reduce((sum,c) => sum + c.samples / SAMPLE_RATE,0),
      reviewFiles: plan.sources.filter(s => s.status === 'needs_review').length, excludedFiles: plan.sources.filter(s => s.status === 'excluded').length,
      withinLimits: pending.length <= config.maxRequests && pendingSeconds <= config.maxAudioSeconds, maxRequests: config.maxRequests, maxAudioSeconds: config.maxAudioSeconds };
    if (options.dryRun || !config.enabled) return { dryRun: true as const, disabled: !config.enabled, summary, plan };
    if (!summary.withinLimits) throw new ApiError(pending.length > config.maxRequests ? 'request_limit' : 'audio_limit');
    let url = '';
    if (pending.length) { url = azureUrl(config.endpoint); if (!config.key.trim() || config.key.startsWith('replace_')) throw new Error('AZURE_SPEECH_KEYを設定してください。'); }
    const transcripts = await privateDirectory(directory, ['transcripts']);
    cacheDirectory = await privateDirectory(transcripts, ['cache']);
    await writeArtifact(transcripts, 'plan.json', plan);
    const budget = new RequestBudget(config.maxRequests, config.maxAudioSeconds);
    const results: ChunkResult[] = []; let next = 0;
    const runId = `${Date.now()}-${hash(JSON.stringify(plan)).slice(0,12)}`;
    const snapshot = async () => writeArtifact(transcripts, 'segments.json', { schemaVersion: 1, runId, plan, chunks: results, usage: { ...budget.stats }, state: 'processing' });
    // 各確定結果を直ちに保存。並列Workerのsnapshot書き込みは順番に行う。
    let writes = Promise.resolve();
    await snapshot();
    await Promise.all(Array.from({ length: Math.min(config.maxConcurrency, plan.chunks.length) }, async () => {
      for (;;) {
        const chunk = plan.chunks[next++]; if (!chunk) return;
        let result = cached.get(chunk.id);
        if (!result) {
          result = { chunk, status: 'failed', utterances: [], cached: false, processedAt: new Date().toISOString(), usage: { requests: 0, submittedAudioSeconds: 0, retries: 0 } };
          // 専用予算ラッパーで並列時もチャンクごとの使用量を正しく計上。
          const localStats: ApiStats = { requests: 0, submittedAudioSeconds: 0, retries: 0 };
          const localBudget = new RequestBudget(Infinity);
          localBudget.reserve = seconds => { budget.reserve(seconds); localStats.requests++; localStats.submittedAudioSeconds += seconds; };
          try {
            const audio = await chunkAudio(directory, chunk, metadata.segments);
            if (hash(audio) !== chunk.audioSha256) throw new ApiError('input_changed');
            const value = await requestJson(url, () => {
              const form = new FormData();
              form.append('audio', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'chunk.wav');
              form.append('definition', JSON.stringify(azureDefinition(config)));
              return { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': config.key }, body: form };
            }, config, localBudget, chunk.samples / SAMPLE_RATE, dependencies);
            result.response = azureTranscript(value);
            Object.assign(result, parseAzureResult(result.response, chunk, config.model), { status: 'succeeded' });
          } catch (error) {
            const failure = error instanceof ApiError ? error : new ApiError('input_changed');
            result.status = ['empty_transcript','unmapped_timestamp'].includes(failure.code) ? 'needs_review' : 'failed';
            result.error = failure.code; if (failure.status !== undefined) result.httpStatus = failure.status;
          }
          localStats.retries = localBudget.stats.retries;
          budget.stats.retries += localStats.retries;
          result.usage = localStats;
          // forceで失敗しても前回の成功キャッシュを上書きしない。
          if (result.status === 'succeeded') await writeArtifact(cacheDirectory!, `${chunk.id}.json`, result);
          else if (result.response && !await cachedResult(cacheDirectory!, chunk, config.model)) {
            // 構造を読める失敗応答は再検査用に保持。ただし前回成功は置換しない。
            await writeArtifact(cacheDirectory!, `${chunk.id}.json`, result);
          }
        }
        results.push(result);
        const captured = [...results]; const usage = { ...budget.stats };
        writes = writes.then(() => writeArtifact(transcripts, 'segments.json', { schemaVersion: 1, runId, plan, chunks: captured, usage, state: 'processing' }));
        await writes;
      }
    }));
    const warnings: string[] = [];
    if (plan.recordingIncomplete) warnings.push('録音が失敗または不完全です。');
    if (plan.sources.some(s => s.status === 'needs_review')) warnings.push('未分類・不完全音声に確認が必要です。');
    if (plan.sources.some(s => s.status === 'excluded')) warnings.push('選択対象外の音声があります。VADによる発話の見逃しは未評価です。');
    if (results.some(r => r.status !== 'succeeded')) warnings.push('文字起こしの失敗または空の結果があり、全文は不完全です。');
    if (!results.length) warnings.push('処理対象の音声がありません。無発話と確定していません。');
    const utterances = mergeUtterances(results);
    const bundle: TranscriptBundle = { schemaVersion: 1, guildId: guild, sessionId: session, recordingStartedAt: plan.recordingStartedAt, model: config.model,
      runId, generatedAt: new Date().toISOString(), incomplete: plan.recordingIncomplete || plan.sources.some(s => s.status === 'needs_review') || results.some(r => r.status !== 'succeeded') || !utterances.length,
      warnings, utterances, sources: plan.sources, chunks: results.sort((a,b) => a.chunk.id.localeCompare(b.chunk.id)), usage: { ...budget.stats }, settings: plan.settings };
    const runs = await privateDirectory(transcripts, ['runs']);
    await writeArtifact(runs, `${runId}.json`, bundle);
    await writeArtifact(transcripts, 'segments.json', { schemaVersion: 1, runId, plan, chunks: bundle.chunks, usage: bundle.usage, state: bundle.incomplete ? 'incomplete' : 'completed' });
    await writeArtifact(transcripts, 'merged.json', bundle);
    await writeArtifact(transcripts, 'merged.md', transcriptMarkdown(bundle), true);
    const users = await privateDirectory(transcripts, ['users']);
    for (const userId of new Set(plan.sources.map(s => s.userId))) await writeArtifact(users, `${userId}.json`, {
      schemaVersion: 1, guildId: guild, sessionId: session, runId, userId, model: config.model, sources: plan.sources.filter(s => s.userId === userId),
      chunks: bundle.chunks.filter(c => c.chunk.userId === userId), utterances: utterances.filter(u => u.userId === userId),
    });
    return { dryRun: false as const, summary, bundle };
  });
}
export function transcriptMarkdown(bundle: TranscriptBundle): string {
  return ['# 時系列文字起こし', '', `状態: ${bundle.incomplete ? '不完全・要確認' : '処理完了（認識品質は要評価）'}`, '',
    ...bundle.warnings.map(w => `- ${escapeMarkdown(w)}`), '',
    ...bundle.utterances.map(u => `- [${u.id}] ${u.startOffsetMs.toFixed(1)}–${u.endOffsetMs.toFixed(1)} ms / ${u.userId}: ${escapeMarkdown(u.text)}\n  元音声: ${u.sourceSegments.map(s => s.file).join(', ')}`), ''].join('\n');
}
