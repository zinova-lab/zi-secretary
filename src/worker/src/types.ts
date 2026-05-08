export interface Env {
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  ANTHROPIC_API_KEY: string;
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
