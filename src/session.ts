import { randomUUID } from 'node:crypto';
import type { RecordingConfig } from './config.js';
import { UserCapture, createDecoder, type Decoder } from './capture.js';
import { exportMix } from './export.js';
import { CHANNELS, SAMPLE_RATE, Timeline, assertTransition, emptyMetrics, systemClock, type Clock, type Metadata, type SessionState } from './model.js';
import type { VoicePort } from './receiver.js';
import { atomicJson, privateDirectory, snowflake } from './storage.js';

export interface SessionOptions {
  guildId: string; channelId: string; ownerId: string; participants: string[];
  voice: VoicePort; notify(message: string): Promise<void>;
  clock?: Clock; decoderFactory?: () => Decoder;
}
const labels: Record<SessionState, string> = {
  awaiting_consent: '同意・接続待ち（受信停止）', recording: '録音中', stopping: '終了処理中', completed: '完了', failed: '失敗',
};
export class RecordingSession {
  readonly metadata: Metadata;
  directory?: string;
  private timeline?: Timeline;
  private readonly captures = new Map<string, UserCapture>();
  private readonly flushing = new Set<Promise<void>>();
  private queue: Promise<void> = Promise.resolve();
  private stopPromise?: Promise<void>;
  private initialized = false;
  private finalized = false;
  private connected = false;
  private connectionStarted = false;
  private everReady = false;
  private reservedBytes = 0;
  private consentTimer?: NodeJS.Timeout;
  private durationTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private checkpointTimer?: NodeJS.Timeout;
  private readonly clock: Clock;

  constructor(private readonly config: RecordingConfig, readonly options: SessionOptions) {
    snowflake(options.guildId); snowflake(options.channelId); snowflake(options.ownerId);
    options.participants.forEach(snowflake);
    if (!options.participants.length || new Set(options.participants).size > config.maxParticipants) throw new Error('参加人数が設定上限を超えているか、参加者がいません。');
    this.clock = options.clock ?? systemClock;
    this.metadata = {
      schemaVersion: 1, sessionId: randomUUID(), guildId: options.guildId, channelId: options.channelId,
      ownerId: options.ownerId, preparedAt: this.clock.wallNow().toISOString(), recordingStartedAt: null,
      endedAt: null, durationMs: 0, state: 'awaiting_consent',
      format: { container: 'WAV', encoding: 'PCM_S16LE', sampleRate: SAMPLE_RATE, channels: CHANNELS },
      participants: Object.fromEntries(options.participants.map((id) => [id, { present: true, consent: false }])),
      users: {}, segments: [], events: [], reconnects: 0, peakParticipants: options.participants.length,
      savedFiles: 0, savedBytes: 0, memoryAtEnd: null, errorCode: null, exportFile: null, exportError: null,
      limitations: [
        '音声受信はDiscord非公開仕様に依存し、安定動作は保証されません。',
        '時刻は復号後パケット到着時刻とPCMサンプル数からの推定です。送信側時刻・RTP連番は公開ストリームから取得していません。',
        'ジッター、順序逆転、欠落、最初のパケットの境界誤差、80ms以内の時間誤差を完全には復元できません。',
        '発話時間は保存PCMの長さです。VADによる実発話時間ではなく、マイク回り込みや通常の無音PCMも含み得ます。',
        'DAVEの内部復号失敗で破棄されたパケットは件数を取得できません。パケットロス率は算出しません。',
      ],
    };
  }
  get active(): boolean { return !this.finalized; }
  private live(): boolean { return !['stopping', 'completed', 'failed'].includes(this.metadata.state); }
  private allConsent(): boolean {
    const present = Object.values(this.metadata.participants).filter((p) => p.present);
    return present.length > 0 && present.every((p) => p.consent);
  }
  private transition(state: SessionState): void {
    if (state === this.metadata.state) return;
    assertTransition(this.metadata.state, state);
    this.metadata.state = state;
    this.event('session_state', undefined, state);
  }
  private event(type: string, userId?: string, value?: string): void {
    if (this.metadata.events.length >= 20_000) {
      if (this.live() && !this.metadata.errorCode) {
        this.metadata.errorCode = 'event_count_limit';
        queueMicrotask(() => { void this.stop('event_count_limit'); });
      }
      return;
    }
    this.metadata.events.push({ at: this.clock.wallNow().toISOString(), offsetMs: this.timeline?.offset() ?? null, type, ...(userId ? { userId } : {}), ...(value ? { value } : {}) });
  }
  async initialize(): Promise<void> {
    try {
      this.directory = await privateDirectory(this.config.root, [this.metadata.guildId, this.metadata.sessionId]);
      await atomicJson(this.directory, this.metadata);
      if (!this.live()) return;
      await this.options.notify(`録音準備：<#${this.metadata.channelId}> の参加者別音声とユーザーID・時刻をローカルに保存し、録音技術を検証します。現在の参加者全員が /record consent agree:true を実行するまで受信しません。撤回は agree:false。退出・再参加時は再同意が必要です。途中参加・撤回時は全員の録音を一時停止します。過去の音声は撤回だけでは削除されません。削除はBot管理者へ依頼してください。`);
      if (!this.live()) return;
      this.initialized = true;
      this.armConsentTimeout();
      this.idleTimer = setInterval(() => { for (const capture of this.captures.values()) capture.idle(); }, 100);
      this.idleTimer.unref();
      this.checkpointTimer = setInterval(() => { void this.enqueue(async () => { if (this.directory && this.live()) { this.metadata.durationMs = this.timeline?.offset() ?? 0; await atomicJson(this.directory, this.metadata); } }); }, 5000);
      this.checkpointTimer.unref();
      await this.reconcile();
    } catch { await this.stop('initialization_error'); throw new Error('録音準備に失敗しました。保存先・通知権限を確認してください。'); }
  }
  private armConsentTimeout(): void {
    if (this.consentTimer || !this.live()) return;
    this.consentTimer = setTimeout(() => { void this.stop('consent_timeout'); }, this.config.consentTimeoutMs);
    this.consentTimer.unref();
  }
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch(() => { void this.stop('session_operation_error'); });
    return this.queue;
  }
  private freeze(): void {
    this.options.voice.setUsers([]);
    for (const capture of this.captures.values()) {
      const promise = capture.close().catch(() => { void this.stop('capture_close_error'); });
      this.flushing.add(promise);
      void promise.then(() => this.flushing.delete(promise));
    }
    this.captures.clear();
    if (this.metadata.state === 'recording') this.transition('awaiting_consent');
  }
  consent(userId: string, agree: boolean): Promise<void> {
    const participant = this.metadata.participants[snowflake(userId)];
    if (!this.live() || !participant?.present) throw new Error('対象VC内の参加者だけが同意を変更できます。');
    if (participant.consent === agree) return this.queue;
    participant.consent = agree;
    this.event(agree ? 'consent_granted' : 'consent_revoked', userId);
    if (!agree) this.freeze();
    return this.enqueue(async () => {
      if (!this.live()) return;
      await this.options.notify(`録音同意が更新されました（同意 ${this.presentConsenting()}/${this.presentCount()}人）。${agree ? '' : '受信を一時停止しました。過去分は保持されます。'}`);
      await this.reconcileNow();
    });
  }
  participants(userIds: string[]): Promise<void> {
    if (!this.live()) return this.queue;
    userIds.forEach(snowflake);
    const present = new Set(userIds);
    let changed = false;
    for (const [id, participant] of Object.entries(this.metadata.participants)) {
      if (participant.present && !present.has(id)) {
        participant.present = false; participant.consent = false; changed = true; this.event('participant_left', id);
      }
    }
    for (const id of present) {
      if (!this.metadata.participants[id]?.present) {
        this.metadata.participants[id] = { present: true, consent: false };
        changed = true; this.event('participant_joined', id);
      }
    }
    this.metadata.peakParticipants = Math.max(this.metadata.peakParticipants, present.size);
    if (!changed) return this.queue;
    this.freeze(); // 非同期通知やキューを待たず、先に受信を停止。
    if (present.size > this.config.maxParticipants || Object.keys(this.metadata.participants).length > 500) return this.stop('participant_limit');
    if (!present.size) return this.stop();
    return this.enqueue(async () => {
      if (!this.live()) return;
      await this.options.notify(`参加者が変わりました。現在 ${present.size}人、同意 ${this.presentConsenting()}人。未同意者がいる間は全員の録音を停止します。再参加者も /record consent が必要です。`);
      await this.reconcileNow();
    });
  }
  private reconcile(): Promise<void> { return this.enqueue(() => this.reconcileNow()); }
  private async reconcileNow(): Promise<void> {
    if (!this.initialized || !this.live()) return;
    if (this.metadata.state === 'recording') return;
    if (!this.allConsent()) { this.armConsentTimeout(); return; }
    if (!this.connectionStarted) {
      this.connectionStarted = true;
      try {
        await this.options.voice.connect({
          packet: (id, packet) => this.packet(id, packet),
          state: (status) => this.voiceState(status),
          failure: (code) => { void this.stop(code); },
        });
        this.connected = true;
      } catch { void this.stop('voice_connect_or_dave_error'); return; }
    }
    if (!this.live() || !this.connected || !this.allConsent()) return;
    await Promise.all(this.flushing);
    await this.options.notify(`録音開始・再開：<#${this.metadata.channelId}>、同意済み ${this.presentCount()}人。参加者別WAVを保存しています。停止は /record stop。`);
    if (!this.live() || !this.connected || !this.allConsent()) return;
    if (!this.timeline) {
      this.timeline = new Timeline(this.clock);
      this.metadata.recordingStartedAt = this.timeline.wallStart.toISOString();
      this.durationTimer = setTimeout(() => { this.event('duration_limit'); void this.stop(); }, this.config.maxDurationMs);
      this.durationTimer.unref();
    }
    clearTimeout(this.consentTimer); this.consentTimer = undefined;
    this.transition('recording');
    const users = Object.entries(this.metadata.participants).filter(([, p]) => p.present && p.consent).map(([id]) => id);
    for (const id of users) {
      if (!this.captures.has(id)) {
        const metrics = this.metadata.users[id] ??= emptyMetrics();
        this.captures.set(id, new UserCapture(id, this.directory!, this.metadata, this.timeline, this.config, metrics,
          (bytes) => { if (this.reservedBytes + bytes > this.config.maxSessionBytes) return false; this.reservedBytes += bytes; return true; },
          (code) => { void this.stop(code); }, (this.options.decoderFactory ?? createDecoder)()));
      }
    }
    this.options.voice.setUsers(users);
  }
  private voiceState(status: string): void {
    if (!this.live()) return;
    this.event('voice_state', undefined, status);
    if (status === 'ready') {
      if (this.everReady && !this.connected) this.metadata.reconnects++;
      this.everReady = true;
      // 初回のReady通知はconnect()によるDAVE鍵確認が完了するまで開始に使わない。
      if (this.timeline) {
        this.connected = true;
        clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
        void this.reconcile();
      }
    } else if (this.timeline) {
      this.connected = false;
      this.freeze();
      if (status === 'destroyed') { void this.stop('voice_destroyed'); return; }
      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => { void this.stop('reconnect_timeout'); }, this.config.reconnectTimeoutMs);
        this.reconnectTimer.unref();
        void this.enqueue(async () => { if (this.live()) await this.options.notify('音声接続が切れたため受信を一時停止しました。制限時間内の再接続を待ちます。欠落区間は復元できません。'); });
      }
    }
  }
  private packet(userId: string, packet: Buffer): void {
    if (this.metadata.state !== 'recording' || !this.connected || !this.allConsent()) return;
    const participant = this.metadata.participants[userId];
    if (participant?.present && participant.consent) this.captures.get(userId)?.packet(packet);
  }
  presentCount(): number { return Object.values(this.metadata.participants).filter((p) => p.present).length; }
  presentConsenting(): number { return Object.values(this.metadata.participants).filter((p) => p.present && p.consent).length; }
  status(): string {
    const packets = Object.values(this.metadata.users).reduce((n, m) => n + m.packets, 0);
    return `状態：${labels[this.metadata.state]}／経過 ${Math.floor((this.live() ? this.timeline?.offset() ?? 0 : this.metadata.durationMs) / 1000)}秒／参加 ${this.presentCount()}人・同意 ${this.presentConsenting()}人／受信 ${packets}パケット・確定 ${this.metadata.savedFiles}ファイル${this.metadata.errorCode ? `／終了理由 ${this.metadata.errorCode}` : ''}`;
  }
  stop(errorCode?: string): Promise<void> {
    if (errorCode && this.active) this.metadata.errorCode ??= errorCode;
    if (this.stopPromise) return this.stopPromise;
    this.freeze();
    this.transition('stopping');
    this.metadata.durationMs = this.timeline?.offset() ?? 0;
    this.metadata.endedAt = this.clock.wallNow().toISOString();
    for (const timer of [this.consentTimer, this.durationTimer, this.reconnectTimer, this.idleTimer, this.checkpointTimer]) clearTimeout(timer);
    try { this.options.voice.close(); } catch { this.metadata.errorCode ??= 'voice_close_error'; }
    this.stopPromise = Promise.resolve().then(async () => {
      await this.queue;
      await Promise.all(this.flushing);
      this.metadata.memoryAtEnd = process.memoryUsage();
      if (this.directory) {
        try { await atomicJson(this.directory, this.metadata); }
        catch { this.metadata.errorCode ??= 'metadata_write_error'; }
        if (this.timeline && this.metadata.savedFiles) {
          try {
            const result = await exportMix(this.directory, this.metadata);
            this.metadata.exportFile = result.file;
            this.event('export_mix', undefined, `gain=${result.gain};clippedSamples=${result.clippedSamples};bytes=${result.bytes}`);
          } catch { this.metadata.exportError = 'mix_export_error'; }
        }
      }
      this.transition(this.metadata.errorCode ? 'failed' : 'completed');
      if (this.directory) {
        try { await atomicJson(this.directory, this.metadata); }
        catch { this.metadata.errorCode ??= 'metadata_write_error'; this.metadata.state = 'failed'; }
      }
      try { await this.options.notify(`録音停止：<#${this.metadata.channelId}>。${this.status()}。${this.metadata.savedFiles ? '音声とメタデータを管理者のローカル保存先に保存しました。' : '保存音声はありません。'}${this.metadata.exportError ? '混合出力に失敗しました。個別ファイルを確認してください。' : ''}`); }
      catch { this.metadata.errorCode ??= 'stop_notification_error'; this.metadata.state = 'failed'; if (this.directory) await atomicJson(this.directory, this.metadata).catch(() => undefined); }
      this.finalized = true;
    });
    return this.stopPromise;
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, RecordingSession>();
  constructor(private readonly config: RecordingConfig) {}
  get(guildId: string): RecordingSession | undefined { return this.sessions.get(guildId); }
  async start(options: SessionOptions): Promise<RecordingSession> {
    if (this.sessions.get(options.guildId)?.active) throw new Error('このサーバーには処理中の録音セッションがあります。');
    const session = new RecordingSession(this.config, options);
    this.sessions.set(options.guildId, session); // 最初のawaitより前にギルドを確保。
    await session.initialize();
    return session;
  }
  async stopAll(code?: string): Promise<void> { await Promise.all([...this.sessions.values()].filter((s) => s.active).map((s) => s.stop(code))); }
}
