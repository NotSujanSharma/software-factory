/**
 * Secret handling.
 *
 * Two jobs: mint the per-app keys the sentinel authenticates ingest with, and keep
 * credentials out of anything written to disk. The agent runner records every tool
 * invocation verbatim, so an agent running `git remote -v` in a repo whose origin
 * carries a token would otherwise write that token straight into a log file.
 */
import crypto from "node:crypto";

/** A URL-safe random key. */
export function newKey(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Constant-time compare, tolerant of length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const PATTERNS: RegExp[] = [
  // GitHub tokens, classic and fine-grained.
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Anthropic keys.
  /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g,
  // Credentials embedded in a URL: https://user:secret@host
  /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g,
];

/** Replace known credential shapes with a marker. Never throws. */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (m, prefix?: string) => (prefix ? `${prefix}<redacted>@` : "<redacted>"));
  }
  // Anything currently in the environment that looks like a credential.
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "ANTHROPIC_API_KEY", "FACTORY_INGEST_KEY"]) {
    const v = process.env[name];
    if (v && v.length >= 8) out = out.split(v).join(`<${name}>`);
  }
  return out;
}
