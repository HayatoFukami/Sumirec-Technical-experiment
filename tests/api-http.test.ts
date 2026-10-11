import { describe, expect, it, vi } from 'vitest';
import { requestJson, RequestBudget } from '../src/api-http.js';

describe('API境界', () => {
  const config={maxRetries:2,timeoutMs:1000};
  it('429/5xxだけHTTP再試行し、Retry-Afterは30秒に制限', async () => {
    const send=vi.fn().mockResolvedValueOnce(new Response('',{status:503})).mockResolvedValueOnce(new Response('',{status:429,headers:{'Retry-After':'999999'}})).mockResolvedValueOnce(new Response('{"ok":true}'));
    const sleep=vi.fn(async (_ms: number) => undefined), budget=new RequestBudget(3,10);
    expect(await requestJson('https://example.test',()=>({}),config,budget,1,{fetch:send,sleep})).toEqual({ok:true});
    expect(budget.stats).toEqual({requests:3,submittedAudioSeconds:3,retries:2}); expect(sleep.mock.calls[1]![0]).toBe(30000);
  });
  it('401と不正JSONを再試行せず、生のAPIエラーを返さない', async () => {
    const send=vi.fn(async () => new Response('super-secret raw body',{status:401}));
    await expect(requestJson('https://example.test',()=>({}),config,new RequestBudget(3),0,{fetch:send})).rejects.toMatchObject({code:'http_error',status:401,message:'http_error'});
    expect(send).toHaveBeenCalledTimes(1);
    const malformed=vi.fn(async () => new Response('{bad'));
    await expect(requestJson('https://example.test',()=>({}),config,new RequestBudget(3),0,{fetch:malformed})).rejects.toMatchObject({code:'invalid_response'}); expect(malformed).toHaveBeenCalledTimes(1);
  });
  it('ネットワーク失敗は有限回で終了し、音声上限をリトライ時にも適用', async () => {
    const send=vi.fn(async () => {throw new Error('key-secret');}), sleep=vi.fn(async () => undefined);
    await expect(requestJson('https://example.test',()=>({}),config,new RequestBudget(10),0,{fetch:send,sleep})).rejects.toMatchObject({code:'network_error'}); expect(send).toHaveBeenCalledTimes(3);
    send.mockClear(); const budget=new RequestBudget(10,1);
    await expect(requestJson('https://example.test',()=>({}),config,budget,1,{fetch:send,sleep})).rejects.toMatchObject({code:'audio_limit'}); expect(send).toHaveBeenCalledTimes(1);
  });
  it('応答サイズ上限を超えるデータを拒否する', async () => {
    const send=vi.fn(async () => new Response('x'.repeat(8_388_609)));
    await expect(requestJson('https://example.test',()=>({}),config,new RequestBudget(3),0,{fetch:send})).rejects.toMatchObject({code:'invalid_response'}); expect(send).toHaveBeenCalledTimes(1);
  });
  it('タイムアウトで中断し、redirect:errorで鍵の他ホスト転送を防ぐ', async () => {
    const send=vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve,reject) => {
      expect(init?.redirect).toBe('error'); init!.signal!.addEventListener('abort',()=>reject(new Error('timeout')),{once:true});
    })) as typeof fetch;
    await expect(requestJson('https://example.test',()=>({}),{timeoutMs:5,maxRetries:0},new RequestBudget(1),0,{fetch:send})).rejects.toMatchObject({code:'network_error'});
  });
});
