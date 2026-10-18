import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import type {
  Budget,
  FailureKind,
  Logger,
  Observation,
  PageProjection,
  Policy,
  Renderer,
  RequestCommand,
  Result,
  WireObservation,
} from "./contracts.ts";
import { fail } from "./contracts.ts";
import { validatePolicy } from "./gate.ts";
import { imageMetadata } from "./renderer.ts";
type Dependencies = {
  readonly policy: Policy;
  readonly tokens: ReadonlyMap<string, string>;
  readonly maximumActive: number;
  readonly maximumRetained: number;
  readonly retentionMilliseconds: number;
  readonly nowMs: () => number;
  readonly logger: Logger;
  readonly gate: {
    request(
      c: RequestCommand,
      b: Budget,
      s: AbortSignal,
    ): Promise<Result<Observation>>;
  };
  readonly renderer: Renderer;
};
type WirePage = WireObservation & {
  readonly projection?: PageProjection;
  readonly screenshotBase64?: string;
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requestCommand(value: unknown): value is RequestCommand {
  return record(value) &&
    Object.keys(value).sort().join(",") ===
      "maximumBytes,purpose,redirectLimit,rootUrl,url" &&
    typeof value.url === "string" && typeof value.rootUrl === "string" &&
    ["page", "robots", "image", "resource"].includes(String(value.purpose)) &&
    typeof value.maximumBytes === "number" &&
    Number.isSafeInteger(value.maximumBytes) && value.maximumBytes > 0 &&
    typeof value.redirectLimit === "number" &&
    Number.isSafeInteger(value.redirectLimit) && value.redirectLimit >= 0;
}
function aborted(signal: AbortSignal): FailureKind {
  return signal.reason instanceof DOMException &&
      signal.reason.name === "TimeoutError"
    ? "TimedOut"
    : "Cancelled";
}
export function createAcquisitionHandler(
  deps: Dependencies,
): (request: Request) => Promise<Response> {
  validatePolicy(deps.policy);
  if (
    !(deps.tokens instanceof Map) || deps.tokens.size === 0 ||
    [...deps.tokens].some(([token, client]) =>
      typeof token !== "string" || token.length < 12 ||
      typeof client !== "string" || client.length === 0
    ) || !Number.isSafeInteger(deps.maximumActive) || deps.maximumActive < 1 ||
    !Number.isSafeInteger(deps.maximumRetained) ||
    deps.maximumRetained < deps.maximumActive ||
    !Number.isSafeInteger(deps.retentionMilliseconds) ||
    deps.retentionMilliseconds < deps.policy.operationMilliseconds ||
    typeof deps.nowMs !== "function" || typeof deps.logger !== "function" ||
    typeof deps.gate?.request !== "function" ||
    typeof deps.renderer?.render !== "function" ||
    typeof deps.renderer?.decodeImage !== "function"
  ) throw new TypeError("ConfigurationInvalid");
  const credentials = [...deps.tokens].map(([token, principal]) => ({
    hash: createHash("sha256").update(token).digest(),
    principal,
  }));
  const operations = new Map<
    string,
    {
      controller: AbortController | null;
      at: number;
      cancelled: boolean;
      done: Promise<void>;
    }
  >();
  const reply = (result: Result<WirePage | null>, status = 200) =>
    Response.json(result, { status, headers: { "cache-control": "no-store" } });
  return async function handle(request: Request): Promise<Response> {
    if (!(request instanceof Request)) throw new TypeError("CommandInvalid");
    const authorization = request.headers.get("authorization");
    const supplied = createHash("sha256").update(
      authorization?.startsWith("Bearer ") ? authorization.slice(7) : "",
    ).digest();
    let principal: string | undefined;
    for (const credential of credentials) {
      if (timingSafeEqual(credential.hash, supplied)) {
        principal = credential.principal;
      }
    }
    if (!principal) return reply(fail("AuthenticationRequired"), 401);
    const path = new URL(request.url).pathname;
    const match = path.match(/^\/v1\/operations\/([a-zA-Z0-9_-]{12,80})$/);
    if (
      !match || new URL(request.url).search ||
      !["POST", "DELETE"].includes(request.method)
    ) return reply(fail("CommandInvalid"), 400);
    const now = deps.nowMs();
    if (!Number.isFinite(now) || now < 0) {
      throw new TypeError("ConfigurationInvalid");
    }
    for (const [key, entry] of operations) {
      if (
        entry.controller === null && now - entry.at > deps.retentionMilliseconds
      ) operations.delete(key);
    }
    const key = `${principal}:${match[1]}`;
    const existing = operations.get(key);
    if (request.method === "DELETE") {
      if (existing?.controller) {
        existing.cancelled = true;
        existing.controller.abort();
        await existing.done;
        return reply({ ok: true, value: null });
      }
      if (!existing && operations.size < deps.maximumRetained) {
        operations.set(key, {
          controller: null,
          at: now,
          cancelled: true,
          done: Promise.resolve(),
        });
        return reply(fail("OperationNotFound", "cancellation-tombstone"), 404);
      }
      return reply(fail("OperationNotFound"), 404);
    }
    if (existing) {
      return reply(
        fail(existing.cancelled ? "Cancelled" : "OperationConflict"),
        409,
      );
    }
    if (
      operations.size >= deps.maximumRetained ||
      [...operations.values()].filter((entry) => entry.controller !== null)
          .length >= deps.maximumActive
    ) return reply(fail("OperationLimitExceeded"), 429);
    let finished: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const controller = new AbortController();
    const entry = {
      controller: controller as AbortController | null,
      at: now,
      cancelled: false,
      done,
    };
    operations.set(key, entry);
    const signal = AbortSignal.any([
      controller.signal,
      request.signal,
      AbortSignal.timeout(deps.policy.operationMilliseconds),
    ]);
    deps.logger({ event: "acquisition-entry" });
    let result: Result<WirePage | null>;
    let interrupted: FailureKind | undefined;
    try {
      result = await execute(request, signal);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      result = fail(signal.aborted ? aborted(signal) : "CommandInvalid");
    } finally {
      if (signal.aborted) interrupted = aborted(signal);
      controller.abort();
      entry.controller = null;
      entry.at = deps.nowMs();
      finished();
    }
    if (interrupted) result = fail(interrupted);
    deps.logger({
      event: result.ok ? "acquisition-success" : "acquisition-failure",
      ...(result.ok ? {} : { failureKind: result.error.kind }),
    });
    return reply(result);
  };
  async function execute(
    request: Request,
    signal: AbortSignal,
  ): Promise<Result<WirePage>> {
    if (signal.aborted) return fail(aborted(signal));
    const reader = request.body?.getReader();
    if (!reader) return fail("CommandInvalid", "body");
    const stop = () => {
      void reader.cancel();
    };
    signal.addEventListener("abort", stop, { once: true });
    let body = "";
    let total = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const next = await reader.read();
        if (signal.aborted) return fail(aborted(signal));
        if (next.done) break;
        total += next.value.byteLength;
        if (total > 16 * 1024) {
          await reader.cancel();
          return fail("EncodedLimitExceeded", "command");
        }
        body += decoder.decode(next.value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      signal.removeEventListener("abort", stop);
      reader.releaseLock();
    }
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return fail("CommandInvalid", "json");
    }
    if (
      !record(value) ||
      Object.keys(value).sort().join(",") !== "action,request" ||
      !["request", "page", "screenshot"].includes(String(value.action)) ||
      !requestCommand(value.request)
    ) return fail("CommandInvalid");
    const command = value.request;
    if (value.action !== "request" && command.purpose !== "page") {
      return fail("CommandInvalid", "purpose");
    }
    const budget: Budget = { encoded: 0, decoded: 0, resources: 0, pixels: 0 };
    const observed = await deps.gate.request(command, budget, signal);
    if (!observed.ok) return observed;
    const observation = observed.value;
    if (
      command.purpose === "image" && observation.status >= 200 &&
      observation.status <= 299
    ) {
      const type = observation.headers["content-type"]?.split(";", 1)[0].trim()
        .toLowerCase() ?? "";
      const metadata = imageMetadata(observation.bytes, type, deps.policy);
      if (!metadata.ok) return metadata;
      budget.pixels += metadata.value.width * metadata.value.height;
      if (budget.pixels > deps.policy.aggregatePixels) {
        return fail("PixelLimitExceeded");
      }
      const decoded = await deps.renderer.decodeImage(
        observation.bytes,
        type,
        signal,
      );
      if (!decoded.ok) return decoded;
    }
    let projection: PageProjection | undefined,
      screenshotBase64: string | undefined;
    if (value.action !== "request") {
      const access: Readonly<Record<number, FailureKind>> = {
        401: "KnowledgePageAuthenticationRequired",
        402: "KnowledgePagePaywallDetected",
        403: "KnowledgePageBotAccessDenied",
        429: "KnowledgePageRateLimited",
      };
      if (observation.status < 200 || observation.status > 299) {
        return fail(access[observation.status] ?? "KnowledgePageFetchFailed");
      }
      const type = observation.headers["content-type"]?.split(";", 1)[0].trim()
        .toLowerCase();
      if (type !== "text/html" && type !== "application/xhtml+xml") {
        return fail("KnowledgePageTypeUnsupported");
      }
      const rendered = await deps.renderer.render(
        command,
        observation,
        budget,
        signal,
        value.action === "screenshot",
      );
      if (!rendered.ok) return rendered;
      projection = rendered.value.projection;
      if (rendered.value.screenshot) {
        screenshotBase64 = Buffer.from(rendered.value.screenshot).toString(
          "base64",
        );
      }
    }
    return {
      ok: true,
      value: {
        peerAddress: observation.peerAddress,
        status: observation.status,
        headers: observation.headers,
        finalUrl: observation.finalUrl,
        redirectHops: observation.redirectHops,
        bodyBase64: Buffer.from(observation.bytes).toString("base64"),
        ...(projection ? { projection } : {}),
        ...(screenshotBase64 ? { screenshotBase64 } : {}),
      },
    };
  }
}
export function createAcquisitionServer(
  deps: {
    readonly handler: (request: Request) => Promise<Response>;
    readonly policy: Policy;
    readonly transport: { readonly kind: "loopback-fixture" | "loopback" } | {
      readonly kind: "tls";
      readonly key: string;
      readonly cert: string;
    };
  },
): http.Server | https.Server {
  if (
    typeof deps.handler !== "function" ||
    !["tls", "loopback-fixture", "loopback"].includes(deps.transport?.kind)
  ) throw new TypeError("ConfigurationInvalid");
  validatePolicy(deps.policy);
  const listener: http.RequestListener = async (req, res) => {
    if (
      deps.transport.kind !== "tls" &&
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress ?? "",
      )
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    const controller = new AbortController();
    const disconnect = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on("close", disconnect);
    try {
      const init: RequestInit & { duplex: "half" } = {
        method: req.method ?? "GET",
        headers: new Headers(
          Object.entries(req.headers).flatMap(([k, v]) =>
            v === undefined
              ? []
              : [[k, Array.isArray(v) ? v.join(",") : v] as [string, string]]
          ),
        ),
        signal: controller.signal,
        duplex: "half",
        ...(["GET", "HEAD"].includes(req.method ?? "GET")
          ? {}
          : { body: Readable.toWeb(req) as ReadableStream<Uint8Array> }),
      };
      const response = await deps.handler(
        new Request(`https://transport.invalid${req.url ?? "/"}`, init),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const next = await reader.read();
            if (next.done || controller.signal.aborted) break;
            if (!res.write(next.value)) {
              await new Promise<void>((resolve) => {
                const done = () => {
                  res.off("drain", done);
                  res.off("close", done);
                  resolve();
                };
                res.once("drain", done);
                res.once("close", done);
              });
            }
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      }
      res.end();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            fail(controller.signal.aborted ? "Cancelled" : "ConnectFailed"),
          ),
        );
      } else res.destroy();
    }
  };
  const server = deps.transport.kind === "tls"
    ? https.createServer({
      key: deps.transport.key,
      cert: deps.transport.cert,
      maxHeaderSize: 16 * 1024,
    }, listener)
    : http.createServer({ maxHeaderSize: 16 * 1024 }, listener);
  server.requestTimeout = deps.policy.operationMilliseconds;
  server.headersTimeout = deps.policy.requestMilliseconds;
  return server;
}
