# Discord会議録音PoC

Discordの通常のボイスチャンネルから、開発チームの参加者の音声をユーザー別に録音する技術検証用Botです。参加者別WAV、発話セグメントの推定時刻、検証用混合WAVをローカルに保存します。停止後の手動CLIでMAI-Transcribe-2の文字起こし、時系列統合、根拠参照付きAI議事録を生成するPoCも実装しています。外部送信は初期設定で無効です。既存の開発チーム録音からAzure実APIで3人分・20発言を取得しました。認識精度は未評価、OpenAI実通信と議事録品質は未検証です。

**今回の修正後の実Discordでの接続・録音は未検証です。** 自動テスト、実Opusのデコード、WAV形式、無音・重なりの復元は検証済みです。複数人録音の不具合調査と既存データの検査結果は [検証レポート](docs/recording-poc-report.md#11-複数ユーザー録音の不具合調査2026-10-10) を参照してください。

## 必要環境

- Node.js **24.17.0以上**（検証環境：24.19.0）、pnpm **11.22.0**。
- Discordのテスト用Botアプリと、開発チームのテストサーバー。
- DiscordへのHTTPS/WebSocket通信と音声用UDP通信が可能なネットワーク。
- `@discordjs/opus` のnativeモジュールをインストールできる環境。ビルド済みバイナリが提供されないNode.js/OSの組み合わせではPython・make・C/C++コンパイラーが必要です。今回のmacOS arm64 / Node.js 24ではソースビルドになりました。macOSではXcode Command Line Toolsを用意してください。
- このPoCではFFmpegは不要です。必要なら検証時に `ffprobe` 等を別途利用してください。

2026-10-08に [voice公式ドキュメント](https://discord.js.org/docs/packages/voice/0.19.2)、npmの配布パッケージ、型定義、実コードを確認しました。公式WebページのNode.js要件は24.17.0以上、配布済み0.19.2の `engines` は22.12.0以上でした。このリポジトリは公式Webページに合わせて24.17.0以上に限定します。音声受信はDiscordが公式に文書化していないため、安定動作は保証されません。

## セットアップと起動

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

`.env` にBotトークン、Application ID、許可するテストGuild IDを設定します。`DISCORD_GUILD_IDS` はカンマ区切りです。実トークンをREADME・Git・ログへ記載しないでください。

Discord Developer Portalでテスト用アプリを作成し、OAuth2の `bot` / `applications.commands` スコープで招待します。必要な権限は、VCの **View Channel・Connect・Send Messages** と、コマンドを実行するテキストチャンネルの表示・利用権限です。VCのテキストチャットへ公開通知するため、そのVCへのSend Messagesを忘れないでください。音声は送信せず、BotはselfMuteを有効にします。Administrator権限は不要です。

Gateway Intentは `Guilds` と `GuildVoiceStates` のみ使用します。Message ContentやGuild Membersなどの特権Intentを有効にする必要はありません。Stageチャンネルは対象外です。

```sh
pnpm register
pnpm dev
```

`pnpm register` は指定ギルドにこのアプリのコマンド一覧を登録・置換します。専用のテストBotアプリを使ってください。グローバル登録はせず、実行時にも許可ギルドをチェックします。

ビルドして起動する場合：

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

`dev`・`register`・`start` は `.env` を必須として読み込みます。`export` は `.env` があれば読み込み、なければ環境変数と既定値を利用します。開発コマンドとビルド済みBotを同じトークンで同時に起動しないでください。

### ビルド・録音準備に失敗した場合

2026-10-11に、Opusの型参照による `TS2503` と、Windowsで録音開始前のメタデータ保存時にディレクトリ同期が失敗する不具合を修正しました。修正版を取得し、`pnpm build` が成功してからBotを起動してください。`pnpm start` はビルドせず `dist/` を実行するため、`bot_ready` だけでは最新ソースのビルド成功を確認できません。

準備失敗の返信には固定の原因コードを表示します。`storage_directory_error` は保存ディレクトリの作成、`metadata_write_error` はメタデータの書き込み・同期・rename、`start_notification_error` はVCのテキストチャットへの準備通知の失敗です。保存先のパス・書き込み権限・空き容量、または通知権限を確認してください。外部例外の本文・パス・秘密情報は返信へ含めません。

## テスト録音のコマンド

開発チームのサーバーでのテスト用途に合わせ、Bot内の同意取得・撤回プロセスを削除しています。`DISCORD_GUILD_IDS` に設定したテストサーバーで利用します。

| コマンド | 動作 |
|---|---|
| `/record start` | 実行者がいるVCへ目的・保存内容を公開通知し、接続・開始通知後に人間の参加者全員を録音する。同意操作は不要 |
| `/record status` | 状態、初回録音開始からの経過時間、現在の参加人数、受信パケット数、確定ファイル数を表示 |
| `/record stop` | 受信停止、WAV確定、Silero VADの非破壊分類、全セグメントの混合出力、メタデータ保存、公開終了通知。VC参加者・開始者・Manage Guild権限のある管理者が実行可能 |

旧 `/record consent` をDiscord側から削除するには `pnpm register` を再実行し、更新したBotを再起動してください。再登録前の旧コマンドはエラーを返し、録音を開始しません。旧 `CONSENT_TIMEOUT_MS` は不要で、設定していても参照しません。

公開通知は**対象VCのテキストチャット**に送信します。準備通知後に接続し、録音開始・再開の公開通知に成功してから購読します。公開通知に失敗した場合は安全側で終了します。

途中参加・退出時は購読を一度停止・確定し、参加者変更と再開の通知後に、現在の参加者全員の録音を自動再開します。途中参加・再参加も同意操作は不要です。この通知・確定処理中の音声は保存されません。人間の参加者だけを対象にし、全員退出したら終了します。同じギルドは終了処理まで1セッション、別ギルドは独立したセッションです。

初回の録音開始から停止までを会議時刻軸とし、一時停止・切断中の時間も含めます。最初の準備・接続時間は会議時刻軸に含みません。状態は `preparing`、`recording`、`paused`、`stopping`、`completed`、`failed` です。準備中・接続中でも停止できます。

### 保存データの削除

停止・退出時も受信済みの書き込み待ちPCMは確定します。新規録音では、完全ゼロPCM・空PCMを含め音声を自動削除しません。VADは分類だけを行い、WAVヘッダー・PCM・ファイル名を変更しません。既存の過去録音の自動移動・再分類も行いません。

削除依頼を受けたBot管理者は、録音終了後、該当するセッションディレクトリ全体（`metadata.json`、`users/`、`exports/`、`.partial` を含む）を削除してください。このPoCではセッション全体の削除を標準手順とし、個別ユーザー削除や自動保持期限は実装していません。管理者が作ったコピー・バックアップも別途削除します。

## 環境変数

| 変数 | 既定値・用途 |
|---|---|
| `DISCORD_TOKEN` | 必須：Botの秘密トークン |
| `DISCORD_APPLICATION_ID` | 必須：Application ID |
| `DISCORD_GUILD_IDS` | 必須：テストサーバーID（カンマ区切り） |
| `RECORDINGS_DIR` | `./recordings`：管理者所有の専用保存先 |
| `MAX_DURATION_MS` | `900000`：初回録音開始後の最大15分。設定可能上限は1時間 |
| `MAX_SESSION_BYTES` | `536870912`：個別WAVのPCM＋ヘッダー合計予約上限512MiB（設定上限2,000,000,000） |
| `MAX_PARTICIPANTS` | `10`：VC内の人間の同時参加人数上限（設定上限50） |
| `MAX_PENDING_BYTES` | `4194304`：ユーザーごとのPCM書き込み待ち上限4MiB（設定上限64MiB） |
| `RECONNECT_TIMEOUT_MS` | `15000`：接続を再びReadyにするまでの制限15秒（設定上限60秒） |
| `SEGMENT_GAP_MS` | `250`：パケット未到着による区間分割・確定の目安（設定上限2秒） |
| `RECORDING_DIAGNOSTICS` | `false`：`true`で受信経路の詳細診断を機密の`metadata.json`へ保存。変更後はBotを再起動 |

上限値は正の整数で指定します。個別録音の容量上限にメタデータや混合音声は含みません。混合WAVも同じく192,000 bytes/秒で、15分なら約173MBが追加されます。保存先全体の空き容量は管理者が確認してください。セグメント数10,000、イベント数20,000、セッション中の累計参加ユーザー数500も上限とし、超過時は停止します。

## 保存形式と時刻

```text
recordings/
  {guildId}/
    {sessionId}/
      metadata.json
      users/
        {userId}/
          speech/
            segment-0001.wav
          non-speech/
            segment-0002.wav
          unclassified/
            segment-0003.wav
      exports/
        mix.wav
```

音声は **48kHz・2ch・16bit signed little-endian PCM WAV** です。1秒あたり192,000 bytes、連続15分で話者1人あたり約173MB（約165MiB）。Discord Opusをデコードし、RIFF/WAVEヘッダーを終了時に確定します。OpusパケットをそのままWAVとして連結しません。個別録音中に話者の音声を混合しません。

人間向け日時はISO 8601 UTC、相対時刻は `performance.now()` の単調増加時計を使用します。最初の受信時刻から、そのパケットのデコードサンプル数で算出した音声長を引き、セグメントの開始位置を推定します。終了位置は開始位置＋累積サンプル数です。1パケットを20ms固定として扱いません。

Discordの標準無音終端パケット、長いパケット間隔、80msを超える到着間隔の異常・累積ドリフトでセグメントを分割します。録音中にはVADを実行せず、停止後の分類だけに使用します。未受信区間はセグメント間の時刻差として残し、混合時に無音を生成します。80ms以内のジッター・欠落による誤差は完全には保持できません。

`metadata.json` はセッション・ギルド・VC・ユーザーID、準備/録音開始/終了日時、状態、参加・退出履歴、各セグメントのファイル参照・開始/終了相対時刻・絶対時刻・サンプル数・音声長・最初/最後のパケット到着時刻・パケット数・容量・`complete` を保存します。`schemaVersion: 2` では同意フィールド・同意履歴を持ちません。旧形式の終了済みセッションも混合CLIで再出力できます。`timing: arrival-estimate` は時刻が推定であることを示します。

メトリクスは、ユーザー別パケット数・標準無音パケット数・デコード失敗数・受信間隔異常数・セグメント数・保存PCM時間・容量、ピーク参加人数、保存ファイル総数、接続状態変化、再接続回数、録音終了時の `process.memoryUsage()` です。`audioDurationMs` は保存PCM時間であり、VADで測った実発話時間ではありません。パケットロス率は算出しません。

メタデータは5秒ごとと終了時に一時ファイル＋renameで更新します。POSIX環境では作成するディレクトリは0700、ファイルは0600です。Windowsではこのmodeで管理者専有を設定できないため、管理者がWindows ACLで保存先へのアクセスを制限してください。既存の保存先も管理者が専有し、他者の書き込みを許さないでください。Discord ID・UUID・ファイル参照を検査し、配下のsymlinkを拒否します。ルートの親ディレクトリは管理者が信頼できる場所を選んでください。`.env`・既定の録音先・音声・ビルド成果物はGitから除外しています。独自の保存先をリポジトリ内に設定する場合は、そのディレクトリも `.gitignore` へ追加してください。

Windowsでは読み取り専用ディレクトリのsyncを省き、ファイル自体のsync・rename・link・unlinkとエラー検出を継続します。POSIX環境では従来どおりディレクトリもsyncし、同期失敗をエラーとして扱います。Windowsでの電源断時のディレクトリエントリー（rename・link・unlink）の永続性は保証しません。この制約をWindowsセッションの `metadata.json` の `limitations` にも保存します。[Node.jsのOS別ファイルシステム仕様](https://nodejs.org/api/fs.html#file-system-flags)と[WindowsのFlushFileBuffers要件](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)を参照してください。

### Silero VADの非破壊分類

[公式Silero VAD v5.1 ONNXモデル](https://github.com/snakers4/silero-vad/tree/v5.1) と [onnxruntime-node](https://onnxruntime.ai/docs/get-started/with-javascript/node.html) **1.30.0** を使用します（どちらもMIT）。モデルを `assets/silero-vad/` に同梱し、初回推論前にSHA-256を照合します。`pnpm install --frozen-lockfile` 後に利用でき、Bot内のモデルダウンロード、Python、FFmpegは不要です。配布時は `dist/` と `assets/` を同じ親に置いてください。[配布元・ライセンス・入出力](assets/silero-vad/README.md) を参照してください。

停止処理は、受信停止→全ユーザーの書き込み確定→VAD分類→同一セッション内の移動→更新後のパスで全セグメントを混合→最終メタデータ保存→公開通知の順です。録音中の受信・セグメント分割・DAVE処理は維持します。

1つのWAVに発話区間が1つでもあれば **speech/**、正常な推論で発話区間がなければ **non-speech/**、無効化・モデル/推論/読込エラー・未対応/破損WAVなら **unclassified/** へ移動します。non-speechにもノイズ・短い声・誤判定された発話が入り得るため、音声は削除しません。手動STTの初期対象はspeechのみですが、聴取確認後に対象分類を変更できます。移動が安全にできないファイルと未確定partialは元の場所に残し、`segments[].vad.error`へ記録します。

推論専用の入力は、左右のInt16を平均してFloat32に正規化し、63タップの対称Hamming窓sincローパス（7.2kHz）で48kHz→16kHzへリサンプリングします。フィルター遅延を相殺し、512サンプル（32ms）ずつ推論、最後だけゼロ埋めします。元WAVの長さ・ヘッダーを書き換えません。元WAVの生成形式以外のWAV（追加チャンク等）は未対応として保持します。

推論と変換はWorkerで実行し、モデルを各Workerで再利用、RNN状態と文脈をファイルごとに初期化します。全ギルドでWorkerプールを共有し、ファイル全体をメモリへ蓄積しません。1ファイルのモデル初期化＋推論は最大120秒（待ち行列の時間は除く）で、超過時はWorker終了を待って枠とFDを解放し、判定不能にします。停止完了通知は分類・混合の終了を待ちます。

| 環境変数 | 既定値 | 判定への作用・範囲 |
|---|---|---|
| `VAD_ENABLED` | `true` | `false`ではモデルをロード・推論せずunclassifiedとして保持。true/falseだけ受理 |
| `VAD_POSITIVE_THRESHOLD` | `0.40` | フレームの発話確率がこの値以上で発話開始。高くすると検出を絞る（0〜1） |
| `VAD_NEGATIVE_THRESHOLD` | `0.30` | 発話中に確率がこの値未満なら終了猶予開始。Positiveより小さくする |
| `VAD_MIN_SPEECH_MS` | `100` | 開始余白と末尾の終了猶予を除く検出区間の最小時間。短くすると短い声を残しやすい（0〜60000の整数） |
| `VAD_REDEMPTION_MS` | `200` | 低確率区間がこの時間続くと発話終了。Positiveへ戻ると猶予をリセット。長くすると近い発話をつなぎやすい（0〜60000の整数） |
| `VAD_PRE_SPEECH_PAD_MS` | `100` | 検出区間の開始前へ付けるメタデータ上の余白。最小発話時間の判定には加えない（0〜60000の整数） |
| `VAD_MAX_CONCURRENCY` | `1` | 全ギルドのモデルWorker上限（1〜4の整数）。増やすとCPU・モデルメモリも増える |

各設定はBot再起動で適用します。不正値は起動時に変数名を含むエラーとなります。しきい値等はモデルの入力引数ではなく、Sileroが返すフレーム確率の後処理へ適用します。これらは短い相づち・小声を検証するための試験用初期値で、最適値ではありません。代表音声を聴いて正解を記録し、1パラメーターずつ変え、発話あり/なしの件数・誤検出・見逃しを比較してください。録音中の購読単位が短い場合、設定を緩めてもモデル自体が検出しない場合があります。

`schemaVersion:2`の任意フィールドとして、各セグメントの `vad` に分類、`completed`（判定成功）、`ranges`（セグメント内相対ms）、固定エラー分類、元WAVのSHA-256を保存します。会議上の位置は `segment.startOffsetMs + range.startMs/endMs` です。セッションの `vad` に有効/無効を含む適用設定、モデル版・ハッシュ・Runtime版、3分類の件数、エラー数、分類処理の状態と移動記録を保存します。`disabled`と`incomplete`は判定不能件数へ含め、処理エラー数へは加えません。エラー数はファイルごとの処理エラー件数とセッションの処理障害1件の合計です。録音の状態と `vad.state:failed` は別で、VADだけの失敗で正常な録音を失敗扱いしません。録音時刻・順序・ユーザー別保存統計・`savedFiles`・`savedBytes`は分類で変更しません。

### 移動障害からの復旧と旧無音削除との互換性

上書きを防ぐため、移動予定（from/to、device/inode/size、SHA-256、判定）を `vad.moves[].state:pending` として先にatomic保存・syncします。その後、同一ファイルシステム上のhard linkを排他的に作り、同じinodeと全バイトのハッシュを照合、POSIX環境では移動先ディレクトリsync後に元の名前だけを解除します。Windowsでのディレクトリ同期の制約は上記のとおりです。音声本体は常に残ります。正常終了時にコピー・重複は残りませんが、途中障害では同じinodeの2つの名前が一時的に残る場合があります。既存宛先、内容変更、symlinkは上書き・削除しません。未解決pendingがある場合、古いパスを誤って読むことを避けるため混合を保留します。

分類中は `.vad.lock` の排他的作成で同一セッションのプロセス間競合を防ぎます。強制終了でロックが残った場合は、Botと他CLIが停止したことを管理者が確認してから、対象セッションの **.vad.lockだけ** を取り除きます。音声は手動削除せず、次を実行してください。

```sh
pnpm recover-vad <guildId> <sessionId>
pnpm export <guildId> <sessionId>
```

復旧CLIは既存のpendingだけを回収し、推論や新たな分類を行いません。元と先の両方があれば同一inode・ハッシュを確認して元の名前を解除し、先だけならハッシュを確認して参照を更新します。保存済みの録音時間・容量を維持します。終了途中なら `failed / interrupted_stop` とし、分類や録音の既存エラー記録を消しません。移動記録保存前の強制終了、モデル判定のやり直し、partial修復、録音再開、保存媒体自体の損失は復旧対象外です。mixが既にあれば再出力前に管理者が退避してください。

新規録音から完全ゼロPCMの自動削除を廃止し、`silenceCleanup`を生成しません。旧パス `users/{userId}/segment-XXXX.wav` と新しい3分類パスはともに混合できます。過去録音の `silenceCleanup` はそのまま残し、新しい分類処理へ自動で渡しません。旧 `pnpm recover-silence <guildId> <sessionId>` は旧pendingだけを処理しますが、**存在する完全ゼロWAVを実際に削除するコマンドです**。既に削除された音声を復元するものではありません。新規セッションでは使用しないでください。

### 複数人録音が欠ける場合の診断

`.env`で `RECORDING_DIAGNOSTICS=true` を設定してBotを再起動し、下記の手動テストを実施します。診断はコンソールやDiscordへ出さず、5秒ごとと終了時に `metadata.json` の `diagnostics` へ保存します。`schemaVersion: 2`の追加フィールドであり、古いデータは移行不要です。`users`にも `decodeSuccesses`（標準無音終端を除くデコード成功数）、`savedSamples`（書き込み確定済みのチャンネルあたりPCMフレーム数）を追加します。保存時間は `savedSamples / 48000` 秒です。

| 観測値 | 調べる段階 |
|---|---|
| `diagnostics.receiver.users[id].subscriptionsStarted = 0` | 対象参加者一覧・購読開始。参加変更、`subscriptions_requested`、`subscription_start/stop/wait_close/close`の順序を確認 |
| `ssrcKnown = false` / `unknownSsrcPackets`が増加 | SSRC対応未登録・削除。`ssrc_create/update/delete`を確認。未知SSRCのパケットを特定ユーザーに推測で結び付けない |
| `rtpPackets = 0` | ユーザーへ対応済みの音声RTPが到着していない。ミュート、UDP経路、SSRC、通知による受信停止を確認 |
| `rtpPackets > 0`、`opusPackets = 0` | 輸送復号・DAVE復号・購読への配送の間で未配送。DAVEの `failureSignals`、`receive_or_decrypt_error`、鍵状態、購読履歴を照合 |
| `opusPackets > 0`、`users[id].decodeSuccesses = 0` | Opusデコードまたは標準無音終端。`silencePackets`、`decodeFailures`、`opus_decode_error`を確認 |
| `decodeSuccesses > 0`、`savedSamples = 0` | 書き込み待ち・上限・保存失敗。終了後のセグメントと`pcm_storage_error`を確認 |
| `savedSamples > 0`なのにプレーヤーで0秒表示 | 実WAVのフレーム数・ヘッダー・短い区間の表示丸めを確認。個別WAVと混合WAVを別々に検査 |

`rtpPackets`は対象ユーザーの購読希望期間に到着した、SSRC対応済みのRTPヘッダーの観測数です。`opusPackets`は保存処理へ渡した復号後パケット数（標準無音終端を含む）です。どちらも送信総数・ロス率ではありません。`speakingStarts`と`speaking_start`もRTP到着に基づくライブラリの検知で、実発話や復号成功の証拠にはなりません。停止後の `desired/subscribed = false` は正常です。SSRCやDAVE状態はスナップショット時点の値であり、履歴も併せて確認してください。

DAVEの `failureSignals` は0.19.2の既知debug通知を接続全体で数えます。ユーザーIDを含まない通知のため、ユーザー別復号失敗数は得られません。正常話者の復号成功でライブラリの連続失敗数がリセットされても、この診断件数は累積します。生のdebugメッセージ・外部例外のmessage/stack・音声・鍵・トークンは保存しません。

イベントは最大2,000件、ユーザー集計は最大500人です。超過イベントは `droppedEvents` に集計し、診断上限だけでは録音を停止しません。最後のエラー分類は `lastError` に残します。パケットごとのイベントは作らず、DAVE失敗イベントは初回と累計件数が倍増したときだけ記録します。UDP・DAVEの交換時に診断リスナーを付け直し、停止時に解除します。依存バージョン変更時はこの診断経路も再検証が必要です。

## 再生と混合音声

各 `segment-*.wav` と `exports/mix.wav` は一般的なWAVプレーヤーで開けます。停止時に、完成した個別ファイルから `mix.wav` を自動生成します。1秒ブロックで読み書きし、会議全体をメモリへ読み込みません。相対時刻を48kHzのサンプル位置へ丸めて配置し、同時発言は加算、音声のない区間は無音とします。

音割れを抑えるため、全セグメントに音声を保存したユーザー数をNとして固定ゲイン1/Nをかけ、残る超過を16bit範囲へ制限します。ゲイン・クリップサンプル数・出力容量はメタデータの `export_mix` イベントに記録します。speech・non-speech・unclassifiedの全個別WAVを保持・混合し、分類で音量・時間軸・内容を変えません。混合に失敗した場合は `exportError` と通知で明示し、途中の混合ファイルは `.partial` として残します。

終了済みのセッションを再出力する場合：

```sh
pnpm export <guildId> <sessionId>
```

既存の `mix.wav` や `mix.wav.partial` は上書きしません。管理者が退避してから再実行します。CLIは録音中のメタデータを拒否し、完成済みの個別WAVのみ対象にします。CLI再出力の結果は標準出力に表示し、元のメタデータは更新しません。

macOSでは `afinfo <wavのパス>`、FFmpegを用意した環境では以下で形式・長さとデコード可能性を確認できます。

```sh
ffprobe -v error -show_streams -show_format "segment-0001.wav"
ffmpeg -v error -i "segment-0001.wav" -f null -
```

## 障害時の動作と制約

- DAVEを有効にし、プロトコルの交渉とMLS鍵の準備を確認します。未確立・復号エラー・鍵消失では安全側で終了します。暗号化を無効にした再試行はありません。[DiscordのDAVE仕様](https://docs.discord.com/developers/topics/voice-connections#end-to-end-encryption-dave-protocol) に沿った処理をライブラリに任せます。
- 接続ReadyとDAVE鍵待ちは各最大20秒です。再接続はライブラリのresume/rejoin動作を利用し、切断時は全ストリームを停止・確定します。Readyに戻れば現在の参加者を確認し、再開通知後に再購読します。BotのVCからの強制切断・移動では終了します。失われた音声は復元しません。
- receiveストリームは現在の人間の参加者を発話前にManual購読し、自然終了後に再購読します。SSRCの対応更新・削除はライブラリが管理し、未知の対応は保存しません。speakingイベントを録音時刻の根拠にしません。
- 接続・デコード・書き込み・容量・人数・バッファ制限の異常では新規受信を停止し、可能な音声を確定します。回収できないセグメントは `complete:false`、セッションは `failed` として残します。ストレージ自体が壊れた場合はメタデータの確定も保証できません。
- SIGINT/SIGTERMではセッションを終了します。プロセス強制終了・電源断では `.partial` と古いメタデータが残り得ます。保存済みのVAD移動予定は上記CLIで回収できますが、録音の自動修復・再開は実装していません。`.partial` のWAVヘッダーは未確定の場合があり、そのまま正常な音声と扱わないでください。
- native Opusの公開APIには明示破棄がないため、終了時に参照を解放しGCによるnative資源の破棄に任せます。5〜15分でのメモリ推移と多数回の再開時の挙動は実Discordで確認が必要です。
- スピーカー音声のマイクへの回り込みや周囲の声が別人のマイクに入ることを完全に防げません。ヘッドホン利用で検証してください。
- 公開運用向けのアクセス制御、保持期限、監視、総ディスク上限、録音全体のプロセス間排他、水平分散はありません（VAD分類の同一セッションには排他があります）。実環境で「欠落しない」「同期精度が保証される」とは確認していません。

## 実Discord手動テスト

すべて**未実施**です。開発チームのテストサーバーで実行し、テスト番号・実施日時・ライブラリ/OS・参加人数・セッションID・成功/失敗・具体的な差異を検証レポートへ記入してください。音声や実ユーザーIDをGitへ追加しないでください。

各試験は対象VCへ入って `/record start`、公開開始通知を確認して発言、`/record stop`、公開完了通知の順に実施します。個別WAVの聴取、形式/長さ、メタデータのユーザー対応、混合WAVの時間配置を照合します。同期用に「開始後5秒でA、10秒でB」のような既知の合図を使い、開始位置の差をmsで記録します。

今回の再検証では診断を有効にし、T2を「A先行」「B先行」の別セッションで実施してください。各人が5秒以上発言し、交互発言、T3の同時発言、T6の3人同時発言、T5の退出・再参加、T9の再接続を続けて確認します。正常話者の声が保存される間に別話者の `rtpPackets` だけが増える場合は、DAVE失敗集計と購読履歴を保存して比較してください。未受信と無言、短いWAVと空のWAVを区別し、音声・実ユーザーID・メタデータ全文をGitへ追加しないでください。

| ID | 方法 | 確認方法・期待結果 |
|---|---|---|
| T1 | 1人で30秒、start後に追加操作なしで発言 | 公開開始通知後に自動で録音され、本人の声を本人のディレクトリで再生できる |
| T2 | 2人が交互に発言 | ユーザー別WAVとIDが対応し、混合の順序と相対時刻が一致する |
| T3 | 2人が同時に5秒発言 | 両者が独立したWAVに残り、メタデータ区間が重複し、混合で両方聞こえる |
| T4 | 発話の間に10秒の無音 | 個別セグメントの間隔が維持され、混合に約10秒の無音がある。到着時刻による誤差を記録する |
| T5 | 録音中に退出・再参加 | 退出者の購読を解放。再参加を通知し、追加操作なしで新セグメントの録音を再開 |
| T6 | 録音中に3人目が参加 | 参加通知中は受信停止。再開通知後、追加操作なしで3人分を保存 |
| T7 | 5〜15分連続録音、数十回発話再開 | 上限で停止。ファイル全体が再生できる。経過/PCM時間・容量・エラー・メモリ推移・既知の合図の時刻差を比較する |
| T8 | 別の許可サーバーで同時録音 | 状態・ID・保存先が分離され、一方の停止が他方に影響しない。同一サーバーで二重startが拒否される |
| T9 | 通信を一時遮断、またはBotをVCから切断/移動 | 通信断で受信停止、Ready回復なら再開・再接続数記録。期限超過/強制切断・移動なら安全に終了。切断区間を詰めない |
| T10 | 発話中にstopを連続実行 | 新規受信停止、受信済みPCM確定、二重解放しない、終了後VCからBotが退出する |
| T11 | start直後、接続・開始通知中にstop | 停止後に受信が再開せず、接続・購読を解放する |
| T12 | 通知権限拒否、保存先書き込み不可、容量上限を低く設定 | 成功通知を出さず失敗/上限停止を明示する。保存できた音声は回収し、不完全分を明示する |
| T13 | 無言、短い小声、環境音、途中の10秒無音を含む2人の録音 | 完全ゼロを含む全WAVの保持、3分類・適用設定・時刻・保存統計を照合。短い相づち・小声・ノイズの誤判定を聴取で記録。VAD_ENABLED=falseでも全音声がunclassifiedに残り、mix内容・時間軸が変わらないことを確認 |

受信0件なら、BotのselfDeaf状態・参加者ミュート・UDP通信・DAVE確立・公開通知を確認してください。0件だけでは「全員無言」と「受信失敗」を判別できません。

## 構成

| ファイル | 責務 |
|---|---|
| `src/bot.ts` / `src/register.ts` / `src/commands.ts` | 起動、ギルド用コマンド登録・処理、参加者/チャンネル変更と終了シグナル |
| `src/session.ts` | ギルド別の状態・参加者・上限・終了・メタデータ/メトリクス |
| `src/receiver.ts` | 実Discord接続、DAVE確認、ユーザー別VoiceReceiver購読、解放 |
| `src/capture.ts` / `src/storage.ts` | Opusデコード、サイズ制限付き逐次書き込み、WAV確定、パス検査 |
| `src/model.ts` / `src/config.ts` | メタデータ型、単調時計、状態遷移、設定検証 |
| `src/diagnostics.ts` | 診断用の型と秘密情報を含めない固定エラー分類 |
| `src/export.ts` / `src/export-cli.ts` | WAV検査、時刻配置・混合、終了済みセッションの再出力 |
| `src/vad.ts` / `src/vad-engine.ts` / `src/vad-worker.ts` | 非破壊分類、移動ジャーナル、Workerプール、モデル推論と入力変換 |
| `src/recover-vad-cli.ts` | 保存済みVAD移動予定の明示的な回収 |
| `src/silence.ts` / `src/recover-silence-cli.ts` | 旧無音削除形式との互換用。新規録音では使用しない |
| `src/transcribe.ts` / `src/transcribe-cli.ts` | 手動STT、同一ユーザーのチャンク結合、元時刻への変換、キャッシュ、全文保存 |
| `src/minutes.ts` / `src/minutes-cli.ts` | Responses API、構造・原文根拠検査、JSON/Markdown議事録 |
| `src/processing-config.ts` / `src/api-http.ts` / `src/processing-storage.ts` | 外部処理の設定・通信予算・安全な読み書きと排他 |
| `tests/` | Discord実接続をしない状態・参加者・障害・実Opus・音声配置・受信購読テスト |
| `docs/recording-poc-report.md` | 検証環境、結果、未検証事項、残課題 |

`pnpm test:vad` は同梱の実ONNXモデルで無音WAV・状態分離・タイムアウトを検証します。`pnpm test`にも含まれ、ネットワークとDiscord資格情報は不要です。人間の朗読音声を用いたローカル評価・短い切り出しの見逃しは [検証レポート第13節](docs/recording-poc-report.md#13-silero-vadによる非破壊分類2026-10-11) を参照してください。

## 停止後の文字起こし・AI議事録PoC

対象は**外部API送信にも同意済みの開発チーム録音**です。録音時の公開通知だけでは外部送信への同意を代替しません。試験前に、音声をAzure Speechへ、文字起こし・DiscordユーザーID・発言時刻をOpenAIへ送ること、検証目的、各サービスの保存・データ利用条件、管理者への削除依頼方法を参加者へ説明してください。説明文の例：

> このテストでは参加者別音声をMicrosoft Azure Speechへ送り、日本語文字起こしを行います。その文字起こし・参加者のDiscord ID・発言時刻をOpenAIへ送り、根拠付き議事録を検証します。録音・文字起こし・議事録は管理者のローカル保存先へ残ります。外部サービスのデータ取扱条件を確認したうえで参加してください。削除を希望する場合は管理者へ対象セッションを連絡してください。

Botの通常起動・録音停止・VAD分類では外部APIを呼びません。CLIはDiscordトークンを必要とせず、`RECORDINGS_DIR`内の`completed`/`failed`録音だけを読みます。失敗録音の完成済みWAVは処理できますが、不完全性を引き継ぎます。

### 設定と手動実行

`.env.example`の追加設定を`.env`へ反映します。キーは環境変数だけから読み、コンソール・成果物へ保存しません。最初は`STT_ENABLED=false`、`MINUTES_ENABLED=false`を維持してください。対象セッションのVAD分類・復旧が終わったことを確認し、Bot・VAD復旧CLI・管理者が音声やメタデータを同時更新しない状態で実行します。

```sh
# 送信予定ファイル数・音声時間（挿入無音込み）・キャッシュ件数・新規リクエスト数・予算を確認
pnpm transcribe <guildId> <sessionId> --dry-run

# .envでSTT_ENABLED=true、Azureのendpoint/keyを設定した後
pnpm transcribe <guildId> <sessionId>

# 生成された全文・失敗状態を確認してから、LLMへの入力件数と文字数を確認
pnpm minutes <guildId> <sessionId> --dry-run

# .envでMINUTES_ENABLED=true、OPENAI_API_KEYを設定した後
pnpm minutes <guildId> <sessionId>
```

有効化フラグがfalseなら、`--dry-run`なしでも通信せず計画だけ表示します。dry-runはAPIキー不要で、音声形式・パス・ハッシュも確認します。成果物は生成せず、一時的な排他ロックだけを使用します。資格情報・上限・保存先に問題がある場合、実行は固定の原因コードで失敗します。一部STT失敗も終了コード1とし、成功分と失敗状態は保存します。空文字は`needs_review / empty_transcript`として記録し、無発話と断定しません。LLM入力が空なら議事録を生成しません。

Azureは[MAI公式仕様](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe)と[REST API仕様](https://learn.microsoft.com/en-us/rest/api/speechtotext/transcriptions/transcribe?view=rest-speechtotext-2025-10-15)に従い、`POST /speechtotext/transcriptions:transcribe?api-version=2025-10-15`をmultipartで呼びます。`AZURE_SPEECH_ENDPOINT`は`https://<resource>.cognitiveservices.azure.com`等のリソースURLです。任意ホスト・非HTTPS・URLの鍵・リダイレクトは拒否します。MAI対応リージョンと権限は利用者側で確認してください。モデルは公開プレビューです。日本語・segment設定の実応答は確認しましたが、他の設定・リージョン・言語は未検証です。

`enhancedMode.enabled=true`、`model=MAI-Transcribe-2`、`transcribeStyle=verbatim`、`timestamps=segment`、`diarization.enabled=false`を既定とします。`STT_LANGUAGE=ja`は日本語固定、`auto`はlocalesを省略します。`STT_PHRASES_JSON='["Silero", "製品名"]'`で専門用語を登録できます。`STT_STYLE=clean`、`STT_TIMESTAMPS=word`も比較可能です。wordを指定しても、このPoCの統合発言単位はAPIのphraseです。

議事録モデルの初期値`gpt-5.6-terra`は[公式モデル一覧](https://developers.openai.com/api/docs/models/gpt-5.6-terra)でResponsesとStructured Outputs対応を確認しました。利用アカウントでのモデルアクセスは未確認です。`MINUTES_MODEL`で変更できます。[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)の`text.format`を使用し、`store:false`で要求します。この指定だけで外部サービスの保持・データ利用全般を保証するものではありません。

### 音声選択・結合・元時刻

初期対象は`segments[].vad.completed=true`かつ`classification=speech`の完成済みWAVです。WAV全体を使用し、VADの`ranges`で切り取らないため、分類対象ファイル内の短い声や前後音声を保ちます。non-speechは除外記録、unclassified・未確定音声は確認待ち記録を残します。すべての原音と録音`metadata.json`を変更・削除しません。

聴取で誤分類を確認した場合は`STT_CLASSES=speech,unclassified`や`speech,non-speech,unclassified`に変更して再実験できます。これは指定分類を送信可能にする設定なので、対象を確認してから変更してください。旧録音でVADがない場合はunclassifiedとして扱います。

同じユーザーの近接音声を、既定で最大20秒・間隔1,000msまで結合します。`STT_CHUNK_SECONDS`は1〜120秒、`STT_CHUNK_GAP_MS`は0〜2,000msで変更できます。間隔はサンプル位置へ丸めて無音を挿入し、長い無音・別ユーザー・同一ユーザーの重複区間では分けます。長いWAVは最大長で分割します。結合音声は一時的なメモリ上の有効な48kHz/2ch WAVで、元ファイルを上書きしません。最大120秒で約23MB/チャンクに制限し、Azureの2時間未満・250MB未満の上限より小さくします。

各チャンクの`mappings`へ元ファイル・`segmentId`・元開始サンプル・サンプル数・チャンク内開始サンプル・会議内開始/終了時刻を保存します。APIの`phrases[].offsetMilliseconds/durationMilliseconds`を対応する元音声区間へ変換し、発言に`sourceSegments`として保存します。複数元セグメントにまたがるphraseは、テキストを推測で分割せず複数参照を持ちます。無音内だけの時刻は要確認です。

全参加者の発言を開始時刻でソートし、重なる時刻を保持します。話者はチャンク作成時のDiscord IDから決め、APIやLLMで入れ替えません。同一ユーザー・同一元区間・同じテキストの完全重複だけを排除します。別人の同文や別時刻の相づちは保持します。マイクへの回り込みで別の人の声が入った場合、ファイル所有者IDとの誤対応は自動修正できません。

録音由来の時刻は到着時刻の推定です。結合時の丸めは約0.01msですが、ネットワーク遅延・欠落・STTのphrase境界誤差は残ります。segmentタイムスタンプは話者分離無効時に言語単位の大きな区間になり得るため、単語単位の発話精度を保証しません。

### 出力と再実行

```text
recordings/<guildId>/<sessionId>/
├── metadata.json                 # 元録音、変更しない
├── users/<userId>/{speech,non-speech,unclassified}/
├── exports/mix.wav               # 既存混合処理、変更しない
├── transcripts/
│   ├── plan.json                 # 送信計画・ハッシュ・元音声対応
│   ├── segments.json             # 最新実行の状態・チャンク別処理結果
│   ├── merged.json / merged.md   # 時系列全文・状態・モデル・API利用量
│   ├── users/<userId>.json       # ユーザー別文字起こし
│   ├── cache/<hash>.json         # 成功結果と、再検査用の構造を読める失敗応答
│   └── runs/<runId>.json         # 過去実行結果、設定比較用
└── minutes/
    ├── minutes.json / minutes.md
    ├── processing.json           # 最新LLM処理の完了/失敗・利用量
    ├── cache/<hash>.json
    └── runs/<runId>.json
```

音声ハッシュ、ギルド/セッション、元時刻の対応表、モデル、言語、style、timestamps、専門用語、分類選択、チャンク設定を照合して成功キャッシュを利用します。読み出し時は保存したAPI結果を再検査して時刻対応を再計算します。設定を戻せば以前のキャッシュを利用できます。LLMは全文・モデル・出力上限・スキーマ・指示文のハッシュを使用します。資格情報はハッシュの入力や成果物に含めません。

同じ設定で比較し直す場合だけ`--force`を使います。再送信・追加課金が発生し得ます。force失敗は前回成功キャッシュを消しません。成功済みSTTはチャンクごとに保存し、部分失敗時も再利用できます。最新の文字起こし途中で以前の`merged.json`が残った場合、議事録CLIは実行IDと完了状態の不一致で停止します。LLM失敗時は前回の議事録を保持するため、**採用前に必ずprocessing.jsonが今回の入力でcompletedになっていることを確認**してください。

実Azure応答では総音声長と元WAV長に最大約2.65msの差を観測しました。`durationMilliseconds`の総長照合は10ms以内の差を許容し、差を`apiDurationDifferenceMs`に残します。発言の時刻配置・チャンク長は元WAVのサンプル数に基づき、APIの丸めに合わせて変更しません。発言範囲や元音声参照の検査は維持します。構造を読める形式不一致の応答はキャッシュへ保存し、修正版の検査を通れば追加通信せず回収します。dry-runではそのキャッシュを変更しません。原音照合による時刻精度の保証とは別です。

`.processing.lock`で同じセッションのSTT/議事録CLIを排他します。VADロックや未解決の移動も拒否しますが、Botの全処理と共有する排他ではありません。クラッシュ後は他のCLI・Botが対象データを更新していないことを管理者が確認してから、対象セッションの`.processing.lock`だけを取り除き再実行します。音声・キャッシュを自動削除する復旧処理はありません。排他下でファイルsync・atomic renameを使い、ディレクトリは0700・成果物は0600で新規作成します。既存保存先は管理者専有を前提とします。

### 予算・リトライ・議事録の根拠検査

STTは1実行あたり最大100リクエスト、累計900音声秒、同時2件が既定です。**リトライも実際の送信件数・音声秒へ加算**します。キャッシュの読出しは新規送信予算を消費しません。予算はCLI実行ごとなので、繰り返し実行や複数ギルドを合計した課金上限にはなりません。LLMは1要求＋最大2回の再試行、入力20万文字、最大16,000出力トークンが既定です。入力上限超過は切り捨てず停止します。値の範囲は設定読込で検査します。

429・5xx・ネットワーク例外は指数バックオフとジッター、最大30秒のRetry-Afterを使って最大2回再試行します。401/403等や不正なJSON・構造は再試行しません。要求と応答読み込みに120秒のタイムアウト、応答に8MiB上限があります。応答前の通信断でサーバー側が処理済みの場合、再送信により二重課金があり得ます。Azureの`durationMilliseconds`と試行数・送信音声秒、OpenAIのtoken usageを保存し、実際の請求金額とは区別します。

議事録は概要・議題・議論・決定・未決定・アクション・担当・期限・課題をJSONで検証し、そこからMarkdownを生成します。各項目の発言IDの実在と引用の原文一致を検査します。決定事項とアクション本文は原文からの抽出に限定し、創作した本文を拒否します。決定は明示的な決定表現と否定/条件付き表現を保守的に検査します。担当者は明示IDまたは発言者本人の担当表明に限定し、名前からIDを推測しません。期限は明示された原文を保存し、未指定の担当・期限は未定と表示します。参照・引用・構造の不整合は`grounding_error`等で失敗させ、未検査JSONを議事録へ採用しません。

**検査だけで捏造や取り違えが完全に防げるとは保証しません。** 引用が正しくても文脈の誤解、提案と合意の誤判断、要約への根拠の弱い情報混入、STT自体の誤認識は残り得ます。保守的な表現チェックは正しい決定を拒否する場合もあります。`semanticAccuracy:requires_human_review`を残し、原音・全文・根拠引用を照合します。録音失敗、未分類/不完全音声、STT失敗・空結果は議事録に不完全と明記します。non-speech除外も警告として残します。

### 実録音による評価手順（認識精度・議事録品質の原音照合は未実施）

1. 外部送信に同意済みのテスト参加者で、交互/同時発言、短い相づち、専門用語、提案だけの文、明示決定、担当/期限がある文とない文を録音します。予定表を用意し、既知の合図時刻・正解発言をローカルで管理します。
2. 録音停止後に個別WAVを聴取し、VAD3分類・ユーザーID・元時刻を照合します。speechの見逃しだけでなくnon-speech/unclassifiedにある発話も確認します。
3. dry-runで選択・総音声時間・請求につながる送信予定を確認し、上記フラグと資格情報を設定してSTT、全文確認、議事録の順に手動実行します。
4. 発言欠落・誤認識・専門用語・短い声・話者ID・開始/終了の時刻差を記録します。文字列の正解と比較するCER等は、原文の表記規則を揃えて算出してください。
5. 議題網羅、決定と提案、アクション、担当、期限、創作情報について、各根拠IDの引用と原音を人間が照合します。失敗音声がある結果の不完全表示も確認します。
6. 同設定の再実行で新規要求0を確認し、20秒/短いチャンク、segment/word、ja/auto、専門用語有無、対象分類変更を比較します。モデル・設定・runId・試行数・利用量・誤差をローカルに残し、匿名化した集計だけを検証レポートへ追記します。

元録音と派生成果物は管理者が保存期間を決め、必要な場合にセッション全体を手動削除します。このCLIは自動削除・外部サービスの削除を行いません。APIキー、実音声、会議全文、実ユーザーIDを含むJSONはGitへ追加しないでください。G1〜G10と品質評価の現状は[検証レポート第15節](docs/recording-poc-report.md#15-文字起こしai議事録poc2026-10-12)、既存録音の実API結果は[第16節](docs/recording-poc-report.md#16-既存discord録音のazure実api検証2026-10-12)を参照してください。
