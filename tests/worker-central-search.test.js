// @ts-check

import { createCentralDiscoverySearch } from "../worker/discovery-search.js";
import { createEducationalSearchPolicy } from "../worker/educational-search-policy.js";

/** @template T @param {T} actual @param {T} expected */
function equal(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

const policyConfiguration = Object.freeze({
  version: "educational-v1",
  maximumSubmittedCharacters: 120,
  maximumProviderCharacters: 240,
});

Deno.test("central educational policy normalizes without generic query augmentation", () => {
  const policy = createEducationalSearchPolicy(policyConfiguration);
  const prepared = policy.prepare("  Vocaloid\u00a0  tuning tutorial  ");
  equal(prepared.ok, true);
  if (!prepared.ok) return;
  equal(prepared.value.submittedQuery, "Vocaloid tuning tutorial");
  equal(
    prepared.value.providerQuery,
    "Vocaloid tuning tutorial",
  );
  equal(prepared.value.policyVersion, "educational-v1");

});

Deno.test("central educational policy rejects invalid and excessive queries", () => {
  const policy = createEducationalSearchPolicy(policyConfiguration);
  const empty = policy.prepare(" \n\t ");
  equal(empty.ok, false);
  if (!empty.ok) equal(empty.error.kind, "EducationalQueryInvalid");
  const submitted = policy.prepare("x".repeat(121));
  equal(submitted.ok, false);
  if (!submitted.ok) equal(submitted.error.kind, "EducationalQueryTooLong");
  const outputPolicy = createEducationalSearchPolicy({
    ...policyConfiguration,
    maximumProviderCharacters: 20,
  });
  const augmented = outputPolicy.prepare("harmony "+"x".repeat(20));
  equal(augmented.ok, false);
  if (!augmented.ok) {
    equal(augmented.error.kind, "EducationalProviderQueryTooLong");
  }
});

/** @param {string} id @param {number} priority @param {boolean} [enabled] */
function descriptor(id, priority, enabled = true) {
  return Object.freeze({
    id,
    label: id === "web" ? "Web" : "Videos",
    resultKind: id === "web" ? "web" : "video",
    priority,
    enabled,
  });
}

/** @param {string} providerId @param {string} title @param {string} canonicalUrl */
function candidate(providerId, title, canonicalUrl) {
  return Object.freeze({
    providerId,
    resultKind: providerId === "web" ? "web" : "video",
    sourceLevel: providerId === "web" ? "site" : "video",
    title,
    description: "Educational tutorial and guided lesson",
    canonicalUrl,
    publisherLabel: providerId,
    publishedAt: null,
    identityEvidence: Object.freeze([Object.freeze({
      attribute: "provider-result",
      value: canonicalUrl,
      provenanceUrl: canonicalUrl,
    })]),
  });
}

Deno.test("raw search preserves query and provider order before the global limit", async () => {
  /** @type {{readonly providerId:string,readonly query:string,readonly limit:number}[]} */
  const calls = [];
  const providers = [
    {
      descriptor: descriptor("web", 1),
      search: async (
        /** @type {{readonly providerId:string,readonly query:string,readonly limit:number}} */ command,
      ) => {
        calls.push(command);
        return {
          ok: /** @type {const} */ (true),
          value: Object.freeze([
            candidate("web", "Harmony tutorial", "https://music.example/"),
            Object.freeze({
              ...candidate(
                "web",
                "Unrelated release",
                "https://noise.example/",
              ),
              description: "New songs",
            }),
          ].slice(0, command.limit)),
        };
      },
    },
    {
      descriptor: descriptor("youtube", 2),
      search: async (
        /** @type {{readonly providerId:string,readonly query:string,readonly limit:number}} */ command,
      ) => {
        calls.push(command);
        return {
          ok: /** @type {const} */ (true),
          value: Object.freeze([
            candidate(
              "youtube",
              "Harmony course",
              "https://music.example/",
            ),
            candidate(
              "youtube",
              "Voice leading explained",
              "https://www.youtube.com/watch?v=lesson-1",
            ),
          ].slice(0, command.limit)),
        };
      },
    },
  ];
  const search = createCentralDiscoverySearch(
    { maximumLimit: 20 },
    { budget:{timeoutMs:25000,now:Date.now,timeoutSignal:AbortSignal.timeout}, policy: createEducationalSearchPolicy(policyConfiguration), providers },
  );
  const result = await search.search({
    query: " harmony ",
    providerIds: ["youtube", "web"],
    limit: 2,
  });
  equal(result.ok, true);
  equal(calls.length, 2);
  equal(calls[0].providerId, "web");
  equal(calls[1].providerId, "youtube");
  for (const call of calls) {
    equal(
      call.query,
      "harmony",
    );
    equal(call.limit, 1);
  }
  if (!result.ok) return;
  equal(result.value.items.length, 2);
  equal(result.value.items[0].providerId, "web");
  equal(
    result.value.items[1].canonicalUrl,
    "https://music.example/",
  );
  equal(result.value.submittedQuery, "harmony");
  equal(result.value.providerQuery, calls[0].query);
  equal(result.value.policyVersion, "educational-v1");
  equal(result.value.providerFailures.length, 0);
});

Deno.test("central search returns partial provider failures without masking results", async () => {
  const search = createCentralDiscoverySearch(
    { maximumLimit: 20 },
    {
      budget:{timeoutMs:25000,now:Date.now,timeoutSignal:AbortSignal.timeout},
      policy: createEducationalSearchPolicy(policyConfiguration),
      providers: [
        {
          descriptor: descriptor("web", 1),
          search: async () => ({
            ok: /** @type {const} */ (false),
            error: { kind: /** @type {const} */ ("SearchProviderUnavailable") },
          }),
        },
        {
          descriptor: descriptor("youtube", 2),
          search: async () => ({
            ok: /** @type {const} */ (true),
            value: [candidate(
              "youtube",
              "Rhythm lesson",
              "https://www.youtube.com/watch?v=rhythm",
            )],
          }),
        },
      ],
    },
  );
  const result = await search.search({
    query: "rhythm",
    providerIds: ["web", "youtube"],
    limit: 10,
  });
  equal(result.ok, true);
  if (!result.ok) return;
  equal(result.value.items.length, 1);
  equal(result.value.providerFailures.length, 1);
  equal(result.value.providerFailures[0].providerId, "web");
  equal(
    result.value.providerFailures[0].failure.kind,
    "SearchProviderUnavailable",
  );
});

Deno.test("central search discards malformed provider batches atomically", async () => {
  const malformed = /** @type {ReturnType<typeof candidate>} */ (
    /** @type {unknown} */ (Object.freeze({
      ...candidate("web", "Malformed course", "https://broken.example/"),
      sourceLevel: "invented",
    }))
  );
  const allMalformed = createCentralDiscoverySearch(
    { maximumLimit: 20 },
    {
      budget:{timeoutMs:25000,now:Date.now,timeoutSignal:AbortSignal.timeout},
      policy: createEducationalSearchPolicy(policyConfiguration),
      providers: [{
        descriptor: descriptor("web", 1),
        search: async () => ({
          ok: /** @type {const} */ (true),
          value: [
            candidate("web", "Valid lesson", "https://valid.example/"),
            malformed,
          ],
        }),
      }],
    },
  );
  const failed = await allMalformed.search({
    query: "counterpoint",
    providerIds: ["web"],
    limit: 10,
  });
  equal(failed.ok, false);
  if (!failed.ok) equal(failed.error.kind, "CentralSearchAllProvidersFailed");

  const partial = createCentralDiscoverySearch(
    { maximumLimit: 20 },
    {
      budget:{timeoutMs:25000,now:Date.now,timeoutSignal:AbortSignal.timeout},
      policy: createEducationalSearchPolicy(policyConfiguration),
      providers: [{
        descriptor: descriptor("web", 1),
        search: async () => ({
          ok: /** @type {const} */ (true),
          value: [
            candidate("web", "Leaked lesson", "https://leaked.example/"),
            malformed,
          ],
        }),
      }, {
        descriptor: descriptor("youtube", 2),
        search: async () => ({
          ok: /** @type {const} */ (true),
          value: [candidate(
            "youtube",
            "Harmony lesson",
            "https://www.youtube.com/watch?v=harmony",
          )],
        }),
      }],
    },
  );
  const result = await partial.search({
    query: "harmony",
    providerIds: ["web", "youtube"],
    limit: 10,
  });
  equal(result.ok, true);
  if (!result.ok) return;
  equal(result.value.items.length, 1);
  equal(result.value.items[0].providerId, "youtube");
  equal(result.value.providerFailures.length, 1);
  equal(result.value.providerFailures[0].providerId, "web");
  equal(
    result.value.providerFailures[0].failure.kind,
    "SearchProviderResponseInvalid",
  );
});

Deno.test("central search validates command variants before provider work", async () => {
  let calls = 0;
  const search = createCentralDiscoverySearch(
    { maximumLimit: 20 },
    {
      budget:{timeoutMs:25000,now:Date.now,timeoutSignal:AbortSignal.timeout},
      policy: createEducationalSearchPolicy(policyConfiguration),
      providers: [{
        descriptor: descriptor("web", 1),
        search: async () => {
          calls += 1;
          return { ok: /** @type {const} */ (true), value: [] };
        },
      }, {
        descriptor: descriptor("disabled", 2, false),
        search: async () => {
          calls += 1;
          return { ok: /** @type {const} */ (true), value: [] };
        },
      }],
    },
  );
  const cases = [
    [{ query: "", providerIds: ["web"], limit: 10 }, "EducationalQueryInvalid"],
    [
      { query: "music", providerIds: [], limit: 10 },
      "CentralSearchProvidersInvalid",
    ],
    [
      { query: "music", providerIds: ["web", "web"], limit: 10 },
      "CentralSearchProvidersInvalid",
    ],
    [
      { query: "music", providerIds: ["missing"], limit: 10 },
      "CentralSearchProviderUnknown",
    ],
    [
      { query: "music", providerIds: ["disabled"], limit: 10 },
      "CentralSearchProviderDisabled",
    ],
    [
      { query: "music", providerIds: ["web"], limit: 21 },
      "CentralSearchLimitInvalid",
    ],
  ];
  for (const [command, kind] of cases) {
    const result = await search.search(command);
    equal(result.ok, false);
    if (!result.ok) equal(result.error.kind, kind);
  }
  equal(calls, 0);
});

Deno.test("central search returns a named all-provider failure", async () => {
  const search = createCentralDiscoverySearch(
    { maximumLimit: 20 },
    {
      budget:{timeoutMs:25000,now:Date.now,timeoutSignal:AbortSignal.timeout},
      policy: createEducationalSearchPolicy(policyConfiguration),
      providers: [{
        descriptor: descriptor("web", 1),
        search: async () => ({
          ok: /** @type {const} */ (false),
          error: { kind: /** @type {const} */ ("SearchProviderQuotaExceeded") },
        }),
      }],
    },
  );
  const result = await search.search({
    query: "counterpoint",
    providerIds: ["web"],
    limit: 5,
  });
  equal(result.ok, false);
  if (!result.ok) equal(result.error.kind, "CentralSearchAllProvidersFailed");
});

Deno.test("raw search preserves same URL duplicates and provider priority over completion", async () => {
  const repeated = "https://music.example/article";
  const search = createCentralDiscoverySearch({maximumLimit:20}, {policy:createEducationalSearchPolicy(policyConfiguration), budget:{timeoutMs:1000,now:Date.now,timeoutSignal:AbortSignal.timeout}, providers:[
    {descriptor:descriptor("youtube",2),search:async()=>({ok:true,value:[candidate("youtube","First completed",repeated)]})},
    {descriptor:descriptor("web",1),search:async()=>{await new Promise(resolve=>setTimeout(resolve,10));return {ok:true,value:[candidate("web","Unreviewed",repeated),{...candidate("web","Duplicate",repeated),description:null}]};}},
  ]});
  const result = await search.search({query:"music",providerIds:["youtube","web"],limit:3});
  equal(result.ok,true);if (!result.ok) throw new Error(result.error.kind);
  equal(JSON.stringify(result.value.items.map(item=>item.title)),JSON.stringify(["Unreviewed","Duplicate","First completed"]));
  equal(result.value.items[1].description,null);
  equal(Object.hasOwn(result.value,"assessments"),false);
});
