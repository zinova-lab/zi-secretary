// サービスアカウントは Drive ストレージを持たないため、Workspace の共有ドライブ
// (Shared Drive)配下に作成する。共有ドライブ「ZiC ドキュメント」(info@zinovacreation.com
// の Workspace 配下)に hana-docs サービスアカウントを「コンテンツ管理者」として
// 招待済み。parents に共有ドライブ自体の ID を指定すると、共有ドライブのルートに
// ファイルが作成され、ストレージは共有ドライブ所有になる。
// 共有ドライブ ID は "0A" で始まる短い形式(個別フォルダ ID とは異なる)。
// 共有ドライブ API 呼び出しには supportsAllDrives=true が必須。
const SHARED_FOLDER_ID = "0AAiu8QWBfZcFUk9PVA";

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

type DocRequest = Record<string, unknown>;

interface Block {
  type: "h1" | "h2" | "h3" | "bullet" | "para";
  text: string;
}

function base64UrlEncode(data: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof data === "string") {
    bytes = new TextEncoder().encode(data);
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else {
    bytes = data;
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(cleaned);
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }
  return buf;
}

async function getAccessToken(saJson: string): Promise<string> {
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(saJson) as ServiceAccount;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`[google-docs] step parse failed: ${detail}`);
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error(
      "[google-docs] step parse failed: service account JSON missing client_email or private_key",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: sa.client_email,
    scope:
      "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const header = { alg: "RS256", typ: "JWT" };
  const headerEnc = base64UrlEncode(JSON.stringify(header));
  const claimsEnc = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${headerEnc}.${claimsEnc}`;

  let key: CryptoKey;
  try {
    const keyBuf = pemToArrayBuffer(sa.private_key);
    key = await crypto.subtle.importKey(
      "pkcs8",
      keyBuf,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`[google-docs] step importKey failed: ${detail}`);
  }

  let sig: ArrayBuffer;
  try {
    sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingInput),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`[google-docs] step sign failed: ${detail}`);
  }

  const jwt = `${signingInput}.${base64UrlEncode(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `[google-docs] step token failed: ${res.status} ${text.slice(0, 2000)}`,
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    scope?: string;
    token_type?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("[google-docs] step token failed: no access_token in response");
  }
  console.log("[google-docs] token scope:", json.scope);
  return json.access_token;
}

async function createDocument(
  accessToken: string,
  title: string,
): Promise<string> {
  const res = await fetch(
    "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        name: title,
        mimeType: "application/vnd.google-apps.document",
        parents: [SHARED_FOLDER_ID],
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `[google-docs] step create failed: ${res.status} ${text.slice(0, 2000)}`,
    );
  }
  const json = (await res.json()) as { id?: string };
  if (!json.id) {
    throw new Error("[google-docs] step create failed: no id in response");
  }
  console.log("[google-docs] document created in shared drive:", json.id);
  return json.id;
}

function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.startsWith("### ")) {
      blocks.push({ type: "h3", text: line.slice(4) });
    } else if (line.startsWith("## ")) {
      blocks.push({ type: "h2", text: line.slice(3) });
    } else if (line.startsWith("# ")) {
      blocks.push({ type: "h1", text: line.slice(2) });
    } else if (/^\s*[-*]\s+/.test(line)) {
      const stripped = line.replace(/^\s*[-*]\s+/, "");
      blocks.push({ type: "bullet", text: stripped });
    } else {
      blocks.push({ type: "para", text: line });
    }
  }
  return blocks;
}

interface DocRequests {
  text: string;
  styleRequests: DocRequest[];
}

function buildDocRequests(md: string): DocRequests {
  const blocks = parseMarkdown(md);
  let text = "";
  let cursor = 1;
  const styleRequests: DocRequest[] = [];

  let bulletStart: number | null = null;
  let bulletEnd = 0;
  const flushBullets = () => {
    if (bulletStart !== null) {
      styleRequests.push({
        createParagraphBullets: {
          range: { startIndex: bulletStart, endIndex: bulletEnd },
          bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
        },
      });
      bulletStart = null;
    }
  };

  for (const block of blocks) {
    const startIndex = cursor;
    const lineText = block.text + "\n";
    text += lineText;
    const endIndex = cursor + lineText.length;

    if (block.type === "bullet") {
      if (bulletStart === null) bulletStart = startIndex;
      bulletEnd = endIndex;
    } else {
      flushBullets();
      if (
        block.type === "h1" ||
        block.type === "h2" ||
        block.type === "h3"
      ) {
        const namedStyleType =
          block.type === "h1"
            ? "HEADING_1"
            : block.type === "h2"
              ? "HEADING_2"
              : "HEADING_3";
        styleRequests.push({
          updateParagraphStyle: {
            range: { startIndex, endIndex },
            paragraphStyle: { namedStyleType },
            fields: "namedStyleType",
          },
        });
      }
    }

    cursor = endIndex;
  }
  flushBullets();

  return { text, styleRequests };
}

async function batchUpdate(
  accessToken: string,
  documentId: string,
  requests: DocRequest[],
): Promise<void> {
  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ requests }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `[google-docs] step batchUpdate failed: ${res.status} ${text.slice(0, 2000)}`,
    );
  }
}

async function makeAnyoneReader(
  accessToken: string,
  documentId: string,
): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${documentId}/permissions?supportsAllDrives=true`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `[google-docs] step share failed: ${res.status} ${text.slice(0, 2000)}`,
    );
  }
}

export async function createGoogleDoc(
  serviceAccountJson: string,
  title: string,
  markdownContent: string,
): Promise<string> {
  console.log("[google-docs] getting access token...");
  const accessToken = await getAccessToken(serviceAccountJson);

  console.log("[google-docs] creating document, title:", title);
  const documentId = await createDocument(accessToken, title);

  console.log("[google-docs] writing content, length:", markdownContent.length);
  const { text, styleRequests } = buildDocRequests(markdownContent);
  if (text.length > 0) {
    const insertRequest: DocRequest = {
      insertText: { location: { index: 1 }, text },
    };
    await batchUpdate(accessToken, documentId, [
      insertRequest,
      ...styleRequests,
    ]);
  }

  console.log("[google-docs] sharing document...");
  await makeAnyoneReader(accessToken, documentId);

  const url = `https://docs.google.com/document/d/${documentId}/edit`;
  console.log("[google-docs] done:", url);
  return url;
}
