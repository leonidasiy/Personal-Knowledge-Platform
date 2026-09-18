// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/** @typedef {{ readonly kind: "WorkflowDnsLookupFailed" | "WorkflowPrivateAddressRejected" }} WorkflowNetworkFailure */

/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }

/** @param {string} value @returns {boolean} */
export function isForbiddenAddress(value) {
  if (!text(value)) return true;
  const normalized = value.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized.includes(".")) {
    const parts = normalized.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b, c] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (!normalized.includes(":")) return true;
  const compact = normalized.replace(/^::ffff:/u, "");
  if (compact.includes(".") && isForbiddenAddress(compact)) return true;
  const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  if (!Number.isInteger(first)) return true;
  return first === 0 || first < 0x2000 || first > 0x3fff ||
    normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") ||
    normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") ||
    normalized.startsWith("feb") || normalized.startsWith("2001:db8:");
}

/** @param {string} hostname @param {typeof fetch} fetchDependency @returns {Promise<Result<readonly string[], WorkflowNetworkFailure>>} */
export async function resolvePublicAddresses(hostname, fetchDependency) {
  if (!/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(hostname) || typeof fetchDependency !== "function") return { ok: false, error: { kind: "WorkflowDnsLookupFailed" } };
  try {
    const responses = await Promise.all(["A", "AAAA"].map((type) => fetchDependency(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, { headers: { accept: "application/dns-json" } })));
    const addresses = [];
    for (const response of responses) {
      if (!response.ok) return { ok: false, error: { kind: "WorkflowDnsLookupFailed" } };
      const document = /** @type {unknown} */ (await response.json());
      if (typeof document !== "object" || document === null || Array.isArray(document)) return { ok: false, error: { kind: "WorkflowDnsLookupFailed" } };
      const answer = /** @type {{ readonly Status?: unknown, readonly Answer?: unknown }} */ (document);
      if (answer.Status !== 0 && answer.Status !== 3) return { ok: false, error: { kind: "WorkflowDnsLookupFailed" } };
      if (answer.Answer !== undefined && !Array.isArray(answer.Answer)) return { ok: false, error: { kind: "WorkflowDnsLookupFailed" } };
      for (const entry of Array.isArray(answer.Answer) ? answer.Answer : []) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const candidate = /** @type {{ readonly type?: unknown, readonly data?: unknown }} */ (entry);
        if ((candidate.type === 1 || candidate.type === 28) && typeof candidate.data === "string") {
          if (isForbiddenAddress(candidate.data)) return { ok: false, error: { kind: "WorkflowPrivateAddressRejected" } };
          addresses.push(candidate.data);
        }
      }
    }
    return addresses.length === 0
      ? { ok: false, error: { kind: "WorkflowDnsLookupFailed" } }
      : { ok: true, value: Object.freeze([...new Set(addresses)]) };
  } catch (error) {
    if (error instanceof Error) return { ok: false, error: { kind: "WorkflowDnsLookupFailed" } };
    throw error;
  }
}

export {};
