import crypto from "node:crypto";
import type { ErrorEvent } from "@factory/shared";

/** Replace volatile parts of an error message so recurrences template to the same string. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/\b\d{3,}\b/g, "<n>")
    .replace(/'[^']{0,80}'/g, "<str>")
    .replace(/"[^"]{0,80}"/g, "<str>")
    .slice(0, 300);
}

/** Top app-code stack frames (file + function), ignoring node internals and dependencies. */
export function topFrames(stack: string | undefined, n = 5): string[] {
  if (!stack) return [];
  const frames: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const t = line.trim();
    if (!t.startsWith("at ")) continue;
    if (t.includes("node_modules") || t.includes("node:internal") || t.includes("node:events")) continue;
    // "at fn (path:line:col)" or "at path:line:col" -> keep fn + file basename (drop line/col: fixes move lines)
    const m = t.match(/^at\s+(?:(.+?)\s+\()?(.+?):\d+:\d+\)?$/);
    if (!m) continue;
    const fn = m[1] ?? "<anon>";
    const file = (m[2] ?? "").replaceAll("\\", "/").split("/").slice(-2).join("/");
    frames.push(`${fn}@${file}`);
    if (frames.length >= n) break;
  }
  return frames;
}

export function fingerprint(event: ErrorEvent): string {
  const material = [event.appId, event.type, normalizeMessage(event.message), ...topFrames(event.stack)].join("|");
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}
