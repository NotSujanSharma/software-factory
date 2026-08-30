/**
 * Git authentication without persisting a credential.
 *
 * Embedding the token in the remote URL - `https://x-access-token:TOKEN@github…` -
 * writes it into `.git/config`, which is a permanent file inside a directory that
 * agents read and write. It also leaks: the agent runner records every tool call
 * verbatim, so one `git remote -v` puts the token in a log.
 *
 * Instead the remote URL carries only the *username*, which is not a secret, and
 * the token is supplied through `GIT_ASKPASS`. The helper script contains no
 * secret either - it echoes an environment variable that is set only on the git
 * child process. Nothing durable on disk ever holds the token.
 */
import fs from "node:fs";
import path from "node:path";
import { frameworkRoot } from "./config.ts";
import { githubToken } from "./github.ts";

/** Username half of a GitHub token credential. Not secret; safe in a URL. */
export const GIT_USERNAME = "x-access-token";

/** Env var the askpass helper reads. Set per git invocation, never exported globally. */
export const GIT_TOKEN_ENV = "FACTORY_GIT_TOKEN";

const SCRIPT_BASENAME = ".factory-askpass";

function scriptPath(): string {
  return path.join(frameworkRoot(), SCRIPT_BASENAME + (process.platform === "win32" ? ".cmd" : ".sh"));
}

/**
 * Create (or refresh) the askpass helper and return its path.
 *
 * Because the remote URL already names the user, git only ever asks for the
 * password, so the helper can unconditionally echo the token.
 */
export function ensureAskpass(): string {
  const file = scriptPath();
  const body =
    process.platform === "win32"
      ? `@echo off\r\necho %${GIT_TOKEN_ENV}%\r\n`
      : `#!/bin/sh\nprintf '%s\\n' "$${GIT_TOKEN_ENV}"\n`;

  // Rewrite only when the content differs, so concurrent agents do not fight.
  let current: string | null = null;
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    /* not created yet */
  }
  if (current !== body) fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

/**
 * Environment additions that let a git child authenticate to GitHub.
 * Returns an empty object when there is no token, so callers stay uniform.
 */
export function gitAuthEnv(): Record<string, string> {
  const token = githubToken();
  if (!token) return {};
  return {
    GIT_ASKPASS: ensureAskpass(),
    [GIT_TOKEN_ENV]: token,
    // Never block on an interactive prompt in an unattended run.
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Remote URL with the username but no secret - safe to store in `.git/config`. */
export function remoteUrl(cloneUrl: string): string {
  const token = githubToken();
  if (!token) return cloneUrl;
  return cloneUrl.replace(/^https:\/\/(?:[^@/]*@)?/, `https://${GIT_USERNAME}@`);
}

/** Does this URL carry an embedded password? Used by the doctor and the scrubber. */
export function hasEmbeddedCredential(url: string): boolean {
  return /^https:\/\/[^@/]*:[^@/]+@/.test(url);
}
