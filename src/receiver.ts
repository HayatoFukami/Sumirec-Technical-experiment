import {
  EndBehaviorType, entersState, joinVoiceChannel, NetworkingStatusCode, RTP_OPUS_PAYLOAD_TYPE,
  VoiceConnectionStatus, type AudioReceiveStream, type DiscordGatewayAdapterCreator,
  type VoiceConnection, type VoiceConnectionState,
  type DAVESession, type Networking, type VoiceUDPSocket, type VoiceUserData,
} from '@discordjs/voice';
import { setTimeout as delay } from 'node:timers/promises';
import { errorCategory, type DiagnosticEvent, type ReceiveMetrics, type ReceiverDiagnostics } from './diagnostics.js';

export interface VoiceCallbacks {
  packet(userId: string, packet: Buffer): void;
  state(status: string): void;
  failure(code: string): void;
  diagnostic?(event: DiagnosticEvent): void;
}
export interface VoicePort {
  connect(callbacks: VoiceCallbacks): Promise<void>;
  setUsers(users: string[]): void;
  close(): void;
  diagnostics?(): ReceiverDiagnostics | undefined;
}
export class DiscordReceiver implements VoicePort {
  private connection?: VoiceConnection;
  private callbacks?: VoiceCallbacks;
  private readonly streams = new Map<string, AudioReceiveStream>();
  private readonly waiting = new Map<AudioReceiveStream, () => void>();
  private readonly metrics = new Map<string, ReceiveMetrics>();
  private networking?: Networking;
  private udp?: VoiceUDPSocket;
  private dave?: DAVESession;
  private unknownSsrcPackets = 0;
  private daveFailureSignals = 0;
  private daveErrorSignals = 0;
  private desired = new Set<string>();
  private closed = false;
  private readonly abort = new AbortController();
  constructor(
    private readonly guildId: string,
    private readonly channelId: string,
    private readonly adapterCreator: DiscordGatewayAdapterCreator,
    private readonly options: { diagnostics?: boolean } = {},
  ) {}
  private diagnostic(type: string, userId?: string, value?: string): void {
    if (this.options.diagnostics) this.callbacks?.diagnostic?.({ type, ...(userId ? { userId } : {}), ...(value ? { value } : {}) });
  }
  private userMetrics(userId: string): ReceiveMetrics | undefined {
    if (!this.options.diagnostics) return undefined;
    let metrics = this.metrics.get(userId);
    if (!metrics) {
      // セッションの累計参加者上限と揃え、診断だけでメモリが増え続けないようにする。
      if (this.metrics.size >= 500) return undefined;
      metrics = { subscriptionsStarted: 0, subscriptionsClosed: 0, streamErrors: 0,
        rtpPackets: 0, opusPackets: 0, speakingStarts: 0, lastRtpAt: null, lastOpusAt: null,
        desired: false, subscribed: false, ssrcKnown: false };
      this.metrics.set(userId, metrics);
    }
    return metrics;
  }
  diagnostics(): ReceiverDiagnostics | undefined {
    if (!this.options.diagnostics) return undefined;
    return {
      users: Object.fromEntries([...this.metrics].map(([id, metrics]) => [id, { ...metrics,
        desired: this.desired.has(id), subscribed: this.streams.has(id) &&
          !this.streams.get(id)!.destroyed && this.connection?.receiver.subscriptions.get(id) === this.streams.get(id),
        ssrcKnown: !!this.connection?.receiver.ssrcMap.get(id) }])),
      unknownSsrcPackets: this.unknownSsrcPackets,
      dave: { failureSignals: this.daveFailureSignals, errorSignals: this.daveErrorSignals,
        protocolVersion: this.dave?.protocolVersion ?? null, ready: !!this.dave?.session?.ready,
        reinitializing: this.dave?.reinitializing ?? false },
    };
  }
  private readonly onSsrcCreate = (data: VoiceUserData): void => {
    if (this.metrics.has(data.userId)) this.diagnostic('ssrc_create', data.userId, `audioSSRC=${data.audioSSRC}`);
  };
  private readonly onSsrcUpdate = (_old: VoiceUserData | undefined, data: VoiceUserData): void => {
    if (this.metrics.has(data.userId)) this.diagnostic('ssrc_update', data.userId, `audioSSRC=${data.audioSSRC}`);
  };
  private readonly onSsrcDelete = (data: VoiceUserData): void => {
    if (this.metrics.has(data.userId)) this.diagnostic('ssrc_delete', data.userId, `audioSSRC=${data.audioSSRC}`);
  };
  private readonly onSpeaking = (id: string): void => {
    const metrics = this.metrics.get(id);
    if (metrics) { metrics.speakingStarts++; this.diagnostic('speaking_start', id); }
  };
  private readonly onUdp = (packet: Buffer): void => {
    // RTPの識別情報だけを読む。暗号本文を保持せず、復号・配送経路には介入しない。
    if (packet.length < 12 || packet[0]! >> 6 !== 2 || (packet[1]! & 127) !== RTP_OPUS_PAYLOAD_TYPE) return;
    const data = this.connection?.receiver.ssrcMap.get(packet.readUInt32BE(8));
    if (!data) { this.unknownSsrcPackets++; return; }
    const metrics = this.metrics.get(data.userId);
    if (metrics && this.desired.has(data.userId)) {
      metrics.rtpPackets++; metrics.lastRtpAt = new Date().toISOString();
    }
  };
  private readonly onDaveDebug = (message: string): void => {
    // 0.19.2の既知メッセージを固定イベントへ変換し、生のdebug文字列は保存しない。
    if (message.startsWith('Failed to decrypt a packet (')) {
      this.daveFailureSignals++;
      // パケット毎のイベントを避け、初回と件数が倍増したときだけ記録。
      const n = this.daveFailureSignals;
      if ((n & (n - 1)) === 0) this.diagnostic('dave_decrypt_failure', undefined, `signals=${n}`);
    } else if (message.startsWith('Transition executed (')) this.diagnostic('dave_transition');
    else if (message.startsWith('Invalidating transition ')) this.diagnostic('dave_invalid_transition');
    else if (message.startsWith('Session reinitialized for protocol version ')) this.diagnostic('dave_reinitialized');
  };
  private readonly onDaveError = (error: Error): void => {
    this.daveErrorSignals++; this.diagnostic('dave_error', undefined, errorCategory(error));
  };
  private readonly onNetworkingState = (): void => { this.bindNetworkDiagnostics(); };
  private bindNetworkDiagnostics(): void {
    if (!this.options.diagnostics || this.closed) return;
    const state = this.connection?.state;
    const networking = state && 'networking' in state ? state.networking : undefined;
    if (this.networking !== networking) {
      this.networking?.off('stateChange', this.onNetworkingState);
      this.networking = networking;
      networking?.on('stateChange', this.onNetworkingState);
    }
    const networkState = networking?.state;
    const udp = networkState && 'udp' in networkState ? networkState.udp : undefined;
    if (this.udp !== udp) {
      this.udp?.off('message', this.onUdp); this.udp = udp;
      // receiverが復号失敗で同期的に停止しても、受信数を先に観測する。
      udp?.prependListener('message', this.onUdp);
    }
    const dave = networkState && 'dave' in networkState ? networkState.dave : undefined;
    if (this.dave !== dave) {
      this.dave?.off('debug', this.onDaveDebug); this.dave?.off('error', this.onDaveError);
      this.dave = dave;
      dave?.on('debug', this.onDaveDebug); dave?.on('error', this.onDaveError);
      this.diagnostic('dave_state', undefined, `protocolVersion=${dave?.protocolVersion ?? 'none'};ready=${!!dave?.session?.ready}`);
    }
  }
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
    if (this.options.diagnostics) {
      connection.receiver.ssrcMap.on('create', this.onSsrcCreate);
      connection.receiver.ssrcMap.on('update', this.onSsrcUpdate);
      connection.receiver.ssrcMap.on('delete', this.onSsrcDelete);
      connection.receiver.speaking.on('start', this.onSpeaking);
      this.bindNetworkDiagnostics();
    }
    callbacks.state(connection.state.status);
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    // Voice ReadyだけではMLS鍵の準備完了を意味しない。
    const deadline = performance.now() + 20_000;
    while (this.daveReady() && !this.keysReady() && performance.now() < deadline) {
      await delay(50, undefined, { signal: this.abort.signal });
    }
    if (this.closed) throw new Error('接続処理は中止されました。');
    if (!this.daveReady() || !this.keysReady()) throw new Error('DAVEセッションを確立できませんでした。');
    this.diagnostic('dave_keys_ready');
  }
  private readonly onError = (error: Error): void => {
    this.diagnostic('voice_error', undefined, errorCategory(error)); this.callbacks?.failure('voice_error');
  };
  private readonly onState = (_old: VoiceConnectionState, next: VoiceConnectionState): void => {
    this.callbacks?.state(next.status);
    this.bindNetworkDiagnostics();
    if (next.status !== VoiceConnectionStatus.Ready) this.destroyStreams();
    else if (!this.daveReady()) this.callbacks?.failure('dave_unavailable');
  };
  setUsers(users: string[]): void {
    if (this.closed) return;
    this.desired = new Set(users);
    for (const userId of this.desired) this.userMetrics(userId);
    this.diagnostic('subscriptions_requested', undefined, `users=${this.desired.size}`);
    for (const [userId, stream] of this.streams) {
      if (!this.desired.has(userId)) {
        this.diagnostic('subscription_stop', userId, 'users_changed');
        this.streams.delete(userId); stream.destroy();
      }
    }
    if (!users.length) return;
    if (!this.daveReady()) { this.callbacks?.failure('dave_unavailable'); return; }
    for (const userId of this.desired) this.subscribe(userId);
  }
  private subscribe(userId: string): void {
    const connection = this.connection;
    if (!connection || this.closed || this.streams.has(userId) || !this.desired.has(userId)) return;
    const previous = connection.receiver.subscriptions.get(userId);
    if (previous?.destroyed) {
      // 同じtickで参加者更新が連続してもclose待ちを重複登録しない。
      if (!this.waiting.has(previous)) {
        const onClose = (): void => {
          this.waiting.delete(previous);
          queueMicrotask(() => this.subscribe(userId));
        };
        this.waiting.set(previous, onClose);
        previous.once('close', onClose);
        this.diagnostic('subscription_wait_close', userId);
      }
      return;
    }
    // speakingイベントより前に購読し、先頭パケットを取り逃さない。
    const stream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    this.streams.set(userId, stream);
    const metrics = this.userMetrics(userId);
    if (metrics) metrics.subscriptionsStarted++;
    this.diagnostic('subscription_start', userId, `ssrcKnown=${!!connection.receiver.ssrcMap.get(userId)}`);
    let errored = false;
    const onError = (error: Error): void => {
      errored = true;
      if (metrics) metrics.streamErrors++;
      this.diagnostic('receive_or_decrypt_error', userId, errorCategory(error));
      this.callbacks?.failure('receive_or_decrypt_error');
    };
    const onData = (packet: Buffer): void => {
      if (this.closed || stream.destroyed || this.streams.get(userId) !== stream || !this.desired.has(userId)) return;
      if (!this.daveReady()) { this.diagnostic('dave_unavailable', userId); this.callbacks?.failure('dave_unavailable'); return; }
      if (!this.keysReady()) {
        this.diagnostic('dave_keys_unavailable', userId);
        this.callbacks?.failure('dave_keys_unavailable'); return;
      }
      // SSRCはライブラリが更新/削除する。既知のユーザー対応がないパケットは保存しない。
      if (!connection.receiver.ssrcMap.get(userId)) { this.diagnostic('ssrc_mapping_missing', userId); this.callbacks?.failure('ssrc_mapping_missing'); return; }
      if (metrics) { metrics.opusPackets++; metrics.lastOpusAt = new Date().toISOString(); }
      this.callbacks?.packet(userId, packet);
    };
    stream.on('error', onError);
    stream.on('data', onData);
    stream.once('close', () => {
      stream.off('data', onData); stream.off('error', onError);
      if (metrics) metrics.subscriptionsClosed++;
      this.diagnostic('subscription_close', userId, errored ? 'error' : this.closed || !this.desired.has(userId) ? 'requested' : 'unexpected');
      if (this.streams.get(userId) === stream) this.streams.delete(userId);
      if (!errored && !this.closed && this.desired.has(userId) && this.daveReady()) {
        // receiver自身のcloseリスナーによる購読Map削除後に再購読する。
        queueMicrotask(() => this.subscribe(userId));
      }
    });
  }
  private destroyStreams(): void {
    for (const [userId, stream] of this.streams) {
      this.diagnostic('subscription_stop', userId, this.closed ? 'receiver_closed' : 'connection_changed');
      stream.destroy();
    }
    this.streams.clear();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.desired.clear();
    this.destroyStreams();
    for (const [stream, listener] of this.waiting) stream.off('close', listener);
    this.waiting.clear();
    const connection = this.connection;
    if (connection) {
      connection.off('stateChange', this.onState);
      connection.off('error', this.onError);
      connection.receiver.ssrcMap.off('create', this.onSsrcCreate);
      connection.receiver.ssrcMap.off('update', this.onSsrcUpdate);
      connection.receiver.ssrcMap.off('delete', this.onSsrcDelete);
      connection.receiver.speaking.off('start', this.onSpeaking);
      this.networking?.off('stateChange', this.onNetworkingState);
      this.udp?.off('message', this.onUdp);
      this.dave?.off('debug', this.onDaveDebug); this.dave?.off('error', this.onDaveError);
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    }
    this.callbacks = undefined;
  }
}
