export type IntentType =
  | "help"
  | "task-extract"
  | "job-post"
  | "pitch-deck"
  | "meeting-summary"
  | "article-writer"
  | "email-writer"
  | "sales-support"
  | "todo"
  | "research"
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
// 「営業サポート」「提案書」「商談記録」等を湊(営業担当 Bot)に振り分ける。
// 「営業」単独は EMAIL_WRITER_KEYWORDS の「営業メール」と衝突するため含めない。
const SALES_SUPPORT_KEYWORDS = [
  "営業サポート",
  "営業支援",
  "提案書",
  "商談記録",
  "ネクストアクション",
  "企業情報整理",
  "営業ストーリー",
];
// ToDo 系の軽量整理依頼。task-extract / meeting-summary より後で評価し、
// 「議事録 + タスク」のような従来パターンは task-extract に流れるようにする。
const TODO_KEYWORDS = [
  "todoリスト",
  "todo リスト",
  "todo整理",
  "todo 整理",
  "やることリスト",
  "やること整理",
  "やること",
];
// 鈴(情報調査)用キーワード。sales-support の後に評価することで
// 「企業情報整理」(湊)と「企業情報を調べて」(鈴)を衝突なく分離できる。
// 「企業情報整理」は SALES_SUPPORT 側の完全一致が先に match する。
const RESEARCH_KEYWORDS = [
  "調べて",
  "調査",
  "リサーチ",
  "情報収集",
  "業界動向",
  "市場調査",
  "企業情報",
  "競合調査",
  "プロフィール",
  "について調べ",
  "について教え",
  "とは何",
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
  // 通常のコマンドは "@zi-secretary 求人原稿 Indeed サンプル工務店様" のような
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

// welcome トリガー判定:単独の「スタート」「start」(大小区別なし、語境界)。
// containsAny の単純な includes() だと "startup" 等で誤検出するため、
// word-boundary 付き正規表現で厳格に判定する。
const WELCOME_KEYWORD_PATTERN = /(^|\s)(スタート|start)(\s|$)/i;

export function detectIntent(text: string): Intent {
  const lowered = text.toLowerCase();
  const company = extractCompany(text);

  // 空メンション or 単独「スタート」/「start」 → welcome(= help intent)。
  // これらは他エージェント語と同時には出にくいため、ガードなしで最優先。
  if (text.trim().length === 0 || WELCOME_KEYWORD_PATTERN.test(text)) {
    return { type: "help" };
  }

  // help を最優先で判定。ただし他エージェント語が同時に含まれる場合は
  // 他エージェントを優先(例:「ヘルプ記事を書いて」→ article-writer)。
  if (containsAny(lowered, HELP_KEYWORDS)) {
    const otherAgent =
      containsAny(lowered, JOB_POST_KEYWORDS) ||
      containsAny(lowered, PITCH_DECK_KEYWORDS) ||
      containsAny(lowered, MEETING_SUMMARY_KEYWORDS) ||
      containsAny(lowered, TASK_EXTRACT_KEYWORDS) ||
      containsAny(lowered, ARTICLE_WRITER_KEYWORDS) ||
      containsAny(lowered, EMAIL_WRITER_KEYWORDS) ||
      containsAny(lowered, SALES_SUPPORT_KEYWORDS) ||
      containsAny(lowered, TODO_KEYWORDS) ||
      containsAny(lowered, RESEARCH_KEYWORDS);
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
  if (containsAny(lowered, SALES_SUPPORT_KEYWORDS)) {
    return { type: "sales-support", company };
  }
  if (containsAny(lowered, TODO_KEYWORDS)) {
    return { type: "todo", company };
  }
  if (containsAny(lowered, RESEARCH_KEYWORDS)) {
    return { type: "research", company };
  }
  return { type: "general" };
}

// 入力テキストに議事録活用を明示するキーワードが含まれるかを判定する。
// 議事録必須エージェント (task-extract / meeting-summary) 以外では、
// このフラグが true の時だけ議事録コンテキストを system prompt に含める。
// → 通常用途で system prompt が肥大化せず、25 秒タイムアウト回避につながる。
export function wantsMeetingContext(text: string): boolean {
  const keywords = [
    "議事録から",
    "議事録ベース",
    "議事録活用",
    "この議事録",
    "議事録の",
    "議事録を踏まえ",
    "議事録を元に",
    "議事録に基づ",
  ];
  return keywords.some((kw) => text.includes(kw));
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
  if (
    text.includes("営業サポート") ||
    text.includes("提案書") ||
    text.includes("商談記録") ||
    text.includes("ネクストアクション") ||
    text.includes("営業ストーリー")
  ) {
    return "sales-support";
  }
  if (
    text.includes("ToDoリスト") ||
    text.includes("todo リスト") ||
    text.includes("ToDo整理") ||
    text.includes("やることリスト") ||
    text.includes("やること整理")
  ) {
    return "todo";
  }
  if (
    text.includes("調べて") ||
    text.includes("調査") ||
    text.includes("リサーチ") ||
    text.includes("について調べ") ||
    text.includes("について教え")
  ) {
    return "research";
  }
  return null;
}

export function intentLabel(type: IntentType): string {
  switch (type) {
    case "help":
      return "ヘルプ";
    case "task-extract":
      return "タスク抽出(凪)";
    case "job-post":
      return "求人原稿作成";
    case "pitch-deck":
      return "採用ピッチ資料作成";
    case "meeting-summary":
      return "議事録要約(凪)";
    case "article-writer":
      return "記事執筆";
    case "email-writer":
      return "メール文面作成";
    case "sales-support":
      return "営業サポート(湊)";
    case "todo":
      return "ToDo整理(凪)";
    case "research":
      return "情報調査(鈴)";
    case "general":
      return "一般応答";
  }
}
