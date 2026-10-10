import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DAVESession, NetworkingStatusCode, VoiceReceiver, VoiceConnectionStatus, joinVoiceChannel, type VoiceConnection } from '@discordjs/voice';
import { createCipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Opus = require('@discordjs/opus');
import { createDecoder } from '../src/capture.js';
import { inspectSegment } from '../src/export.js';
import { SessionManager } from '../src/session.js';
import { DiscordReceiver, type VoiceCallbacks } from '../src/receiver.js';
import { A, B, C, CHANNEL, GUILD, config, fixture as sessionFixture } from './helpers.js';

vi.mock('@discordjs/voice', async (importOriginal) => ({
  ...await importOriginal<typeof import('@discordjs/voice')>(),
  joinVoiceChannel: vi.fn(), entersState: vi.fn(async (connection: unknown) => connection),
}));
class Connection extends EventEmitter {
  state = { status: VoiceConnectionStatus.Ready, networking: Object.assign(new EventEmitter(), {
    state: { code: NetworkingStatusCode.Ready, udp: new EventEmitter(), dave: new DAVESession(1, A, CHANNEL, {}) },
  }) };
  destroys = 0;
  receiver = new VoiceReceiver(this as unknown as VoiceConnection);
  constructor() {
    super();
    // MLS鍵交換だけを差し替える。DAVESession wrapper、RTP輸送復号、配送は配布済み0.19.2。
    this.state.networking.state.dave.session = { ready: true, decrypt: (_id: string, _media: number, packet: Buffer) => packet } as DAVESession['session'];
    this.receiver.connectionData = { encryptionMode: 'aead_aes256_gcm_rtpsize', nonceBuffer: Buffer.alloc(12), secretKey: Buffer.alloc(32, 17) };
    this.state.networking.state.udp.on('message', this.receiver.onUdpMessage);
  }
  destroy(): void { this.destroys++; }
}
function fixture(diagnostics = false) {
  const connection = new Connection();
  vi.mocked(joinVoiceChannel).mockReturnValue(connection as unknown as VoiceConnection);
  const callbacks: VoiceCallbacks = { packet: vi.fn(), state: vi.fn(), failure: vi.fn(), diagnostic: vi.fn() };
  const port = new DiscordReceiver(GUILD, CHANNEL, () => ({ sendPayload: () => true, destroy: () => {} }), { diagnostics });
  return { connection, callbacks, port };
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
function rtp(ssrc: number, opus: Buffer, counter = 1): Buffer {
  const header = Buffer.alloc(12); header[0] = 0x80; header[1] = 120; header.writeUInt32BE(ssrc, 8);
  const trailer = Buffer.alloc(4); trailer.writeUInt32BE(counter);
  const nonce = Buffer.alloc(12); trailer.copy(nonce);
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 17), nonce); cipher.setAAD(header);
  return Buffer.concat([header, cipher.update(opus), cipher.final(), cipher.getAuthTag(), trailer]);
}

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
    g.connection.state.networking.state.dave.session!.ready = false;
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
  it('終了待ち中の連続更新でもclose待ちリスナーを増殖させない', async () => {
    const f = fixture(); await f.port.connect(f.callbacks); f.port.setUsers([A, B]);
    const old = f.connection.receiver.subscriptions.get(B)!;
    f.port.setUsers([A]);
    for (let i = 0; i < 30; i++) f.port.setUsers([A, B]);
    expect(old.listenerCount('close')).toBeLessThanOrEqual(3); // voice自身、購読、終了待ち各1
    await tick();
    expect(f.connection.receiver.subscriptions.get(B)).not.toBe(old);
    expect(f.connection.receiver.subscriptions.size).toBe(2);
    f.port.close(); await tick();
    expect(old.listenerCount('data')).toBe(0);
    expect(old.listenerCount('close')).toBe(0);
  });
  it('RTPからストリームへの配送をSSRC更新・削除と診断ON/OFFで追跡する', async () => {
    const f = fixture(true); await f.port.connect(f.callbacks); f.port.setUsers([A, B]);
    const udp = f.connection.state.networking.state.udp;
    f.connection.receiver.ssrcMap.update({ userId: A, audioSSRC: 101 });
    f.connection.receiver.ssrcMap.update({ userId: B, audioSSRC: 102 });
    udp.emit('message', rtp(101, Buffer.from([1])));
    udp.emit('message', rtp(102, Buffer.from([2]))); await tick();
    f.connection.receiver.ssrcMap.delete(102);
    udp.emit('message', rtp(102, Buffer.from([3]))); // 対応削除後はライブラリで配送されない
    f.connection.receiver.ssrcMap.update({ userId: B, audioSSRC: 103 });
    udp.emit('message', rtp(103, Buffer.from([4]))); await tick();
    expect(f.callbacks.packet).toHaveBeenNthCalledWith(1, A, Buffer.from([1]));
    expect(f.callbacks.packet).toHaveBeenNthCalledWith(2, B, Buffer.from([2]));
    expect(f.callbacks.packet).toHaveBeenNthCalledWith(3, B, Buffer.from([4]));
    expect(f.port.diagnostics()?.users[B]).toMatchObject({ rtpPackets: 2, opusPackets: 2, subscribed: true, ssrcKnown: true });
    expect(f.port.diagnostics()?.unknownSsrcPackets).toBe(1);
    expect(f.callbacks.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ type: 'ssrc_delete', userId: B }));
    const snapshot = f.port.diagnostics()!; snapshot.users[B]!.opusPackets = 100;
    expect(f.port.diagnostics()?.users[B]?.opusPackets).toBe(2);
    f.port.close(); await tick();
    expect(udp.listenerCount('message')).toBe(1); // voice本来の受信リスナーだけ
    expect(f.connection.state.networking.listenerCount('stateChange')).toBe(0);
    expect(f.connection.state.networking.state.dave.listenerCount('debug')).toBe(0);
    expect(f.connection.receiver.ssrcMap.listenerCount('update')).toBe(0);
    expect(f.connection.receiver.speaking.listenerCount('start')).toBe(0);
    const g = fixture(); await g.port.connect(g.callbacks); g.port.setUsers([A]);
    expect(g.port.diagnostics()).toBeUndefined(); expect(g.callbacks.diagnostic).not.toHaveBeenCalled();
    expect(g.connection.state.networking.state.udp.listenerCount('message')).toBe(1); g.port.close();
  });
  it('DAVEがnullで破棄する失敗を観測し、他話者の成功でエラーを隠さない', async () => {
    const f = fixture(true); await f.port.connect(f.callbacks); f.port.setUsers([A, B]);
    const dave = f.connection.state.networking.state.dave;
    dave.session!.decrypt = (id, _media, packet) => { if (id === B) throw new Error('secret test content'); return packet; };
    f.connection.receiver.ssrcMap.update({ userId: A, audioSSRC: 101 });
    f.connection.receiver.ssrcMap.update({ userId: B, audioSSRC: 102 });
    for (let i = 0; i < 8; i++) {
      f.connection.state.networking.state.udp.emit('message', rtp(102, Buffer.from([2]), i + 1));
      f.connection.state.networking.state.udp.emit('message', rtp(101, Buffer.from([1]), i + 1));
    }
    await tick();
    expect(f.callbacks.failure).not.toHaveBeenCalled(); // voiceの連続失敗カウンタはA成功で毎回0に戻る
    expect(f.port.diagnostics()?.dave.failureSignals).toBe(8);
    expect(f.port.diagnostics()?.users[B]).toMatchObject({ rtpPackets: 8, opusPackets: 0 });
    expect(f.port.diagnostics()?.users[A]?.opusPackets).toBe(8);
    expect(JSON.stringify(vi.mocked(f.callbacks.diagnostic!).mock.calls)).not.toContain('secret test content');
    f.port.close();
    const g = fixture(true); await g.port.connect(g.callbacks); g.port.setUsers([B]);
    g.connection.state.networking.state.dave.session!.decrypt = () => { throw new Error('private'); };
    g.connection.receiver.ssrcMap.update({ userId: B, audioSSRC: 102 });
    for (let i = 0; i < 37; i++) g.connection.state.networking.state.udp.emit('message', rtp(102, Buffer.from([2]), i + 1));
    await tick();
    expect(g.callbacks.failure).toHaveBeenCalledWith('receive_or_decrypt_error');
    expect(g.port.diagnostics()?.users[B]?.streamErrors).toBe(1);
    expect(g.connection.receiver.subscriptions.size).toBe(0); g.port.close();
  });
  it('Networking内のUDP・DAVE交換に追随し、旧リスナーを外す', async () => {
    const f = fixture(true); await f.port.connect(f.callbacks); f.port.setUsers([A]);
    const networking = f.connection.state.networking;
    const old = networking.state;
    const nextDave = new DAVESession(1, A, CHANNEL, {}); nextDave.session = old.dave.session;
    networking.state = { ...old, udp: new EventEmitter(), dave: nextDave };
    networking.emit('stateChange', old, networking.state);
    expect(old.udp.listenerCount('message')).toBe(1);
    expect(old.dave.listenerCount('debug')).toBe(0);
    old.dave.emit('debug', 'Failed to decrypt a packet (1 consecutive fails)');
    nextDave.emit('debug', 'Failed to decrypt a packet (1 consecutive fails)');
    expect(f.port.diagnostics()?.dave.failureSignals).toBe(1);
    f.port.close(); expect(nextDave.listenerCount('debug')).toBe(0);
    expect(networking.state.udp.listenerCount('message')).toBe(0);
  });
});

describe('複数ユーザーの実RTP/OpusからWAV保存まで', () => {
  it('途中参加・退出・連続変更・再接続・再購読後も正しいユーザーへPCMを保存する', async () => {
    const f = sessionFixture([A, B]); const receive = fixture(true);
    f.options.voice = receive.port;
    f.options.decoderFactory = () => ({ decode: (packet) => Buffer.alloc(960 * 4, packet[0]!), delete: () => {} });
    const cfg = await config(); cfg.diagnostics = true;
    const session = await new SessionManager(cfg).start(f.options);
    for (const [i, id] of [A, B, C].entries()) receive.connection.receiver.ssrcMap.update({ userId: id, audioSSRC: 101 + i });
    const values = new Map([[A, 1], [B, 2], [C, 3]]);
    const send = async (ids: string[]): Promise<void> => {
      f.clock.now += 100;
      for (const id of ids) receive.connection.state.networking.state.udp.emit('message', rtp(101 + [A, B, C].indexOf(id), Buffer.from([values.get(id)!])));
      await tick();
    };
    try {
      await send([A, B]);
      await session.participants([A, C]); await tick();
      await send([A, B, C]); // 退出済みBは保存されない
      const changes = [session.participants([A, B, C]), session.participants([B, C]), session.participants([A, B, C])];
      await Promise.all(changes); await tick(); await send([A, B, C]);
      const old = { ...receive.connection.state };
      receive.connection.state.status = VoiceConnectionStatus.Disconnected;
      receive.connection.emit('stateChange', old, receive.connection.state);
      await send([A, B, C]); // 切断中は保存されない
      receive.connection.state.status = VoiceConnectionStatus.Ready;
      receive.connection.emit('stateChange', old, receive.connection.state);
      await session.participants([A, B, C]); await tick(); await send([A, B, C]);
      receive.connection.receiver.subscriptions.get(B)!.destroy(); await tick();
      await send([B]);
      await session.stop();
      expect(session.metadata.state).toBe('completed');
      expect(session.metadata.reconnects).toBe(1);
      for (const id of [A, B, C]) {
        const segments = session.metadata.segments.filter((s) => s.userId === id);
        const contents = await Promise.all(segments.map(async (s) => {
          await inspectSegment(session.directory!, s); return (await readFile(join(session.directory!, s.file))).subarray(44);
        }));
        const count = id === C ? 3 : 4;
        expect(Buffer.concat(contents)).toEqual(Buffer.alloc(count * 960 * 4, values.get(id)!));
        expect(session.metadata.users[id]?.savedSamples).toBe(count * 960);
      }
      const diagnostics = session.metadata.diagnostics!;
      expect(diagnostics.events.some((e) => e.type === 'participant_joined' && e.userId === C)).toBe(true);
      expect(diagnostics.events.some((e) => e.type === 'subscription_close' && e.userId === B && e.value === 'unexpected')).toBe(true);
      const stored = JSON.parse(await readFile(join(session.directory!, 'metadata.json'), 'utf8'));
      expect(stored.diagnostics.receiver.users[B].subscriptionsStarted).toBeGreaterThan(1);
      expect(receive.connection.receiver.subscriptions.size).toBe(0);
      expect(receive.connection.state.networking.listenerCount('stateChange')).toBe(0);
    } finally { await session.stop(); }
  });
  it('実Opusのデコードエラーを話者別に記録し、受信済みの別話者PCMを確定する', async () => {
    const f = sessionFixture([A, B]); const receive = fixture(true);
    f.options.voice = receive.port; f.options.decoderFactory = createDecoder;
    const cfg = await config(); cfg.diagnostics = true;
    const session = await new SessionManager(cfg).start(f.options);
    receive.connection.receiver.ssrcMap.update({ userId: A, audioSSRC: 101 });
    receive.connection.receiver.ssrcMap.update({ userId: B, audioSSRC: 102 });
    const encoder = new Opus.OpusEncoder(48_000, 2);
    f.clock.now = 100;
    const valid = encoder.encode(Buffer.alloc(960 * 4, 12));
    receive.connection.state.networking.state.udp.emit('message', rtp(101, valid)); await tick();
    receive.connection.state.networking.state.udp.emit('message', rtp(102, Buffer.from([0xff]))); await tick();
    await session.stop();
    expect(session.metadata.state).toBe('failed'); expect(session.metadata.errorCode).toBe('decode_error');
    expect(session.metadata.users[A]?.savedSamples).toBe(960);
    expect(session.metadata.users[B]?.decodeFailures).toBe(1);
    expect(session.metadata.users[B]?.savedSamples).toBe(0);
    expect(session.metadata.diagnostics?.events).toContainEqual(expect.objectContaining({ type: 'opus_decode_error', userId: B, value: 'type_error' }));
    await inspectSegment(session.directory!, session.metadata.segments[0]!);
  });
  it.each([
    ['A先行', [A, A, B, B]], ['B先行', [B, B, A, A]],
    ['交互', [A, B, A, B]], ['同時', [A, B, A, B]], ['3人同時', [C, B, A, A, C, B]],
  ])('%sでもユーザー別の期待PCM・サンプル数・時刻を保存する', async (label, order) => {
    const users = [...new Set(order as string[])];
    const f = sessionFixture(users); const receive = fixture(true);
    f.options.voice = receive.port; f.options.decoderFactory = createDecoder;
    const cfg = await config(); cfg.diagnostics = true;
    const session = await new SessionManager(cfg).start(f.options);
    const encoders = new Map(users.map((id) => [id, new Opus.OpusEncoder(48_000, 2)]));
    const decoders = new Map(users.map((id) => [id, createDecoder()]));
    const expected = new Map(users.map((id) => [id, [] as Buffer[]]));
    for (const [i, id] of users.entries()) receive.connection.receiver.ssrcMap.update({ userId: id, audioSSRC: 101 + i });
    try {
      for (const [index, id] of (order as string[]).entries()) {
        f.clock.now = label.includes('同時') ? 100 + Math.floor(index / users.length) * 20 : 100 + index * 20;
        const pcm = Buffer.alloc(960 * 4); const hz = [440, 660, 880][[A, B, C].indexOf(id)]!;
        for (let n = 0; n < 960; n++) { const sample = Math.round(Math.sin(n * 2 * Math.PI * hz / 48_000) * 10000); pcm.writeInt16LE(sample, n * 4); pcm.writeInt16LE(sample, n * 4 + 2); }
        const packet = encoders.get(id)!.encode(pcm);
        expected.get(id)!.push(decoders.get(id)!.decode(packet));
        receive.connection.state.networking.state.udp.emit('message', rtp(101 + users.indexOf(id), packet, index + 1));
        await tick();
      }
      f.clock.now = 200; await session.stop();
      expect(session.metadata.state).toBe('completed');
      for (const id of users) {
        const segments = session.metadata.segments.filter((s) => s.userId === id);
        const contents: Buffer[] = [];
        for (const segment of segments) { await inspectSegment(session.directory!, segment); contents.push((await readFile(join(session.directory!, segment.file))).subarray(44)); }
        const actual = Buffer.concat(contents);
        expect(actual).toEqual(Buffer.concat(expected.get(id)!));
        expect(actual.some((byte) => byte !== 0)).toBe(true);
        expect(session.metadata.users[id]).toMatchObject({ packets: 2, decodeSuccesses: 2, savedSamples: 1920, audioDurationMs: 40 });
        expect(session.metadata.diagnostics?.receiver?.users[id]).toMatchObject({ rtpPackets: 2, opusPackets: 2 });
      }
      if (label.includes('同時')) expect(new Set(session.metadata.segments.map((s) => s.startOffsetMs)).size).toBe(1);
    } finally { await session.stop(); for (const decoder of decoders.values()) decoder.delete(); }
  });
});
