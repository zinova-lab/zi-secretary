export type IntentType =
  | "task-extract"
  | "job-post"
  | "pitch-deck"
  | "meeting-summary"
  | "general";

export type Media = "indeed" | "mynavi" | "rikunavi-next";

export interface Intent {
  type: IntentType;
  media?: Media;
  company?: string;
}

const JOB_POST_KEYWORDS = ["求人原稿", "求人"];
const PITCH_DECK_KEYWORDS = ["採用資料", "ピッチ資料", "会社説明"];
const MEETING_SUMMARY_KEYWORDS = ["議事録要約", "要約", "サマリー"];
const TASK_EXTRACT_KEYWORDS = ["タスク抽出", "タスク", "todo", "やること"];

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
  const samaMatch = text.match(/([^\s「『【]+?)(?:様|さん)/);
  if (samaMatch && samaMatch[1]) return samaMatch[1];

  const corpMatch = text.match(
    /([^\s「『【]+?(?:株式会社|有限会社|合同会社|工務店|ホームズ|建設|建築))/,
  );
  if (corpMatch && corpMatch[1]) return corpMatch[1];

  return undefined;
}

export function detectIntent(text: string): Intent {
  const lowered = text.toLowerCase();
  const company = extractCompany(text);

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
  return { type: "general" };
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
  return null;
}

export function intentLabel(type: IntentType): string {
  switch (type) {
    case "task-extract":
      return "タスク抽出";
    case "job-post":
      return "求人原稿作成";
    case "pitch-deck":
      return "採用ピッチ資料作成";
    case "meeting-summary":
      return "議事録要約";
    case "general":
      return "一般応答";
  }
}
