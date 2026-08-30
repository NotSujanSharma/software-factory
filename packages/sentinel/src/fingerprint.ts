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

/** Vendor and runtime directories whose frames say nothing about *this* bug. */
const NOISE = [
  "node_modules",
  "node:internal",
  "node:events",
  "site-packages",
  "dist-packages",
  "/usr/lib/python",
  "lib/python3",
  "vendor/bundle",
  "gems/",
  "/usr/local/go/src",
  "runtime/panic.go",
  "\\.cargo\\registry",
  "/.cargo/registry",
  "vendor/",
  "target/release/deps",
  "org.springframework",
  "java.base/",
  "jdk.internal",
  "sun.reflect",
];

function isNoise(line: string): boolean {
  return NOISE.some((n) => line.includes(n));
}

/** Keep the function name and the last two path segments; drop line and column. */
function frame(fn: string | undefined, file: string): string {
  const short = file.replaceAll("\\", "/").split("/").slice(-2).join("/");
  return `${fn?.trim() || "<anon>"}@${short}`;
}

/**
 * One stack-frame parser per language family.
 *
 * Fingerprinting is what stops two reports of the same bug becoming two healing
 * agents, so it has to work for whatever the app was written in - a Python
 * traceback and a Go panic look nothing like a V8 stack.
 *
 * Line and column numbers are deliberately discarded: a fix that shifts code down
 * a few lines must not make the next occurrence look like a brand-new bug.
 */
const PARSERS: { name: string; parse: (line: string) => string | null }[] = [
  {
    // JavaScript / TypeScript:  at fn (file:line:col)  |  at file:line:col
    name: "js",
    parse: (line) => {
      const t = line.trim();
      if (!t.startsWith("at ")) return null;
      const m = t.match(/^at\s+(?:(.+?)\s+\()?(.+?):\d+:\d+\)?$/);
      return m ? frame(m[1], m[2] ?? "") : null;
    },
  },
  {
    // Python:  File "path/to/file.py", line 12, in fn
    name: "python",
    parse: (line) => {
      const m = line.trim().match(/^File "(.+?)", line \d+(?:, in (.+))?$/);
      return m ? frame(m[2], m[1]) : null;
    },
  },
  {
    // Java / Kotlin / Scala:  at com.example.Class.method(File.java:23)
    name: "jvm",
    parse: (line) => {
      const t = line.trim();
      if (!t.startsWith("at ")) return null;
      const m = t.match(/^at\s+([\w$.]+)\((?:([\w$]+\.\w+):\d+|[^)]*)\)$/);
      if (!m) return null;
      const qualified = m[1] ?? "";
      const method = qualified.split(".").slice(-2).join(".");
      return frame(method, m[2] ?? qualified);
    },
  },
  {
    // Go:  \t/path/file.go:23 +0x1d
    name: "go",
    parse: (line) => {
      const m = line.match(/^\s+(\S+\.go):(\d+)(?:\s+\+0x[0-9a-f]+)?$/);
      return m ? frame(undefined, m[1]) : null;
    },
  },
  {
    // Ruby:  path/file.rb:23:in `method'
    name: "ruby",
    parse: (line) => {
      const m = line.trim().match(/^(?:from\s+)?(.+?\.rb):\d+:in [`'](.+?)'$/);
      return m ? frame(m[2], m[1]) : null;
    },
  },
  {
    // PHP:  #0 /path/file.php(23): Class->method()
    name: "php",
    parse: (line) => {
      const m = line.trim().match(/^#\d+\s+(.+?)\((\d+)\):\s*(.+?)\(/);
      return m ? frame(m[3], m[1]) : null;
    },
  },
  {
    // Rust:  at ./src/main.rs:10:5   (the frame name is on the preceding line)
    name: "rust",
    parse: (line) => {
      const m = line.trim().match(/^at\s+(\.{0,2}\/?[\w./-]+\.rs):\d+(?::\d+)?$/);
      return m ? frame(undefined, m[1]) : null;
    },
  },
  {
    // .NET:  at Namespace.Class.Method() in C:\path\File.cs:line 23
    name: "dotnet",
    parse: (line) => {
      const m = line.trim().match(/^at\s+(.+?)\s+in\s+(.+?):line\s+\d+$/);
      if (!m) return null;
      const method = (m[1] ?? "").split("(")[0].split(".").slice(-2).join(".");
      return frame(method, m[2] ?? "");
    },
  },
];

/**
 * Application stack frames, most recent first, in whatever language the app is.
 * Vendor and runtime frames are skipped: they are the same for every bug.
 */
export function topFrames(stack: string | undefined, n = 5): string[] {
  if (!stack) return [];
  const frames: string[] = [];

  for (const line of stack.split("\n")) {
    if (isNoise(line)) continue;
    for (const parser of PARSERS) {
      const parsed = parser.parse(line);
      if (parsed) {
        frames.push(parsed);
        break;
      }
    }
    if (frames.length >= n) break;
  }
  return frames;
}

export function fingerprint(event: ErrorEvent): string {
  const material = [event.appId, event.type, normalizeMessage(event.message), ...topFrames(event.stack)].join("|");
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}
