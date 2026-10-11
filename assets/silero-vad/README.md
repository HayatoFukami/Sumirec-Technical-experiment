# Silero VAD v5.1

公式 [Silero VAD v5.1](https://github.com/snakers4/silero-vad/tree/v5.1) のONNXモデルを変更せず同梱します。

- 配布元：[silero_vad.onnx](https://github.com/snakers4/silero-vad/blob/v5.1/src/silero_vad/data/silero_vad.onnx)
- 保存名：`silero_vad_v5.1.onnx`
- SHA-256：`2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f`
- ライセンス：MIT、Copyright (c) 2020-present Silero Team。全文は同梱の `LICENSE`。
- 入出力は公式 [OnnxWrapper](https://github.com/snakers4/silero-vad/blob/v5.1/src/silero_vad/utils_vad.py) を確認。16kHzの512サンプル＋64サンプルの文脈、RNN状態 `[2,1,128]`、`sr` はint64 scalar。出力 `output` は確率、`stateN` は次の状態。

推論は `onnxruntime-node@1.30.0`（MIT）を使用します。配布package.jsonにはNode.js enginesの指定がなく、N-API 6のnativeバインディングを使用します。このリポジトリのNode.js下限24.17.0は変更しません。macOS arm64 / Node.js 24.19.0でnativeロード・ソースTS Worker・ビルド済みJS Workerを実行しました。他OS/CPUは未検証です。

`pnpm install --frozen-lockfile` でRuntimeを導入します。`pnpm-workspace.yaml`でRuntimeのpostinstallを許可しています。モデルはリポジトリに含まれ、Bot起動時・停止時のモデルダウンロードはありません。デプロイ時は `dist/` と同じ親へ `assets/` を配置してください。初回推論前にモデルのSHA-256を検証し、不一致・欠落・Runtime読込失敗は音声を保持して判定不能にします。
