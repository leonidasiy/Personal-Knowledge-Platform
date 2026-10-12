import https from "node:https";
import addressPolicy from "./iana/policy.json" with { type: "json" };
import { BlockList, isIP } from "node:net";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { IncomingMessage } from "node:http";
import type {
  Budget,
  FailureKind,
  Logger,
  Observation,
  Policy,
  RequestCommand,
  Resolver,
  Result,
} from "./contracts.ts";
import { fail, validatePolicy } from "./contracts.ts";

type Dial = (
  url: URL,
  address: string,
  signal: AbortSignal,
) => Promise<IncomingMessage>;

// Compiled offline from retained IANA bytes; all special assignments are denied,
// including global=True exceptions. Missing/incomplete artifacts fail at startup.
export function createAddressPolicy(): (value: string) => boolean {
  const denied = { ipv4: new BlockList(), ipv6: new BlockList() };
  if (addressPolicy.registries.length !== 2 ||
    addressPolicy.registries[0].family !== 4 || addressPolicy.registries[1].family !== 6) {
    throw new TypeError("AddressPolicyInvalid: registries");
  }
  for (const registry of addressPolicy.registries) {
    const family = registry.family === 4 ? "ipv4" : "ipv6";
    const blocks = registry.records.flatMap((record) => record.blocks);
    if (!registry.recordCount || !registry.prefixCount ||
      registry.records.length !== registry.recordCount || blocks.length !== registry.prefixCount) {
      throw new TypeError("AddressPolicyInvalid: incomplete-registry");
    }
    for (const { cidr } of blocks) {
      const [address, prefix] = cidr.split("/");
      denied[family].addSubnet(address, Number(prefix), family);
    }
  }
  const [multicast, multicastPrefix] = addressPolicy.conservativeConfig.ipv4Multicast.cidr.split("/");
  denied.ipv4.addSubnet(multicast, Number(multicastPrefix), "ipv4");
  const globalV6 = new BlockList();
  const [envelope, envelopePrefix] = addressPolicy.conservativeConfig.ipv6Envelope.cidr.split("/");
  globalV6.addSubnet(envelope, Number(envelopePrefix), "ipv6");
  return function addressAllowed(value: string): boolean {
    const family = isIP(value);
    return family === 4
      ? !denied.ipv4.check(value, "ipv4")
      : family === 6 && globalV6.check(value, "ipv6") &&
        !denied.ipv6.check(value, "ipv6");
  };
}
export const publicAddress = createAddressPolicy();
export function publicUrl(
  value: string,
  maximumCharacters: number,
  addressAllowed: (value: string) => boolean = publicAddress,
): Result<URL> {
  if (typeof value !== "string" || value.length > maximumCharacters) {
    return fail("UrlInvalid", "url-length");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return fail("UrlInvalid");
  }
  if (url.username || url.password) return fail("CredentialsRejected");
  if (url.protocol !== "https:") return fail("HttpsRequired");
  if (url.port !== "") return fail("PortRejected");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" || hostname.endsWith(".localhost") ||
    (isIP(hostname) && !addressAllowed(hostname))
  ) return fail("AddressRejected");
  url.hash = "";
  return { ok: true, value: url };
}
export function inScope(root: URL, target: URL): boolean {
  const path = root.pathname === "/" ? "/" : root.pathname.replace(/\/$/, "");
  return root.origin === target.origin &&
    (path === "/" || target.pathname === path ||
      target.pathname.startsWith(`${path}/`));
}
// Low-level TLS primitive: callers must pass a validated address. Public gate is
// the sole production caller. Fixture-only CA trust is explicit; verification
// remains enabled. No proxy environment, ambient headers, pool or TLS reuse.
export function pinnedRequest(
  url: URL,
  address: string,
  signal: AbortSignal,
  trust?: { readonly ca: string },
): Promise<IncomingMessage> {
  if (
    !(url instanceof URL) || url.protocol !== "https:" || url.username ||
    url.password || !isIP(address) || !(signal instanceof AbortSignal)
  ) throw new TypeError("CommandInvalid");
  return new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const request = https.request(url, {
      method: "GET",
      agent: false,
      signal,
      rejectUnauthorized: true,
      ...(trust ? { ca: trust.ca } : {}),
      servername: isIP(hostname) ? "" : hostname,
      family: isIP(address),
      lookup: (_host, _options, callback) =>
        callback(null, address, isIP(address)),
      headers: {
        accept: "*/*",
        "accept-encoding": "gzip, deflate, br",
        "user-agent": "knowledge-platform-acquisition/1.0",
      },
      maxHeaderSize: 16 * 1024,
    }, resolve);
    request.once("error", reject);
    request.end();
  });
}
class BoundaryFailure extends Error {
  readonly kind: FailureKind;
  constructor(kind: FailureKind) {
    super(kind);
    this.kind = kind;
  }
}
function abortFailure(signal: AbortSignal): FailureKind {
  return signal.reason instanceof DOMException &&
      signal.reason.name === "TimeoutError"
    ? "TimedOut"
    : "Cancelled";
}
async function cancellable<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let listener: () => void = () => {};
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        listener = () => reject(new BoundaryFailure(abortFailure(signal)));
        signal.addEventListener("abort", listener, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}
async function readBody(
  response: IncomingMessage,
  maximum: number,
  policy: Policy,
  budget: Budget,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const encodedMaximum = Math.min(maximum, policy.encodedResourceBytes);
  const length = Number(response.headers["content-length"]);
  if (Number.isFinite(length) && length > encodedMaximum) {
    response.destroy();
    throw new BoundaryFailure("EncodedLimitExceeded");
  }
  const encoding = response.headers["content-encoding"] ?? "identity";
  const decoder = encoding === "identity"
    ? null
    : encoding === "gzip"
    ? createGunzip()
    : encoding === "br"
    ? createBrotliDecompress()
    : encoding === "deflate"
    ? createInflate()
    : undefined;
  if (decoder === undefined) {
    response.destroy();
    throw new BoundaryFailure("EncodingUnsupported");
  }
  let encoded = 0, decoded = 0;
  const chunks: Uint8Array[] = [];
  const encodedCounter = new Transform({
    transform(chunk: Uint8Array, _encoding, callback) {
      encoded += chunk.length;
      budget.encoded += chunk.length;
      callback(
        encoded > encodedMaximum
          ? new BoundaryFailure("EncodedLimitExceeded")
          : budget.encoded > policy.encodedOperationBytes
          ? new BoundaryFailure("OperationLimitExceeded")
          : null,
        chunk,
      );
    },
  });
  const sink = new Writable({
    write(chunk: Uint8Array, _encoding, callback) {
      decoded += chunk.length;
      budget.decoded += chunk.length;
      const failure = decoded > maximum
        ? "DecodedLimitExceeded"
        : budget.decoded > policy.decodedOperationBytes
        ? "OperationLimitExceeded"
        : null;
      if (failure) callback(new BoundaryFailure(failure));
      else {
        chunks.push(new Uint8Array(chunk));
        callback();
      }
    },
  });
  try {
    if (decoder) {
      await pipeline(response, encodedCounter, decoder, sink, { signal });
    } else await pipeline(response, encodedCounter, sink, { signal });
  } finally {
    response.destroy();
    decoder?.destroy();
    encodedCounter.destroy();
    sink.destroy();
  }
  const bytes = new Uint8Array(decoded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export function createGate(
  deps: {
    readonly policy: Policy;
    readonly resolve: Resolver;
    readonly dial: Dial;
    readonly logger: Logger;
    readonly addressAllowed?: (value: string) => boolean;
  },
) {
  validatePolicy(deps.policy);
  const addressAllowed = deps.addressAllowed ?? publicAddress;
  if (
    typeof deps.resolve !== "function" || typeof deps.dial !== "function" ||
    typeof deps.logger !== "function" || typeof addressAllowed !== "function"
  ) throw new TypeError("ConfigurationInvalid");
  return Object.freeze({
    async request(
      command: RequestCommand,
      budget: Budget,
      signal: AbortSignal,
    ): Promise<Result<Observation>> {
      deps.logger({ event: "acquisition-entry" });
      const result = await run(command, budget, signal);
      deps.logger({
        event: result.ok ? "acquisition-success" : "acquisition-failure",
        ...(result.ok
          ? { resources: budget.resources }
          : { failureKind: result.error.kind }),
      });
      return result;
    },
  });
  async function run(
    command: RequestCommand,
    budget: Budget,
    externalSignal: AbortSignal,
  ): Promise<Result<Observation>> {
    if (
      !command ||
      !["page", "robots", "image", "resource"].includes(command.purpose) ||
      !Number.isSafeInteger(command.maximumBytes) ||
      command.maximumBytes <= 0 ||
      !Number.isSafeInteger(command.redirectLimit) ||
      command.redirectLimit < 0 || !(externalSignal instanceof AbortSignal)
    ) return fail("CommandInvalid");
    if (
      !budget || typeof budget !== "object" || Array.isArray(budget) ||
      (["encoded", "decoded", "resources", "pixels"] as const).some((key) =>
        !Object.hasOwn(budget, key) || !Number.isSafeInteger(budget[key]) ||
        budget[key] < 0
      )
    ) return fail("CommandInvalid", "budget");
    const cap = command.purpose === "robots"
      ? deps.policy.robotsBytes
      : command.purpose === "image"
      ? deps.policy.imageBytes
      : deps.policy.htmlBytes;
    const redirects = command.purpose === "robots"
      ? 0
      : command.purpose === "image"
      ? deps.policy.mediaRedirects
      : deps.policy.pageRedirects;
    if (command.maximumBytes > cap || command.redirectLimit > redirects) {
      return fail("CommandInvalid", "limits");
    }
    const initial = publicUrl(command.url, deps.policy.urlCharacters, addressAllowed);
    if (!initial.ok) return initial;
    const root = publicUrl(command.rootUrl, deps.policy.urlCharacters, addressAllowed);
    if (!root.ok) return root;
    if (
      command.purpose === "robots" &&
      initial.value.href !== `${root.value.origin}/robots.txt`
    ) return fail("ScopeRejected");
    let url = initial.value;
    const redirectHops: string[] = [];
    const signal = AbortSignal.any([
      externalSignal,
      AbortSignal.timeout(deps.policy.requestMilliseconds),
    ]);
    try {
      while (true) {
        if (signal.aborted) return fail(abortFailure(signal));
        if (command.purpose !== "robots" && !inScope(root.value, url)) {
          return fail("ScopeRejected");
        }
        if (++budget.resources > deps.policy.resources) {
          return fail("OperationLimitExceeded");
        }
        let addresses: readonly string[];
        try {
          const hostname = url.hostname.replace(/^\[|\]$/g, "");
          addresses = isIP(hostname)
            ? [hostname]
            : await cancellable(deps.resolve(hostname, signal), signal);
        } catch (error) {
          if (signal.aborted) return fail(abortFailure(signal));
          if (error instanceof BoundaryFailure) return fail(error.kind);
          return fail("DnsFailed");
        }
        if (!Array.isArray(addresses) || addresses.length === 0) {
          return fail("DnsFailed");
        }
        if (addresses.some((address) => !addressAllowed(address))) {
          return fail("AddressRejected");
        }
        let response: IncomingMessage | undefined;
        let selectedAddress = "";
        let lastFailure: FailureKind = "ConnectFailed";
        for (const address of addresses) {
          if (signal.aborted) return fail(abortFailure(signal));
          try {
            response = await deps.dial(url, address, signal);
            selectedAddress = address;
            break;
          } catch (error) {
            if (signal.aborted) return fail(abortFailure(signal));
            const code = error instanceof Error && "code" in error
              ? String(error.code)
              : "";
            lastFailure = /TLS|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)
              ? "TlsFailed"
              : "ConnectFailed";
            if (lastFailure === "TlsFailed") return fail(lastFailure);
          }
        }
        if (!response) return fail(lastFailure);
        const peer = response.socket?.remoteAddress;
        const normalized = (ip: string) =>
          isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname : ip;
        if (
          !peer || !addressAllowed(peer) ||
          normalized(peer) !== normalized(selectedAddress)
        ) {
          response.destroy();
          return fail("AddressRejected", "connected-peer");
        }
        const status = response.statusCode;
        if (status === undefined) {
          response.destroy();
          return fail("ConnectFailed", "status");
        }
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          if (command.purpose === "robots") return fail("RedirectRejected");
          if (redirectHops.length >= command.redirectLimit) {
            return fail("RedirectLimitExceeded");
          }
          const location = response.headers.location;
          if (!location) return fail("RedirectRejected");
          let next: Result<URL>;
          try {
            next = publicUrl(
              new URL(location, url).href,
              deps.policy.urlCharacters,
              addressAllowed,
            );
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            return fail("RedirectRejected");
          }
          if (!next.ok) return next;
          redirectHops.push(url.href);
          url = next.value;
          continue;
        }
        const bytes = await readBody(
          response,
          command.maximumBytes,
          deps.policy,
          budget,
          signal,
        );
        // Credential-bearing response headers never reach a renderer or client.
        const headers: Record<string, string> = {};
        for (const key of ["content-type", "retry-after"]) {
          const v = response.headers[key];
          if (typeof v === "string") headers[key] = v;
        }
        return {
          ok: true,
          value: {
            peerAddress: peer,
            status,
            headers,
            bytes,
            finalUrl: url.href,
            redirectHops,
          },
        };
      }
    } catch (error) {
      if (signal.aborted) return fail(abortFailure(signal));
      if (error instanceof BoundaryFailure) return fail(error.kind);
      return fail("DecodeFailed");
    }
  }
}

export { validatePolicy } from "./contracts.ts";
