// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/** @typedef {{ readonly input: (bytes: Uint8Array) => ImageInput }} ImageBinding */
/** @typedef {{ readonly transform: (options: Record<string, unknown>) => ImageOutput }} ImageInput */
/** @typedef {{ readonly output: (options: Record<string, unknown>) => ImageResponse }} ImageOutput */
/** @typedef {{ readonly response: () => Promise<Response> }} ImageResponse */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }

/**
 * Create the production raster derivative boundary. Cloudflare Images decodes
 * and re-encodes the bytes as bounded WebP, which removes source metadata and
 * prevents the private original from being returned as a derivative.
 *
 * @param {ImageBinding} binding
 * @param {{ readonly maximumBytes?: number }} [options]
 * @returns {(command: { readonly assetId: string, readonly variant: "feed" | "thumbnail", readonly bytes: Uint8Array, readonly mediaType: string }) => Promise<Result<{ readonly bytes: Uint8Array, readonly mediaType: "image/webp" }, { readonly kind: "MediaDerivativeProcessingFailed" | "MediaDerivativeTooLarge" }>>}
 */
export function createCloudflareImageDerivative(binding, options = {}) {
  const maximumBytes = options.maximumBytes ?? 2 * 1024 * 1024;
  if (typeof binding?.input !== "function" || !Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new TypeError("Cloudflare Images derivative dependencies are invalid.");
  return async (command) => {
    if (!record(command) || !text(command.assetId) || (command.variant !== "feed" && command.variant !== "thumbnail") || !(command.bytes instanceof Uint8Array) || !text(command.mediaType)) return { ok: false, error: { kind: "MediaDerivativeProcessingFailed" } };
    try {
      const width = command.variant === "thumbnail" ? 480 : 1_600;
      const height = command.variant === "thumbnail" ? 360 : 1_200;
      const input = binding.input(command.bytes);
      const transformed = input.transform({ width, height, fit: "scale-down" });
      const response = await transformed.output({ format: "image/webp", quality: 82, anim: false }).response();
      if (!(response instanceof Response) || !response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "image/webp") return { ok: false, error: { kind: "MediaDerivativeProcessingFailed" } };
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) return { ok: false, error: { kind: "MediaDerivativeProcessingFailed" } };
      if (bytes.byteLength > maximumBytes) return { ok: false, error: { kind: "MediaDerivativeTooLarge" } };
      return { ok: true, value: Object.freeze({ bytes, mediaType: /** @type {const} */ ("image/webp") }) };
    } catch (error) {
      if (error instanceof Error) return { ok: false, error: { kind: "MediaDerivativeProcessingFailed" } };
      throw error;
    }
  };
}

/** @param {unknown} value @returns {value is ImageBinding} */
export function isCloudflareImageBinding(value) { return record(value) && typeof value.input === "function"; }
