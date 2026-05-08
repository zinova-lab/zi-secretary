# Zi秘書 (zi-secretary)

ZiC秘書AI - Slackで動く業務支援エージェント

## 構造

zi-secretary/
├── prompts/                      # エージェントプロンプト
│   ├── secretary-hub.md          # 秘書AI(ハブ)
│   ├── agent-task-extract.md     # タスク抽出
│   ├── agent-job-post.md         # 求人原稿
│   ├── agent-pitch-deck.md       # 採用資料
│   └── agent-meeting-summary.md  # 議事録要約
├── rules/                        # 媒体ルール
│   ├── indeed.md
│   ├── mynavi.md
│   └── rikunavi-next.md
├── clients/                      # 顧客情報・サンプル
│   ├── dummy-rsc.md
│   └── dummy-rsc-meeting-2026-05-02.md
├── src/                          # ソースコード
└── README.md

## 起動コマンド例

@zi-secretary タスク抽出
@zi-secretary 求人原稿 Indeed 山田ホームズ様
@zi-secretary 採用資料 山田ホームズ様
@zi-secretary 議事録要約

メンションのみ → ボタンUI起動

## デプロイ先
Cloudflare Workers (zinovacreation.workers.dev)
