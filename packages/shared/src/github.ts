/** Minimal GitHub REST client (fetch-based; no gh CLI dependency). */

const API = "https://api.github.com";

export function githubToken(): string | null {
  return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
}

async function gh<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = githubToken();
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

export async function ghUser(): Promise<string> {
  const u = await gh<{ login: string }>("GET", "/user");
  return u.login;
}

export interface RepoInfo {
  full_name: string;
  html_url: string;
  clone_url: string;
  default_branch: string;
}

/** Create the repo if it does not exist; returns repo info. `owner` empty = authenticated user. */
export async function ensureGithubRepo(owner: string, name: string, isPrivate: boolean): Promise<RepoInfo> {
  const me = await ghUser();
  const realOwner = owner || me;
  try {
    return await gh<RepoInfo>("GET", `/repos/${realOwner}/${name}`);
  } catch {
    /* not found -> create */
  }
  if (realOwner === me) {
    return gh<RepoInfo>("POST", "/user/repos", { name, private: isPrivate, auto_init: false });
  }
  return gh<RepoInfo>("POST", `/orgs/${realOwner}/repos`, { name, private: isPrivate, auto_init: false });
}

export interface PrInfo {
  number: number;
  html_url: string;
  state: string;
  merged: boolean;
}

export async function createPR(
  fullName: string,
  opts: { title: string; body: string; head: string; base: string },
): Promise<PrInfo> {
  const pr = await gh<PrInfo>("POST", `/repos/${fullName}/pulls`, opts);
  return pr;
}

export async function getPR(fullName: string, number: number): Promise<PrInfo> {
  return gh<PrInfo>("GET", `/repos/${fullName}/pulls/${number}`);
}

export async function mergePR(fullName: string, number: number): Promise<void> {
  await gh("PUT", `/repos/${fullName}/pulls/${number}/merge`, { merge_method: "squash" });
}
