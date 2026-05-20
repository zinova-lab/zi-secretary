import { fetchPrompt } from "./github";
import { intentLabel, type Intent } from "./intent";

const HUB_PATH = "prompts/secretary-hub.md";
const CLIENT_INFO_PATH = "clients/dummy-rsc.md";
const DUMMY_MEETING_PATH = "clients/dummy-rsc-meeting-2026-05-02.md";

interface PromptSection {
  title: string;
  content: string;
}

function joinSections(sections: PromptSection[]): string {
  return sections
    .map(
      (s) =>
        `========================================\n# ${s.title}\n========================================\n\n${s.content}`,
    )
    .join("\n\n");
}

function buildModeNote(intent: Intent): PromptSection | null {
  if (intent.type === "general") return null;
  const lines = [
    `ユーザーの指示は「${intentLabel(intent.type)}」と判定されました。`,
    `振り分けは完了しています。あなたは指定された専門エージェントとして、エージェントの出力フォーマットに沿って直接応答してください。`,
    `「振り分けます」「専門エージェントに依頼します」のような中継メッセージは出力しないでください。`,
  ];
  if (intent.company) {
    lines.push(`対象企業: ${intent.company}`);
  }
  if (intent.media) {
    lines.push(`対象媒体: ${intent.media}`);
  }
  return { title: "現在の処理モード", content: lines.join("\n") };
}

async function getMeetingSection(
  userMeetingNote: string | undefined,
  fallbackTitle: string,
): Promise<PromptSection> {
  if (userMeetingNote) {
    return {
      title: "参照議事録(ユーザー投稿)",
      content: userMeetingNote,
    };
  }
  const meeting = await fetchPrompt(DUMMY_MEETING_PATH);
  return {
    title: `${fallbackTitle}(サンプル)`,
    content: meeting,
  };
}

export async function buildSystemPrompt(
  intent: Intent,
  userMeetingNote?: string,
): Promise<string> {
  const sections: PromptSection[] = [];

  switch (intent.type) {
    case "task-extract": {
      const [hub, agent, meetingSection] = await Promise.all([
        fetchPrompt(HUB_PATH),
        fetchPrompt("prompts/agent-task-extract.md"),
        getMeetingSection(userMeetingNote, "対象議事録"),
      ]);
      sections.push(
        { title: "ハブプロンプト", content: hub },
        { title: "タスク抽出エージェント", content: agent },
        meetingSection,
      );
      break;
    }
    case "job-post": {
      const media = intent.media ?? "indeed";
      const [hub, agent, rule, client, meetingSection] = await Promise.all([
        fetchPrompt(HUB_PATH),
        fetchPrompt("prompts/agent-job-post.md"),
        fetchPrompt(`rules/${media}.md`),
        fetchPrompt(CLIENT_INFO_PATH),
        getMeetingSection(userMeetingNote, "対象議事録(参考文脈)"),
      ]);
      sections.push(
        { title: "ハブプロンプト", content: hub },
        { title: "求人原稿エージェント", content: agent },
        { title: `媒体ルール: ${media}`, content: rule },
        { title: "顧客情報", content: client },
        meetingSection,
      );
      break;
    }
    case "pitch-deck": {
      const [hub, agent, client, meetingSection] = await Promise.all([
        fetchPrompt(HUB_PATH),
        fetchPrompt("prompts/agent-pitch-deck.md"),
        fetchPrompt(CLIENT_INFO_PATH),
        getMeetingSection(userMeetingNote, "対象議事録(参考文脈)"),
      ]);
      sections.push(
        { title: "ハブプロンプト", content: hub },
        { title: "採用資料エージェント", content: agent },
        { title: "顧客情報", content: client },
        meetingSection,
      );
      break;
    }
    case "meeting-summary": {
      const [hub, agent, meetingSection] = await Promise.all([
        fetchPrompt(HUB_PATH),
        fetchPrompt("prompts/agent-meeting-summary.md"),
        getMeetingSection(userMeetingNote, "対象議事録"),
      ]);
      sections.push(
        { title: "ハブプロンプト", content: hub },
        { title: "議事録要約エージェント", content: agent },
        meetingSection,
      );
      break;
    }
    case "article-writer": {
      const [hub, agent, meetingSection] = await Promise.all([
        fetchPrompt(HUB_PATH),
        fetchPrompt("prompts/agent-article-writer.md"),
        getMeetingSection(userMeetingNote, "対象議事録(参考文脈)"),
      ]);
      sections.push(
        { title: "ハブプロンプト", content: hub },
        { title: "記事執筆エージェント", content: agent },
        meetingSection,
      );
      break;
    }
    case "email-writer": {
      const [hub, agent, meetingSection] = await Promise.all([
        fetchPrompt(HUB_PATH),
        fetchPrompt("prompts/agent-email-writer.md"),
        getMeetingSection(userMeetingNote, "対象議事録(参考文脈)"),
      ]);
      sections.push(
        { title: "ハブプロンプト", content: hub },
        { title: "メール文面エージェント", content: agent },
        meetingSection,
      );
      break;
    }
    case "general": {
      const [hub, agent] = await Promise.all([
        fetchPrompt(HUB_PATH),
        fetchPrompt("prompts/agent-general.md"),
      ]);
      sections.push(
        { title: "ハブプロンプト", content: hub },
        { title: "汎用エージェント", content: agent },
      );
      // general は議事録のサンプルにフォールバックしない。
      // ユーザーが実際に議事録を貼った場合のみ参考文脈として添える。
      if (userMeetingNote) {
        sections.push({
          title: "参照議事録(ユーザー投稿)",
          content: userMeetingNote,
        });
      }
      break;
    }
  }

  const mode = buildModeNote(intent);
  if (mode) sections.push(mode);

  return joinSections(sections);
}
