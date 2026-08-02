// @ts-check

import { PublisherTranscriptAuthorizationDurableObject } from "../worker/transcript-authorization.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

class AuthorizationSqlFixture {
  /** @type {Set<string>} */ references = new Set();
  /** @type {Map<string, Record<string, unknown>>} */ authorizations =
    new Map();
  /** @type {boolean} */ failWrites;

  /** @param {boolean} [failWrites] */
  constructor(failWrites = false) {
    this.failWrites = failWrites;
  }

  /** @param {string} query @param {...(string|number)} bindings @returns {Iterable<Record<string,unknown>>} */
  exec(query, ...bindings) {
    if (query.startsWith("CREATE TABLE")) return [];
    if (this.failWrites && query.startsWith("INSERT")) {
      throw new Error("Injected persistence failure.");
    }
    if (query.startsWith("INSERT INTO transcript_source_reference")) {
      this.references.add(`${bindings[0]}|${bindings[1]}`);
      return [];
    }
    if (
      query.startsWith("SELECT transcript_url FROM transcript_source_reference")
    ) {
      return this.references.has(`${bindings[0]}|${bindings[1]}`)
        ? [{ transcript_url: bindings[1] }]
        : [];
    }
    if (query.startsWith("INSERT INTO transcript_authorization")) {
      this.authorizations.set(`${bindings[0]}|${bindings[1]}`, {
        evidence_id: bindings[1],
        transcript_url: bindings[2],
        access_status: bindings[3],
        storage_status: bindings[4],
        display_status: bindings[5],
        transformation_status: bindings[6],
        attribution_status: bindings[7],
        attribution_text: bindings[8],
        expires_at: bindings[12],
      });
      return [];
    }
    if (query.startsWith("SELECT evidence_id, transcript_url")) {
      const record = this.authorizations.get(`${bindings[0]}|${bindings[1]}`);
      return record === undefined ? [] : [record];
    }
    throw new Error(`Unexpected SQL fixture query: ${query}`);
  }
}

/** @param {AuthorizationSqlFixture} sql */
function durableObject(sql) {
  return new PublisherTranscriptAuthorizationDurableObject({
    storage: {
      sql,
      transactionSync: (operation) => operation(),
    },
  });
}

/** @param {PublisherTranscriptAuthorizationDurableObject} object @param {string} path @param {unknown} body */
function post(object, path, body) {
  return object.fetch(
    new Request(`https://rights.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const transcriptUrl = "https://publisher.example/transcript.txt";
const authorization = Object.freeze({
  ownerId: "owner-a",
  evidenceId: "evidence-1",
  transcriptUrl,
  access: "allowed",
  storage: "allowed",
  display: "allowed",
  transformation: "allowed",
  attribution: "allowed",
  attributionText: "Publisher transcript",
  evidenceBasis: "Publisher license",
  evidenceReference: "https://publisher.example/license",
  scope: "transcript-retention-and-transformation",
  expiresAt: "2027-07-21T00:00:00.000Z",
});

Deno.test("authorization Durable Object requires an exact owner-scoped observed reference", async () => {
  const object = durableObject(new AuthorizationSqlFixture());
  const unobserved = await post(object, "/authorizations", authorization);
  assertEquals(unobserved.status, 409);

  const recorded = await post(object, "/source-references", {
    ownerId: "owner-a",
    sourceRequestId: "rss-request-1",
    sourceUrl: "https://publisher.example/feed.xml",
    observedAt: "2026-07-21T00:00:00.000Z",
    references: [{
      url: transcriptUrl,
      type: "text/plain",
      language: "en",
      itemIdentityKey: "episode-1",
    }],
  });
  assertEquals(recorded.status, 200);
  const wrongOwner = await post(object, "/authorizations", {
    ...authorization,
    ownerId: "owner-b",
  });
  assertEquals(wrongOwner.status, 409);
  assertEquals(
    (await post(object, "/authorizations", authorization)).status,
    200,
  );
});

Deno.test("authorization Durable Object distinguishes missing, owner, and URL mismatch lookups", async () => {
  const object = durableObject(new AuthorizationSqlFixture());
  await post(object, "/source-references", {
    ownerId: "owner-a",
    sourceRequestId: "rss-request-1",
    sourceUrl: "https://publisher.example/feed.xml",
    observedAt: "2026-07-21T00:00:00.000Z",
    references: [{
      url: transcriptUrl,
      type: "text/plain",
      language: null,
      itemIdentityKey: "episode-1",
    }],
  });
  await post(object, "/authorizations", authorization);
  assertEquals(
    (await post(object, "/resolve", {
      ownerId: "owner-a",
      evidenceId: "missing",
      transcriptUrl,
    })).status,
    404,
  );
  assertEquals(
    (await post(object, "/resolve", {
      ownerId: "owner-b",
      evidenceId: "evidence-1",
      transcriptUrl,
    })).status,
    404,
  );
  assertEquals(
    (await post(object, "/resolve", {
      ownerId: "owner-a",
      evidenceId: "evidence-1",
      transcriptUrl: "https://publisher.example/other.txt",
    })).status,
    409,
  );
  const resolved = await post(object, "/resolve", {
    ownerId: "owner-a",
    evidenceId: "evidence-1",
    transcriptUrl,
  });
  assertEquals(resolved.status, 200);
  const document = await resolved.json();
  assertEquals(document.transcriptUrl, transcriptUrl);
  assertEquals(document.storage, "allowed");
});

Deno.test("authorization Durable Object reports persistence failure without a partial record", async () => {
  const sql = new AuthorizationSqlFixture(true);
  const object = durableObject(sql);
  const response = await post(object, "/source-references", {
    ownerId: "owner-a",
    sourceRequestId: "rss-request-1",
    sourceUrl: "https://publisher.example/feed.xml",
    observedAt: "2026-07-21T00:00:00.000Z",
    references: [{
      url: transcriptUrl,
      type: "text/plain",
      language: "en",
      itemIdentityKey: "episode-1",
    }],
  });
  assertEquals(response.status, 503);
  assertEquals(sql.references.size, 0);
});
