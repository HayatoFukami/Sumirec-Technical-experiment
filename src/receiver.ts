import {
  EndBehaviorType, entersState, joinVoiceChannel, NetworkingStatusCode,
  VoiceConnectionStatus, type AudioReceiveStream, type DiscordGatewayAdapterCreator,
  type VoiceConnection, type VoiceConnectionState,
} from '@discordjs/voice';
import { setTimeout as delay } from 'node:timers/promises';

export interface VoiceCallbacks {
  packet(userId: string, packet: Buffer): void;
  state(status: string): void;
  failure(code: string): void;
}
export interface VoicePort {
  connect(callbacks: VoiceCallbacks): Promise<void>;
  setUsers(users: string[]): void;
  close(): void;
}
export class DiscordReceiver implements VoicePort {
  private connection?: VoiceConnection;
  private callbacks?: VoiceCallbacks;
  private readonly streams = new Map<string, AudioReceiveStream>();
  private desired = new Set<string>();
  private closed = false;
  private readonly abort = new AbortController();
  constructor(
    private readonly guildId: string,
    private readonly channelId: string,
    private readonly adapterCreator: DiscordGatewayAdapterCreator,
  ) {}
  private daveReady(): boolean {
    const state = this.connection?.state;
    if (state?.status !== VoiceConnectionStatus.Ready) return false;
    const networking = state.networking.state;
    return networking.code === NetworkingStatusCode.Ready &&
      !!networking.dave?.session && networking.dave.protocolVersion > 0;
  }
  private keysReady(): boolean {
    const state = this.connection?.state;
    if (state?.status !== VoiceConnectionStatus.Ready) return false;
    const networking = state.networking.state;
    return networking.code === NetworkingStatusCode.Ready && !!networking.dave?.session?.ready;
  }
  async connect(callbacks: VoiceCallbacks): Promise<void> {
    this.callbacks = callbacks;
    const connection = joinVoiceChannel({
      guildId: this.guildId, channelId: this.channelId, adapterCreator: this.adapterCreator,
      selfDeaf: false, selfMute: true, daveEncryption: true, debug: false,
    });
    this.connection = connection;
    connection.on('stateChange', this.onState);
    connection.on('error', this.onError);
    callbacks.state(connection.state.status);
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    // Voice ReadyだけではMLS鍵の準備完了を意味しない。
    const deadline = performance.now() + 20_000;
    while (this.daveReady() && !this.keysReady() && performance.now() < deadline) {
      await delay(50, undefined, { signal: this.abort.signal });
    }
    if (this.closed) throw new Error('接続処理は中止されました。');
    if (!this.daveReady() || !this.keysReady()) throw new Error('DAVEセッションを確立できませんでした。');
  }
  private readonly onError = (): void => { this.callbacks?.failure('voice_error'); };
  private readonly onState = (_old: VoiceConnectionState, next: VoiceConnectionState): void => {
    this.callbacks?.state(next.status);
    if (next.status !== VoiceConnectionStatus.Ready) this.destroyStreams();
    else if (!this.daveReady()) this.callbacks?.failure('dave_unavailable');
  };
  setUsers(users: string[]): void {
    this.desired = new Set(users);
    for (const [userId, stream] of this.streams) {
      if (!this.desired.has(userId)) { this.streams.delete(userId); stream.destroy(); }
    }
    if (!users.length) return;
    if (!this.daveReady()) { this.callbacks?.failure('dave_unavailable'); return; }
    for (const userId of users) this.subscribe(userId);
  }
  private subscribe(userId: string): void {
    const connection = this.connection;
    if (!connection || this.closed || this.streams.has(userId) || !this.desired.has(userId)) return;
    const previous = connection.receiver.subscriptions.get(userId);
    if (previous?.destroyed) {
      previous.once('close', () => queueMicrotask(() => this.subscribe(userId)));
      return;
    }
    // speakingイベントより前に購読し、先頭パケットを取り逃さない。
    const stream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    this.streams.set(userId, stream);
    let errored = false;
    stream.on('error', () => { errored = true; this.callbacks?.failure('receive_or_decrypt_error'); });
    stream.on('data', (packet: Buffer) => {
      if (this.closed || stream.destroyed || this.streams.get(userId) !== stream || !this.desired.has(userId)) return;
      if (!this.daveReady()) { this.callbacks?.failure('dave_unavailable'); return; }
      if (!this.keysReady()) {
        this.callbacks?.failure('dave_keys_unavailable'); return;
      }
      // SSRCはライブラリが更新/削除する。既知のユーザー対応がないパケットは保存しない。
      if (!connection.receiver.ssrcMap.get(userId)) { this.callbacks?.failure('ssrc_mapping_missing'); return; }
      this.callbacks?.packet(userId, packet);
    });
    stream.once('close', () => {
      if (this.streams.get(userId) === stream) this.streams.delete(userId);
      if (!errored && !this.closed && this.desired.has(userId) && this.daveReady()) {
        // receiver自身のcloseリスナーによる購読Map削除後に再購読する。
        queueMicrotask(() => this.subscribe(userId));
      }
    });
  }
  private destroyStreams(): void {
    for (const stream of this.streams.values()) stream.destroy();
    this.streams.clear();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.desired.clear();
    this.destroyStreams();
    const connection = this.connection;
    if (connection) {
      connection.off('stateChange', this.onState);
      connection.off('error', this.onError);
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    }
    this.callbacks = undefined;
  }
}
