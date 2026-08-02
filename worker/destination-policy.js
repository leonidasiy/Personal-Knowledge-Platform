// @ts-check

/** @import { Result, WorkerFailure } from "./contracts.js" */

/**
 * Validate a publisher destination before every request and redirect.
 * DNS-resolved addresses remain the responsibility of the injected fetch boundary.
 *
 * @param {unknown} value
 * @returns {Result<URL, WorkerFailure>}
 */
export function validatePublisherDestination(value) {
  if (typeof value !== "string" || !URL.canParse(value)) {
    return { ok: false, error: { kind: "DiscoverySourceUrlInvalid" } };
  }
  const url = new URL(value);
  if (url.protocol !== "https:") {
    return {
      ok: false,
      error: {
        kind: "DiscoverySourceProtocolUnsupported",
        protocol: url.protocol,
      },
    };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      error: { kind: "DiscoveryDestinationForbidden", reason: "credentials" },
    };
  }
  if (url.port !== "" && url.port !== "443") {
    return {
      ok: false,
      error: { kind: "DiscoveryDestinationForbidden", reason: "port" },
    };
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") || hostname === "0"
  ) {
    return {
      ok: false,
      error: { kind: "DiscoveryDestinationForbidden", reason: "local-host" },
    };
  }
  if (hostname.includes(":")) {
    return {
      ok: false,
      error: { kind: "DiscoveryDestinationForbidden", reason: "ip-literal" },
    };
  }
  const ipv4 = parseIpv4(hostname);
  if (ipv4 !== null && isForbiddenIpv4(ipv4)) {
    return {
      ok: false,
      error: {
        kind: "DiscoveryDestinationForbidden",
        reason: "reserved-address",
      },
    };
  }
  return { ok: true, value: url };
}

/** @param {string} hostname @returns {readonly number[] | null} */
function parseIpv4(hostname) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return null;
  const parts = hostname.split(".").map(Number);
  return parts.every((part) =>
      Number.isInteger(part) && part >= 0 && part <= 255
    )
    ? Object.freeze(parts)
    : null;
}

/** @param {readonly number[]} address */
function isForbiddenIpv4(address) {
  const [a, b, c] = address;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113);
}
