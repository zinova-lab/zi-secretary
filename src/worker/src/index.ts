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
import {
  askClaudeConversation,
  type ClaudeTool,
  type ConversationMessage,
} from "./anthropic";
import {
  detectIntent,
  hasExplicitAgentKeyword,
  intentLabel,
  wantsGoogleDoc,
  wantsMeetingContext,
  type Intent,
  type IntentType,
} from "./intent";
import { buildSystemPrompt } from "./prompt-builder";
import { createGoogleDoc } from "./google-docs";

// マルチエージェント構成。各 Bot は独立した Slack App として登録され、
// その Bot Token で chat.postMessage を呼ぶと Slack 上では各 Bot のアイデンティティ
// (Bot 名 / アイコン)で投稿される。username / icon_emoji の上書きは使わない。
type BotType = "hub" | "minato" | "nagi" | "suzu";

interface BotConfig {
  displayName: string;
  iconEmoji: string;
  getToken: (env: Env) => string;
  getSigningSecret: (env: Env) => string;
}

const BOT_CONFIGS: Record<BotType, BotConfig> = {
  hub: {
    displayName: "華",
    iconEmoji: ":cherry_blossom:",
    getToken: (env) => env.SLACK_BOT_TOKEN,
    getSigningSecret: (env) => env.SLACK_SIGNING_SECRET,
  },
  minato: {
    displayName: "湊",
    iconEmoji: ":briefcase:",
    getToken: (env) => env.MINATO_BOT_TOKEN,
    getSigningSecret: (env) => env.MINATO_SIGNING_SECRET,
  },
  nagi: {
    displayName: "凪",
    iconEmoji: ":clipboard:",
    getToken: (env) => env.NAGI_BOT_TOKEN,
    getSigningSecret: (env) => env.NAGI_SIGNING_SECRET,
  },
  suzu: {
    displayName: "鈴",
    iconEmoji: ":bell:",
    getToken: (env) => env.SUZU_BOT_TOKEN,
    getSigningSecret: (env) => env.SUZU_SIGNING_SECRET,
  },
};

// 華(ハブ)が単独で応答する際の受領メッセージ。湊・凪・鈴の「承りました」と
// 同じ位置づけで、考え中プレースホルダーを置き換えてユーザーに「秘書 AI が
// 業務を引き受けた」感を与える。intent に応じて文言を出し分け。
function getHubAcknowledgement(intent: Intent): string {
  switch (intent.type) {
    case "article-writer":
      return "私が対応いたします、記事を作成します…";
    case "email-writer":
      return "私が対応いたします、メール文面を考えます…";
    case "job-post":
      return "私が対応いたします、求人原稿を作成します…";
    case "pitch-deck":
      return "私が対応いたします、採用資料を作成します…";
    case "general":
      return "私が対応いたします、少々お待ちください…";
    default:
      return "私が対応いたします…";
  }
}

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

// Block Kit による歓迎/メニュー表示。空メンション or "スタート" / "start" /
// "ヘルプ" / "使い方" / "help" 等の welcome トリガーで表示。
// 既存の HELP_MESSAGE はこの Block Kit メッセージの「fallback text」として
// 引き続き使用される(通知文字列、Block 非対応クライアントでの表示)。
const WELCOME_BLOCKS: unknown[] = [
  {
    type: "header",
    text: {
      type: "plain_text",
      text: "🤖 こんにちは!華です",
      emoji: true,
    },
  },
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "業務を支援する AI 秘書です。\n採用 / マーケ / 営業 / 議事録活用を、一言の指示でサポートします。",
    },
  },
  { type: "divider" },
  {
    type: "header",
    text: {
      type: "plain_text",
      text: "👥 採用支援",
      emoji: true,
    },
  },
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*求人原稿*(Indeed / マイナビ / リクナビNEXT 対応)\n`@zi-secretary 求人原稿 Indeed 山田工務店様`\n\n*採用ピッチ資料*\n`@zi-secretary 採用資料 山田工務店様`",
    },
  },
  { type: "divider" },
  {
    type: "header",
    text: {
      type: "plain_text",
      text: "📝 マーケ支援",
      emoji: true,
    },
  },
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*記事執筆*(ブログ / コラム / オウンドメディア)\n`@zi-secretary 記事 中小企業のSlack活用術`",
    },
  },
  { type: "divider" },
  {
    type: "header",
    text: {
      type: "plain_text",
      text: "💼 営業支援",
      emoji: true,
    },
  },
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*ビジネスメール*(華が対応)\n`@zi-secretary 営業メール 山田工務店様にフォローアップ`\n`@zi-secretary メール 商談後のお礼を〇〇様に`\n\n*営業サポート*(湊が対応)\n提案書 / 商談記録 / 企業情報整理 / ネクストアクション / 営業ストーリー\n`@zi-secretary 営業サポート 提案書 〇〇株式会社向け`\n`@minato 提案書 〇〇株式会社向け`",
    },
  },
  { type: "divider" },
  {
    type: "header",
    text: {
      type: "plain_text",
      text: "📋 議事録活用",
      emoji: true,
    },
  },
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "議事録テキストを Slack に貼り付けた直後に呼び出します(凪が対応)。\n\n*議事録要約*\n`@zi-secretary 議事録要約`\n`@nagi 議事録要約`\n\n*タスク抽出*\n`@zi-secretary タスク抽出`\n`@nagi タスク抽出`\n\n*ToDo 整理*(議事録なしでも OK)\n`@zi-secretary ToDoリスト整理`\n`@nagi ToDo`",
    },
  },
  { type: "divider" },
  {
    type: "header",
    text: {
      type: "plain_text",
      text: "🔔 情報調査",
      emoji: true,
    },
  },
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "Web を検索して構造化情報を返します(鈴が対応)。\n企業情報 / 業界動向 / 競合調査 / 人物 / 商品・サービス\n`@zi-secretary 〇〇株式会社について調べて`\n`@zi-secretary AI業界の最新動向を調査`\n`@suzu 〇〇というツールについて教えて`",
    },
  },
  { type: "divider" },
  {
    type: "header",
    text: {
      type: "plain_text",
      text: "✨ 便利な使い方",
      emoji: true,
    },
  },
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*スレッドで対話的に磨く*\n華の応答に「@zi-secretary もっと押し強めに」「短く」など返すと、その指示で再生成します。\n\n*Google ドキュメントで納品*\n末尾に `docs` を付けると Google ドキュメントに出力します。\n例:`@zi-secretary 記事 〇〇 docs`",
    },
  },
  { type: "divider" },
  {
    type: "header",
    text: {
      type: "plain_text",
      text: "🚀 まず試してみる",
      emoji: true,
    },
  },
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "• `@zi-secretary 記事 リモートワーク導入のコツ`\n• `@zi-secretary 営業メール 商談後のお礼を山田様に`\n• `@zi-secretary 採用資料 山田工務店様`",
    },
  },
  { type: "divider" },
  {
    type: "header",
    text: {
      type: "plain_text",
      text: "👥 チームメンバー",
      emoji: true,
    },
  },
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "🌸 *華* - 全体統括 / 案内 / 採用 / 記事 / メール / 雑談\n💼 *湊* - 営業担当(提案書・商談記録・営業ストーリー)\n📋 *凪* - 議事録整理担当(タスク抽出・要約・ToDo)\n🔔 *鈴* - 情報調査担当(企業情報・市場リサーチ・競合調査)",
    },
  },
  {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "💡 困った時はいつでも `@zi-secretary ヘルプ` でこのメニューを表示します。",
      },
    ],
  },
];

const HELP_MESSAGE = `:wave: *華 - AI秘書Bot* の使い方

業務を支援する AI 秘書です。以下の機能があります。

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

*■ 営業支援*
• メール文面 — \`@zi-secretary 営業メール 〇〇株式会社にフォローアップ\`
   (新規営業 / フォローアップ / お礼 / 提案 / お断り 等)

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
  // ハブが自身で議事録コンテキストを system prompt に含めて Claude を呼ぶ
  // 対象の intent のみ true。湊・凪に委譲する intent(sales-support /
  // task-extract / meeting-summary / todo)は、委譲先の executeXxxTask 内で
  // 自前で議事録を取得するため、ここでは false 扱いとする。
  return (
    intent.type === "job-post" ||
    intent.type === "pitch-deck" ||
    intent.type === "article-writer" ||
    intent.type === "email-writer" ||
    intent.type === "general"
  );
}

// 議事録を必ず含めるべきエージェント(議事録抜きでは機能しない)。
// それ以外(article-writer / job-post / pitch-deck / email-writer / general)は
// wantsMeetingContext で明示的にユーザーが要求した時のみ含めて、
// 通常用途では system prompt の肥大化を避ける。
function requiresMeetingContext(intent: Intent): boolean {
  return intent.type === "task-extract" || intent.type === "meeting-summary";
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
  // 「考え中…」プレースホルダーを我々が明示的に削除済みかどうかを追跡。
  // help short-circuit / delegate / hub 直接応答パスで delete 後に true にセット。
  // catch ブロックと末尾の defensive cleanup はこのフラグを見て二重削除を回避する。
  let placeholderDeleted = false;
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
      const latestIntent = detectIntent(latestUserText);
      const explicit: IntentType | null =
        hasExplicitAgentKeyword(latestUserText);
      // 最新ユーザー発言が welcome トリガー(空メンション/スタート/ヘルプ等)なら
      // スレッド継続を無視して welcome を表示。
      if (latestIntent.type === "help") {
        intent = { type: "help" };
      } else if (explicit) {
        intent = { ...detectIntent(latestUserText), type: explicit };
      } else {
        intent = rootIntent;
      }
      console.log("[handleMention] intent(root):", rootIntent);
      console.log("[handleMention] intent(effective):", intent);

      if (needsMeetingContext(intent)) {
        const forceUse = requiresMeetingContext(intent);
        const userOptIn = wantsMeetingContext(latestUserText);
        if (forceUse || userOptIn) {
          console.log(
            "[handleMention] fetching channel history before thread root... (forceUse:",
            forceUse,
            "userOptIn:",
            userOptIn,
            ")",
          );
          userMeetingNote = await findMeetingNoteInHistory(
            env.SLACK_BOT_TOKEN,
            event.channel,
            event.thread_ts,
          );
        } else {
          console.log(
            "[handleMention] meeting context skipped (opt-in only, not requested)",
          );
        }
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
        const forceUse = requiresMeetingContext(intent);
        const userOptIn = wantsMeetingContext(userMessage);
        if (forceUse || userOptIn) {
          console.log(
            "[handleMention] fetching channel history... (forceUse:",
            forceUse,
            "userOptIn:",
            userOptIn,
            ")",
          );
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
        } else {
          console.log(
            "[handleMention] meeting context skipped (opt-in only, not requested)",
          );
        }
      }

      messages = [{ role: "user", content: userMessage }];
    }

    if (intent.type === "help") {
      console.log("[handleMention] help/welcome intent, short-circuiting");
      try {
        await deleteSlackMessage(
          env.SLACK_BOT_TOKEN,
          placeholder.channel,
          placeholder.ts,
        );
        placeholderDeleted = true;
      } catch (delErr) {
        const detail =
          delErr instanceof Error ? delErr.message : String(delErr);
        console.error(
          "[handleMention] welcome: failed to delete placeholder:",
          detail,
        );
      }
      await postSlackMessage(
        env.SLACK_BOT_TOKEN,
        placeholder.channel,
        HELP_MESSAGE,
        replyTs,
        WELCOME_BLOCKS,
      );
      cleanedUp = true;
      console.log("[handleMention] done (welcome)");
      return;
    }

    if (intent.type === "sales-support") {
      console.log("[handleMention] sales-support intent, delegating to minato");
      const userMessageForMinato = stripBotMention(event.text);
      await delegateToMinato(
        env,
        placeholder.channel,
        replyTs,
        userMessageForMinato,
        placeholder,
      );
      cleanedUp = true;
      console.log("[handleMention] done (delegated to minato)");
      return;
    }

    if (
      intent.type === "task-extract" ||
      intent.type === "meeting-summary" ||
      intent.type === "todo"
    ) {
      console.log(
        `[handleMention] ${intent.type} intent, delegating to nagi`,
      );
      const userMessageForNagi = stripBotMention(event.text);
      await delegateToNagi(
        env,
        placeholder.channel,
        replyTs,
        userMessageForNagi,
        placeholder,
        intent,
      );
      cleanedUp = true;
      console.log("[handleMention] done (delegated to nagi)");
      return;
    }

    if (intent.type === "research") {
      console.log("[handleMention] research intent, delegating to suzu");
      const userMessageForSuzu = stripBotMention(event.text);
      await delegateToSuzu(
        env,
        placeholder.channel,
        replyTs,
        userMessageForSuzu,
        placeholder,
        intent,
      );
      cleanedUp = true;
      console.log("[handleMention] done (delegated to suzu)");
      return;
    }

    // 華(ハブ)が単独で応答するパス。委譲分岐(help / sales-support /
    // task-extract / meeting-summary / todo / research)はすべて上の return
    // で抜けているので、ここに到達する intent は article-writer / email-writer
    // / job-post / pitch-deck / general のいずれか。
    //
    // 湊・凪・鈴と同じ「受領 + 本文」の 2 投稿フローに揃えるため、まず
    // 「考え中…」プレースホルダーを削除し、intent に応じた受領メッセージを
    // 独立投稿として送る。本文は Claude 応答が返った後にさらに新規投稿として
    // 追加する(postMultipartReply による placeholder 更新は使わない)。
    try {
      await deleteSlackMessage(
        env.SLACK_BOT_TOKEN,
        placeholder.channel,
        placeholder.ts,
      );
      placeholderDeleted = true;
    } catch (delErr) {
      const detail =
        delErr instanceof Error ? delErr.message : String(delErr);
      console.error(
        "[handleMention] hub direct: failed to delete placeholder:",
        detail,
      );
    }

    try {
      await postSlackMessage(
        env.SLACK_BOT_TOKEN,
        placeholder.channel,
        getHubAcknowledgement(intent),
        replyTs,
      );
    } catch (ackErr) {
      const detail =
        ackErr instanceof Error ? ackErr.message : String(ackErr);
      console.error(
        "[handleMention] hub direct: acknowledgement post failed:",
        detail,
      );
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

    // 本文は新規投稿として追加(受領メッセージはスレッドに残したまま、
    // 湊・凪・鈴と同じ振る舞い)。
    console.log("[handleMention] posting reply parts as new messages...");
    for (const part of postParts) {
      await postSlackMessage(
        env.SLACK_BOT_TOKEN,
        placeholder.channel,
        part,
        replyTs,
      );
    }
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

    if (placeholderDeleted) {
      // プレースホルダーは既に削除済み(hub 直接応答パス等で先に消した)。
      // 警告メッセージを新規投稿として出せていれば、それで十分。
      if (posted) {
        cleanedUp = true;
      }
    } else {
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
  }

  if (!cleanedUp && !placeholderDeleted) {
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

// ────────────────────────────────────────────────────────────
// 湊(営業担当 Bot)関連
// ────────────────────────────────────────────────────────────

// 湊として実際の作業を行うコア関数。ハブからの委譲・直接メンションの両方から
// 呼ばれる。intent は sales-support に固定し、議事録は opt-in のみ、docs 納品
// 分岐は既存ロジックを再利用する。
//
// 「承りました」は **独立した新規投稿** として送信する(placeholder ではない)。
// 本文も postMultipartReply で placeholder を「更新」するのではなく、新規投稿
// として追加する。これによりスレッドに 4 投稿のワークフローが可視化される。
async function executeMinatoTask(
  env: Env,
  channel: string,
  threadTs: string,
  userMessage: string,
  postAnnouncement: boolean,
): Promise<void> {
  const minatoToken = BOT_CONFIGS.minato.getToken(env);

  if (postAnnouncement) {
    try {
      await postSlackMessage(
        minatoToken,
        channel,
        "湊です。承りました、作成中です…",
        threadTs,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        "[executeMinatoTask] announcement post failed:",
        detail,
      );
    }
  }

  try {
    const baseIntent = detectIntent(userMessage);
    const intent: Intent = {
      ...baseIntent,
      type: "sales-support",
    };
    console.log("[executeMinatoTask] intent:", intent);

    let userMeetingNote: string | undefined;
    if (wantsMeetingContext(userMessage)) {
      console.log(
        "[executeMinatoTask] meeting context requested, fetching history...",
      );
      userMeetingNote = await findMeetingNoteInHistory(
        minatoToken,
        channel,
        threadTs,
      );
    }

    const systemPrompt = await buildSystemPrompt(intent, userMeetingNote);
    console.log(
      "[executeMinatoTask] system prompt length:",
      systemPrompt.length,
    );

    const reply = await askClaudeConversation(env.ANTHROPIC_API_KEY, systemPrompt, [
      { role: "user", content: userMessage },
    ]);
    console.log("[executeMinatoTask] reply length:", reply.length);

    const useDocs = wantsGoogleDoc(userMessage);
    let postParts: string[];
    if (useDocs) {
      console.log("[executeMinatoTask] google doc requested");
      try {
        const title = buildDocTitle(intent);
        const docUrl = await createGoogleDoc(
          env.GOOGLE_SERVICE_ACCOUNT_JSON,
          title,
          reply,
        );
        console.log("[executeMinatoTask] google doc created:", docUrl);
        postParts = [
          `:page_facing_up: ${intentLabel(intent.type)}をGoogle ドキュメントで作成しました\n${docUrl}`,
        ];
      } catch (docErr) {
        const detail =
          docErr instanceof Error ? docErr.message : String(docErr);
        console.error("[executeMinatoTask] google doc failed:", detail);
        postParts = [
          ":warning: Google ドキュメントの作成に失敗しました。本文を以下に投稿します。",
          ...splitForSlack(reply),
        ];
      }
    } else {
      postParts = splitForSlack(reply);
    }

    // 本文は新規投稿として追加(承りましたメッセージは残したまま)
    for (const part of postParts) {
      await postSlackMessage(minatoToken, channel, part, threadTs);
    }
  } catch (err) {
    const detail =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error("[executeMinatoTask] error:", detail);
    try {
      await postSlackMessage(
        minatoToken,
        channel,
        `:warning: 湊が応答できませんでした。少し時間を置いて再度お試しください。`,
        threadTs,
      );
    } catch (cleanupErr) {
      const cleanupDetail =
        cleanupErr instanceof Error
          ? cleanupErr.message
          : String(cleanupErr);
      console.error("[executeMinatoTask] cleanup failed:", cleanupDetail);
    }
  }
}

// ハブから湊への委譲。ハブの「考え中」プレースホルダーを削除し、ハブとして
// 引き継ぎ宣言を投稿してから湊を起動する。完了後にハブとして締めメッセージも投稿。
async function delegateToMinato(
  env: Env,
  channel: string,
  threadTs: string,
  userMessage: string,
  hubPlaceholder: PostedMessage,
): Promise<void> {
  const hubToken = BOT_CONFIGS.hub.getToken(env);

  try {
    await deleteSlackMessage(hubToken, hubPlaceholder.channel, hubPlaceholder.ts);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      "[delegateToMinato] failed to delete hub placeholder:",
      detail,
    );
  }

  // ハブとして引き継ぎ宣言
  try {
    await postSlackMessage(
      hubToken,
      channel,
      "営業のご依頼ですね。担当の湊にお願いします。",
      threadTs,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[delegateToMinato] hub handover post failed:", detail);
  }

  // 湊が実作業
  await executeMinatoTask(env, channel, threadTs, userMessage, true);

  // ハブとして締めメッセージ
  try {
    await postSlackMessage(
      hubToken,
      channel,
      "湊、ありがとう。他にもご依頼があればお声がけください。",
      threadTs,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[delegateToMinato] hub closing post failed:", detail);
  }
}

// @minato への直接メンションを処理。ハブを経由しない単体フロー。
async function handleMinatoMention(
  env: Env,
  event: SlackAppMentionEvent,
): Promise<void> {
  console.log("[handleMinatoMention] start", {
    channel: event.channel,
    user: event.user,
    ts: event.ts,
    thread_ts: event.thread_ts,
  });
  const replyTs = event.thread_ts ?? event.ts;
  const userMessage = stripBotMention(event.text);
  console.log("[handleMinatoMention] userMessage:", userMessage);

  // 直接メンションは内容に関わらず sales-support として湊が応対する。
  // 「承りました」プレースホルダーを置きつつ executeMinatoTask に処理を委ねる。
  await executeMinatoTask(env, event.channel, replyTs, userMessage, true);
  console.log("[handleMinatoMention] done");
}

// 湊専用 Slack イベント受信エンドポイント。
// Slack App 側の Event Subscriptions URL に
// https://<worker>/slack/minato/events を設定する想定。
app.post("/slack/minato/events", async (c) => {
  const rawBody = await c.req.text();

  let payload: SlackPayload;
  try {
    payload = JSON.parse(rawBody) as SlackPayload;
  } catch {
    return c.text("invalid json", 400);
  }

  console.log("[/slack/minato/events] payload.type =", payload.type);

  if (payload.type === "url_verification") {
    return c.json({ challenge: payload.challenge });
  }

  const timestamp = c.req.header("x-slack-request-timestamp");
  const signature = c.req.header("x-slack-signature");

  if (!timestamp || !signature) {
    console.error("[/slack/minato/events] missing slack headers");
    return c.text("missing slack headers", 400);
  }

  const valid = await verifySlackSignature(
    rawBody,
    timestamp,
    signature,
    BOT_CONFIGS.minato.getSigningSecret(c.env),
  );
  if (!valid) {
    console.error("[/slack/minato/events] signature INVALID");
    return c.text("invalid signature", 401);
  }

  if (payload.type === "event_callback") {
    const inner = (payload as SlackEventCallback).event;
    if (inner.type === "app_mention") {
      const event = inner as SlackAppMentionEvent;
      c.executionCtx.waitUntil(handleMinatoMention(c.env, event));
    }
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});

// ────────────────────────────────────────────────────────────
// 凪(議事録整理・タスク管理担当 Bot)関連
// ────────────────────────────────────────────────────────────

// 凪として実際の作業を行うコア関数。湊と同じ構造。
// forcedIntent が渡されればそれを使う(ハブからの委譲時)。なければ
// 入力から detectIntent し、凪の領域外(task-extract/meeting-summary/todo
// 以外)なら todo にフォールバック(直接 @nagi メンション時の安全策)。
//
// 議事録は requiresMeetingContext(task-extract / meeting-summary)なら必須、
// それ以外は wantsMeetingContext で opt-in 判定。
async function executeNagiTask(
  env: Env,
  channel: string,
  threadTs: string,
  userMessage: string,
  postAnnouncement: boolean,
  forcedIntent?: Intent,
): Promise<void> {
  const nagiToken = BOT_CONFIGS.nagi.getToken(env);

  if (postAnnouncement) {
    try {
      await postSlackMessage(
        nagiToken,
        channel,
        "凪です。承りました、整理します…",
        threadTs,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[executeNagiTask] announcement post failed:", detail);
    }
  }

  try {
    let intent: Intent;
    if (forcedIntent) {
      intent = forcedIntent;
    } else {
      const baseIntent = detectIntent(userMessage);
      if (
        baseIntent.type === "task-extract" ||
        baseIntent.type === "meeting-summary" ||
        baseIntent.type === "todo"
      ) {
        intent = baseIntent;
      } else {
        // 凪の領域外の依頼(挨拶含む)。todo を catch-all として使う:
        // 議事録 fetch は走らず、agent-nagi.md のペルソナで応答する。
        // 必要に応じてプロンプト側で他 Bot に誘導する。
        intent = { ...baseIntent, type: "todo" };
      }
    }
    console.log("[executeNagiTask] intent:", intent);

    let userMeetingNote: string | undefined;
    const forceUse = requiresMeetingContext(intent);
    const userOptIn = wantsMeetingContext(userMessage);
    if (forceUse || userOptIn) {
      console.log(
        "[executeNagiTask] fetching channel history (forceUse:",
        forceUse,
        "userOptIn:",
        userOptIn,
        ")",
      );
      userMeetingNote = await findMeetingNoteInHistory(
        nagiToken,
        channel,
        threadTs,
      );
    }

    const systemPrompt = await buildSystemPrompt(intent, userMeetingNote);
    console.log("[executeNagiTask] system prompt length:", systemPrompt.length);

    const reply = await askClaudeConversation(env.ANTHROPIC_API_KEY, systemPrompt, [
      { role: "user", content: userMessage },
    ]);
    console.log("[executeNagiTask] reply length:", reply.length);

    const useDocs = wantsGoogleDoc(userMessage);
    let postParts: string[];
    if (useDocs) {
      console.log("[executeNagiTask] google doc requested");
      try {
        const title = buildDocTitle(intent);
        const docUrl = await createGoogleDoc(
          env.GOOGLE_SERVICE_ACCOUNT_JSON,
          title,
          reply,
        );
        console.log("[executeNagiTask] google doc created:", docUrl);
        postParts = [
          `:page_facing_up: ${intentLabel(intent.type)}をGoogle ドキュメントで作成しました\n${docUrl}`,
        ];
      } catch (docErr) {
        const detail =
          docErr instanceof Error ? docErr.message : String(docErr);
        console.error("[executeNagiTask] google doc failed:", detail);
        postParts = [
          ":warning: Google ドキュメントの作成に失敗しました。本文を以下に投稿します。",
          ...splitForSlack(reply),
        ];
      }
    } else {
      postParts = splitForSlack(reply);
    }

    for (const part of postParts) {
      await postSlackMessage(nagiToken, channel, part, threadTs);
    }
  } catch (err) {
    const detail =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error("[executeNagiTask] error:", detail);
    try {
      await postSlackMessage(
        nagiToken,
        channel,
        `:warning: 凪が応答できませんでした。少し時間を置いて再度お試しください。`,
        threadTs,
      );
    } catch (cleanupErr) {
      const cleanupDetail =
        cleanupErr instanceof Error
          ? cleanupErr.message
          : String(cleanupErr);
      console.error("[executeNagiTask] cleanup failed:", cleanupDetail);
    }
  }
}

// ハブから凪への委譲。湊と同じパターン。
async function delegateToNagi(
  env: Env,
  channel: string,
  threadTs: string,
  userMessage: string,
  hubPlaceholder: PostedMessage,
  intent: Intent,
): Promise<void> {
  const hubToken = BOT_CONFIGS.hub.getToken(env);

  try {
    await deleteSlackMessage(hubToken, hubPlaceholder.channel, hubPlaceholder.ts);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      "[delegateToNagi] failed to delete hub placeholder:",
      detail,
    );
  }

  try {
    await postSlackMessage(
      hubToken,
      channel,
      "整理のご依頼ですね。凪にお願いします。",
      threadTs,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[delegateToNagi] hub handover post failed:", detail);
  }

  await executeNagiTask(env, channel, threadTs, userMessage, true, intent);

  try {
    await postSlackMessage(
      hubToken,
      channel,
      "凪、ありがとう。他にもご依頼があればお声がけください。",
      threadTs,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[delegateToNagi] hub closing post failed:", detail);
  }
}

// @nagi への直接メンション処理。湊と同じく executeNagiTask に委ねる
// (forcedIntent なしで呼ぶことで、入力からの intent 判定 + todo フォールバックが効く)。
async function handleNagiMention(
  env: Env,
  event: SlackAppMentionEvent,
): Promise<void> {
  console.log("[handleNagiMention] start", {
    channel: event.channel,
    user: event.user,
    ts: event.ts,
    thread_ts: event.thread_ts,
  });
  const replyTs = event.thread_ts ?? event.ts;
  const userMessage = stripBotMention(event.text);
  console.log("[handleNagiMention] userMessage:", userMessage);

  await executeNagiTask(env, event.channel, replyTs, userMessage, true);
  console.log("[handleNagiMention] done");
}

// 凪専用 Slack イベント受信エンドポイント。
// Slack App 側の Event Subscriptions URL に
// https://<worker>/slack/nagi/events を設定する想定。
app.post("/slack/nagi/events", async (c) => {
  const rawBody = await c.req.text();

  let payload: SlackPayload;
  try {
    payload = JSON.parse(rawBody) as SlackPayload;
  } catch {
    return c.text("invalid json", 400);
  }

  console.log("[/slack/nagi/events] payload.type =", payload.type);

  if (payload.type === "url_verification") {
    return c.json({ challenge: payload.challenge });
  }

  const timestamp = c.req.header("x-slack-request-timestamp");
  const signature = c.req.header("x-slack-signature");

  if (!timestamp || !signature) {
    console.error("[/slack/nagi/events] missing slack headers");
    return c.text("missing slack headers", 400);
  }

  const valid = await verifySlackSignature(
    rawBody,
    timestamp,
    signature,
    BOT_CONFIGS.nagi.getSigningSecret(c.env),
  );
  if (!valid) {
    console.error("[/slack/nagi/events] signature INVALID");
    return c.text("invalid signature", 401);
  }

  if (payload.type === "event_callback") {
    const inner = (payload as SlackEventCallback).event;
    if (inner.type === "app_mention") {
      const event = inner as SlackAppMentionEvent;
      c.executionCtx.waitUntil(handleNagiMention(c.env, event));
    }
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});

// ────────────────────────────────────────────────────────────
// 鈴(情報調査担当 Bot)関連
// ────────────────────────────────────────────────────────────

// Claude API の web_search ツール定義。鈴の Claude 呼び出し時にのみ渡す。
// 他 Bot は tools なし。
const SUZU_TOOLS: ClaudeTool[] = [
  { type: "web_search_20250305", name: "web_search" },
];

// 鈴として実際の作業を行うコア関数。湊・凪と同じ構造、追加で web_search
// ツールを Claude API に渡す。
async function executeSuzuTask(
  env: Env,
  channel: string,
  threadTs: string,
  userMessage: string,
  postAnnouncement: boolean,
  forcedIntent?: Intent,
): Promise<void> {
  const suzuToken = BOT_CONFIGS.suzu.getToken(env);

  if (postAnnouncement) {
    try {
      await postSlackMessage(
        suzuToken,
        channel,
        "鈴です。承りました、調査します…",
        threadTs,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[executeSuzuTask] announcement post failed:", detail);
    }
  }

  // 空メンション(@suzu だけ)対応:Claude API は空 content を拒否するため、
  // 案内メッセージだけ返して終了する。承りましたメッセージは残す(自然な流れ)。
  if (userMessage.trim().length === 0) {
    console.log("[executeSuzuTask] empty userMessage, posting guidance");
    try {
      await postSlackMessage(
        suzuToken,
        channel,
        "何を調べましょうか?例えば以下のような調査ができます:\n• `〇〇株式会社について調べて`\n• `〇〇業界の動向を調査`\n• `〇〇というツールについて教えて`",
        threadTs,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[executeSuzuTask] guidance post failed:", detail);
    }
    return;
  }

  try {
    let intent: Intent;
    if (forcedIntent) {
      intent = forcedIntent;
    } else {
      const baseIntent = detectIntent(userMessage);
      if (baseIntent.type === "research") {
        intent = baseIntent;
      } else {
        // 鈴の領域外フォールバック。research にクランプして
        // agent-suzu.md のペルソナ(専門外は他 Bot に誘導)で応答させる。
        intent = { ...baseIntent, type: "research" };
      }
    }
    console.log("[executeSuzuTask] intent:", intent);

    // 鈴は外部 Web で情報を取るため議事録は原則不要。
    // ユーザーが明示的に opt-in した時のみコンテキストに追加。
    let userMeetingNote: string | undefined;
    if (wantsMeetingContext(userMessage)) {
      console.log("[executeSuzuTask] meeting context requested (opt-in)");
      userMeetingNote = await findMeetingNoteInHistory(
        suzuToken,
        channel,
        threadTs,
      );
    }

    const systemPrompt = await buildSystemPrompt(intent, userMeetingNote);
    console.log("[executeSuzuTask] system prompt length:", systemPrompt.length);

    // ⭐ web_search ツールを Claude API に渡す。これにより必要に応じて
    // 検索が自動実行され、結果を踏まえた応答が返る。
    const reply = await askClaudeConversation(
      env.ANTHROPIC_API_KEY,
      systemPrompt,
      [{ role: "user", content: userMessage }],
      SUZU_TOOLS,
    );
    console.log("[executeSuzuTask] reply length:", reply.length);

    const useDocs = wantsGoogleDoc(userMessage);
    let postParts: string[];
    if (useDocs) {
      console.log("[executeSuzuTask] google doc requested");
      try {
        const title = buildDocTitle(intent);
        const docUrl = await createGoogleDoc(
          env.GOOGLE_SERVICE_ACCOUNT_JSON,
          title,
          reply,
        );
        console.log("[executeSuzuTask] google doc created:", docUrl);
        postParts = [
          `:page_facing_up: ${intentLabel(intent.type)}をGoogle ドキュメントで作成しました\n${docUrl}`,
        ];
      } catch (docErr) {
        const detail =
          docErr instanceof Error ? docErr.message : String(docErr);
        console.error("[executeSuzuTask] google doc failed:", detail);
        postParts = [
          ":warning: Google ドキュメントの作成に失敗しました。本文を以下に投稿します。",
          ...splitForSlack(reply),
        ];
      }
    } else {
      postParts = splitForSlack(reply);
    }

    for (const part of postParts) {
      await postSlackMessage(suzuToken, channel, part, threadTs);
    }
  } catch (err) {
    const detail =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error("[executeSuzuTask] error:", detail);
    try {
      await postSlackMessage(
        suzuToken,
        channel,
        `:warning: 鈴が応答できませんでした。少し時間を置いて再度お試しください。`,
        threadTs,
      );
    } catch (cleanupErr) {
      const cleanupDetail =
        cleanupErr instanceof Error
          ? cleanupErr.message
          : String(cleanupErr);
      console.error("[executeSuzuTask] cleanup failed:", cleanupDetail);
    }
  }
}

async function delegateToSuzu(
  env: Env,
  channel: string,
  threadTs: string,
  userMessage: string,
  hubPlaceholder: PostedMessage,
  intent: Intent,
): Promise<void> {
  const hubToken = BOT_CONFIGS.hub.getToken(env);

  try {
    await deleteSlackMessage(hubToken, hubPlaceholder.channel, hubPlaceholder.ts);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      "[delegateToSuzu] failed to delete hub placeholder:",
      detail,
    );
  }

  try {
    await postSlackMessage(
      hubToken,
      channel,
      "調査のご依頼ですね。鈴にお願いします。",
      threadTs,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[delegateToSuzu] hub handover post failed:", detail);
  }

  await executeSuzuTask(env, channel, threadTs, userMessage, true, intent);

  try {
    await postSlackMessage(
      hubToken,
      channel,
      "鈴、ありがとう。他にもご依頼があればお声がけください。",
      threadTs,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[delegateToSuzu] hub closing post failed:", detail);
  }
}

async function handleSuzuMention(
  env: Env,
  event: SlackAppMentionEvent,
): Promise<void> {
  console.log("[handleSuzuMention] start", {
    channel: event.channel,
    user: event.user,
    ts: event.ts,
    thread_ts: event.thread_ts,
  });
  const replyTs = event.thread_ts ?? event.ts;
  const userMessage = stripBotMention(event.text);
  console.log("[handleSuzuMention] userMessage:", userMessage);

  await executeSuzuTask(env, event.channel, replyTs, userMessage, true);
  console.log("[handleSuzuMention] done");
}

// 鈴専用 Slack イベント受信エンドポイント。
// Slack App 側の Event Subscriptions URL に
// https://<worker>/slack/suzu/events を設定する想定。
app.post("/slack/suzu/events", async (c) => {
  const rawBody = await c.req.text();

  let payload: SlackPayload;
  try {
    payload = JSON.parse(rawBody) as SlackPayload;
  } catch {
    return c.text("invalid json", 400);
  }

  console.log("[/slack/suzu/events] payload.type =", payload.type);

  if (payload.type === "url_verification") {
    return c.json({ challenge: payload.challenge });
  }

  const timestamp = c.req.header("x-slack-request-timestamp");
  const signature = c.req.header("x-slack-signature");

  if (!timestamp || !signature) {
    console.error("[/slack/suzu/events] missing slack headers");
    return c.text("missing slack headers", 400);
  }

  const valid = await verifySlackSignature(
    rawBody,
    timestamp,
    signature,
    BOT_CONFIGS.suzu.getSigningSecret(c.env),
  );
  if (!valid) {
    console.error("[/slack/suzu/events] signature INVALID");
    return c.text("invalid signature", 401);
  }

  if (payload.type === "event_callback") {
    const inner = (payload as SlackEventCallback).event;
    if (inner.type === "app_mention") {
      const event = inner as SlackAppMentionEvent;
      c.executionCtx.waitUntil(handleSuzuMention(c.env, event));
    }
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});

export default app;
