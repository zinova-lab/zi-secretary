import Anthropic from "@anthropic-ai/sdk";

// 速度優先で Haiku を採用。品質を上げたい場合は "claude-sonnet-4-6" に切り替え。
// 速度・品質バランスで Sonnet 4.6 を採用。
// Haiku 4.5 は速度優先だが、長文出力(記事執筆・採用資料)+ 長い入力
// プロンプト(議事録 8000字超を含む 11000字超)の組み合わせで 25秒
// タイムアウトに到達するケースが観測された。Sonnet 4.6 は速度最適化
// されつつ品質が高く、納品物の質向上と時間内完了を両立する。
const MODEL = "claude-sonnet-4-6";
// MAX_TOKENS=3000 は「末尾切れ防止」と「タイムアウト回避」の両立点。
// 3000 tokens ≒ 日本語 4000〜4500字相当、記事執筆の目安 2000〜3500字を
// 安全に書き切れる。他エージェント(議事録要約 500-800字、メール文面
// 100-400字 等)は遥かに小さい範囲で完結するため影響なし。
const MAX_TOKENS = 3000;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [0, 2000, 5000];
const CLAUDE_TIMEOUT_MS = 25000;

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return (
    message.includes("529") ||
    message.includes("overloaded") ||
    message.includes("rate_limit") ||
    message.includes("rate limit") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("504") ||
    message.includes("network")
  );
}

export async function askClaudeConversation(
  apiKey: string,
  systemPrompt: string,
  messages: ConversationMessage[],
): Promise<string> {
  const client = new Anthropic({ apiKey });
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt] ?? 0;
      console.log(
        `[askClaudeConversation] retrying (attempt ${attempt + 1}/${MAX_RETRIES}) after ${delay}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const apiPromise = client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages,
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Claude API timeout (${CLAUDE_TIMEOUT_MS / 1000}s)`)),
          CLAUDE_TIMEOUT_MS,
        );
      });

      const response = await Promise.race([apiPromise, timeoutPromise]);

      return response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
        .trim();
    } catch (err) {
      lastError = err;
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        `[askClaudeConversation] attempt ${attempt + 1} failed:`,
        detail,
      );

      if (!isRetryableError(err)) {
        throw err;
      }
      if (attempt === MAX_RETRIES - 1) {
        throw err;
      }
    }
  }

  throw lastError ?? new Error("askClaudeConversation failed after retries");
}

export async function askClaude(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  return askClaudeConversation(apiKey, systemPrompt, [
    { role: "user", content: userMessage },
  ]);
}
