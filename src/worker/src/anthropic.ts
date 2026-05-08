import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2000;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [0, 2000, 5000];

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
    message.includes("timeout") ||
    message.includes("network")
  );
}

export async function askClaude(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const client = new Anthropic({ apiKey });
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt] ?? 0;
      console.log(
        `[askClaude] retrying (attempt ${attempt + 1}/${MAX_RETRIES}) after ${delay}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      });
      return response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
        .trim();
    } catch (err) {
      lastError = err;
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[askClaude] attempt ${attempt + 1} failed:`, detail);

      if (!isRetryableError(err)) {
        throw err;
      }
      if (attempt === MAX_RETRIES - 1) {
        throw err;
      }
    }
  }

  throw lastError ?? new Error("askClaude failed after retries");
}
