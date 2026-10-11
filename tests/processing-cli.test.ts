import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { recordingFixture, azureResponse } from './processing-helpers.js';
import { transcribeSession } from '../src/transcribe.js';

const run = promisify(execFile);
describe('手動CLI（通信なし）', () => {
  it('transcribeのdry-runは件数と音声長だけを表示しID・音声・鍵を出さない', async () => {
    const f = await recordingFixture();
    const { stdout, stderr } = await run(process.execPath, ['--import','tsx',join(process.cwd(),'src/transcribe-cli.ts'),f.guild,f.session,'--dry-run'], {
      env: {...process.env, RECORDINGS_DIR:f.root, STT_ENABLED:'false'},
    });
    const output=JSON.parse(stdout); expect(output).toMatchObject({event:'transcription_dry_run',files:1,requests:1,audioSeconds:1,disabled:true});
    expect(stdout).not.toContain(f.guild); expect(stdout).not.toContain(f.session); expect(stderr).toBe('');
  });
  it('minutesの送信無効時はLLM通信しないCLI経路で入力件数を表示', async () => {
    const f=await recordingFixture();
    await transcribeSession(f.guild,f.session,f.stt,{}, {fetch:vi.fn(async () => azureResponse()) as typeof fetch});
    const { stdout } = await run(process.execPath,['--import','tsx',join(process.cwd(),'src/minutes-cli.ts'),f.guild,f.session], {
      env:{...process.env,RECORDINGS_DIR:f.root,MINUTES_ENABLED:'false',OPENAI_API_KEY:''},
    });
    expect(JSON.parse(stdout)).toMatchObject({event:'minutes_dry_run',disabled:true,utterances:1});
  });
  it('無効な引数を固定メッセージ・終了コード1で拒否', async () => {
    await expect(run(process.execPath,['--import','tsx',join(process.cwd(),'src/transcribe-cli.ts'),'../private','anything'])).rejects.toMatchObject({code:1});
  });
});
