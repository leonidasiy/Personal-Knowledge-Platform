// @ts-check

import {
  executeCompanionJob,
  recoverCompanionTemporaryMedia,
} from "../companion/service.js";

/** @import { CompanionCommand, CompanionDependencies, CompanionDownloadRequest, CompanionFailure, CompanionUploadRequest } from "../companion/contracts.js" */

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const command = /** @type {CompanionCommand} */ (Object.freeze({
  jobId: "job-1",
  ownerId: "owner-a",
  source: Object.freeze({
    provenance: "rss-enclosure",
    provenanceId: "source-evidence-1",
    feedUrl: "https://publisher.test/feed.xml",
    canonicalItemUrl: "https://publisher.test/episodes/1",
    enclosureUrl: "https://cdn.publisher.test/episodes/1.mp3",
  }),
  rights: Object.freeze({
    evidenceId: "rights-evidence-1",
    transcriptionPermitted: true,
    derivedTranscriptPermitted: true,
    excerptPermitted: false,
  }),
  media: Object.freeze({
    declaredBytes: 2_000,
    declaredDurationSeconds: 120,
    declaredMediaType: "audio/mpeg",
  }),
  timeoutMs: 10_000,
}));

/**
 * @param {{
 *   readonly elapsedOnWait?: number,
 *   readonly overrides?: Partial<CompanionDependencies>,
 * }} [options]
 */
function createHarness(options = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {CompanionUploadRequest[]} */
  const uploads = [];
  let waitCount = 0;
  /** @type {CompanionDependencies["clock"]["wait"]} */
  const wait = (
    /** @type {number} */ _delayMs,
    /** @type {AbortSignal} */ signal,
  ) => {
    waitCount += 1;
    if (options.elapsedOnWait === waitCount) {
      return Promise.resolve("elapsed");
    }
    if (signal.aborted) return Promise.resolve("cancelled");
    return new Promise((resolve) => {
      signal.addEventListener(
        "abort",
        () => resolve("cancelled"),
        { once: true },
      );
    });
  };
  /** @type {CompanionDependencies["sourcePolicy"]["isYouTubeUrl"]} */
  const isYouTubeUrl = (/** @type {URL} */ url) =>
    url.hostname.endsWith("youtube.test");
  /** @type {CompanionDependencies["uploader"]["upload"]} */
  const upload = (/** @type {CompanionUploadRequest} */ request) => {
    calls.push("upload");
    uploads.push(request);
    return Promise.resolve({ ok: true, value: { uploadId: "upload-1" } });
  };
  /** @type {CompanionDependencies} */
  const dependencies = {
    limits: Object.freeze({
      maximumBytes: 5_000,
      maximumDurationSeconds: 300,
      maximumTimeoutMs: 60_000,
    }),
    clock: Object.freeze({
      now: () => 1_000,
      wait,
    }),
    sourcePolicy: Object.freeze({
      isYouTubeUrl,
    }),
    temporaryStorage: Object.freeze({
      createPrivate: () => {
        calls.push("temporary-storage");
        return Promise.resolve({ ok: true, value: { token: "private-1" } });
      },
    }),
    downloader: Object.freeze({
      download: () => {
        calls.push("download");
        return Promise.resolve({ ok: true, value: { actualBytes: 2_100 } });
      },
    }),
    signatureValidator: Object.freeze({
      validate: () => {
        calls.push("signature");
        return Promise.resolve({ ok: true, value: true });
      },
    }),
    transcriber: Object.freeze({
      transcribe: () => {
        calls.push("transcription");
        return Promise.resolve({
          ok: true,
          value: {
            transcript: "A permitted derived transcript.",
            excerpt: "A short excerpt.",
          },
        });
      },
    }),
    uploader: Object.freeze({
      upload,
    }),
    temporaryDelete: Object.freeze({
      remove: () => {
        calls.push("delete");
        return Promise.resolve({ ok: true, value: true });
      },
    }),
    ...options.overrides,
  };
  return { dependencies, calls, uploads };
}

/** @param {CompanionFailure} error @param {CompanionFailure["kind"]} kind */
function assertFailureKind(error, kind) {
  assertEquals(error.kind, kind);
}

Deno.test("companion validates unknown commands before every side effect", async () => {
  const harness = createHarness();
  const result = await executeCompanionJob(
    { ...command, media: { ...command.media, declaredBytes: "large" } },
    new AbortController().signal,
    harness.dependencies,
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertFailureKind(result.error, "CompanionCommandInvalid");
    if (result.error.kind === "CompanionCommandInvalid") {
      assertEquals(result.error.field, "media.declaredBytes");
    }
  }
  assertEquals(harness.calls.length, 0);
});

Deno.test("companion rejects YouTube provenance and every policy-identified YouTube URL", async () => {
  const provenanceHarness = createHarness();
  const provenanceResult = await executeCompanionJob(
    {
      ...command,
      source: { ...command.source, provenance: "youtube" },
    },
    new AbortController().signal,
    provenanceHarness.dependencies,
  );
  assertEquals(provenanceResult.ok, false);
  if (!provenanceResult.ok) {
    assertFailureKind(provenanceResult.error, "CompanionSourceForbidden");
  }
  assertEquals(provenanceHarness.calls.length, 0);

  const spacedHarness = createHarness();
  const spacedResult = await executeCompanionJob(
    {
      ...command,
      source: { ...command.source, provenance: " YouTube " },
    },
    new AbortController().signal,
    spacedHarness.dependencies,
  );
  assertEquals(spacedResult.ok, false);
  if (!spacedResult.ok) {
    assertFailureKind(spacedResult.error, "CompanionSourceForbidden");
  }
  assertEquals(spacedHarness.calls.length, 0);

  for (const field of ["feedUrl", "canonicalItemUrl", "enclosureUrl"]) {
    const harness = createHarness();
    const result = await executeCompanionJob(
      {
        ...command,
        source: {
          ...command.source,
          [field]: `https://media.youtube.test/${field}`,
        },
      },
      new AbortController().signal,
      harness.dependencies,
    );
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertFailureKind(result.error, "CompanionSourceForbidden");
      if (result.error.kind === "CompanionSourceForbidden") {
        assertEquals(result.error.reason, "youtube-url");
      }
    }
    assertEquals(harness.calls.length, 0);
  }
});

Deno.test("companion rejects missing transcription or derivative permission before storage", async () => {
  for (
    const [field, expected] of /** @type {const} */ ([
      ["transcriptionPermitted", "transcription"],
      ["derivedTranscriptPermitted", "derived-transcript"],
    ])
  ) {
    const harness = createHarness();
    const result = await executeCompanionJob(
      {
        ...command,
        rights: { ...command.rights, [field]: false },
      },
      new AbortController().signal,
      harness.dependencies,
    );
    assertEquals(result.ok, false);
    if (!result.ok && result.error.kind === "CompanionPermissionMissing") {
      assertEquals(result.error.permission, expected);
    }
    assertEquals(harness.calls.length, 0);
  }
});

Deno.test("companion enforces HTTPS enclosure and declared media bounds before storage", async () => {
  const cases = [
    {
      value: {
        ...command,
        source: {
          ...command.source,
          enclosureUrl: "http://cdn.publisher.test/episode.mp3",
        },
      },
      kind: /** @type {const} */ ("CompanionEnclosureUrlInvalid"),
    },
    {
      value: {
        ...command,
        media: { ...command.media, declaredBytes: 5_001 },
      },
      kind: /** @type {const} */ ("CompanionDeclaredBytesExceeded"),
    },
    {
      value: {
        ...command,
        media: { ...command.media, declaredDurationSeconds: 301 },
      },
      kind: /** @type {const} */ ("CompanionDeclaredDurationExceeded"),
    },
  ];
  for (const testCase of cases) {
    const harness = createHarness();
    const result = await executeCompanionJob(
      testCase.value,
      new AbortController().signal,
      harness.dependencies,
    );
    assertEquals(result.ok, false);
    if (!result.ok) assertFailureKind(result.error, testCase.kind);
    assertEquals(harness.calls.length, 0);
  }
});

Deno.test("successful companion job uploads only permitted derivatives and deletes media", async () => {
  const harness = createHarness();
  const result = await executeCompanionJob(
    command,
    new AbortController().signal,
    harness.dependencies,
  );
  assertEquals(result.ok, true);
  assertEquals(
    harness.calls.join(","),
    "temporary-storage,download,signature,transcription,upload,delete",
  );
  assertEquals(harness.uploads.length, 1);
  const uploaded = harness.uploads[0];
  assertEquals(uploaded.transcript, "A permitted derived transcript.");
  assertEquals(uploaded.excerpt, null);
  assertEquals("file" in uploaded, false);
  assertEquals("enclosureUrl" in uploaded, false);
});

Deno.test("signature rejection after download blocks transcription and still deletes media", async () => {
  const calls = /** @type {string[]} */ ([]);
  const harness = createHarness({
    overrides: {
      signatureValidator: {
        validate: () => {
          calls.push("signature-rejected");
          return Promise.resolve({
            ok: false,
            error: { kind: "SignatureMismatch" },
          });
        },
      },
      temporaryDelete: {
        remove: () => {
          calls.push("delete");
          return Promise.resolve({ ok: true, value: true });
        },
      },
    },
  });
  const result = await executeCompanionJob(
    command,
    new AbortController().signal,
    harness.dependencies,
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertFailureKind(result.error, "CompanionMediaSignatureRejected");
  }
  assertEquals(calls.join(","), "signature-rejected,delete");
  assertEquals(harness.calls.includes("transcription"), false);
  assertEquals(harness.calls.includes("upload"), false);
});

Deno.test("downloaded byte overflow blocks later processing and deletes media", async () => {
  const harness = createHarness({
    overrides: {
      downloader: {
        download: () =>
          Promise.resolve({ ok: true, value: { actualBytes: 5_001 } }),
      },
    },
  });
  const result = await executeCompanionJob(
    command,
    new AbortController().signal,
    harness.dependencies,
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertFailureKind(result.error, "CompanionDownloadedBytesExceeded");
  }
  assertEquals(harness.calls.join(","), "temporary-storage,delete");
});

Deno.test("cancellation after private-file creation deletes media", async () => {
  const controller = new AbortController();
  const harness = createHarness({
    overrides: {
      temporaryStorage: {
        createPrivate: () => {
          controller.abort();
          return Promise.resolve({
            ok: true,
            value: { token: "private-cancelled" },
          });
        },
      },
    },
  });
  const result = await executeCompanionJob(
    command,
    controller.signal,
    harness.dependencies,
  );
  assertEquals(result.ok, false);
  if (!result.ok) assertFailureKind(result.error, "CompanionCancelled");
  assertEquals(harness.calls.join(","), "delete");
});

Deno.test("timeout during download deletes media", async () => {
  const harness = createHarness({
    elapsedOnWait: 2,
    overrides: {
      downloader: {
        download: (
          /** @type {CompanionDownloadRequest} */ request,
        ) =>
          new Promise((resolve) => {
            request.signal.addEventListener(
              "abort",
              () =>
                resolve({
                  ok: false,
                  error: { kind: "DownloadUnavailable" },
                }),
              { once: true },
            );
          }),
      },
    },
  });
  const result = await executeCompanionJob(
    command,
    new AbortController().signal,
    harness.dependencies,
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertFailureKind(result.error, "CompanionTimedOut");
    if (result.error.kind === "CompanionTimedOut") {
      assertEquals(result.error.stage, "download");
    }
  }
  assertEquals(harness.calls.join(","), "temporary-storage,delete");
});

Deno.test("transcription and upload failures each delete temporary media", async () => {
  const stages = /** @type {const} */ (["transcription", "upload"]);
  for (const stage of stages) {
    const harness = createHarness({
      overrides: stage === "transcription"
        ? {
          transcriber: {
            transcribe: () =>
              Promise.resolve({
                ok: false,
                error: { kind: "TranscriptionUnavailable" },
              }),
          },
        }
        : {
          uploader: {
            upload: () =>
              Promise.resolve({
                ok: false,
                error: { kind: "UploadUnavailable" },
              }),
          },
        },
    });
    const result = await executeCompanionJob(
      command,
      new AbortController().signal,
      harness.dependencies,
    );
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertFailureKind(
        result.error,
        stage === "transcription"
          ? "CompanionTranscriptionFailed"
          : "CompanionUploadFailed",
      );
    }
    assertEquals(harness.calls.at(-1), "delete");
  }
});

Deno.test("deletion failure blocks success and exposes the preceding failure", async () => {
  for (const uploadFails of [false, true]) {
    const harness = createHarness({
      overrides: {
        uploader: uploadFails
          ? {
            upload: () =>
              Promise.resolve({
                ok: false,
                error: { kind: "UploadRejected" },
              }),
          }
          : {
            upload: () =>
              Promise.resolve({
                ok: true,
                value: { uploadId: "upload-1" },
              }),
          },
        temporaryDelete: {
          remove: () =>
            Promise.resolve({
              ok: false,
              error: { kind: "TemporaryDeletionUnavailable" },
            }),
        },
      },
    });
    const result = await executeCompanionJob(
      command,
      new AbortController().signal,
      harness.dependencies,
    );
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertFailureKind(result.error, "TemporaryMediaDeletionFailed");
      if (result.error.kind === "TemporaryMediaDeletionFailed") {
        assertEquals(
          result.error.precedingFailureKind,
          uploadFails ? "CompanionUploadFailed" : null,
        );
      }
    }
  }
});

Deno.test("restart recovery deletes only the bounded private job-temp snapshot before work resumes", async () => {
  const files = Object.freeze([
    Object.freeze({ token: "private-job-1" }),
    Object.freeze({ token: "private-job-2" }),
  ]);
  /** @type {string[]} */
  const deleted = [];
  const recovered = await recoverCompanionTemporaryMedia(
    { maximumRecords: 4 },
    {
      privateJobTemporaryStorage: {
        listPrivateJobFiles: () => Promise.resolve({ ok: true, value: files }),
      },
      temporaryDelete: {
        remove: (file) => {
          deleted.push(file.token);
          return Promise.resolve({ ok: true, value: true });
        },
      },
    },
  );
  assertEquals(recovered.ok, true);
  if (recovered.ok) assertEquals(recovered.value.deletedCount, 2);
  assertEquals(deleted.join(","), "private-job-1,private-job-2");
});

Deno.test("restart recovery validates and bounds its complete snapshot before deletion", async () => {
  for (const files of [
    [{ token: "private-1" }, { token: "private-2" }],
    [{ token: "private-1", path: "/unscoped" }],
    [{ token: "duplicate" }, { token: "duplicate" }],
  ]) {
    let deletions = 0;
    const recovered = await recoverCompanionTemporaryMedia(
      { maximumRecords: 1 },
      {
        privateJobTemporaryStorage: {
          listPrivateJobFiles: () => Promise.resolve({ ok: true, value: files }),
        },
        temporaryDelete: {
          remove: () => {
            deletions += 1;
            return Promise.resolve({ ok: true, value: true });
          },
        },
      },
    );
    assertEquals(recovered.ok, false);
    if (!recovered.ok) {
      assert(
        recovered.error.kind === "CompanionRecoveryLimitExceeded" ||
          recovered.error.kind === "CompanionTemporaryStorageFailed",
        "Recovery must report a typed snapshot failure.",
      );
    }
    assertEquals(deletions, 0);
  }
});

Deno.test("restart recovery attempts the full snapshot and blocks on listing or deletion failure", async () => {
  const unavailable = await recoverCompanionTemporaryMedia(
    { maximumRecords: 2 },
    {
      privateJobTemporaryStorage: {
        listPrivateJobFiles: () => Promise.resolve({ ok: false, error: { kind: "TemporaryStorageUnavailable" } }),
      },
      temporaryDelete: { remove: () => Promise.resolve({ ok: true, value: true }) },
    },
  );
  assertEquals(unavailable.ok, false);
  if (!unavailable.ok) assertFailureKind(unavailable.error, "CompanionTemporaryStorageFailed");

  /** @type {string[]} */
  const attempted = [];
  const failed = await recoverCompanionTemporaryMedia(
    { maximumRecords: 2 },
    {
      privateJobTemporaryStorage: {
        listPrivateJobFiles: () => Promise.resolve({
          ok: true,
          value: [{ token: "private-fails" }, { token: "private-succeeds" }],
        }),
      },
      temporaryDelete: {
        remove: (file) => {
          attempted.push(file.token);
          return Promise.resolve(file.token === "private-fails"
            ? { ok: false, error: { kind: "TemporaryDeletionUnavailable" } }
            : { ok: true, value: true });
        },
      },
    },
  );
  assertEquals(failed.ok, false);
  if (!failed.ok) {
    assertFailureKind(failed.error, "TemporaryMediaDeletionFailed");
    if (failed.error.kind === "TemporaryMediaDeletionFailed") {
      assertEquals(failed.error.precedingFailureKind, "restart-recovery");
    }
  }
  assertEquals(attempted.join(","), "private-fails,private-succeeds");
});
