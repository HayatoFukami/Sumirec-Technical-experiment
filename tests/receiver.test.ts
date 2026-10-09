import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AudioReceiveStream, EndBehaviorType, NetworkingStatusCode, SSRCMap, VoiceConnectionStatus, joinVoiceChannel, type VoiceConnection } from '@discordjs/voice';
import { DiscordReceiver, type VoiceCallbacks } from '../src/receiver.js';
import { A, B, CHANNEL, GUILD } from './helpers.js';

vi.mock('@discordjs/voice', async (importOriginal) => ({
  ...await importOriginal<typeof import('@discordjs/voice')>(),
  joinVoiceChannel: vi.fn(), entersState: vi.fn(async (connection: unknown) => connection),
}));
class Connection extends EventEmitter {
  state = { status: VoiceConnectionStatus.Ready, networking: { state: { code: NetworkingStatusCode.Ready, dave: { protocolVersion: 1, session: { ready: true } } } } };
  destroys = 0;
  receiver = {
    ssrcMap: new SSRCMap(), subscriptions: new Map<string, AudioReceiveStream>(),
    subscribe: (userId: string) => {
      const old = this.receiver.subscriptions.get(userId); if (old) return old;
      const stream = new AudioReceiveStream({ end: { behavior: EndBehaviorType.Manual } });
      stream.once('close', () => this.receiver.subscriptions.delete(userId));
      this.receiver.subscriptions.set(userId, stream); return stream;
    },
  };
  destroy(): void { this.destroys++; }
}
function fixture() {
  const connection = new Connection();
  vi.mocked(joinVoiceChannel).mockReturnValue(connection as unknown as VoiceConnection);
  const callbacks: VoiceCallbacks = { packet: vi.fn(), state: vi.fn(), failure: vi.fn() };
  const port = new DiscordReceiver(GUILD, CHANNEL, () => ({ sendPayload: () => true, destroy: () => {} }));
  return { connection, callbacks, port };
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('Discord音声受信アダプター', () => {
  it('DAVEを有効に接続し、指定したユーザーだけをSSRCで紐付けて受信する', async () => {
    const f = fixture(); await f.port.connect(f.callbacks);
    expect(joinVoiceChannel).toHaveBeenLastCalledWith(expect.objectContaining({ selfDeaf: false, selfMute: true, daveEncryption: true }));
    expect(f.connection.receiver.subscriptions.size).toBe(0);
    f.port.setUsers([A]);
    f.connection.receiver.ssrcMap.update({ userId: A, audioSSRC: 123 });
    f.connection.receiver.subscriptions.get(A)!.push(Buffer.from([1])); await tick();
    expect(f.callbacks.packet).toHaveBeenCalledWith(A, Buffer.from([1]));
    expect(f.connection.receiver.subscriptions.has(B)).toBe(false);
    f.port.setUsers([]); await tick();
    expect(f.connection.receiver.subscriptions.size).toBe(0);
    f.port.close(); f.port.close();
    expect(f.connection.destroys).toBe(1);
    expect(f.connection.listenerCount('stateChange')).toBe(0);
    expect(f.connection.listenerCount('error')).toBe(0);
  });
  it('自然終了後と購読停止直後の再開で購読を再生成する', async () => {
    const f = fixture(); await f.port.connect(f.callbacks); f.port.setUsers([A]);
    const first = f.connection.receiver.subscriptions.get(A)!;
    first.destroy(); await tick();
    const second = f.connection.receiver.subscriptions.get(A)!;
    expect(second).not.toBe(first);
    f.port.setUsers([]); f.port.setUsers([A]); await tick();
    const third = f.connection.receiver.subscriptions.get(A)!;
    expect(third).not.toBe(second); expect(third.destroyed).toBe(false);
    f.port.close(); await tick(); expect(f.connection.receiver.subscriptions.size).toBe(0);
  });
  it('DAVE未確立、鍵消失、SSRC不明、復号エラーを成功扱いしない', async () => {
    const f = fixture(); f.connection.state.networking.state.dave.protocolVersion = 0;
    await expect(f.port.connect(f.callbacks)).rejects.toThrow('DAVE'); f.port.close();
    const g = fixture(); await g.port.connect(g.callbacks); g.port.setUsers([A]);
    g.connection.state.networking.state.dave.session.ready = false;
    g.connection.receiver.subscriptions.get(A)!.push(Buffer.from([1])); await tick();
    expect(g.callbacks.failure).toHaveBeenCalledWith('dave_keys_unavailable');
    expect(g.callbacks.packet).not.toHaveBeenCalled(); g.port.close();
    const h = fixture(); await h.port.connect(h.callbacks); h.port.setUsers([A]);
    const stream = h.connection.receiver.subscriptions.get(A)!;
    stream.push(Buffer.from([1])); await tick();
    expect(h.callbacks.failure).toHaveBeenCalledWith('ssrc_mapping_missing');
    stream.destroy(new Error('test decrypt failure')); await tick();
    expect(h.callbacks.failure).toHaveBeenCalledWith('receive_or_decrypt_error');
    expect(h.connection.receiver.subscriptions.size).toBe(0); h.port.close();
  });
});
