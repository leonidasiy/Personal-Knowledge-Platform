# Milestone 3F Browser Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair Discovery's browser-session result lifecycle and add a secure, repeatable Chrome acceptance gate for the authenticated hosted product.

**Architecture:** Keep live central-search state inside the existing composition-owned Discovery controller, resolve detail routes against that live collection, and prevent stale asynchronous completions from replacing a newer search. Add an external Playwright runner that uses installed Chrome and Cloudflare Access service-token headers, records only redacted operational evidence, and performs one reversible podcast Library mutation. Expose the deployed Worker version through a validated response header so every acceptance report identifies the tested release.

**Tech Stack:** Deno 2, JavaScript with strict JSDoc checking, `playwright-core` 1.61.1, installed stable Google Chrome, Cloudflare Workers, Cloudflare Access, D1, the existing Deno test runner, and the existing pinned esbuild/Terser production build.

## Global Constraints

- Use pinned `playwright-core` 1.61.1 with `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; do not download a browser or use a personal Chrome profile.
- Authenticate through one 90-day Cloudflare Access service token covered by an exact-token Service Auth policy.
- Keep `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` only in ignored `.env.browser-acceptance`; never print, log, bundle, or persist their values.
- Capture no query text, raw response body, token, credential, private note, or personal browser data in logs, exceptions, filenames, or screenshots.
- Keep redacted evidence under ignored `logs/` and `test-results/` and delete artifacts older than 30 days.
- Permit only one generated, reversible podcast Library mutation during hosted release acceptance; preserve unrelated sources and all completed study/review history.
- Keep the deployed Taddy candidate online, but perform no further production mutation until local validation and independent review pass.
- Preserve aggregate browser budgets of `182,000` raw / `58,000` gzip JavaScript and `24,000` raw CSS.
- Preserve Taddy metadata-only handling, YouTube manual-transcript-only handling, Library D1-only search, Access authentication, source suppression, and provider quotas.
- Validate every public entry point and return a typed named failure for every expected failure mode; do not introduce silent fallbacks or generic catches.
- Keep each active editing unit to five files or fewer and do not create a shared abstraction before three real uses.
- Do not make per-task commits. The project permits one milestone commit only after approved validation; use review checkpoints between tasks.

---

### Task 1: Reproduce And Repair Discovery Session State

**Files:**
- Modify: `tests/discovery-page.test.js`
- Modify: `src/startup/discovery-page.js:96-354`

**Interfaces:**
- Consumes: `createDiscoveryPage(dependencies)` and its existing `load()`, `render(route)`, and `search(command)` methods.
- Produces: live-session selection resolution and a controller-local `{ ok: false, error: { kind: "DiscoverySearchSuperseded" } }` result when an older request completes after a newer search.
- Invariant: a route-only `load()` may refresh capabilities and Library availability, but must not reset a submitted query, selected provider IDs, result limit, live items, or current search failure.

- [x] **Step 1: Add the exact-result regression test**

  Extend the existing centralized-search fixture to capture the searched ID and assert the current result renders on its detail route:

  ```js
  const searchedHtml = page.render({ selectedItemId: null, online: true });
  const searchedId = searchedHtml.match(
    /data-discovery-item-id="([^"]+)"[^>]*>[\s\S]*?Counterpoint course library/,
  )?.[1] ?? null;
  assert(searchedId !== null, "The searched result must expose a stable route ID.");

  const detail = page.render({ selectedItemId: searchedId, online: true });
  assert(
    detail.includes("Counterpoint course library") &&
      !detail.includes("Item unavailable"),
    "A live central result must resolve before persisted starter data.",
  );
  ```

- [x] **Step 2: Add route-preservation and replacement regression tests**

  After the first search, call `await page.load()`, render list/detail/list, and assert the same query, selected providers, limit, and result remain without incrementing the central-search request count. Then return a second result batch for a changed query/filter command and assert the first title is absent and the second title is present.

  ```js
  const requestsAfterSearch = centralSearchRequests;
  await page.load();
  const restored = page.render({ selectedItemId: null, online: true });
  assertEquals(centralSearchRequests, requestsAfterSearch);
  assert(restored.includes('value="counterpoint"'));
  assert(restored.includes('value="10" selected'));
  assert(restored.includes("Counterpoint course library"));

  const replaced = await page.search({
    query: "orchestration",
    providerIds: ["web"],
    limit: 5,
  });
  assert(replaced.ok, "The replacement search must succeed.");
  const replacementHtml = page.render({ selectedItemId: null, online: true });
  assert(!replacementHtml.includes("Counterpoint course library"));
  assert(replacementHtml.includes("Orchestration lesson archive"));
  ```

- [x] **Step 3: Add the stale-completion race test**

  Use two controlled promises. Start search A, start search B, resolve B first, then resolve A. Assert B remains rendered and A returns the named superseded variant without changing loading or failure state.

  ```js
  const first = page.search({ query: "first", providerIds: ["web"], limit: 5 });
  const second = page.search({ query: "second", providerIds: ["web"], limit: 5 });
  resolveSecond(searchResult("Second result"));
  assert((await second).ok);
  resolveFirst(searchResult("First result"));
  const stale = await first;
  assert(!stale.ok && stale.error.kind === "DiscoverySearchSuperseded");
  const html = page.render({ selectedItemId: null, online: true });
  assert(html.includes("Second result") && !html.includes("First result"));
  ```

- [x] **Step 4: Run the focused test and preserve the failure evidence**

  Run: `deno test --allow-read --allow-write tests/discovery-page.test.js`

  Expected before implementation: FAIL because a central result detail renders `Item unavailable`, `load()` resets filters, and the late request can overwrite the newer result.

- [x] **Step 5: Implement live-first route resolution**

  In `render(route)`, obtain the persisted runtime projection with `selectedItemId: null`, derive `visibleItems = centralRouteItems ?? projectedItems`, and resolve `route.selectedItemId` against `visibleItems`. Pass the selected ID to `renderDiscoverRoute` only after the live list has been populated. Keep the existing explicit missing-detail path when the ID is absent from both live and persisted items.

  ```js
  const projected = runtime.renderModel({
    name: "discover",
    cursor: null,
    selectedItemId: null,
    online: route.online,
  });
  if (projected.ok) {
    const projectedModel = toDiscoverRouteModel(
      projected.value,
      dependencies.escapeHtml,
    );
    const visibleItems = centralRouteItems ?? [...projectedModel.items];
    const items = visibleItems.filter((item) =>
      !suppressed.has(item.candidate.canonicalIdentity)
    );
    return renderDiscoverRoute(freeze({
      ...projectedModel,
      page: route.selectedItemId === null ? "list" : "detail",
      selectedItemId: route.selectedItemId,
      items: freeze(items),
      state: searchFailure === null
        ? items.length === 0 ? "empty" : "success"
        : "partial",
      stateMessage: searchFailure,
      areas: freeze(interestAreas.map((area) =>
        freeze({ id: area.id, title: area.title })
      )),
      pendingId: pendingDecisionItemId,
      canAct: sourceActionsAvailable && route.online,
      search: searchModel(route.online),
      markup: dependencies.markup,
    }));
  }
  ```

- [x] **Step 6: Make load initialization idempotent**

  Add `let searchInitialized = false`. On the first successful capability load, select enabled providers and clear capability failure; on later route loads, refresh capability metadata without replacing user-owned query/filter/result state. Set `searchInitialized = true` when a valid command is accepted.

  ```js
  if (capabilities.ok) {
    searchCapabilities = [...capabilities.value];
    if (!searchInitialized) {
      selectedProviderIds = searchCapabilities
        .filter((provider) => provider.enabled)
        .map((provider) => provider.id);
    }
  } else if (!searchInitialized) {
    searchFailure = friendlyDiscoveryFailure(
      capabilities.error,
      dependencies.markup,
    );
  }
  ```

- [x] **Step 7: Reject stale asynchronous completions**

  Add a monotonic generation. Only the latest generation may clear `searchPending`, update `centralRouteItems`, update `searchFailure`, synchronize identities, or rerender.

  ```js
  let searchGeneration = 0;

  async function search(command) {
    const generation = ++searchGeneration;
    // Existing public command validation and YouTube policy gate remain first.
    searchPending = true;
    dependencies.rerender();
    const result = await centralGateway.search(command);
    if (generation !== searchGeneration) {
      return {
        ok: false,
        error: { kind: /** @type {const} */ ("DiscoverySearchSuperseded") },
      };
    }
    searchPending = false;
    if (!result.ok) {
      searchFailure = friendlyDiscoveryFailure(
        result.error,
        dependencies.markup,
      );
      dependencies.onError(searchFailure);
      dependencies.rerender();
      return result;
    }
    searchQuery = result.value.submittedQuery;
    centralRouteItems = result.value.items.map((item) =>
      centralRouteItem(item, result.value.policyVersion)
    );
    searchFailure = result.value.providerFailures.length === 0
      ? null
      : "Some selected source types could not be searched. Available results are shown.";
  }
  ```

- [x] **Step 8: Run focused and adjacent Discovery tests**

  Run: `deno test --allow-read --allow-write tests/discovery-page.test.js tests/discovery-route.test.js tests/discovery-gateway.test.js`

  Expected: PASS with no starter replacement, no unknown-ID substitution, and no extra provider request during route navigation.

- [x] **Step 9: Review checkpoint**

  Confirm the diff changes only controller lifecycle behavior and focused tests. Record the root cause in the Milestone 3F section of `documentations/RECENT_CHANGES.md` only at the final documentation task, not here.

---

### Task 2: Expose Validated Worker Version Evidence

**Files:**
- Create: `worker/version-metadata.js`
- Create: `worker/versioned-router.js`
- Create: `tests/worker-version-metadata.test.js`
- Modify: `worker/cloudflare-entry.mjs:1-42`
- Modify: `wrangler.jsonc:1-20`

**Interfaces:**
- Produces: `attachWorkerVersion(response: Response, metadata: unknown): Result<Response, WorkerVersionMetadataInvalid>`.
- Produces: `routeWithWorkerVersion(routed, request, metadata): Promise<Response>`, a deployment-neutral composition helper covering successful static/API routing and router-construction failures.
- Failure: `{ kind: "WorkerVersionMetadataInvalid", field: "id" }` for absent, non-object, empty, or non-string IDs.
- Output header: `x-resonance-worker-version: <Cloudflare version UUID>` on every API and static response.

- [x] **Step 1: Write pure metadata validation tests**

  ```js
  Deno.test("Worker version metadata is required and attached", () => {
    const attached = attachWorkerVersion(
      new Response("ok", { status: 200 }),
      { id: "version-a" },
    );
    assert(attached.ok);
    if (attached.ok) {
      assertEquals(
        attached.value.headers.get("x-resonance-worker-version"),
        "version-a",
      );
      assertEquals(attached.value.status, 200);
    }
    for (const metadata of [undefined, null, {}, { id: "" }, { id: 1 }]) {
      const rejected = attachWorkerVersion(new Response("ok"), metadata);
      assert(!rejected.ok);
      if (!rejected.ok) {
        assertEquals(rejected.error.kind, "WorkerVersionMetadataInvalid");
        assertEquals(rejected.error.field, "id");
      }
    }
  });
  ```

- [x] **Step 2: Run the new test and verify the red state**

  Run: `deno test --allow-read tests/worker-version-metadata.test.js`

  Expected: FAIL because `worker/version-metadata.js` does not exist.

- [x] **Step 3: Implement the pure response decorator**

  Validate metadata, clone headers, set the version header, and construct a new `Response` preserving body, status, and status text. Do not log or include environment data beyond the validated version ID.

  ```js
  export function attachWorkerVersion(response, metadata) {
    if (
      typeof metadata !== "object" || metadata === null ||
      typeof metadata.id !== "string" || metadata.id.trim() === ""
    ) {
      return {
        ok: false,
        error: { kind: "WorkerVersionMetadataInvalid", field: "id" },
      };
    }
    const headers = new Headers(response.headers);
    headers.set("x-resonance-worker-version", metadata.id);
    return {
      ok: true,
      value: new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
    };
  }
  ```

- [x] **Step 4: Test successful and failed router composition**

  In the same test file, inject a routed success whose `fetch` returns a static response and an API response, plus a routed failure. Assert all three responses carry the same version header and the routed failure remains a typed 503 JSON response with `cache-control: no-store`.

  ```js
  const routed = {
    ok: true,
    value: { fetch: async () => new Response("asset", { status: 200 }) },
  };
  const response = await routeWithWorkerVersion(
    routed,
    new Request("https://app.example/"),
    { id: "version-a" },
  );
  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("x-resonance-worker-version"),
    "version-a",
  );

  const failed = await routeWithWorkerVersion(
    { ok: false, error: { kind: "WorkerConfigurationInvalid", field: "ASSETS" } },
    new Request("https://app.example/"),
    { id: "version-a" },
  );
  assertEquals(failed.status, 503);
  assertEquals(failed.headers.get("cache-control"), "no-store");
  assertEquals(failed.headers.get("x-resonance-worker-version"), "version-a");
  ```

- [x] **Step 5: Implement the deployment-neutral composition helper**

  In `worker/versioned-router.js`, accept the existing router Result rather than importing Puppeteer or constructing the Worker. For a successful router, await `routed.value.fetch(request)`; for a router failure, build the existing typed 503 response. Pass either response through `attachWorkerVersion`. If metadata is invalid, return a typed 503 `WorkerVersionMetadataInvalid` response with `cache-control: no-store`.

  ```js
  export async function routeWithWorkerVersion(routed, request, metadata) {
    const response = routed.ok
      ? await routed.value.fetch(request)
      : Response.json(
        { error: routed.error.kind, field: routed.error.field },
        {
          status: 503,
          headers: { "cache-control": "no-store" },
        },
      );
    const attached = attachWorkerVersion(response, metadata);
    return attached.ok
      ? attached.value
      : Response.json(
        { error: attached.error.kind, field: attached.error.field },
        {
          status: 503,
          headers: { "cache-control": "no-store" },
        },
      );
  }
  ```

- [x] **Step 6: Bind and compose version metadata at the Worker boundary**

  Add to `wrangler.jsonc`:

  ```json
  "version_metadata": {
    "binding": "CF_VERSION_METADATA"
  },
  ```

  In `worker/cloudflare-entry.mjs`, construct the router exactly as today and return `routeWithWorkerVersion(routed, request, environment.CF_VERSION_METADATA)`. The entry remains the only module importing deployment-only `@cloudflare/puppeteer`; the tested helper has no deployment-only import.

- [x] **Step 7: Run focused Worker tests and strict checking**

  Run: `deno test --allow-read tests/worker-version-metadata.test.js tests/worker-static-router.test.js && deno task check`

  Expected: PASS, and strict checking accepts the environment metadata boundary without `any`.

- [x] **Step 8: Review checkpoint**

  Confirm the header contains only the Cloudflare version ID, all existing status/body/cache headers are preserved, and no secret or Access claim is exposed.

---

### Task 3: Define The Redacted Browser Harness Contract

**Files:**
- Create: `scripts/browser-acceptance-core.mjs`
- Create: `tests/browser-acceptance.test.js`

**Interfaces:**
- Produces: `validateBrowserAcceptanceConfig(environment, overrides): Result<BrowserAcceptanceConfig, BrowserAcceptanceFailure>`.
- Produces: `runBrowserAcceptance(config, dependencies): Promise<Result<BrowserAcceptanceReport, BrowserAcceptanceFailure>>`.
- Produces: `redactEvidence(event): Result<RedactedEvidence, BrowserAcceptanceRedactionFailed>` and `removeExpiredArtifacts(fileSystem, roots, now, retentionDays)`.
- Injected dependencies: `{ launch, fileSystem, now, log, createId }`; no business module or Worker feature import is permitted.

The named failure union is:

```js
/** @typedef {
 * | { readonly kind: "BrowserAcceptanceConfigInvalid", readonly field: string }
 * | { readonly kind: "BrowserAcceptanceAccessClientIdMissing" }
 * | { readonly kind: "BrowserAcceptanceAccessClientSecretMissing" }
 * | { readonly kind: "BrowserAcceptanceChromeLaunchFailed" }
 * | { readonly kind: "BrowserAcceptanceNetworkUnavailable" }
 * | { readonly kind: "BrowserAcceptanceAccessRejected", readonly status: number }
 * | { readonly kind: "BrowserAcceptanceAccessRedirected" }
 * | { readonly kind: "BrowserAcceptanceNavigationTimedOut", readonly route: string }
 * | { readonly kind: "BrowserAcceptanceConsoleError", readonly category: string }
 * | { readonly kind: "BrowserAcceptanceSameOriginResponseFailed", readonly category: string, readonly status: number }
 * | { readonly kind: "BrowserAcceptanceAssertionFailed", readonly assertion: string }
 * | { readonly kind: "BrowserAcceptanceWorkerVersionUnavailable" }
 * | { readonly kind: "BrowserAcceptanceArtifactWriteFailed", readonly artifact: string }
 * | { readonly kind: "BrowserAcceptanceArtifactCleanupFailed", readonly artifact: string }
 * | { readonly kind: "BrowserAcceptanceRedactionFailed", readonly artifact: string }
 * | { readonly kind: "BrowserAcceptanceCleanupFailed", readonly resource: string }
 * } BrowserAcceptanceFailure */
```

- [x] **Step 1: Write configuration boundary tests**

  Cover a valid HTTPS workers.dev URL, exact Chrome executable, positive bounded timeouts, two artifact roots, and the complete Access pair. Assert distinct failures for missing ID, missing secret, HTTP/non-URL target, missing Chrome path, out-of-range timeout, and a result directory outside project-controlled roots.

- [x] **Step 2: Write redaction and retention tests**

  Feed the sanitizer an event containing URL query text, response body, cookie, `CF-Access-Client-Id`, `CF-Access-Client-Secret`, and an Authorization value. Assert the result contains only route category, status, duration, failure kind, viewport, and Worker version. Assert a suspected secret causes `BrowserAcceptanceRedactionFailed` instead of partial output. With an injected clock, delete artifacts older than 30 days and preserve newer artifacts.

- [x] **Step 3: Write lifecycle failure tests with injected fakes**

  Use fake browser/context/page objects to exercise launch failure, network failure, Access redirect/rejection, timeout, console error category, same-origin module/API non-success status, missing Worker version, assertion failure, artifact write failure, and browser/context cleanup failure. Assert each public result is one exact named variant and the original exception text is absent.

- [x] **Step 4: Run the contract tests and verify the red state**

  Run: `deno test --allow-read --allow-write tests/browser-acceptance.test.js`

  Expected: FAIL because the core module does not exist.

- [x] **Step 5: Implement config validation and result constructors**

  Parse environment at the composition boundary, require HTTPS and the exact approved host, reject credentials with leading/trailing whitespace, normalize only artifact paths, and freeze successful config/report objects. Do not read `Deno.env` inside `runBrowserAcceptance`.

- [x] **Step 6: Implement redaction, evidence writes, and retention**

  Accept only an allowlist of evidence fields. Categorize URLs as `document`, `module`, `asset`, or `api` without retaining paths or query strings. Use generated run IDs in filenames, never user input. Write JSON Lines to `logs/browser-acceptance-<run-id>.log` and screenshots to `test-results/browser-acceptance/<run-id>/`. Delete expired files before launch; make cleanup failure blocking.

- [x] **Step 7: Implement deterministic lifecycle orchestration**

  Ensure launch, context, page, and cleanup are individually guarded and mapped to named failures. Pass only the two Access headers as `extraHTTPHeaders`, use a fresh context with no `userDataDir`, and prohibit trace, HAR, video, raw console text, and response-body capture.

- [x] **Step 8: Run contract tests and strict checking**

  Run: `deno test --allow-read --allow-write tests/browser-acceptance.test.js && deno task check`

  Expected: PASS with no credential value appearing in captured output or temporary artifacts.

- [x] **Step 9: Review checkpoint**

  Search: `rg -n "CF_ACCESS_CLIENT|authorization|cookie|responseBody|query" scripts/browser-acceptance-core.mjs tests/browser-acceptance.test.js`

  Expected: credential names appear only at validation/header construction boundaries; there is no value logging, raw payload capture, or query retention.

---

### Task 4: Pin Playwright And Keep It Out Of The Browser Graph

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `deno.json`
- Modify: `tests/build.test.js`
- Create: `scripts/browser-acceptance.mjs`

**Interfaces:**
- Consumes: `runBrowserAcceptance` and `validateBrowserAcceptanceConfig` from Task 3.
- Produces: `deno task browser:acceptance` and a Node composition root that injects `playwright-core` Chromium, the installed Chrome path, filesystem, clock, and a redacted log sink.

- [x] **Step 1: Add the dependency-isolation test**

  Extend `tests/build.test.js` to assert:

  ```js
  assertEquals(packageDocument.devDependencies?.["playwright-core"], "1.61.1");
  for (const sourcePath of ["src/app.js", "service-worker.js"]) {
    const source = await Deno.readTextFile(sourcePath);
    assertEquals(source.includes("playwright-core"), false);
  }
  const manifest = await Deno.readTextFile("dist/asset-manifest.json");
  assertEquals(manifest.includes("playwright"), false);
  ```

  Also assert the Deno task is exactly:

  ```text
  node --env-file=.env.browser-acceptance scripts/browser-acceptance.mjs
  ```

- [x] **Step 2: Run the build test and verify the red state**

  Run: `deno test --allow-read tests/build.test.js`

  Expected: FAIL because `playwright-core` and the acceptance task are absent.

- [x] **Step 3: Install the exact development dependency**

  Run: `npm install --save-dev --save-exact playwright-core@1.61.1`

  Expected: `package.json` and `package-lock.json` record exactly `1.61.1`; no browser download runs because this is `playwright-core`.

- [x] **Step 4: Add the acceptance task and composition root**

  Add the exact task to `deno.json`. In `scripts/browser-acceptance.mjs`, read environment once, validate before launch, import `chromium` from `playwright-core`, inject `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, and set `process.exitCode = 1` for any named failure while printing only the failure kind and non-sensitive field/category.

- [x] **Step 5: Build and prove browser-graph isolation**

  Run: `deno task build && deno test --allow-read tests/build.test.js`

  Expected: PASS; the asset manifest and all `dist/src/**/*.js` files contain no `playwright` string; browser artifacts remain at or below the approved raw/gzip JS and raw CSS limits.

- [x] **Step 6: Review checkpoint**

  Run: `rg -n "playwright" dist src service-worker.js asset-manifest.json 2>/dev/null || true`

  Expected: no production-browser match. A match in `scripts/`, tests, package metadata, or `node_modules/` is acceptable and must not be copied into `dist/`.

---

### Task 5: Implement The Hosted User Journey

**Files:**
- Modify: `scripts/browser-acceptance-core.mjs`
- Modify: `tests/browser-acceptance.test.js`
- Modify: `scripts/browser-acceptance.mjs`

**Interfaces:**
- Produces: desktop viewport `{ width: 1440, height: 1000 }` and mobile viewport `{ width: 390, height: 844 }` acceptance journeys.
- Selectors use accessible roles and stable existing attributes: `data-view`, `data-discovery-search-form`, `data-discovery-item-id`, `data-discovery-approve`, `data-library-source`, and `data-library-disable`.
- Mutation cleanup is mandatory and keyed by the generated acceptance source ID captured after approval.

- [x] **Step 1: Add fake-page workflow tests**

  Model the exact journey and assert ordered actions:

  1. Open Feed, Discover, Review, and Library at desktop and mobile.
  2. Submit one bounded generic search with `web` and `podcasts` selected and limit `10`.
  3. Select the first current result, verify its title, follow Back to results, and verify the same collection without a new search response.
  4. Change providers/limit, submit again, and verify the old collection is absent.
  5. Select a generated podcast feed result, assert detail evidence identifies feed-level metadata, add it to Music, verify it appears in Library, remove it, and verify it is inactive/absent while an unrelated pre-existing source remains.

  The fake must also assert that no screenshot is taken while a query value, Access redirect, notification containing a source title, or destructive confirmation dialog is visible.

- [x] **Step 2: Implement navigation and same-origin observation**

  Observe `page.on("console")`, `page.on("pageerror")`, `page.on("requestfailed")`, and `page.on("response")`. Retain only console severity/category, same-origin resource category/status/duration, and the validated `x-resonance-worker-version`. Ignore known extension messages because the acceptance context has no extensions; treat every application error and failed same-origin module/API response as blocking.

- [x] **Step 3: Implement exact-result and state assertions**

  Capture the selected row's `data-discovery-item-id` and visible title before navigation. On detail, require the same `data-selected-item-id` and heading. On return, require the original result IDs and control values. After the replacement search, require at least one new ID and require every prior live ID to be absent.

- [x] **Step 4: Implement reversible Library mutation**

  Generate a run label locally but never place it in provider query text or logs. Select a returned podcast item whose detail and candidate action identify feed-level metadata. Submit `data-discovery-approve`, capture the Library source element reached by navigation, require its visible capability text to be `feed · metadata`, record only its generated source ID in memory, remove it through `data-library-disable`, accept the page confirmation, and verify an unrelated source ID captured before mutation remains.

- [x] **Step 5: Implement screenshot gates**

  Capture one redacted screenshot per top-level route and viewport only after clearing search inputs, closing transient notices, and verifying there is no credential, query, raw error, or source-specific private text in the screenshot's associated metadata. Use filenames such as `desktop-discover.png`, never query/title-derived filenames.

- [x] **Step 6: Run deterministic workflow tests**

  Run: `deno test --allow-read --allow-write tests/browser-acceptance.test.js`

  Expected: PASS for success, mutation cleanup, stale result rejection, console/network failure mapping, and screenshot redaction gates.

- [x] **Step 7: Review checkpoint**

  Confirm cleanup executes in `finally` after every post-approval failure. A failed source removal must return `BrowserAcceptanceCleanupFailed` and block release acceptance rather than report success.

---

### Task 6: Validate Locally, Activate Access, And Run The Hosted Gate

**Files:**
- Modify: `documentations/ENV.md`
- Modify: `documentations/TESTING.md`
- Modify: `documentations/spec.md`
- Modify: `documentations/TESTS.md`
- Modify: `logs/hosted-activation-2026-08-01.log` (ignored operational evidence)

**Interfaces:**
- Requires local ignored `.env.browser-acceptance` containing only `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.
- Requires an exact-token Cloudflare Access Service Auth policy for `resonance-discovery.lirenleonidas.workers.dev`, valid for 90 days.
- Produces a redacted acceptance result tied to `x-resonance-worker-version`.

- [x] **Step 1: Run local validation before any Cloudflare mutation**

  Run:

  ```bash
  deno test --allow-read --allow-write tests/discovery-page.test.js tests/discover-route.test.js tests/discovery-gateway.test.js tests/browser-acceptance-composition.test.js tests/browser-acceptance.test.js tests/worker-version-metadata.test.js tests/build.test.js
  deno task check
  deno task test
  deno task build
  ```

  Expected: all tests and strict checking pass; build reports JavaScript at or below `182,000` raw / `58,000` gzip and CSS at or below `24,000` raw. Do not create a service token, change an Access policy, deploy, or run a production mutation if this step fails.

- [x] **Step 2: Independently validate the release candidate**

  Dispatch a fresh `gpt-5.6-terra` subagent with medium reasoning and read-only ownership of the Milestone 3F diff. Require separate reports for behavior/spec compliance, test gaps, security/redaction, and maintainability. Resolve every blocking finding and rerun Step 1 before changing Cloudflare configuration.

- [x] **Step 3: Configure the least-privilege Access credential**

  In Cloudflare Zero Trust, create one 90-day service token named `resonance-browser-acceptance`. Add a Service Auth policy to the existing application with one Include rule matching that exact service token. Do not use an `Any valid service token` rule. In a local editor, create ignored `.env.browser-acceptance` with exactly two assignments named `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`; enter the generated values directly and never send them in chat. Confirm `git status --ignored --short .env.browser-acceptance` reports it as ignored.

- [x] **Step 4: Deploy the validated Worker candidate**

  Run from the user-controlled terminal because the managed sandbox cannot reach the Cloudflare API:

  ```bash
  npx wrangler deploy
  ```

  Record only deployment timestamp, Worker version ID, outcome, and durations in the ignored hosted-activation log. Do not copy binding values or provider output.

- [ ] **Step 5: Run the browser network, Access, and complete hosted acceptance journey**

  Run: `deno task browser:acceptance`

  The runner first opens the hosted document in installed Chrome with the Access headers and requires status 200, no Access redirect, and a non-empty Worker version header before any Library mutation. If Chrome cannot reach the host from the managed sandbox, it returns `BrowserAcceptanceNetworkUnavailable`, makes no mutation, and stops for an infrastructure decision; autonomous hosted coverage must not be claimed.

  Expected after preflight: Feed, Discover, Review, and Library pass at both viewports; exact result detail and replacement state pass; the generated podcast source is added as `feed · metadata`, removed, and absent afterward; the unrelated source and completed learning history remain; the report carries the deployed Worker version; no console or same-origin module/API failure occurs.

- [ ] **Step 6: Inspect redacted artifacts and cleanup**

  Run:

  ```bash
  rg -n "CF_ACCESS|Authorization|Cookie|[?&][^ ]+=|query|response.body" logs test-results
  find logs test-results -type f -mtime +30 -print
  ```

  Expected: no credential, token, query string, or response-body match; no artifact older than 30 days; the acceptance-created Library source is absent.

- [ ] **Step 7: Update milestone records**

  In `documentations/spec.md`, mark completed checklist items only after the hosted gate passes. In `documentations/TESTS.md`, record focused/full counts, check/build results, exact artifact measurements, independent validation outcome, hosted Worker version, and reversible cleanup result. Add activation variables and commands to `ENV.md` and `TESTING.md` without secret values.

- [ ] **Step 8: Present Milestone 3F for approval**

  Report the root cause, changed behavior, exact validation results, artifact sizes, deployed Worker version, hosted browser evidence, cleanup result, and any residual risk. Wait for explicit user approval before committing or beginning another milestone.

---

## Final Self-Review

- Spec coverage: Tasks 1 and 5 cover live-result preservation, exact selection, replacement, unknown IDs, and route navigation. Tasks 3 through 6 cover Access, installed Chrome, redaction, artifact retention, viewports, typed failures, reversible Library mutation, version evidence, and hosted release gating. Tasks 4 and 6 enforce fixed production budgets and dependency isolation.
- Placeholder scan: activation credential values are intentionally absent and must be entered directly into the ignored environment file. No implementation behavior is deferred or described generically.
- Type consistency: Task 3 defines the failure union and public harness signatures used unchanged by Tasks 4 through 6. Task 2 defines the exact version header consumed by Tasks 3 and 5. Task 1's superseded variant remains controller-local and never enters provider or persistence contracts.
- Scope: no layout, ranking, semantic search, acquisition, transcription, recall scheduling, Android, or personal-profile change is included.
