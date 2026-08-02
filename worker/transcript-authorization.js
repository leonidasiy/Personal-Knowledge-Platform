// @ts-check

import { isRecord } from "./contracts.js";

/** @template T @template E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */
/** @typedef {{ readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }} AuthorizationBinding */
/** @typedef {{ readonly exec: (query: string, ...bindings: readonly (string | number)[]) => Iterable<Record<string, unknown>> }} AuthorizationSql */
/** @typedef {{ readonly sql: AuthorizationSql, readonly transactionSync: <T>(callback: () => T) => T }} AuthorizationStorage */
/** @typedef {{ readonly storage: AuthorizationStorage }} AuthorizationState */
/** @typedef {{ readonly url: string, readonly type: string, readonly language: string | null, readonly itemIdentityKey: string }} TranscriptReference */
/** @typedef {{ readonly ownerId: string, readonly sourceRequestId: string, readonly sourceUrl: string, readonly observedAt: string, readonly references: readonly TranscriptReference[] }} ReferenceCommand */
/** @typedef {{ readonly ownerId: string, readonly evidenceId: string, readonly transcriptUrl: string, readonly access: "allowed" | "denied" | "unknown", readonly storage: "allowed" | "denied" | "unknown", readonly display: "allowed" | "denied" | "unknown", readonly transformation: "allowed" | "denied" | "unknown", readonly attribution: "allowed" | "denied" | "unknown", readonly attributionText: string, readonly evidenceBasis: string, readonly evidenceReference: string, readonly scope: string, readonly expiresAt: string }} AuthorizationCommand */
/** @typedef {{ readonly evidenceId: string, readonly transcriptUrl: string }} AuthorizationLookup */
/** @typedef {{ readonly evidenceId: string, readonly transcriptUrl: string, readonly access: "allowed" | "denied" | "unknown", readonly storage: "allowed" | "denied" | "unknown", readonly display: "allowed" | "denied" | "unknown", readonly transformation: "allowed" | "denied" | "unknown", readonly attribution: "allowed" | "denied" | "unknown", readonly attributionText: string, readonly expiresAt: string }} ResolvedAuthorization */
/** @typedef {{ readonly kind: "TranscriptAuthorizationPersistenceFailed" } | { readonly kind: "TranscriptAuthorizationMissing" } | { readonly kind: "TranscriptAuthorizationReferenceMismatch" } | { readonly kind: "TranscriptAuthorizationResponseInvalid" }} AuthorizationFailure */

const CAPABILITIES = Object.freeze([
  "access",
  "storage",
  "display",
  "transformation",
  "attribution",
]);

export class DurablePublisherTranscriptAuthorization {
  /** @type {AuthorizationBinding} */
  #binding;

  /** @param {AuthorizationBinding} binding */
  constructor(binding) {
    if (!isBinding(binding)) {
      throw new TypeError(
        "Publisher transcript authorization binding is invalid.",
      );
    }
    this.#binding = binding;
  }

  /** @param {ReferenceCommand} command @returns {Promise<Result<undefined, { readonly kind: "TranscriptAuthorizationPersistenceFailed" }>>} */
  async recordReferences(command) {
    const response = await this.#request("/source-references", command);
    return response.ok ? { ok: true, value: undefined } : {
      ok: false,
      error: { kind: "TranscriptAuthorizationPersistenceFailed" },
    };
  }

  /** @param {AuthorizationCommand} command @returns {Promise<Result<undefined, AuthorizationFailure>>} */
  async authorize(command) {
    const response = await this.#request("/authorizations", command);
    if (response.status === 409) {
      return {
        ok: false,
        error: { kind: "TranscriptAuthorizationReferenceMismatch" },
      };
    }
    return response.ok ? { ok: true, value: undefined } : {
      ok: false,
      error: { kind: "TranscriptAuthorizationPersistenceFailed" },
    };
  }

  /** @param {string} ownerId @param {AuthorizationLookup} lookup @returns {Promise<Result<ResolvedAuthorization, AuthorizationFailure>>} */
  async resolve(ownerId, lookup) {
    const response = await this.#request("/resolve", { ownerId, ...lookup });
    if (response.status === 404) {
      return { ok: false, error: { kind: "TranscriptAuthorizationMissing" } };
    }
    if (response.status === 409) {
      return {
        ok: false,
        error: { kind: "TranscriptAuthorizationReferenceMismatch" },
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        error: { kind: "TranscriptAuthorizationPersistenceFailed" },
      };
    }
    /** @type {unknown} */
    let document;
    try {
      document = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        return {
          ok: false,
          error: { kind: "TranscriptAuthorizationResponseInvalid" },
        };
      }
      throw error;
    }
    return validResolved(document)
      ? { ok: true, value: Object.freeze(document) }
      : {
        ok: false,
        error: { kind: "TranscriptAuthorizationResponseInvalid" },
      };
  }

  /** @param {string} path @param {unknown} body */
  async #request(path, body) {
    try {
      return await this.#binding.fetch(
        `https://transcript-rights.internal${path}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    } catch (error) {
      if (error instanceof Error) return Response.error();
      throw error;
    }
  }
}

export class PublisherTranscriptAuthorizationDurableObject {
  /** @type {AuthorizationStorage} */
  #storage;

  /** @param {AuthorizationState} state */
  constructor(state) {
    if (!isStorage(state?.storage)) {
      throw new TypeError(
        "Publisher transcript authorization storage is invalid.",
      );
    }
    this.#storage = state.storage;
    this.#storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS transcript_source_reference (owner_id TEXT NOT NULL, transcript_url TEXT NOT NULL, media_type TEXT NOT NULL, language TEXT, item_identity_key TEXT NOT NULL, source_request_id TEXT NOT NULL, source_url TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY (owner_id, transcript_url))",
    );
    this.#storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS transcript_authorization (owner_id TEXT NOT NULL, evidence_id TEXT NOT NULL, transcript_url TEXT NOT NULL, access_status TEXT NOT NULL, storage_status TEXT NOT NULL, display_status TEXT NOT NULL, transformation_status TEXT NOT NULL, attribution_status TEXT NOT NULL, attribution_text TEXT NOT NULL, evidence_basis TEXT NOT NULL, evidence_reference TEXT NOT NULL, rights_scope TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY (owner_id, evidence_id), UNIQUE (owner_id, transcript_url))",
    );
  }

  /** @param {Request} request */
  async fetch(request) {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405);
    }
    const command = await readBoundedJson(request, 32_768);
    if (!command.ok) return command.error;
    const path = new URL(request.url).pathname;
    if (path === "/source-references") {
      return this.#recordReferences(command.value);
    }
    if (path === "/authorizations") return this.#authorize(command.value);
    if (path === "/resolve") return this.#resolve(command.value);
    return json({ error: "Not found." }, 404);
  }

  /** @param {unknown} value */
  #recordReferences(value) {
    const command = validateReferenceCommand(value);
    if (!command.ok) return command.error;
    try {
      this.#storage.transactionSync(() => {
        for (const reference of command.value.references) {
          this.#storage.sql.exec(
            "INSERT INTO transcript_source_reference (owner_id, transcript_url, media_type, language, item_identity_key, source_request_id, source_url, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner_id, transcript_url) DO UPDATE SET media_type = excluded.media_type, language = excluded.language, item_identity_key = excluded.item_identity_key, source_request_id = excluded.source_request_id, source_url = excluded.source_url, observed_at = excluded.observed_at",
            command.value.ownerId,
            reference.url,
            reference.type,
            reference.language ?? "",
            reference.itemIdentityKey,
            command.value.sourceRequestId,
            command.value.sourceUrl,
            command.value.observedAt,
          );
        }
      });
      return json({ stored: command.value.references.length }, 200);
    } catch (error) {
      if (error instanceof Error) {
        return json({ error: "TranscriptAuthorizationPersistenceFailed" }, 503);
      }
      throw error;
    }
  }

  /** @param {unknown} value */
  #authorize(value) {
    const command = validateAuthorizationCommand(value);
    if (!command.ok) return command.error;
    try {
      const persisted = this.#storage.transactionSync(() => {
        const source = [...this.#storage.sql.exec(
          "SELECT transcript_url FROM transcript_source_reference WHERE owner_id = ? AND transcript_url = ?",
          command.value.ownerId,
          command.value.transcriptUrl,
        )];
        if (source.length !== 1) return false;
        this.#storage.sql.exec(
          "INSERT INTO transcript_authorization (owner_id, evidence_id, transcript_url, access_status, storage_status, display_status, transformation_status, attribution_status, attribution_text, evidence_basis, evidence_reference, rights_scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner_id, evidence_id) DO UPDATE SET transcript_url = excluded.transcript_url, access_status = excluded.access_status, storage_status = excluded.storage_status, display_status = excluded.display_status, transformation_status = excluded.transformation_status, attribution_status = excluded.attribution_status, attribution_text = excluded.attribution_text, evidence_basis = excluded.evidence_basis, evidence_reference = excluded.evidence_reference, rights_scope = excluded.rights_scope, expires_at = excluded.expires_at",
          command.value.ownerId,
          command.value.evidenceId,
          command.value.transcriptUrl,
          command.value.access,
          command.value.storage,
          command.value.display,
          command.value.transformation,
          command.value.attribution,
          command.value.attributionText,
          command.value.evidenceBasis,
          command.value.evidenceReference,
          command.value.scope,
          command.value.expiresAt,
        );
        return true;
      });
      return persisted
        ? json({ stored: true }, 200)
        : json({ error: "TranscriptAuthorizationReferenceMismatch" }, 409);
    } catch (error) {
      if (error instanceof Error) {
        return json({ error: "TranscriptAuthorizationPersistenceFailed" }, 503);
      }
      throw error;
    }
  }

  /** @param {unknown} value */
  #resolve(value) {
    if (
      !isRecord(value) || !nonBlank(value.ownerId) ||
      !nonBlank(value.evidenceId) || !safeHttps(value.transcriptUrl)
    ) {
      return json({ error: "TranscriptAuthorizationLookupInvalid" }, 400);
    }
    try {
      const rows = [...this.#storage.sql.exec(
        "SELECT evidence_id, transcript_url, access_status, storage_status, display_status, transformation_status, attribution_status, attribution_text, expires_at FROM transcript_authorization WHERE owner_id = ? AND evidence_id = ?",
        value.ownerId,
        value.evidenceId,
      )];
      if (rows.length === 0) {
        return json({ error: "TranscriptAuthorizationMissing" }, 404);
      }
      if (rows.length !== 1) {
        throw new TypeError(
          "Transcript authorization uniqueness invariant is broken.",
        );
      }
      const row = rows[0];
      if (row.transcript_url !== value.transcriptUrl) {
        return json({ error: "TranscriptAuthorizationReferenceMismatch" }, 409);
      }
      return json({
        evidenceId: row.evidence_id,
        transcriptUrl: row.transcript_url,
        access: row.access_status,
        storage: row.storage_status,
        display: row.display_status,
        transformation: row.transformation_status,
        attribution: row.attribution_status,
        attributionText: row.attribution_text,
        expiresAt: row.expires_at,
      }, 200);
    } catch (error) {
      if (error instanceof Error) {
        return json({ error: "TranscriptAuthorizationPersistenceFailed" }, 503);
      }
      throw error;
    }
  }
}

/** @param {unknown} value @returns {value is ResolvedAuthorization} */
function validResolved(value) {
  if (
    !isRecord(value) || !nonBlank(value.evidenceId) ||
    !safeHttps(value.transcriptUrl) || !nonBlank(value.attributionText) ||
    !validTimestamp(value.expiresAt)
  ) return false;
  return CAPABILITIES.every((field) => capability(value[field]));
}

/** @param {unknown} value @returns {Result<ReferenceCommand, Response>} */
function validateReferenceCommand(value) {
  if (
    !isRecord(value) || !nonBlank(value.ownerId) ||
    !nonBlank(value.sourceRequestId) || !safeHttps(value.sourceUrl) ||
    !validTimestamp(value.observedAt) || !Array.isArray(value.references) ||
    value.references.length > 512
  ) return invalid("sourceReferences");
  const references = [];
  for (const reference of value.references) {
    if (
      !isRecord(reference) || !safeHttps(reference.url) ||
      !nonBlank(reference.type) ||
      !(reference.language === null || nonBlank(reference.language)) ||
      !nonBlank(reference.itemIdentityKey)
    ) return invalid("sourceReferences");
    references.push(
      Object.freeze({
        url: reference.url,
        type: reference.type,
        language: reference.language,
        itemIdentityKey: reference.itemIdentityKey,
      }),
    );
  }
  return {
    ok: true,
    value: Object.freeze({
      ownerId: value.ownerId,
      sourceRequestId: value.sourceRequestId,
      sourceUrl: value.sourceUrl,
      observedAt: value.observedAt,
      references: Object.freeze(references),
    }),
  };
}

/** @param {unknown} value @returns {Result<AuthorizationCommand, Response>} */
function validateAuthorizationCommand(value) {
  if (
    !isRecord(value) || !nonBlank(value.ownerId) ||
    !nonBlank(value.evidenceId) || !safeHttps(value.transcriptUrl) ||
    !nonBlank(value.attributionText) || !nonBlank(value.evidenceBasis) ||
    !safeHttps(value.evidenceReference) || !nonBlank(value.scope) ||
    !validTimestamp(value.expiresAt)
  ) return invalid("authorization");
  if (!CAPABILITIES.every((field) => capability(value[field]))) {
    return invalid("authorization");
  }
  return {
    ok: true,
    value: /** @type {AuthorizationCommand} */ (Object.freeze({ ...value })),
  };
}

/** @param {Request} request @param {number} maximumBytes @returns {Promise<Result<unknown, Response>>} */
async function readBoundedJson(request, maximumBytes) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    return {
      ok: false,
      error: json({ error: "TranscriptAuthorizationCommandTooLarge" }, 413),
    };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    return {
      ok: false,
      error: json({ error: "TranscriptAuthorizationCommandTooLarge" }, 413),
    };
  }
  try {
    return { ok: true, value: /** @type {unknown} */ (JSON.parse(text)) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        ok: false,
        error: json({ error: "TranscriptAuthorizationCommandInvalid" }, 400),
      };
    }
    throw error;
  }
}

/** @param {string} field */
function invalid(field) {
  return /** @type {const} */ ({
    ok: false,
    error: json({ error: "TranscriptAuthorizationCommandInvalid", field }, 400),
  });
}

/** @param {unknown} value */
function capability(value) {
  return value === "allowed" || value === "denied" || value === "unknown";
}

/** @param {unknown} value @returns {value is string} */
function nonBlank(value) {
  return typeof value === "string" && value.trim() !== "" &&
    value.length <= 1_024;
}

/** @param {unknown} value @returns {value is string} */
function safeHttps(value) {
  return nonBlank(value) && URL.canParse(value) &&
    new URL(value).protocol === "https:";
}

/** @param {unknown} value @returns {value is string} */
function validTimestamp(value) {
  return nonBlank(value) && Number.isFinite(Date.parse(value));
}

/** @param {unknown} value @returns {value is AuthorizationBinding} */
function isBinding(value) {
  return isRecord(value) && typeof value.fetch === "function";
}

/** @param {unknown} value @returns {value is AuthorizationStorage} */
function isStorage(value) {
  return isRecord(value) && isRecord(value.sql) &&
    typeof value.sql.exec === "function" &&
    typeof value.transactionSync === "function";
}

/** @param {unknown} body @param {number} status */
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
