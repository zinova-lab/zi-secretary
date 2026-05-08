const GITHUB_RAW_BASE =
  "https://raw.githubusercontent.com/zinova-lab/zi-secretary/main";

export async function fetchPrompt(path: string): Promise<string> {
  const url = `${GITHUB_RAW_BASE}/${path.replace(/^\/+/, "")}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch prompt "${path}" (${res.status} ${res.statusText})`,
    );
  }
  return await res.text();
}
