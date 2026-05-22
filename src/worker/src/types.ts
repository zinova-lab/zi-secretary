export interface Env {
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  ANTHROPIC_API_KEY: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  // 湊(営業担当)Bot 用シークレット。別 Slack App として登録され、
  // chat.postMessage で投稿すると Slack 上では「湊」として表示される。
  MINATO_BOT_TOKEN: string;
  MINATO_SIGNING_SECRET: string;
  // 凪(議事録整理・タスク管理担当)Bot 用シークレット。
  // 湊と同様、別 Slack App として登録された独立 Bot。
  NAGI_BOT_TOKEN: string;
  NAGI_SIGNING_SECRET: string;
  // 鈴(情報調査・市場リサーチ担当)Bot 用シークレット。
  // 別 Slack App。web_search ツール経由で Web 上の情報を集める役割。
  SUZU_BOT_TOKEN: string;
  SUZU_SIGNING_SECRET: string;
}

export interface SlackUrlVerification {
  type: "url_verification";
  token: string;
  challenge: string;
}

export interface SlackAppMentionEvent {
  type: "app_mention";
  user: string;
  text: string;
  ts: string;
  channel: string;
  event_ts: string;
  thread_ts?: string;
}

export interface SlackEventCallback {
  type: "event_callback";
  team_id: string;
  api_app_id: string;
  event: SlackAppMentionEvent | { type: string; [key: string]: unknown };
  event_id: string;
  event_time: number;
}

export type SlackPayload = SlackUrlVerification | SlackEventCallback;
