export async function verifySlackSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  signingSecret: string,
): Promise<boolean> {
  const ts = Number.parseInt(timestamp, 10);
  if (Number.isNaN(ts)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 60 * 5) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(baseString),
  );
  const computed = `v0=${[...new Uint8Array(sigBytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

  if (computed.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < computed.length; i++) {
    result |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

export function stripBotMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

interface SlackApiResponse {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
  warning?: string;
  response_metadata?: unknown;
  message?: unknown;
}

export interface PostedMessage {
  channel: string;
  ts: string;
}

export async function postSlackMessage(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
  blocks?: unknown[],
): Promise<PostedMessage> {
  const body: Record<string, unknown> = { channel, text };
  if (threadTs) body.thread_ts = threadTs;
  if (blocks && blocks.length > 0) body.blocks = blocks;

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as SlackApiResponse;
  if (!json.ok) {
    throw new Error(
      `chat.postMessage failed: ${JSON.stringify(json)} (http=${res.status})`,
    );
  }
  if (!json.ts || !json.channel) {
    throw new Error(
      `chat.postMessage response missing ts/channel: ${JSON.stringify(json)}`,
    );
  }
  return { channel: json.channel, ts: json.ts };
}

export async function updateSlackMessage(
  token: string,
  channel: string,
  ts: string,
  text: string,
): Promise<void> {
  const res = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, ts, text }),
  });
  const json = (await res.json()) as SlackApiResponse;
  if (!json.ok) {
    throw new Error(
      `chat.update failed: ${JSON.stringify(json)} (http=${res.status})`,
    );
  }
}

export async function deleteSlackMessage(
  token: string,
  channel: string,
  ts: string,
): Promise<void> {
  const res = await fetch("https://slack.com/api/chat.delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, ts }),
  });
  const json = (await res.json()) as SlackApiResponse;
  if (!json.ok) {
    throw new Error(
      `chat.delete failed: ${JSON.stringify(json)} (http=${res.status})`,
    );
  }
}

export interface SlackMessage {
  user?: string;
  text: string;
  ts: string;
  bot_id?: string;
  subtype?: string;
}

interface SlackHistoryResponse {
  ok: boolean;
  messages?: SlackMessage[];
  error?: string;
  response_metadata?: unknown;
}

export async function fetchChannelHistory(
  token: string,
  channel: string,
  limit: number = 10,
  beforeTs?: string,
): Promise<SlackMessage[]> {
  const params = new URLSearchParams({
    channel,
    limit: String(limit),
  });
  if (beforeTs) params.set("latest", beforeTs);

  const res = await fetch(
    `https://slack.com/api/conversations.history?${params.toString()}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
  const json = (await res.json()) as SlackHistoryResponse;
  if (!json.ok) {
    throw new Error(
      `conversations.history failed: ${JSON.stringify(json)} (http=${res.status})`,
    );
  }
  return json.messages ?? [];
}

export interface SlackThreadMessage {
  user?: string;
  text: string;
  ts: string;
  bot_id?: string;
  subtype?: string;
}

interface SlackRepliesResponse {
  ok: boolean;
  messages?: SlackThreadMessage[];
  error?: string;
  response_metadata?: unknown;
}

export async function fetchThreadReplies(
  token: string,
  channel: string,
  threadTs: string,
): Promise<SlackThreadMessage[]> {
  const params = new URLSearchParams({
    channel,
    ts: threadTs,
    limit: "50",
  });
  const res = await fetch(
    `https://slack.com/api/conversations.replies?${params.toString()}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
  const json = (await res.json()) as SlackRepliesResponse;
  if (!json.ok) {
    throw new Error(
      `conversations.replies failed: ${JSON.stringify(json)} (http=${res.status})`,
    );
  }
  return json.messages ?? [];
}

const MEETING_MIN_LENGTH = 200;

export function looksLikeMeetingNote(text: string): boolean {
  if (!text) return false;
  if (text.length < MEETING_MIN_LENGTH) return false;

  const stripped = text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (stripped.length < MEETING_MIN_LENGTH) return false;

  return true;
}

const SLACK_CHUNK_SIZE = 3500;

export function splitForSlack(
  text: string,
  maxLen: number = SLACK_CHUNK_SIZE,
): string[] {
  if (text.length <= maxLen) {
    return text.length > 0 ? [text] : [];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen);
    let cut: number;

    const paraIdx = slice.lastIndexOf("\n\n");
    const lineIdx = slice.lastIndexOf("\n");
    const sentIdx = slice.lastIndexOf("。");

    if (paraIdx > 0) {
      cut = paraIdx + 2;
    } else if (lineIdx > 0) {
      cut = lineIdx + 1;
    } else if (sentIdx > 0) {
      cut = sentIdx + 1;
    } else {
      cut = maxLen;
    }

    const chunk = remaining.slice(0, cut).trimEnd();
    if (chunk.length > 0) chunks.push(chunk);
    remaining = remaining.slice(cut);
  }

  const tail = remaining.trim();
  if (tail.length > 0) chunks.push(tail);

  return chunks;
}

export async function postMultipartReply(
  token: string,
  channel: string,
  threadTs: string,
  placeholderTs: string,
  parts: string[],
): Promise<void> {
  try {
    await deleteSlackMessage(token, channel, placeholderTs);
  } catch (err) {
    const detail =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error("[postMultipartReply] failed to delete placeholder:", detail);
  }

  if (parts.length === 0) {
    await postSlackMessage(token, channel, "(空の応答)", threadTs);
    return;
  }

  for (const part of parts) {
    await postSlackMessage(token, channel, part, threadTs);
  }
}
