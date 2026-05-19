import { Hono } from "hono";
import type {
  Env,
  SlackAppMentionEvent,
  SlackEventCallback,
  SlackPayload,
} from "./types";
import {
  deleteSlackMessage,
  fetchChannelHistory,
  fetchThreadReplies,
  looksLikeMeetingNote,
  postMultipartReply,
  postSlackMessage,
  splitForSlack,
  stripBotMention,
  updateSlackMessage,
  verifySlackSignature,
  type PostedMessage,
  type SlackThreadMessage,
} from "./slack";
import { askClaudeConversation, type ConversationMessage } from "./anthropic";
import {
  detectIntent,
  hasExplicitAgentKeyword,
  intentLabel,
  wantsGoogleDoc,
  type Intent,
  type IntentType,
} from "./intent";
import { buildSystemPrompt } from "./prompt-builder";
import { createGoogleDoc } from "./google-docs";

function buildDocTitle(intent: Intent): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  const label = intentLabel(intent.type);
  if (intent.company) {
    return `${label} - ${intent.company} (${dateStr})`;
  }
  return `${label} (${dateStr})`;
}

const MAX_THREAD_MESSAGES = 40;
const PLACEHOLDER_TEXT = ":hourglass_flowing_sand: 考え中...";
const MENTION_PATTERN = /<@[A-Z0-9]+>/;

const HELP_MESSAGE = `:wave: *華 - AI秘書Bot* の使い方

私は ZiC の業務を支援する AI 秘書です。以下の機能があります。

*■ 議事録から作る*
• タスク抽出 — \`@zi-secretary タスク抽出\`
• 議事録要約 — \`@zi-secretary 議事録要約\`
※ チャンネルに議事録を貼ってから実行すると、その内容を使います

*■ 採用支援*
• 求人原稿 — \`@zi-secretary 求人原稿 Indeed 〇〇様\`
   (媒体: Indeed / マイナビ / リクナビNEXT に対応)
• 採用資料 — \`@zi-secretary 採用資料 〇〇様\`

*■ マーケ支援*
• 記事執筆 — \`@zi-secretary 記事 テーマや指示\`
   (ブログ / コラム / オウンドメディア記事)

*■ 便利な使い方*
• *対話で仕上げる*: 私の返信にスレッドで返信すると、「もっとカジュアルに」「事例を追加して」など修正指示で磨けます
• *ドキュメント納品*: 末尾に \`docs\` を付けると Google ドキュメントで納品します(例: \`@zi-secretary 記事 〇〇 docs\`)

困ったら \`@zi-secretary ヘルプ\` でいつでもこの案内を表示します。`;

function findIntentSourceText(replies: SlackThreadMessage[]): string {
  for (const msg of replies) {
    if (msg.bot_id) continue;
    if (looksLikeMeetingNote(msg.text)) continue;
    if (!MENTION_PATTERN.test(msg.text)) continue;
    return stripBotMention(msg.text);
  }
  for (const msg of replies) {
    if (msg.bot_id) continue;
    return stripBotMention(msg.text);
  }
  return "";
}

function cleanBotText(text: string): string {
  return text
    .replace(/:[a-z_]+:/g, "")
    .trim();
}

function needsMeetingContext(intent: Intent): boolean {
  return (
    intent.type === "task-extract" ||
    intent.type === "meeting-summary" ||
    intent.type === "job-post" ||
    intent.type === "pitch-deck" ||
    intent.type === "article-writer" ||
    intent.type === "general"
  );
}

async function findMeetingNoteInHistory(
  token: string,
  channel: string,
  beforeTs: string,
): Promise<string | undefined> {
  try {
    const history = await fetchChannelHistory(token, channel, 15, beforeTs);
    for (const msg of history) {
      if (msg.bot_id) continue;
      if (looksLikeMeetingNote(msg.text)) {
        console.log(
          "[findMeetingNoteInHistory] found user meeting note, length:",
          msg.text.length,
        );
        return msg.text;
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[findMeetingNoteInHistory] failed:", detail);
  }
  return undefined;
}

interface ConversationFromReplies {
  messages: ConversationMessage[];
  truncated: boolean;
  multiUser: boolean;
}

function repliesToConversation(
  replies: SlackThreadMessage[],
  placeholderTs: string,
): ConversationFromReplies {
  const userIds = new Set<string>();
  for (const msg of replies) {
    if (msg.bot_id) continue;
    if (msg.user) userIds.add(msg.user);
  }
  const multiUser = userIds.size > 1;

  const result: ConversationMessage[] = [];
  for (const msg of replies) {
    if (msg.ts === placeholderTs) continue;
    if (msg.bot_id && msg.text.trim() === PLACEHOLDER_TEXT.trim()) continue;

    const role: "user" | "assistant" = msg.bot_id ? "assistant" : "user";
    let content: string;
    if (msg.bot_id) {
      content = cleanBotText(msg.text);
    } else {
      const stripped = stripBotMention(msg.text).trim();
      content =
        multiUser && msg.user
          ? `[発言者: ${msg.user}]\n${stripped}`
          : stripped;
    }
    if (!content.trim()) continue;

    const last = result[result.length - 1];
    if (last && last.role === role) {
      last.content += "\n\n" + content;
    } else {
      result.push({ role, content });
    }
  }

  while (result.length > 0 && result[0]?.role !== "user") {
    result.shift();
  }
  while (
    result.length > 0 &&
    result[result.length - 1]?.role !== "user"
  ) {
    result.pop();
  }

  let truncated = false;
  let messages = result;
  if (messages.length > MAX_THREAD_MESSAGES) {
    truncated = true;
    messages = messages.slice(messages.length - MAX_THREAD_MESSAGES);
    while (messages.length > 0 && messages[0]?.role !== "user") {
      messages.shift();
    }
  }
  return { messages, truncated, multiUser };
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("zi-secretary worker is running"));

app.post("/slack/events", async (c) => {
  const rawBody = await c.req.text();

  let payload: SlackPayload;
  try {
    payload = JSON.parse(rawBody) as SlackPayload;
  } catch {
    return c.text("invalid json", 400);
  }

  console.log("[/slack/events] payload.type =", payload.type);

  if (payload.type === "url_verification") {
    return c.json({ challenge: payload.challenge });
  }

  const timestamp = c.req.header("x-slack-request-timestamp");
  const signature = c.req.header("x-slack-signature");

  console.log("[/slack/events] headers present:", {
    timestamp: Boolean(timestamp),
    signature: Boolean(signature),
  });

  if (!timestamp || !signature) {
    console.error("[/slack/events] missing slack headers");
    return c.text("missing slack headers", 400);
  }

  console.log("[/slack/events] verifying signature...");
  const valid = await verifySlackSignature(
    rawBody,
    timestamp,
    signature,
    c.env.SLACK_SIGNING_SECRET,
  );
  if (!valid) {
    console.error("[/slack/events] signature INVALID");
    return c.text("invalid signature", 401);
  }
  console.log("[/slack/events] signature verified");

  if (payload.type === "event_callback") {
    console.log("[/slack/events] entering event_callback branch");
    const inner = (payload as SlackEventCallback).event;
    console.log("[/slack/events] event.type =", inner.type);
    if (inner.type === "app_mention") {
      const event = inner as SlackAppMentionEvent;
      c.executionCtx.waitUntil(handleMention(c.env, event));
    } else {
      console.log("[/slack/events] non-app_mention event, skipping");
    }
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});

function friendlyErrorMessage(
  err: unknown,
  isThreadContinuation: boolean,
): string {
  const msg = err instanceof Error ? err.message : "unknown error";
  const lower = msg.toLowerCase();
  let base: string;
  if (lower.includes("timeout")) {
    base = "応答に時間がかかりすぎました。もう一度お試しください。";
  } else if (lower.includes("overloaded") || lower.includes("529")) {
    base = "Claude APIが混雑しています。しばらくしてから再度お試しください。";
  } else if (lower.includes("rate_limit") || lower.includes("rate limit")) {
    base = "APIの利用制限に達しました。しばらくしてから再度お試しください。";
  } else if (lower.includes("conversations.history")) {
    base =
      "Slackチャンネルの履歴取得に失敗しました。Botの権限を確認してください。";
  } else if (lower.includes("conversations.replies")) {
    base =
      "スレッド履歴の取得に失敗しました。Botの権限を確認してください。";
  } else {
    base = `エラーが発生しました: ${msg}`;
  }

  if (isThreadContinuation) {
    base +=
      "\n※これまでの会話内容は保持されています。同じスレッドで再度メンションすれば続きから再開できます。";
  }
  return base;
}

async function handleMention(
  env: Env,
  event: SlackAppMentionEvent,
): Promise<void> {
  console.log("[handleMention] start", {
    channel: event.channel,
    user: event.user,
    ts: event.ts,
    thread_ts: event.thread_ts,
  });
  const replyTs = event.thread_ts ?? event.ts;
  const isThreadContinuation = Boolean(event.thread_ts);

  let placeholder: PostedMessage;
  try {
    placeholder = await postSlackMessage(
      env.SLACK_BOT_TOKEN,
      event.channel,
      PLACEHOLDER_TEXT,
      replyTs,
    );
    console.log("[handleMention] placeholder posted, ts:", placeholder.ts);
  } catch (err) {
    const detail =
      err instanceof Error
        ? `${err.name}: ${err.message}`
        : String(err);
    console.error("[handleMention] failed to post placeholder:", detail);
    return;
  }

  let cleanedUp = false;
  try {
    console.log(
      "[handleMention] thread continuation:",
      isThreadContinuation,
    );

    let intent: Intent;
    let messages: ConversationMessage[];
    let userMeetingNote: string | undefined;
    let truncated = false;
    let multiUser = false;

    if (isThreadContinuation && event.thread_ts) {
      // TODO: 長大スレッドのトークン最適化。現状は MAX_THREAD_MESSAGES (40件) での
      // 件数制限のみ。将来的に古い会話の要約圧縮 (map-reduce) を検討。
      console.log("[handleMention] fetching thread replies...");
      const replies = await fetchThreadReplies(
        env.SLACK_BOT_TOKEN,
        event.channel,
        event.thread_ts,
      );
      console.log("[handleMention] thread replies count:", replies.length);

      if (replies.length === 0) {
        throw new Error("thread has no replies");
      }

      const intentSourceText = findIntentSourceText(replies);
      const rootIntent = detectIntent(intentSourceText);
      const latestUserText = stripBotMention(event.text);
      const explicit: IntentType | null =
        hasExplicitAgentKeyword(latestUserText);
      intent = explicit
        ? { ...detectIntent(latestUserText), type: explicit }
        : rootIntent;
      console.log("[handleMention] intent(root):", rootIntent);
      console.log("[handleMention] intent(effective):", intent);

      if (needsMeetingContext(intent)) {
        console.log(
          "[handleMention] fetching channel history before thread root...",
        );
        userMeetingNote = await findMeetingNoteInHistory(
          env.SLACK_BOT_TOKEN,
          event.channel,
          event.thread_ts,
        );
      }

      const conv = repliesToConversation(replies, placeholder.ts);
      messages = conv.messages;
      truncated = conv.truncated;
      multiUser = conv.multiUser;
      console.log(
        "[handleMention] conversation messages count:",
        messages.length,
        "truncated:",
        truncated,
        "multiUser:",
        multiUser,
      );
      if (messages.length === 0) {
        throw new Error("no valid messages in thread");
      }
    } else {
      const userMessage = stripBotMention(event.text);
      console.log("[handleMention] userMessage:", userMessage);

      intent = detectIntent(userMessage);
      console.log("[handleMention] intent:", intent);

      if (needsMeetingContext(intent)) {
        console.log("[handleMention] fetching channel history...");
        userMeetingNote = await findMeetingNoteInHistory(
          env.SLACK_BOT_TOKEN,
          event.channel,
          event.ts,
        );
        if (!userMeetingNote) {
          console.log(
            "[handleMention] no user meeting note in recent history; using sample",
          );
        }
      }

      messages = [{ role: "user", content: userMessage }];
    }

    if (intent.type === "help") {
      console.log("[handleMention] help intent, short-circuiting");
      await postMultipartReply(
        env.SLACK_BOT_TOKEN,
        placeholder.channel,
        replyTs,
        placeholder.ts,
        [HELP_MESSAGE],
      );
      cleanedUp = true;
      console.log("[handleMention] done (help)");
      return;
    }

    console.log("[handleMention] building system prompt...");
    let systemPrompt = await buildSystemPrompt(intent, userMeetingNote);
    if (multiUser) {
      systemPrompt +=
        "\n\n========================================\n# スレッド参加者\n========================================\n\nこのスレッドには複数の参加者がいます。発言冒頭の `[発言者: Uxxxxx]` は Slack ユーザーIDです。発言者IDに注意して文脈を理解してください。";
    }
    console.log("[handleMention] system prompt length:", systemPrompt.length);

    console.log("[handleMention] calling Claude...");
    const reply = await askClaudeConversation(
      env.ANTHROPIC_API_KEY,
      systemPrompt,
      messages,
    );
    console.log("[handleMention] reply length:", reply.length);

    const finalReply = truncated
      ? `${reply}\n\n---\n(注:会話が長くなったため、古い一部のやりとりは省略されています)`
      : reply;

    const useDocs = wantsGoogleDoc(stripBotMention(event.text));
    let postParts: string[];

    if (useDocs) {
      console.log("[handleMention] google doc requested");
      try {
        const title = buildDocTitle(intent);
        const docUrl = await createGoogleDoc(
          env.GOOGLE_SERVICE_ACCOUNT_JSON,
          title,
          reply,
        );
        console.log("[handleMention] google doc created:", docUrl);
        const noticeSuffix = truncated
          ? "\n(注:会話が長くなったため、古い一部のやりとりは省略されています)"
          : "";
        postParts = [
          `:page_facing_up: ${intentLabel(intent.type)}をGoogle ドキュメントで作成しました\n${docUrl}${noticeSuffix}`,
        ];
      } catch (docErr) {
        const detail =
          docErr instanceof Error ? docErr.message : String(docErr);
        console.error("[handleMention] google doc failed:", detail);
        postParts = [
          ":warning: Google ドキュメントの作成に失敗しました。本文を以下に投稿します。",
          ...splitForSlack(finalReply),
        ];
      }
    } else {
      postParts = splitForSlack(finalReply);
    }

    console.log("[handleMention] split into", postParts.length, "parts");

    console.log("[handleMention] posting reply (multipart)...");
    await postMultipartReply(
      env.SLACK_BOT_TOKEN,
      placeholder.channel,
      replyTs,
      placeholder.ts,
      postParts,
    );
    cleanedUp = true;
    console.log("[handleMention] done");
  } catch (err) {
    const detail =
      err instanceof Error
        ? `${err.name}: ${err.message}\n${err.stack ?? ""}`
        : String(err);
    console.error("[handleMention] error:", detail);

    const userMsg = friendlyErrorMessage(err, isThreadContinuation);

    let posted = false;
    try {
      await postSlackMessage(
        env.SLACK_BOT_TOKEN,
        placeholder.channel,
        `:warning: ${userMsg}`,
        replyTs,
      );
      posted = true;
    } catch (postErr) {
      const postDetail =
        postErr instanceof Error
          ? `${postErr.name}: ${postErr.message}`
          : String(postErr);
      console.error("[handleMention] failed to post error:", postDetail);
    }

    try {
      if (posted) {
        await deleteSlackMessage(
          env.SLACK_BOT_TOKEN,
          placeholder.channel,
          placeholder.ts,
        );
      } else {
        await updateSlackMessage(
          env.SLACK_BOT_TOKEN,
          placeholder.channel,
          placeholder.ts,
          `:warning: ${userMsg}`,
        );
      }
      cleanedUp = true;
    } catch (cleanupErr) {
      const cleanupDetail =
        cleanupErr instanceof Error
          ? `${cleanupErr.name}: ${cleanupErr.message}`
          : String(cleanupErr);
      console.error("[handleMention] cleanup failed:", cleanupDetail);
    }
  }

  if (!cleanedUp) {
    console.log("[handleMention] running final defensive cleanup");
    try {
      await deleteSlackMessage(
        env.SLACK_BOT_TOKEN,
        placeholder.channel,
        placeholder.ts,
      );
      console.log("[handleMention] final defensive cleanup succeeded");
    } catch (err) {
      const detail =
        err instanceof Error ? err.message : String(err);
      console.error(
        "[handleMention] final defensive cleanup failed:",
        detail,
      );
    }
  }
}

export default app;
