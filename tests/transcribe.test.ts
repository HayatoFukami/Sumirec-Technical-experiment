import { readFile, lstat, symlink, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { transcribeSession, planTranscription, mergeUtterances, parseAzureResult, azureDefinition } from '../src/transcribe.js';
import { sttConfig, azureUrl } from '../src/processing-config.js';
import { atomicJson, privateDirectory } from '../src/storage.js';
import { writeArtifact } from '../src/processing-storage.js';
import { A, B, C } from './helpers.js';
import { recordingFixture, azureResponse } from './processing-helpers.js';

describe('文字起こし対象・結合・時刻', () => {
  it('初期設定はspeechのみ、分類不明は確認待ち。無効時とdry-runは送信・成果物保存をしない', async () => {
    const f = await recordingFixture([{classification:'speech'}, {classification:'non-speech'}, {classification:'unclassified'}]);
    const send = vi.fn(); const before = await readFile(join(f.directory,'metadata.json'));
    const dry = await transcribeSession(f.guild,f.session,f.stt,{dryRun:true},{fetch:send});
    expect(dry.summary).toMatchObject({files:1,chunks:1,requests:1,audioSeconds:1,reviewFiles:1,excludedFiles:1});
    const disabled = await transcribeSession(f.guild,f.session,{...f.stt,enabled:false},{},{fetch:send});
    expect(disabled.dryRun).toBe(true); expect(send).not.toHaveBeenCalled();
    expect(await readdir(f.directory)).not.toContain('transcripts'); expect(await readFile(join(f.directory,'metadata.json'))).toEqual(before);
  });
  it('近接する同一話者だけを無音付き結合し、元サンプル・元時刻・同時発言を維持', async () => {
    const f = await recordingFixture([{userId:A,start:500,ms:1000,value:10}, {userId:A,start:1800,ms:500,value:20}, {userId:B,start:600,ms:800,value:30}, {userId:A,start:9000,ms:1000,value:40}]);
    const audios: Buffer[] = []; const definitions: unknown[] = [];
    const send = vi.fn(async (_url, init) => {
      const form = init!.body as FormData; const file = form.get('audio') as Blob;
      const audio = Buffer.from(await file.arrayBuffer()); audios.push(audio); definitions.push(JSON.parse(String(form.get('definition'))));
      const length = audio.readUInt32LE(40) / 192;
      if (length === 1800) return new Response(JSON.stringify({durationMilliseconds:length,combinedPhrases:[{text:'最初 次'}],phrases:[
        {text:'最初',offsetMilliseconds:0,durationMilliseconds:1000}, {text:'次',offsetMilliseconds:1300,durationMilliseconds:500}]}));
      return azureResponse(length,'発言',0,length);
    }) as typeof fetch;
    const result = await transcribeSession(f.guild,f.session,f.stt,{}, {fetch:send});
    if (result.dryRun) throw new Error('expected execution');
    expect(result.bundle.utterances.map(u => [u.userId,u.startOffsetMs,u.endOffsetMs])).toEqual([[A,500,1500],[B,600,1400],[A,1800,2300],[A,9000,10000]]);
    const combined = audios.find(b => b.readUInt32LE(40) === 1800 * 192)!;
    expect(combined.readInt16LE(44)).toBe(10); expect(combined.readInt16LE(44 + 1000 * 192)).toBe(0); expect(combined.readInt16LE(44 + 1300 * 192)).toBe(20);
    expect(result.bundle.chunks.every(r => r.chunk.mappings.every(m => m.file.startsWith(`users/${r.chunk.userId}/`)))).toBe(true);
    expect(definitions[0]).toMatchObject({enhancedMode:{enabled:true,model:'MAI-Transcribe-2',modelOptions:{transcribeStyle:'verbatim',timestamps:'segment'}},locales:['ja'],diarization:{enabled:false}});
    expect(JSON.stringify(definitions)).not.toContain(A); expect(JSON.stringify(definitions)).not.toContain('test-stt-key');
    const perUser = JSON.parse(await readFile(join(f.directory,'transcripts','users',`${B}.json`),'utf8'));
    expect(perUser.utterances).toHaveLength(1); expect(perUser.userId).toBe(B);
  });
  it('20秒以上の音声を切り分け、同一話者の重複時刻は別チャンクとして保持', async () => {
    const f = await recordingFixture([{start:123.5,ms:21000},{start:1000,ms:1000}]);
    const plan = await planTranscription(f.directory,f.metadata,f.stt);
    expect(plan.chunks.map(c => c.samples / 48)).toEqual([20000,1000,1000]);
    expect(plan.chunks[1]!.mappings[0]).toMatchObject({sourceStartSample:960000,meetingStartMs:20123.5});
    expect(plan.chunks[2]!.mappings[0]!.meetingStartMs).toBe(1000);
  });
  it('チャンク間の長い無音を送らず、時刻を詰めない', async () => {
    const f = await recordingFixture([{start:0},{start:30000}]);
    const plan = await planTranscription(f.directory,f.metadata,f.stt);
    expect(plan.chunks).toHaveLength(2); expect(plan.chunks[1]!.mappings[0]!.meetingStartMs).toBe(30000);
    expect(plan.chunks.reduce((n,c) => n + c.samples / 48,0)).toBe(2000);
  });
  it('speech分類とパスの矛盾・他人のパス・処理中セッション・ギルド不一致を拒否', async () => {
    const f = await recordingFixture(); const send = vi.fn();
    const segment = f.metadata.segments[0]!; segment.userId = B; await atomicJson(f.directory,f.metadata);
    await expect(transcribeSession(f.guild,f.session,f.stt,{}, {fetch:send})).rejects.toThrow();
    segment.userId = A; segment.vad!.classification = 'non-speech'; await atomicJson(f.directory,f.metadata);
    await expect(transcribeSession(f.guild,f.session,f.stt,{}, {fetch:send})).rejects.toThrow('一致');
    segment.vad!.classification = 'speech'; f.metadata.state = 'recording'; await atomicJson(f.directory,f.metadata);
    await expect(transcribeSession(f.guild,f.session,f.stt,{}, {fetch:send})).rejects.toThrow('終了');
    f.metadata.state = 'completed'; f.metadata.guildId = C; await atomicJson(f.directory,f.metadata);
    await expect(transcribeSession(f.guild,f.session,f.stt,{}, {fetch:send})).rejects.toThrow(); expect(send).not.toHaveBeenCalled();
  });
  it('保存先外を指すWAV symlinkを送信しない', async () => {
    const f = await recordingFixture(); const path = join(f.directory,f.metadata.segments[0]!.file);
    await unlink(path); await symlink('/etc/hosts',path); const send = vi.fn();
    await expect(transcribeSession(f.guild,f.session,f.stt,{}, {fetch:send})).rejects.toThrow(); expect(send).not.toHaveBeenCalled();
  });
});
describe('キャッシュ・失敗・予算', () => {
  it('同じ設定は再送信せず、設定変更時は再処理し、設定を戻すとキャッシュを再利用', async () => {
    const f = await recordingFixture(); const send = vi.fn(async () => azureResponse()) as typeof fetch;
    const before = await readFile(join(f.directory,f.metadata.segments[0]!.file));
    await transcribeSession(f.guild,f.session,f.stt,{}, {fetch:send});
    const again = await transcribeSession(f.guild,f.session,f.stt,{}, {fetch:send});
    expect(again.summary.cachedChunks).toBe(1); expect(again.summary.requests).toBe(0); expect(send).toHaveBeenCalledTimes(1);
    await transcribeSession(f.guild,f.session,{...f.stt,style:'clean'}, {}, {fetch:send}); expect(send).toHaveBeenCalledTimes(2);
    await transcribeSession(f.guild,f.session,f.stt,{}, {fetch:send}); expect(send).toHaveBeenCalledTimes(2);
    expect(await readFile(join(f.directory,f.metadata.segments[0]!.file))).toEqual(before);
    expect(await readdir(join(f.directory,'transcripts','cache'))).toHaveLength(2);
    const changedAudio = Buffer.from(before); changedAudio.writeInt16LE(15,44);
    const { writeFile } = await import('node:fs/promises'); await writeFile(join(f.directory,f.metadata.segments[0]!.file),changedAudio);
    await transcribeSession(f.guild,f.session,f.stt,{}, {fetch:send}); expect(send).toHaveBeenCalledTimes(3);
  });
  it('一部認証失敗・空文字は不完全として残し、成功済み結果は次回再送しない', async () => {
    const f = await recordingFixture([{userId:A},{userId:B}]);
    let n = 0; const send = vi.fn(async () => ++n === 1 ? azureResponse() : new Response('secret-key raw error', {status:401})) as typeof fetch;
    const result = await transcribeSession(f.guild,f.session,{...f.stt,maxConcurrency:1},{},{fetch:send});
    if (result.dryRun) throw new Error('expected execution');
    expect(result.bundle.incomplete).toBe(true); expect(result.bundle.utterances).toHaveLength(1); expect(result.bundle.chunks.find(c => c.status === 'failed')).toMatchObject({error:'http_error',httpStatus:401});
    expect(JSON.stringify(result)).not.toContain('secret-key');
    const again = await transcribeSession(f.guild,f.session,f.stt,{}, {fetch:vi.fn(async () => azureResponse(1000,'')) as typeof fetch});
    if (again.dryRun) throw new Error('expected execution');
    expect(again.summary.cachedChunks).toBe(1); expect(again.bundle.chunks.find(c => !c.cached)).toMatchObject({status:'needs_review',error:'empty_transcript'});
    expect(await lstat(join(f.directory,f.metadata.segments[1]!.file))).toBeDefined();
  });
  it('forceの失敗後も前回成功キャッシュを保持', async () => {
    const f = await recordingFixture(); const send = vi.fn(async () => azureResponse()) as typeof fetch;
    await transcribeSession(f.guild,f.session,f.stt,{}, {fetch:send});
    await transcribeSession(f.guild,f.session,f.stt,{force:true},{fetch:vi.fn(async () => new Response('error',{status:403})) as typeof fetch});
    const retry = await transcribeSession(f.guild,f.session,f.stt,{}, {fetch:send}); expect(retry.summary.cachedChunks).toBe(1); expect(send).toHaveBeenCalledTimes(1);
  });
  it('リトライもリクエスト数・音声時間上限に含め、429/5xxを再試行する', async () => {
    const f = await recordingFixture(); let n = 0;
    const send = vi.fn(async () => ++n === 1 ? new Response('busy',{status:429,headers:{'Retry-After':'1'}}) : azureResponse()) as typeof fetch;
    const sleep = vi.fn(async () => undefined);
    const result = await transcribeSession(f.guild,f.session,f.stt,{}, {fetch:send,sleep});
    if (result.dryRun) throw new Error('expected execution');
    expect(result.bundle.usage).toEqual({requests:2,submittedAudioSeconds:2,retries:1}); expect(sleep).toHaveBeenCalledWith(expect.any(Number));
    const limited = await transcribeSession(f.guild,f.session,{...f.stt,maxRequests:1},{force:true},{fetch:vi.fn(async () => new Response('',{status:503})) as typeof fetch,sleep});
    if (limited.dryRun) throw new Error('expected execution');
    expect(limited.bundle.chunks[0]!.error).toBe('request_limit'); expect(limited.bundle.usage.requests).toBe(1);
  });
  it('事前に予算超過を検知して一件も送らず、dry-runで範囲外を表示', async () => {
    const f = await recordingFixture([{userId:A},{userId:B}]); const send = vi.fn();
    const dry = await transcribeSession(f.guild,f.session,{...f.stt,maxAudioSeconds:1},{dryRun:true},{fetch:send}); expect(dry.summary.withinLimits).toBe(false);
    await expect(transcribeSession(f.guild,f.session,{...f.stt,maxRequests:1},{},{fetch:send})).rejects.toMatchObject({code:'request_limit'});
    await expect(transcribeSession(f.guild,f.session,{...f.stt,maxAudioSeconds:1},{},{fetch:send})).rejects.toMatchObject({code:'audio_limit'}); expect(send).not.toHaveBeenCalled();
  });
  it('複数ギルドの出力・キャッシュは独立', async () => {
    const f = await recordingFixture(), other = await recordingFixture([{}],C); const send = vi.fn(async () => azureResponse()) as typeof fetch;
    const a = await transcribeSession(f.guild,f.session,f.stt,{}, {fetch:send}), b = await transcribeSession(other.guild,other.session,other.stt,{}, {fetch:send});
    if (a.dryRun || b.dryRun) throw new Error('expected execution');
    expect(a.bundle.guildId).not.toBe(b.bundle.guildId); expect(a.bundle.chunks[0]!.chunk.id).not.toBe(b.bundle.chunks[0]!.chunk.id); expect(send).toHaveBeenCalledTimes(2);
  });
  it('同一セッションの並列実行をロックで拒否し停止後に解放', async () => {
    const f = await recordingFixture(); let release: (() => void) | undefined;
    const blocked = new Promise<void>(resolve => {release=resolve;});
    let entered: (() => void) | undefined; const started = new Promise<void>(resolve => {entered=resolve;});
    const send = vi.fn(async () => {entered!(); await blocked; return azureResponse();}) as typeof fetch;
    const first = transcribeSession(f.guild,f.session,f.stt,{}, {fetch:send}); await started;
    await expect(transcribeSession(f.guild,f.session,f.stt,{dryRun:true})).rejects.toMatchObject({code:'EEXIST'}); release!(); await first;
    expect(await readdir(f.directory)).not.toContain('.processing.lock');
  });
});
describe('レスポンス検査と設定', () => {
  it('実APIの総長丸めを許容し、元サンプルの時刻を保つ。10ms超の差は拒否', async () => {
    const f = await recordingFixture([{start:500.5,ms:86527/48}]); const plan = await planTranscription(f.directory,f.metadata,f.stt), chunk = plan.chunks[0]!;
    const value = {durationMilliseconds:1800,combinedPhrases:[{text:'発言'}],phrases:[{text:'発言',offsetMilliseconds:0,durationMilliseconds:1802}]};
    const parsed = parseAzureResult(value,chunk,f.stt.model);
    expect(parsed.apiDurationDifferenceMs).toBeCloseTo(-2.6458333333);
    expect(parsed.utterances[0]!.startOffsetMs).toBe(500.5); expect(parsed.utterances[0]!.endOffsetMs).toBe(2302.5);
    expect(() => parseAzureResult({...value,durationMilliseconds:1840},chunk,f.stt.model)).toThrow('invalid_response');
    expect(() => parseAzureResult({...value,phrases:[{text:'発言',offsetMilliseconds:0,durationMilliseconds:1900}]},chunk,f.stt.model)).toThrow('invalid_response');
  });
  it('保存した失敗応答を修正版で再検査し、APIを再送しない。dry-runではキャッシュを変更しない', async () => {
    const f = await recordingFixture([{ms:86527/48}]); const plan = await planTranscription(f.directory,f.metadata,f.stt), chunk = plan.chunks[0]!;
    const cache = await privateDirectory(f.directory,['transcripts','cache']);
    const failed = {chunk,status:'failed',error:'invalid_response',utterances:[],processedAt:'2026-10-12T00:00:00Z',cached:false,
      usage:{requests:1,retries:0,submittedAudioSeconds:chunk.samples/48000},response:{durationMilliseconds:1800,combinedPhrases:[{text:'発言'}],phrases:[{text:'発言',offsetMilliseconds:0,durationMilliseconds:1802}]}};
    await writeArtifact(cache,`${chunk.id}.json`,failed); const before=await readFile(join(cache,`${chunk.id}.json`)); const send=vi.fn();
    const dry=await transcribeSession(f.guild,f.session,f.stt,{dryRun:true},{fetch:send}); expect(dry.summary.cachedChunks).toBe(1); expect(await readFile(join(cache,`${chunk.id}.json`))).toEqual(before);
    const result=await transcribeSession(f.guild,f.session,f.stt,{}, {fetch:send});
    if (result.dryRun) throw new Error('expected execution');
    expect(result.bundle.usage.requests).toBe(0); expect(result.bundle.chunks[0]).toMatchObject({status:'succeeded',responseReprocessed:true}); expect(send).not.toHaveBeenCalled();
    const persisted=JSON.parse(await readFile(join(cache,`${chunk.id}.json`),'utf8')); expect(persisted.status).toBe('succeeded'); expect(persisted.error).toBeUndefined();
  });
  it('応答の形式不一致を保存し、再検査用の失敗応答で過去成功を上書きしない', async () => {
    const f=await recordingFixture(); const malformed=vi.fn(async()=>new Response(JSON.stringify({durationMilliseconds:1200,combinedPhrases:[{text:'発言'}],phrases:[{text:'発言',offsetMilliseconds:0,durationMilliseconds:1000}]}))) as typeof fetch;
    const first=await transcribeSession(f.guild,f.session,f.stt,{}, {fetch:malformed});
    if(first.dryRun) throw new Error('expected execution');
    const chunk=first.bundle.chunks[0]!; expect(chunk.status).toBe('failed'); expect(chunk.response!.durationMilliseconds).toBe(1200);
    await transcribeSession(f.guild,f.session,f.stt,{}, {fetch:vi.fn(async()=>azureResponse()) as typeof fetch});
    const cache=join(f.directory,'transcripts','cache',`${chunk.chunk.id}.json`); const before=await readFile(cache);
    await transcribeSession(f.guild,f.session,f.stt,{force:true},{fetch:malformed}); expect(await readFile(cache)).toEqual(before);
  });
  it('不正時刻・無音内だけの時刻を拒否し同一元発言の重複だけ排除', async () => {
    const f = await recordingFixture([{start:0},{start:1500}]); const plan = await planTranscription(f.directory,f.metadata,f.stt), chunk = plan.chunks[0]!;
    const data = (offset: number,duration: number) => ({durationMilliseconds:2500,combinedPhrases:[{text:'はい'}],phrases:[{text:'はい',offsetMilliseconds:offset,durationMilliseconds:duration}]});
    expect(() => parseAzureResult(data(-1,10),chunk,'model')).toThrow(); expect(() => parseAzureResult(data(2400,500),chunk,'model')).toThrow();
    expect(() => parseAzureResult(data(1100,100),chunk,'model')).toThrow('unmapped_timestamp');
    const parsed = parseAzureResult(data(900,700),chunk,'model'); expect(parsed.utterances[0]!.sourceSegments).toHaveLength(2);
    const result = {chunk,status:'succeeded' as const,utterances:parsed.utterances,processedAt:'now',usage:{requests:1,retries:0,submittedAudioSeconds:1},cached:false};
    expect(mergeUtterances([result,result])).toHaveLength(1);
    const other = {...result,utterances:parsed.utterances.map(u => ({...u,userId:B}))}; expect(mergeUtterances([result,other])).toHaveLength(2);
  });
  it('auto・専門用語・選択分類を設定可能。設定値と非AzureURLを拒否', () => {
    const c = sttConfig({STT_LANGUAGE:'auto',STT_PHRASES_JSON:'["Silero"]',STT_CLASSES:'speech,unclassified'});
    expect(azureDefinition(c)).not.toHaveProperty('locales'); expect(azureDefinition(c).phraseList).toEqual({phrases:['Silero']});
    for (const env of [{STT_ENABLED:'yes'},{STT_MAX_CONCURRENCY:'0'},{STT_CHUNK_SECONDS:'121'},{STT_PHRASES_JSON:'{}'},{STT_CLASSES:'anything'},{STT_MODEL:'invented'},{STT_LANGUAGE:'ja-JP'}]) expect(() => sttConfig(env)).toThrow();
    for (const url of ['http://test.cognitiveservices.azure.com','https://evil.example','https://test.cognitiveservices.azure.com/path','https://user:pw@test.cognitiveservices.azure.com']) expect(() => azureUrl(url)).toThrow();
    expect(azureUrl('https://test.cognitiveservices.azure.com')).toContain('api-version=2025-10-15');
  });
});
