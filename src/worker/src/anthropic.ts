import Anthropic from "@anthropic-ai/sdk";

// 速度優先で Haiku を採用。品質を上げたい場合は "claude-sonnet-4-6" に切り替え。
const MODEL = "claude-haiku-4-5-20251001";
// 日本語+Markdownでの実測:2000 tokens ≒ 2000-3000字で末尾切れが発生していた。
// 4000 tokens ≒ 5000-6000字相当で、記事執筆など長文成果物にも安全。
// 全エージェントの共通上限として作用するが、各エージェント側のプロンプトで
// 適切な目安字数を指示しているため、無駄な肥大化は起きない。
const MAX_TOKENS = 4000;
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
