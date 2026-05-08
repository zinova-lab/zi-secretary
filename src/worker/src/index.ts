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
  looksLikeMeetingNote,
  postMultipartReply,
  postSlackMessage,
  splitForSlack,
  stripBotMention,
  verifySlackSignature,
} from "./slack";
import { askClaude } from "./anthropic";
import { detectIntent } from "./intent";
import { buildSystemPrompt } from "./prompt-builder";

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

  let placeholder;
  try {
    placeholder = await postSlackMessage(
      env.SLACK_BOT_TOKEN,
      event.channel,
      ":hourglass_flowing_sand: 考え中...",
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

  try {
    const userMessage = stripBotMention(event.text);
    console.log("[handleMention] userMessage:", userMessage);

    const intent = detectIntent(userMessage);
    console.log("[handleMention] intent:", intent);

    let userMeetingNote: string | undefined;
    const needsMeetingContext =
      intent.type === "task-extract" ||
      intent.type === "meeting-summary" ||
      intent.type === "job-post" ||
      intent.type === "pitch-deck";

    if (needsMeetingContext) {
      console.log("[handleMention] fetching channel history...");
      try {
        const history = await fetchChannelHistory(
          env.SLACK_BOT_TOKEN,
          event.channel,
          5,
          event.ts,
        );
        for (const msg of history) {
          if (msg.bot_id) continue;
          if (looksLikeMeetingNote(msg.text)) {
            userMeetingNote = msg.text;
            console.log(
              "[handleMention] found user meeting note, length:",
              msg.text.length,
            );
            break;
          }
        }
        if (!userMeetingNote) {
          console.log(
            "[handleMention] no user meeting note in recent history; using sample",
          );
        }
      } catch (err) {
        const detail =
          err instanceof Error ? err.message : String(err);
        console.error("[handleMention] failed to fetch history:", detail);
      }
    }

    console.log("[handleMention] building system prompt...");
    const systemPrompt = await buildSystemPrompt(intent, userMeetingNote);
    console.log("[handleMention] system prompt length:", systemPrompt.length);

    console.log("[handleMention] calling Claude...");
    const reply = await askClaude(
      env.ANTHROPIC_API_KEY,
      systemPrompt,
      userMessage,
    );
    console.log("[handleMention] reply length:", reply.length);

    const parts = splitForSlack(reply);
    console.log("[handleMention] split into", parts.length, "parts");

    console.log("[handleMention] posting reply (multipart)...");
    await postMultipartReply(
      env.SLACK_BOT_TOKEN,
      placeholder.channel,
      replyTs,
      placeholder.ts,
      parts,
    );
    console.log("[handleMention] done");
  } catch (err) {
    const detail =
      err instanceof Error
        ? `${err.name}: ${err.message}\n${err.stack ?? ""}`
        : String(err);
    console.error("[handleMention] error:", detail);
    const shortMsg = err instanceof Error ? err.message : "unknown error";
    try {
      await deleteSlackMessage(
        env.SLACK_BOT_TOKEN,
        placeholder.channel,
        placeholder.ts,
      );
    } catch (delErr) {
      const delDetail =
        delErr instanceof Error
          ? `${delErr.name}: ${delErr.message}`
          : String(delErr);
      console.error(
        "[handleMention] failed to delete placeholder on error:",
        delDetail,
      );
    }
    try {
      await postSlackMessage(
        env.SLACK_BOT_TOKEN,
        placeholder.channel,
        `:warning: エラーが発生しました: ${shortMsg}`,
        replyTs,
      );
    } catch (postErr) {
      const postDetail =
        postErr instanceof Error
          ? `${postErr.name}: ${postErr.message}`
          : String(postErr);
      console.error("[handleMention] failed to post error:", postDetail);
    }
  }
}

export default app;
