// @ts-check
import {
  createDiscoverySourceAssessor,
  SOURCE_QUALITY_PROMPT,
} from "../worker/discovery-source-assessment.js";
import { createCentralDiscoverySearch } from "../worker/discovery-search.js";
import { createEducationalSearchPolicy } from "../worker/educational-search-policy.js";
/** @param {unknown} a @param {unknown} b */
function equal(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
const configuration = {
  maximumCandidates: 60,
  maximumInputCharacters: 90_000,
  timeoutMs: 15_000,
  maxOutputTokens: 12_000,
};
/** @param {number} index */
function candidate(index) {
  return {
    providerId: "web",
    resultKind: "web",
    sourceLevel: /** @type {const} */ ("document"),
    title: [
      "Forum tutorial",
      "Short post",
      "Harmonic motion",
      "Official irrelevant course",
      "Teacher worksheets",
      "Thin promotion",
    ][index] ?? "Uncertain source",
    description: "Provider supplied description",
    canonicalUrl: `https://material.example/article/${index}`,
    publisherLabel: null,
    publishedAt: null,
    identityEvidence: [{
      attribute: "provider-result-description",
      value: "Explains harmonic motion with worked musical examples",
      provenanceUrl: `https://material.example/article/${index}`,
    }],
  };
}
/** @param {number} index */
function assessment(index) {
  return {
    candidateId: `c${index}`,
    qualityScope: "provider-summary",
    relevance: "relevant",
    substance: "explanatory",
    provenance: "evidenced",
    selection: "eligible",
    reason: "Supplied evidence supports an explanation of this topic",
    evidenceRefs: [`c${index}:e0`],
  };
}
/** @param {Record<string,unknown>} output */
function assessor(output) {
  return createDiscoverySourceAssessor(configuration, {
    model: {
      generate: async () => ({
        ok: true,
        value: {
          output,
          requestId: "synthetic",
          inputTokens: null,
          outputTokens: null,
          reasoningTrace: null,
        },
      }),
    },
    logger: () => {},
  });
}
Deno.test("source assessment excludes forums short posts teacher-only and promotions; accepts explanations without markers", async () => {
  const assessments = [
    assessment(0),
    assessment(1),
    assessment(2),
    assessment(3),
    assessment(4),
    assessment(5),
  ];
  Object.assign(assessments[0], { substance: "forum", selection: "rejected" });
  Object.assign(assessments[1], {
    substance: "short-post",
    selection: "rejected",
  });
  Object.assign(assessments[3], {
    relevance: "irrelevant",
    provenance: "unknown",
    selection: "rejected",
  });
  Object.assign(assessments[4], {
    substance: "teacher-only",
    selection: "rejected",
  });
  Object.assign(assessments[5], {
    substance: "promotion",
    selection: "rejected",
  });
  const result = await assessor({ assessments, rankedIds: ["c2"] }).assess(
    "harmony",
    Array.from({ length: 6 }, (_, i) => candidate(i)),
  );
  equal(result.ok, true);
  if (result.ok) {
    equal(result.value.rankedIds, ["c2"]);
    equal(result.value.assessments.length, 6);
  }
  for (
    const requirement of [
      "untrusted",
      "forums",
      "short posts",
      "teacher",
      "promotions",
      "official",
      "unseen",
      "word-count",
      "domain",
      "withhold",
    ]
  ) equal(SOURCE_QUALITY_PROMPT.includes(requirement), true);
});
for (const provenance of ["missing", "unknown", "conflicting", "ambiguous"]) {
  Deno.test(`source assessment withholds ${provenance} provenance with diagnostics`, async () => {
    const entry = {
      ...assessment(0),
      provenance,
      selection: "withheld",
      reason: "Insufficient or inconsistent supplied evidence",
    };
    const result = await assessor({ assessments: [entry], rankedIds: [] })
      .assess("harmony", [candidate(0)]);
    equal(result.ok, true);
    if (result.ok) {
      equal(result.value.rankedIds, []);
      equal(result.value.assessments[0].reason, entry.reason);
    }
  });
}
for (
  const [name, output] of Object.entries({
    malformed: { assessments: "invalid", rankedIds: [] },
    arrayRelevance: {
      assessments: [{ ...assessment(0), relevance: ["relevant"] }],
      rankedIds: ["c0"],
    },
    arraySubstance: {
      assessments: [{ ...assessment(0), substance: ["explanatory"] }],
      rankedIds: ["c0"],
    },
    arrayProvenance: {
      assessments: [{ ...assessment(0), provenance: ["evidenced"] }],
      rankedIds: ["c0"],
    },
    duplicate: {
      assessments: [assessment(0), assessment(0)],
      rankedIds: ["c0"],
    },
    unknown: {
      assessments: [{ ...assessment(0), candidateId: "unknown" }],
      rankedIds: ["c0"],
    },
    inventedEvidence: {
      assessments: [{
        ...assessment(0),
        evidenceRefs: ["https://invented.example/"],
      }],
      rankedIds: ["c0"],
    },
    foreignEvidence: {
      assessments: [
        { ...assessment(0), evidenceRefs: ["c1:e0"] },
        assessment(1),
      ],
      rankedIds: ["c0", "c1"],
    },
    missing: { assessments: [], rankedIds: [] },
    extraField: {
      assessments: [{ ...assessment(0), authority: true }],
      rankedIds: ["c0"],
    },
    uncertainEligible: {
      assessments: [{ ...assessment(0), relevance: "uncertain" }],
      rankedIds: ["c0"],
    },
    conflictingEligible: {
      assessments: [{ ...assessment(0), provenance: "conflicting" }],
      rankedIds: ["c0"],
    },
    forumEligible: {
      assessments: [{ ...assessment(0), substance: "forum" }],
      rankedIds: ["c0"],
    },
    missingRank: { assessments: [assessment(0)], rankedIds: [] },
    duplicateRank: { assessments: [assessment(0)], rankedIds: ["c0", "c0"] },
    unknownRank: { assessments: [assessment(0)], rankedIds: ["c99"] },
    noEvidence: {
      assessments: [{ ...assessment(0), evidenceRefs: [] }],
      rankedIds: ["c0"],
    },
  })
) {
  Deno.test(`source assessment rejects ${name} model output atomically`, async () => {
    const result = await assessor(output).assess(
      "harmony",
      name === "foreignEvidence"
        ? [candidate(0), candidate(1)]
        : [candidate(0)],
    );
    equal(result.ok, false);
    if (!result.ok) equal(result.error.kind, "SourceAssessmentResponseInvalid");
  });
}
for (
  const kind of [
    "KnowledgeModelTimeout",
    "KnowledgeModelUnavailable",
    "KnowledgeModelCredentialMissing",
    "KnowledgeModelResponseInvalid",
  ]
) {
  Deno.test(`source assessment preserves ${kind} without fallback`, async () => {
    const service = createDiscoverySourceAssessor(configuration, {
      model: {
        generate: async () => ({
          ok: false,
          error: { kind: /** @type {'KnowledgeModelTimeout'} */ (kind) },
        }),
      },
      logger: () => {},
    });
    const result = await service.assess("harmony", [candidate(0)]);
    equal(result.ok, false);
    if (!result.ok) {
      equal(result.error.kind, "SourceAssessmentModelFailed");
      if (result.error.kind === "SourceAssessmentModelFailed") {
        equal(result.error.failure.kind, kind);
      }
    }
  });
}
// The standalone legacy assessor contract remains checked, but raw Discover
// never invokes it. Central ranking/withholding expectations are superseded.
Deno.test("raw central search retains all provider claims in order before the display limit", async () => {
  const items = [candidate(0), {...candidate(0), description:"Conflicting provider claim"}, candidate(2)];
  const search = createCentralDiscoverySearch({maximumLimit:20}, {
    budget:{timeoutMs:25000,now:Date.now,timeoutSignal:AbortSignal.timeout},
    policy:createEducationalSearchPolicy({version:"raw-v1",maximumSubmittedCharacters:120,maximumProviderCharacters:120}),
    providers:[{descriptor:{id:"web",label:"Web",resultKind:"web",priority:1,enabled:true},search:async(command)=>({ok:true,value:items.slice(0,command.limit)})}],
  });
  const result = await search.search({query:"harmony",providerIds:["web"],limit:2});
  equal(result.ok,true);
  if(result.ok) { equal(result.value.items,items.slice(0,2)); equal(Object.keys(result.value).sort(),["items","policyVersion","providerFailures","providerQuery","submittedQuery"]); }
});
Deno.test("assessment validates input bounds and empty pool skips model", async () => {
  let calls = 0;
  const service = createDiscoverySourceAssessor(configuration, {
    model: {
      generate: async () => {
        calls++;
        return {
          ok: true,
          value: {
            output: {},
            requestId: "stub",
            inputTokens: null,
            outputTokens: null,
            reasoningTrace: null,
          },
        };
      },
    },
    logger: () => {},
  });
  for (
    const [query, items] of [["", [candidate(0)]], [
      "harmony",
      Array.from({ length: 61 }, () => candidate(0)),
    ], ["harmony", [{ ...candidate(0), description: "x".repeat(90_001) }]]]
  ) {
    const result = await service.assess(query, items);
    equal(result.ok, false);
  }
  const empty = await service.assess("harmony", []);
  equal(empty.ok, true);
  equal(calls, 0);
});
