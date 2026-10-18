import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { fail, validatePolicy } from "./contracts.ts";
import type { Policy, Renderer } from "./contracts.ts";
import { imageMetadata } from "./renderer.ts";

/** Image decoding has no URL input or browser; a bounded child releases native allocations. */
export function createImageDecoder(deps: {
  readonly policy: Policy;
  readonly nodePath: string;
}): Renderer["decodeImage"] {
  validatePolicy(deps.policy);
  if (!isAbsolute(deps.nodePath)) throw new TypeError("ConfigurationInvalid");
  return async (bytes, mediaType, signal) => {
    if (signal.aborted) return fail("Cancelled");
    if (bytes.byteLength > deps.policy.imageBytes) return fail("EncodedLimitExceeded");
    const metadata = imageMetadata(bytes, mediaType, deps.policy);
    if (!metadata.ok) return metadata;
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(deps.policy.requestMilliseconds),
    ]);
    const valid = await new Promise<boolean>((resolve) => {
      const child = spawn(deps.nodePath, [
        "--max-old-space-size=128",
        fileURLToPath(new URL("./image-decode.mjs", import.meta.url)),
        String(deps.policy.imageBytes),
        String(deps.policy.pixels),
        String(metadata.value.width),
        String(metadata.value.height),
      ], {
        stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
        // Native decoding does not need the app's API keys or service credentials.
        env: Object.fromEntries(["PATH", "SystemRoot", "TEMP", "TMP"]
          .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
      });
      const abort = () => { child.kill("SIGKILL"); };
      deadline.addEventListener("abort", abort, { once: true });
      child.once("error", () => resolve(false));
      child.stdin.on("error", () => {}); // A rejected image may close stdin early.
      child.once("close", (code) => {
        deadline.removeEventListener("abort", abort);
        resolve(code === 0 && !deadline.aborted);
      });
      child.stdin.end(bytes);
      if (deadline.aborted) abort();
    });
    if (signal.aborted) return fail("Cancelled");
    if (deadline.aborted) return fail("TimedOut");
    return valid ? { ok: true, value: null } : fail("ImageDecodeFailed");
  };
}
