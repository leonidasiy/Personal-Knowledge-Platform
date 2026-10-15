// @ts-check
import { imageHash } from "./webpage-images.js";

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/** @typedef {{ readonly input: (bytes: ReadableStream<Uint8Array>) => ImageInput }} ImageBinding */
/** @typedef {{ readonly transform: (options: Record<string, unknown>) => ImageOutput }} ImageInput */
/** @typedef {{ readonly output: (options: Record<string, unknown>) => Promise<ImageResponse> }} ImageOutput */
/** @typedef {{ readonly response: () => Response | Promise<Response> }} ImageResponse */

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
 * @param {{ readonly maximumBytes?: number, readonly logger?: (entry: import("./knowledge-workflow-logging.js").KnowledgeWorkflowLogEntry) => void }} [options]
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
      const input = binding.input(new ReadableStream({ start(controller) { controller.enqueue(command.bytes); controller.close(); } }));
      const transformed = input.transform({ width, height, fit: "scale-down" });
      const output = await transformed.output({ format: "image/webp", quality: 82, anim: false });
      const response = await output.response();
      if (!(response instanceof Response) || !response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "image/webp") {
        options.logger?.({event:"image-decode-failure",failureKind:"MediaDerivativeProcessingFailed",field:"image-response",...(response instanceof Response?{httpStatus:response.status}:{})});
        return { ok: false, error: { kind: "MediaDerivativeProcessingFailed" } };
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) return { ok: false, error: { kind: "MediaDerivativeProcessingFailed" } };
      if (bytes.byteLength > maximumBytes) return { ok: false, error: { kind: "MediaDerivativeTooLarge" } };
      return { ok: true, value: Object.freeze({ bytes, mediaType: /** @type {const} */ ("image/webp") }) };
    } catch (error) {
      if (error instanceof Error) {
        options.logger?.({event:"image-decode-failure",failureKind:"MediaDerivativeProcessingFailed",field:/subrequest|too many requests/iu.test(error.message)?"subrequest-limit":"image-service-error"});
        return { ok: false, error: { kind: "MediaDerivativeProcessingFailed" } };
      }
      throw error;
    }
  };
}

/**
 * Reuse successful decoding of identical pixels across a run's model phases.
 * The upload boundary still checks scope and expected digest on every call.
 * @param {ImageBinding} binding
 * @param {Parameters<typeof createCloudflareImageDerivative>[1]} [options]
 * @returns {(bytes: Uint8Array, mediaType: string) => Promise<Result<null, {readonly kind:"UploadedImageDecodeFailed"}>>}
 */
export function createCloudflareImageDecoder(binding, options) {
  const transform = createCloudflareImageDerivative(binding, options);
  const decoded = new Set();
  return async (bytes, mediaType) => {
    const digest = `${mediaType}:${await imageHash(bytes)}`;
    if (decoded.has(digest)) return {ok:true,value:null};
    const result = await transform({assetId:"upload-decode",variant:"feed",bytes,mediaType});
    if (!result.ok) return {ok:false,error:{kind:"UploadedImageDecodeFailed"}};
    decoded.add(digest);
    return {ok:true,value:null};
  };
}

/** @param {unknown} value @returns {value is ImageBinding} */
export function isCloudflareImageBinding(value) { return record(value) && typeof value.input === "function"; }
