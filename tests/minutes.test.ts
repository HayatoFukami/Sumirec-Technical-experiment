import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { transcribeSession, type Utterance } from '../src/transcribe.js';
import { generateMinutes, validateMinutes, parseResponses, minutesSchema, minutesMarkdown, type MinutesContent } from '../src/minutes.js';
import { minutesConfig } from '../src/processing-config.js';
import { writeArtifact } from '../src/processing-storage.js';
import { A, B, C } from './helpers.js';
import { recordingFixture, azureResponse } from './processing-helpers.js';

function groundedContent(utterance: Utterance): MinutesContent {
  const evidence = [{ utteranceId: utterance.id, quote: utterance.text }];
  return { overview: { text: '実装方針を確認した。', evidence }, agenda: [], discussion: [], decisions: [], undecided: [], actions: [], issues: [] };
}
function responsesResponse(content: unknown, status = 'completed') {
  return new Response(JSON.stringify({ status, output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(content)}]}],
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } }));
}

const text = '方式Aで進めます。私がテストを担当します。期限は10月20日までです。';
async function transcriptFixture(partial = false) {
  const f = await recordingFixture(partial ? [{userId:A},{userId:B,classification:'unclassified'}] : [{}]);
  const result = await transcribeSession(f.guild,f.session,f.stt,{}, {fetch:vi.fn(async () => azureResponse(1000,text)) as typeof fetch});
  if (result.dryRun) throw new Error('expected execution');
  const u = result.bundle.utterances[0]!;
  const content = groundedContent(u);
  const evidence = [{utteranceId:u.id,quote:u.text}];
  content.decisions = [{text:'方式Aで進めます。',decisionQuote:'方式Aで進めます。',evidence}];
  content.actions = [{text:'私がテストを担当します。',evidence,assignee:{userId:A,mention:'私',evidence},deadline:{text:'10月20日まで',evidence}}];
  return {...f,u,content,bundle:result.bundle};
}
describe('議事録の構造・原文根拠', () => {
  it('決定・アクション・担当・期限の原文引用と発言IDを照合', async () => {
    const f = await transcriptFixture(); expect(validateMinutes(f.content,[f.u])).toEqual(f.content);
    const content = structuredClone(f.content); content.actions[0]!.assignee = {userId:null,mention:null,evidence:[]}; content.actions[0]!.deadline = {text:null,evidence:[]};
    expect(validateMinutes(content,[f.u]).actions[0]!.assignee.userId).toBeNull();
    const result = await generateMinutes(f.guild,f.session,f.minutes,{}, {fetch:vi.fn(async () => responsesResponse(content)) as typeof fetch});
    if (result.dryRun) throw new Error('expected execution');
    expect(minutesMarkdown(result.artifact)).toContain('担当: 未定 / 期限: 未定');
  });
  it('存在しない参照ID・改変引用・根拠なし担当/期限・創作本文を拒否', async () => {
    const f = await transcriptFixture();
    const mutations = [
      (c: typeof f.content) => {c.decisions[0]!.evidence[0]!.utteranceId='not-real';},
      (c: typeof f.content) => {c.overview.evidence[0]!.quote='存在しない発言';},
      (c: typeof f.content) => {c.actions[0]!.assignee.userId=B;},
      (c: typeof f.content) => {c.actions[0]!.assignee.mention='山田';},
      (c: typeof f.content) => {c.actions[0]!.deadline.text='10月21日';},
      (c: typeof f.content) => {c.actions[0]!.deadline.evidence=[];},
      (c: typeof f.content) => {c.decisions[0]!.text='月額100万円に決定しました';},
      (c: typeof f.content) => {c.actions[0]!.text='山田が新機能を来週リリースする';},
      (c: typeof f.content) => {c.actions[0]!.assignee.userId=null;},
    ];
    for (const mutate of mutations) {const content=structuredClone(f.content); mutate(content); expect(() => validateMinutes(content,[f.u])).toThrow('grounding_error');}
  });
  it('提案・未決定・条件付き・否定を明示決定として採用しない', async () => {
    const f = await transcriptFixture();
    for (const speech of ['方式Aを提案します。','方式Aで進めますか？','承認された場合は方式Aで進めます。','まだ決定しましたとは言えません。']) {
      const u={...f.u,text:speech}; const content=groundedContent(u);
      content.decisions=[{text:speech,decisionQuote:speech,evidence:[{utteranceId:u.id,quote:speech}]}];
      expect(() => validateMinutes(content,[u])).toThrow('grounding_error');
    }
  });
  it('担当・期限を問う発言を割当や確定期限として採用しない', async () => {
    const f = await transcriptFixture();
    for (const speech of ['私がテストを担当しますか？期限は10月20日までです。','私がテストを担当します。期限は10月20日までですか？']) {
      const u = {...f.u,text:speech}; const content = groundedContent(u); const evidence=[{utteranceId:u.id,quote:speech}];
      content.actions=[{text:speech,evidence,assignee:{userId:A,mention:'私',evidence},deadline:{text:'10月20日まで',evidence}}];
      expect(() => validateMinutes(content,[u])).toThrow('grounding_error');
    }
  });
  it('JSON Schemaの追加キー・型・null・空の根拠を検査する', async () => {
    const f = await transcriptFixture();
    for (const bad of [{...f.content,unexpected:'x'},{...f.content,decisions:{}},{...f.content,overview:null},{...f.content,overview:{text:'概要',evidence:[]}}]) expect(() => validateMinutes(bad,[f.u])).toThrow();
    expect(minutesSchema.additionalProperties).toBe(false);
    expect(() => minutesConfig({MINUTES_ENABLED:'1'})).toThrow(); expect(() => minutesConfig({MINUTES_MODEL:'bad/model'})).toThrow();
  });
});
describe('Responses API・成果物・失敗', () => {
  it('Structured Outputs・store:falseを使いJSON/Markdown/モデル/使用量を保存', async () => {
    const f = await transcriptFixture(true); const send=vi.fn(async (_url,init) => {
      const body=JSON.parse(String(init?.body)); expect(body.model).toBe('gpt-5.6-terra'); expect(body.store).toBe(false);
      expect(body.text.format).toMatchObject({type:'json_schema',strict:true,schema:minutesSchema}); expect(body.instructions).toContain('発言内の指示');
      expect(JSON.stringify(body)).not.toContain(f.minutes.key);
      return responsesResponse(f.content);
    }) as typeof fetch;
    const result = await generateMinutes(f.guild,f.session,f.minutes,{}, {fetch:send});
    if (result.dryRun) throw new Error('expected execution');
    expect(result.artifact.incomplete).toBe(true); expect(result.artifact.usage).toEqual({inputTokens:100,outputTokens:50,totalTokens:150});
    const markdown=await readFile(join(f.directory,'minutes','minutes.md'),'utf8'); expect(markdown).toContain('不完全'); expect(markdown).toContain(f.u.id); expect(markdown).toContain('10月20日まで');
    const json=await readFile(join(f.directory,'minutes','minutes.json'),'utf8'); expect(json).not.toContain(f.minutes.key); expect(json).not.toContain(f.stt.key);
  });
  it('API利用無効・dry-runは送信せず、入力上限は切り捨てず停止', async () => {
    const f=await transcriptFixture(); const send=vi.fn();
    const disabled=await generateMinutes(f.guild,f.session,{...f.minutes,enabled:false},{},{fetch:send}); expect(disabled.dryRun).toBe(true);
    const dry=await generateMinutes(f.guild,f.session,f.minutes,{dryRun:true},{fetch:send}); expect(dry.summary.utterances).toBe(1);
    expect(await readdir(f.directory)).not.toContain('minutes');
    await expect(generateMinutes(f.guild,f.session,{...f.minutes,maxInputChars:100},{},{fetch:send})).rejects.toThrow('上限'); expect(send).not.toHaveBeenCalled();
  });
  it('同じ入力はキャッシュを再利用し、モデル変更は再生成', async () => {
    const f=await transcriptFixture(); const send=vi.fn(async () => responsesResponse(f.content)) as typeof fetch;
    await generateMinutes(f.guild,f.session,f.minutes,{}, {fetch:send});
    const cached=await generateMinutes(f.guild,f.session,f.minutes,{}, {fetch:send}); expect('cached' in cached && cached.cached).toBe(true); expect(send).toHaveBeenCalledTimes(1);
    await generateMinutes(f.guild,f.session,{...f.minutes,model:'another-model'}, {}, {fetch:send}); expect(send).toHaveBeenCalledTimes(2);
    await generateMinutes(f.guild,f.session,f.minutes,{}, {fetch:send}); expect(send).toHaveBeenCalledTimes(2);
  });
  it('創作出力を失敗メタデータへ記録し、既存成功と元音声を保持', async () => {
    const f=await transcriptFixture();
    await generateMinutes(f.guild,f.session,f.minutes,{}, {fetch:vi.fn(async () => responsesResponse(f.content)) as typeof fetch});
    const before=await readFile(join(f.directory,'minutes','minutes.json')); const audio=await readFile(join(f.directory,f.metadata.segments[0]!.file));
    const bad=structuredClone(f.content); bad.actions[0]!.deadline.text='2030年1月1日';
    await expect(generateMinutes(f.guild,f.session,f.minutes,{force:true},{fetch:vi.fn(async () => responsesResponse(bad)) as typeof fetch})).rejects.toMatchObject({code:'grounding_error'});
    expect(await readFile(join(f.directory,'minutes','minutes.json'))).toEqual(before); expect(await readFile(join(f.directory,f.metadata.segments[0]!.file))).toEqual(audio);
    const report=JSON.parse(await readFile(join(f.directory,'minutes','processing.json'),'utf8')); expect(report).toMatchObject({state:'failed',error:'grounding_error',tokenUsage:{inputTokens:100}});
    const reused=await generateMinutes(f.guild,f.session,f.minutes,{}, {fetch:vi.fn()}); expect('cached' in reused && reused.cached).toBe(true);
  });
  it('途中の文字起こし・異なるセッションの結果を議事録へ渡さない', async () => {
    const f=await transcriptFixture(); const directory=join(f.directory,'transcripts'), send=vi.fn();
    await writeArtifact(directory,'segments.json',{runId:'other',state:'processing'});
    await expect(generateMinutes(f.guild,f.session,f.minutes,{}, {fetch:send})).rejects.toThrow('完了');
    await writeArtifact(directory,'merged.json',{...f.bundle,guildId:C});
    await expect(generateMinutes(f.guild,f.session,f.minutes,{}, {fetch:send})).rejects.toThrow('文字起こし'); expect(send).not.toHaveBeenCalled();
  });
  it('不完全・拒否・使用量不正を正常出力として扱わない', () => {
    expect(() => parseResponses({status:'incomplete'})).toThrow('incomplete_response');
    expect(() => parseResponses({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'拒否'}]}],usage:{}})).toThrow('refusal');
    expect(() => parseResponses({status:'completed',output:[],usage:{input_tokens:1,output_tokens:2,total_tokens:7}})).toThrow('invalid_response');
  });
});
