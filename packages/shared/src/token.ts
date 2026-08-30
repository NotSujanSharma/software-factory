/**
 * The sentinel's admin token.
 *
 * Guards registration and incident control - the endpoints that decide which
 * directory a healing agent will clone and run `npm test` inside. It lives in
 * shared rather than in the sentinel because the orchestrator has to present it
 * when it registers an app it has just deployed.
 *
 * Set FACTORY_ADMIN_TOKEN to pin it (useful when the sentinel runs elsewhere);
 * otherwise one is generated on first use and kept beside the config.
 */
import fs from "node:fs";
import path from "node:path";
import { frameworkRoot } from "./config.ts";
import { newKey } from "./secrets.ts";

export const ADMIN_TOKEN_FILE = ".factory-admin-token";

export function adminTokenPath(): string {
  return path.join(frameworkRoot(), ADMIN_TOKEN_FILE);
}

/** Read the token, generating and persisting one the first time. */
export function adminToken(): string {
  const fromEnv = process.env.FACTORY_ADMIN_TOKEN;
  if (fromEnv) return fromEnv;

  const file = adminTokenPath();
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* not created yet */
  }

  const token = newKey(32);
  // 0600: on Windows this is advisory, but it costs nothing and is correct on POSIX.
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}
