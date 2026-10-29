// Fetch once per static build; no browser request or credential is needed.
let stars: Promise<number | null> | undefined;

async function loadStars(): Promise<number | null> {
  try {
    const response = await fetch(
      "https://api.github.com/repos/hugues31/duckpad",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(process.env.GITHUB_TOKEN
            ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
            : {}),
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) return null;
    const { stargazers_count: count } = await response.json();
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

export const getGitHubStars = () => (stars ??= loadStars());
