import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ErrorSdkKind } from "@factory/stacks";

const dir = path.dirname(fileURLToPath(import.meta.url));
const vendorDir = path.resolve(dir, "../vendor");

export const VENDOR_FILE_NAME = "factory-error-sdk.cjs";
export const BROWSER_FILE_NAME = "factory-error-sdk.browser.js";
export const PYTHON_FILE_NAME = "factory_error_sdk.py";
export const CONTRACT_FILE_NAME = "FACTORY_ERROR_CONTRACT.md";

/** Absolute path of the Node-side global error handler. */
export function vendorFilePath(): string {
  return path.join(vendorDir, VENDOR_FILE_NAME);
}

/** Absolute path of the browser-side error handler (for apps that serve a UI). */
export function browserFilePath(): string {
  return path.join(vendorDir, BROWSER_FILE_NAME);
}

/** Absolute path of the Python-side handler. */
export function pythonFilePath(): string {
  return path.join(vendorDir, PYTHON_FILE_NAME);
}

export interface VendoredSdk {
  /** Files copied into the app repo, by destination name. */
  files: Record<string, string>;
  /** Instructions the deploy agent must follow to wire them in. */
  instructions: string[];
}

/**
 * What to vendor into an app, and how the agent should wire it up.
 *
 * Node and Python get a real SDK. Everything else gets the wire contract and
 * writes ~30 lines against it in its own language - which is the only approach
 * that scales, since the alternative is maintaining an SDK per ecosystem.
 */
export function sdkFor(kind: ErrorSdkKind, servesHtml: boolean): VendoredSdk {
  const contract = { [CONTRACT_FILE_NAME]: path.join(vendorDir, CONTRACT_FILE_NAME) };

  if (kind === "node") {
    const files: Record<string, string> = { [VENDOR_FILE_NAME]: vendorFilePath() };
    if (servesHtml) files[BROWSER_FILE_NAME] = browserFilePath();
    return {
      files,
      instructions: [
        `In the server entry point, require ./${VENDOR_FILE_NAME} and call init() as early as possible.`,
        `If the app uses Express, register expressErrorHandler() AFTER all routes and middleware.`,
        ...(servesHtml
          ? [
              `Serve ${BROWSER_FILE_NAME} at /factory-error-sdk.js and include it in the HTML head as`,
              `  <script src="/factory-error-sdk.js" data-app-id="..."></script> using the FACTORY_APP_ID env var.`,
              `Mount the SDK's own proxy for browser reports:`,
              `  app.post("/__factory_error", express.json({ limit: "64kb" }), factoryErrors.browserProxy());`,
            ]
          : [`This app serves no HTML, so delete ${BROWSER_FILE_NAME} if it was copied.`]),
      ],
    };
  }

  if (kind === "python") {
    return {
      files: { [PYTHON_FILE_NAME]: pythonFilePath() },
      instructions: [
        `Import factory_error_sdk as early as possible in the entry point and call init().`,
        `Flask: factory_error_sdk.install_flask(app). FastAPI/Starlette: install_asgi(app).`,
        `Django: add "factory_error_sdk.DjangoMiddleware" to MIDDLEWARE.`,
        `Anything else: call factory_error_sdk.capture(exc) from your top-level exception handler.`,
      ],
    };
  }

  return {
    files: contract,
    instructions: [
      `There is no vendored SDK for this language. Read ${CONTRACT_FILE_NAME} and implement it:`,
      `write a small module in this project's language that POSTs the documented JSON to`,
      `SENTINEL_URL + "/ingest" with the x-factory-key header, and call it from the`,
      `framework's top-level error/panic handler AND from a process-level crash handler.`,
      `Keep it dependency-free where the standard library allows, and make it fire-and-forget:`,
      `a failure to report must never change how the application behaves.`,
    ],
  };
}

/** Copy an SDK's files into the app repo. Returns the destination names written. */
export function vendorInto(appDir: string, sdk: VendoredSdk): string[] {
  const written: string[] = [];
  for (const [name, source] of Object.entries(sdk.files)) {
    fs.copyFileSync(source, path.join(appDir, name));
    written.push(name);
  }
  return written;
}
