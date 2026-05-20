import Anthropic from "@anthropic-ai/sdk";

// 速度優先で Haiku 4.5 を採用。
// Sonnet 4.6 は品質は高いが、入力プロンプトを 11500→5025 字に圧縮しても
// Cloudflare Workers の 25 秒制限内で出力 3000 tokens を生成しきれなかった。
// 入力サイズ最適化(intent.ts: wantsMeetingContext によるオプトイン式
// 議事録コンテキスト)と組み合わせ、Haiku で確実に完走させる構成にする。
// 将来 streaming レスポンス対応 or Workers Paid プラン(CPU 時間拡張)を
// 導入すれば、Sonnet 4.6 再導入を再検討する。
const MODEL = "claude-haiku-4-5-20251001";
// MAX_TOKENS=3000 は「末尾切れ防止」と「タイムアウト回避」の両立点。
// 3000 tokens ≒ 日本語 4000〜4500字相当、記事執筆の目安 2000〜3500字を
// 安全に書き切れる。他エージェント(議事録要約 500-800字、メール文面
// 100-400字 等)は遥かに小さい範囲で完結するため影響なし。
const MAX_TOKENS = 3000;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [0, 2000, 5000];
// 45 秒に設定。Workers の CPU 時間制限(30 秒)は fetch() による
// 外部 API 待ちを含まないため、wall-clock でこれ以上待つことは公式制限上
// 問題ない。
//
// 平均完了時間 24 秒(実測)に対し、約 2 倍の余裕(48 秒近似で 45 秒)。
// エンジニアリング定石「平均の 2 倍程度の余裕」に合致。
//
// 60 秒は過剰と判断:失敗時のユーザー待ち時間が長すぎる。
// 最悪リトライ 3 回で 60+2+60+5+60 = 187 秒に達するため、Slack UX として
// 不適切。45 秒なら最悪 45+2+45+5+45 = 142 秒に収まる(まだ長いが許容範囲)。
//
// 履歴:
//  - 25 秒(5 秒マージン取りすぎ、24 秒完了でも打ち切られていた)
//  - 28 秒(検証段階)
//  - 45 秒(本日確定、平均の約 2 倍余裕)
const CLAUDE_TIMEOUT_MS = 45000;

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
    message.includes("network") ||
    message.includes("timeout")
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

    const startMs = Date.now();
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

      const elapsedMs = Date.now() - startMs;
      console.log(
        `[askClaudeConversation] attempt ${attempt + 1} succeeded in ${elapsedMs}ms`,
      );

      return response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
        .trim();
    } catch (err) {
      lastError = err;
      const elapsedMs = Date.now() - startMs;
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        `[askClaudeConversation] attempt ${attempt + 1} failed in ${elapsedMs}ms:`,
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
