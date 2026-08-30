import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

export const VENDOR_FILE_NAME = "factory-error-sdk.cjs";
export const BROWSER_FILE_NAME = "factory-error-sdk.browser.js";

/** Absolute path of the Node-side global error handler. */
export function vendorFilePath(): string {
  return path.resolve(dir, "../vendor", VENDOR_FILE_NAME);
}

/** Absolute path of the browser-side error handler (for apps that serve a UI). */
export function browserFilePath(): string {
  return path.resolve(dir, "../vendor", BROWSER_FILE_NAME);
}
