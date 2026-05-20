export type IntentType =
  | "help"
  | "task-extract"
  | "job-post"
  | "pitch-deck"
  | "meeting-summary"
  | "article-writer"
  | "email-writer"
  | "general";

export type Media = "indeed" | "mynavi" | "rikunavi-next";

export interface Intent {
  type: IntentType;
  media?: Media;
  company?: string;
}

const JOB_POST_KEYWORDS = ["求人原稿", "求人"];
const PITCH_DECK_KEYWORDS = ["採用資料", "ピッチ資料", "会社説明"];
// TODO: "要約" 単独は汎用的な要約依頼にも反応する(誤検出余地あり)。
// general に流す方が適切な場面もあるが、議事録要約の検出が弱くなる懸念があるため
// 慎重判断が必要。今回はスコープ外として保留。
const MEETING_SUMMARY_KEYWORDS = ["議事録要約", "要約", "サマリー"];
const TASK_EXTRACT_KEYWORDS = ["タスク抽出", "タスク", "todo", "やること"];
const ARTICLE_WRITER_KEYWORDS = [
  "記事執筆",
  "記事",
  "ブログ",
  "コラム",
  "オウンドメディア",
];
// TODO: "メール" 単独は汎用的なメール話題にも反応する余地あり。
// 誤検出が観測されたらキーワードを絞る(例:「メール」を外し
// 「メール文面」「営業メール」「ビジネスメール」のみに限定)。
const EMAIL_WRITER_KEYWORDS = [
  "メール",
  "営業メール",
  "文面",
  "ビジネスメール",
  "営業文面",
];
const HELP_KEYWORDS = [
  "ヘルプ",
  "助けて",
  "使い方",
  "なにができ",
  "何ができ",
  "help",
];

const MEDIA_RULES: Array<{ media: Media; keywords: string[] }> = [
  { media: "indeed", keywords: ["indeed"] },
  { media: "mynavi", keywords: ["マイナビ", "mynavi"] },
  { media: "rikunavi-next", keywords: ["リクナビ", "rikunavi"] },
];

function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => text.includes(kw));
}

function detectMedia(loweredText: string): Media | undefined {
  for (const { media, keywords } of MEDIA_RULES) {
    if (keywords.some((kw) => loweredText.includes(kw))) {
      return media;
    }
  }
  return undefined;
}

function extractCompany(text: string): string | undefined {
  // 長文ペースト中の誤抽出を避けるため、1行目のみを対象にする。
  // 通常のコマンドは "@zi-secretary 求人原稿 Indeed 山田ホームズ様" のような
  // 短い1行入力。長文の途中の「〜様」「〜株式会社」等にマッチしないようにする。
  const firstLine = text.split("\n")[0] ?? "";

  const samaMatch = firstLine.match(/([^\s「『【]+?)(?:様|さん)/);
  if (samaMatch && samaMatch[1]) return samaMatch[1];

  const corpMatch = firstLine.match(
    /([^\s「『【]+?(?:株式会社|有限会社|合同会社|工務店|ホームズ|建設|建築))/,
  );
  if (corpMatch && corpMatch[1]) return corpMatch[1];

  return undefined;
}

export function detectIntent(text: string): Intent {
  const lowered = text.toLowerCase();
  const company = extractCompany(text);

  // help を最優先で判定。ただし他エージェント語が同時に含まれる場合は
  // 他エージェントを優先(例:「ヘルプ記事を書いて」→ article-writer)。
  if (containsAny(lowered, HELP_KEYWORDS)) {
    const otherAgent =
      containsAny(lowered, JOB_POST_KEYWORDS) ||
      containsAny(lowered, PITCH_DECK_KEYWORDS) ||
      containsAny(lowered, MEETING_SUMMARY_KEYWORDS) ||
      containsAny(lowered, TASK_EXTRACT_KEYWORDS) ||
      containsAny(lowered, ARTICLE_WRITER_KEYWORDS) ||
      containsAny(lowered, EMAIL_WRITER_KEYWORDS);
    if (!otherAgent) {
      return { type: "help" };
    }
    // 競合時は通常の分岐に流す
  }

  if (containsAny(lowered, JOB_POST_KEYWORDS)) {
    const media = detectMedia(lowered) ?? "indeed";
    return { type: "job-post", media, company };
  }
  if (containsAny(lowered, PITCH_DECK_KEYWORDS)) {
    return { type: "pitch-deck", company };
  }
  if (containsAny(lowered, MEETING_SUMMARY_KEYWORDS)) {
    return { type: "meeting-summary", company };
  }
  if (containsAny(lowered, TASK_EXTRACT_KEYWORDS)) {
    return { type: "task-extract", company };
  }
  if (containsAny(lowered, ARTICLE_WRITER_KEYWORDS)) {
    return { type: "article-writer", company };
  }
  if (containsAny(lowered, EMAIL_WRITER_KEYWORDS)) {
    return { type: "email-writer", company };
  }
  return { type: "general" };
}

export function wantsGoogleDoc(text: string): boolean {
  // 1行目のみで判定する。長文ペースト中の "docs" や「ドキュメント」に
  // 誤反応しないようにする(コマンドは通常 1行で書かれる前提)。
  const firstLine = text.split("\n")[0] ?? "";
  return (
    /(^|\s)docs(\s|$)/i.test(firstLine) || firstLine.includes("ドキュメント")
  );
}

export function hasExplicitAgentKeyword(text: string): IntentType | null {
  const lowered = text.toLowerCase();
  if (
    text.includes("タスク抽出") ||
    text.includes("タスクを抽出") ||
    lowered.includes("todo抽出")
  ) {
    return "task-extract";
  }
  if (text.includes("求人原稿") || text.includes("求人票")) {
    return "job-post";
  }
  if (
    text.includes("採用資料") ||
    text.includes("ピッチ資料") ||
    text.includes("会社説明資料")
  ) {
    return "pitch-deck";
  }
  if (
    text.includes("議事録要約") ||
    text.includes("議事録をまとめ") ||
    text.includes("議事録の要約")
  ) {
    return "meeting-summary";
  }
  if (
    text.includes("記事執筆") ||
    text.includes("記事を書") ||
    text.includes("ブログ記事")
  ) {
    return "article-writer";
  }
  if (
    text.includes("営業メール") ||
    text.includes("ビジネスメール") ||
    text.includes("メール文面") ||
    text.includes("メールを書") ||
    text.includes("文面を書")
  ) {
    return "email-writer";
  }
  return null;
}

export function intentLabel(type: IntentType): string {
  switch (type) {
    case "help":
      return "ヘルプ";
    case "task-extract":
      return "タスク抽出";
    case "job-post":
      return "求人原稿作成";
    case "pitch-deck":
      return "採用ピッチ資料作成";
    case "meeting-summary":
      return "議事録要約";
    case "article-writer":
      return "記事執筆";
    case "email-writer":
      return "メール文面作成";
    case "general":
      return "一般応答";
  }
}
