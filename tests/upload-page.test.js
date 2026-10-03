// @ts-check
import { createUploadPage } from "../src/features/uploads/page.js";
// Supply the browser document boundary from the actual offline shell.
const shell = Deno.readTextFileSync("index.html");
Object.defineProperty(globalThis, "document", { configurable: true, value: {
  getElementById: (/** @type {string} */ id) => {
    const content = shell.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`))?.[1];
    return content === undefined ? null : { textContent: content };
  },
} });
/** @param {boolean} value @param {string} message */
function assert(value, message) {
  if (!value) throw new Error(message);
}
const deps = {
  fetch: /** @type {typeof fetch} */ (async () => {
    throw new Error("Unexpected request");
  }),
  baseUrl: "https://app.example/",
  onChange: () => {},
  createId: () => "request-a",
  onRenamed: () => {},
  upload: async () => ({ ok: true, message: "Uploaded." }),
};
Deno.test("Upload static form content is available in the cached HTML shell", () => {
  const html = Deno.readTextFileSync("index.html");
  assert(html.includes('id="upload-markup"'), "Upload markup must live in the shell.");
  assert(html.includes("Add authorized material for knowledge extraction and paired questions."), "Shell carries approved Upload copy.");
  assert(html.includes("Title was not saved. The source may have changed."), "Shell carries recovery copy too.");
  const worker = Deno.readTextFileSync("service-worker.js");
  assert(worker.includes('"./index.html"'), "Offline shell includes the markup source.");
});
Deno.test("Upload offers four distinct inputs with Title and only relevant controls", () => {
  const page = createUploadPage(deps);
  for (const input of ["text", "documents", "pdf", "images"]) {
    page.select(input);
    const html = page.render();
    assert(html.includes(`value="${input}" selected`), "Current input remains selected.");
    assert(
      html.includes('<h1 id="upload-title">Upload</h1>') &&
        html.includes('name="title"'),
      "Upload and Title must always be visible.",
    );
    for (const label of ["Paste text", "Documents", "PDF", "Images"]) {
      assert(html.includes(`>${label}</option>`), `Missing input ${label}`);
    }
    assert(
      html.includes("<textarea") === (input === "text"),
      "Only pasted input has textarea.",
    );
    assert(
      html.includes('type="file"') === (input !== "text"),
      "Only selected file control is shown.",
    );
    assert(
      html.includes('name="pageRange"') === (input === "pdf"),
      "Only PDF has pages.",
    );
    assert(
      html.includes('name="imageProcessing"') ===
        (input === "pdf" || input === "images"),
      "Only PDF/images have image settings.",
    );
    if (input === "documents") {
      assert(
        html.includes('accept=".txt,.md,.pptx"'),
        "Preserve document support exactly.",
      );
    }
    if (input === "images") {
      assert(
        html.includes('accept=".png,.jpg,.jpeg,.webp,.gif"'),
        "Preserve raster support exactly.",
      );
    }
  }
});

const source = {
  id: "source-a",
  ownerId: "owner-a",
  title: "Original <title>",
  description: "A source.",
  submittedUrl: "https://publisher.example/",
  canonicalUrl: "https://publisher.example/",
  adapter: {
    id: "web",
    version: "1",
    granularity: "page",
    capabilities: ["metadata"],
  },
  interestAreaIds: [],
  identityEvidence: [],
  state: "active",
  approvedAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
  revision: 2,
};
Deno.test("Upload resolves bound identity independently of Library and rejects missing or unavailable context", async () => {
  let calls = 0;
  const page = createUploadPage({
    ...deps,
    fetch: async (url) => {
      calls++;
      assert(
        String(url).includes("/upload-context?sourceId=source-a&runId=run-a"),
        "Bound identity must be validated by the server.",
      );
      return Response.json({
        result: { source, runId: "run-a", reason: "Blocked <reason>" },
      });
    },
  });
  await page.load("#upload?sourceId=source-a&runId=run-a&title=Untrusted");
  assert(
    page.render().includes('value="Original &lt;title&gt;"'),
    "Server title must replace URL display text.",
  );
  assert(
    page.render().includes("Blocked &lt;reason&gt;"),
    "Reason must be escaped.",
  );
  for (
    const route of [
      "#upload?sourceId=",
      "#upload?runId=run-a",
      "#upload?sourceId=source-a",
      "#upload?title=orphan",
    ]
  ) {
    await page.load(route);
    assert(
      page.render().includes("Upload unavailable") &&
        page.render().includes('href="#library"'),
      "Incomplete bound route needs explicit recovery.",
    );
    assert(
      !page.render().includes("data-upload-form"),
      "Never create privately from malformed context.",
    );
  }
  assert(calls === 1, "Invalid identity must not reach the server.");
  const denied = createUploadPage({
    ...deps,
    fetch: async () =>
      Response.json({ error: "SourceRenameConflict" }, { status: 409 }),
  });
  await denied.load("#upload?sourceId=source-a&runId=run-a");
  assert(
    denied.render().includes("Upload unavailable") &&
      !denied.render().includes("source-a"),
    "Conflict must not disclose internal IDs.",
  );
});
Deno.test("Upload saves a source title separately with the exact concurrency guard", async () => {
  const renamed = /** @type {string[]} */ ([]);
  const page = createUploadPage({
    ...deps,
    onRenamed: (id, title) => renamed.push(`${id}:${title}`),
    fetch: async (url, init) => {
      if (String(url).includes("upload-context")) {
        return Response.json({
          result: {
            source,
            runId: "run-a",
            reason: "Authorized copy required.",
          },
        });
      }
      assert(
        String(url).endsWith("/rename"),
        "Rename uses its dedicated endpoint.",
      );
      const body = JSON.parse(String(init?.body));
      assert(
        body.expectedRevision === 2 &&
          body.expectedTitle === "Original <title>" && body.runId === "run-a" &&
          body.title === "New title",
        "Rename preserves revision and exact old-title guard.",
      );
      return Response.json({
        result: {
          sourceId: source.id,
          runId: "run-a",
          title: "New title",
          revision: 2,
          reused: false,
        },
      });
    },
  });
  await page.load("#upload?sourceId=source-a&runId=run-a");
  const form = new FormData();
  form.set("title", "New title");
  assert(
    await page.saveTitle(form),
    "Title can be saved without material or attestation.",
  );
  assert(
    renamed[0] === "source-a:New title" &&
      page.render().includes('value="New title"'),
    "Saved title updates source presentation immediately.",
  );
});
Deno.test("Upload retains a successful rename and retryable draft when material fails", async () => {
  let uploads = 0, renames = 0;
  const page = createUploadPage({
    ...deps,
    fetch: async (url) => {
      if (String(url).includes("upload-context")) {
        return Response.json({
          result: {
            source,
            runId: "run-a",
            reason: "Authorized copy required.",
          },
        });
      }
      renames++;
      return Response.json({
        result: {
          sourceId: source.id,
          runId: "run-a",
          title: "Changed",
          revision: 2,
          reused: false,
        },
      });
    },
    upload: async (id, form, context) => {
      uploads++;
      assert(
        id === "source-a" && context?.source.title === "Changed" &&
          form.get("content") === "Synthetic material",
        "Upload must use renamed bound source and selected material.",
      );
      return {
        ok: uploads > 1,
        message: uploads > 1
          ? "Content uploaded."
          : "Material service unavailable.",
      };
    },
  });
  await page.load("#upload?sourceId=source-a&runId=run-a");
  const form = new FormData();
  form.set("title", "Changed");
  form.set("content", "Synthetic material");
  form.set("attested", "on");
  assert(
    !(await page.submit(form)),
    "Failed material must be distinct from saved title.",
  );
  assert(
    page.render().includes('value="Changed"') &&
      page.render().includes("Synthetic material") &&
      page.render().includes("Title saved. Upload failed"),
    "Title and draft survive failure with separate feedback.",
  );
  assert(await page.submit(form), "Draft can be retried.");
  assert(renames === 1 && uploads === 2, "Retry must not rename again.");
});
Deno.test("Upload excludes stale input values after switching choices", async () => {
  const page = createUploadPage({
    ...deps,
    upload: async (_id, form) => {
      assert(
        form.get("content") === null && form.get("pageRange") === null &&
          form.get("imageProcessing") === null,
        "Document submission excludes all stale text/PDF/image settings.",
      );
      assert(form.get("file") instanceof File, "Selected file remains.");
      return { ok: true, message: "Uploaded." };
    },
  });
  page.select("documents");
  const form = new FormData();
  form.set("title", "Document");
  form.set("file", new File(["sample"], "sample.md"));
  form.set("content", "stale");
  form.set("pageRange", "2");
  form.set("imageProcessing", "on");
  form.set("attested", "on");
  assert(
    await page.submit(form),
    "Selected input can upload while stale controls are excluded.",
  );
});
Deno.test("A rename response cannot change a different Upload route", async () => {
  const delayed = Promise.withResolvers();
  const renamed = /** @type {string[]} */ ([]);
  const page = createUploadPage({
    ...deps,
    onRenamed: (id, title) => renamed.push(`${id}:${title}`),
    fetch: async (url) =>
      String(url).includes("upload-context")
        ? Response.json({
          result: { source, runId: "run-a", reason: "Copy required." },
        })
        : delayed.promise,
  });
  await page.load("#upload?sourceId=source-a&runId=run-a");
  const form = new FormData();
  form.set("title", "Changed");
  const pending = page.saveTitle(form);
  await page.load("#upload");
  delayed.resolve(
    Response.json({
      result: {
        sourceId: source.id,
        runId: "run-a",
        title: "Changed",
        revision: 2,
        reused: false,
      },
    }),
  );
  await pending;
  assert(
    !page.render().includes('value="Changed"') &&
      renamed.every((value) => value.startsWith("source-a:")),
    "Late response cannot overwrite new route context.",
  );
});
Deno.test("Changing Upload context clears a previous private draft", async () => {
  const page = createUploadPage({
    ...deps,
    fetch: async () =>
      Response.json({
        result: { source, runId: "run-a", reason: "Copy required." },
      }),
  });
  const form = new FormData();
  form.set("title", "Private title");
  form.set("content", "Private draft must not cross routes");
  page.remember(form);
  await page.load("#upload?sourceId=source-a&runId=run-a");
  assert(
    !page.render().includes("Private draft must not cross routes"),
    "Draft must be scoped to its Upload route.",
  );
});
Deno.test("Failed file upload keeps selected file and settings for a retry from the rendered form", async () => {
  let calls = 0;
  const page = createUploadPage({
    ...deps,
    upload: async (_id, form) => {
      calls++;
      assert(
        form.get("file") instanceof File,
        "Retry must retain the original file.",
      );
      assert(form.get("attested") === "on", "Attestation survives rerender.");
      return { ok: calls > 1, message: "Synthetic failure" };
    },
  });
  page.select("pdf");
  const form = new FormData();
  form.set("title", "PDF draft");
  form.set("file", new File(["pdf"], "sample.pdf"));
  form.set("pageRange", "");
  form.set("attested", "on");
  await page.submit(form);
  assert(
    page.render().includes("sample.pdf") &&
      /name="attested"[^>]*checked/.test(page.render()),
    "Retained file and permission are visible.",
  );
  const rendered = new FormData();
  rendered.set("title", "PDF draft");
  rendered.set("file", new File([], ""));
  rendered.set("attested", "on");
  assert(
    await page.submit(rendered),
    "Retry uses retained file when browser file input was rebuilt.",
  );
});
Deno.test("Upload input selector binds change events to the rendered controls", () => {
  const choice = Object.assign(new EventTarget(), {
    value: "pdf",
    focus: () => {},
  });
  const form = new EventTarget();
  const root = /** @type {HTMLElement} */ (/** @type {unknown} */ ({
    querySelector: (/** @type {string} */ selector) =>
      selector === "[data-upload-form]"
        ? form
        : selector === "[data-upload-input]"
        ? choice
        : null,
  }));
  const page = createUploadPage(deps);
  page.bind(root);
  choice.dispatchEvent(new Event("change"));
  assert(
    page.render().includes('name="pageRange"'),
    "Selecting PDF must expose PDF controls.",
  );
});
Deno.test("Selected input enforces supported formats and a title for pasted material", async () => {
  let requests = 0;
  const page = createUploadPage({
    ...deps,
    upload: async () => {
      requests++;
      return { ok: true, message: "Uploaded" };
    },
  });
  for (
    const [kind, name] of [["documents", "wrong.pdf"], ["pdf", "wrong.txt"], [
      "images",
      "wrong.svg",
    ]]
  ) {
    page.select(kind);
    const form = new FormData();
    form.set("title", "Sample");
    form.set("file", new File(["sample"], name));
    form.set("attested", "on");
    assert(
      !await page.submit(form),
      "Unsupported selected format must not reach transport.",
    );
  }
  page.select("text");
  const form = new FormData();
  form.set("title", " ");
  form.set("content", "sample");
  form.set("attested", "on");
  assert(
    !await page.submit(form) && requests === 0,
    "Pasted material requires a title.",
  );
});
Deno.test("Stale title conflicts stop material upload and require reopening the source", async () => {
  let uploads = 0;
  const page = createUploadPage({
    ...deps,
    fetch: async (url) =>
      String(url).includes("upload-context")
        ? Response.json({
          result: { source, runId: "run-a", reason: "Copy required." },
        })
        : Response.json({ error: "SourceRenameConflict" }, { status: 409 }),
    upload: async () => {
      uploads++;
      return { ok: true, message: "Uploaded" };
    },
  });
  await page.load("#upload?sourceId=source-a&runId=run-a");
  const form = new FormData();
  form.set("title", "Changed");
  form.set("content", "sample");
  form.set("attested", "on");
  assert(
    !await page.submit(form) && uploads === 0,
    "Conflict must stop material mutation.",
  );
  assert(
    page.render().includes("Upload unavailable") &&
      page.render().includes('href="#library"') &&
      !page.render().includes("data-upload-form"),
    "Stale context requires explicit recovery.",
  );
});
Deno.test("Private file uploads preserve the existing optional-title filename behavior", async () => {
  const page = createUploadPage({
    ...deps,
    upload: async () => ({ ok: true, message: "Uploaded." }),
  });
  page.select("documents");
  const form = new FormData();
  form.set("title", "");
  form.set("file", new File(["sample"], "sample.md"));
  form.set("attested", "on");
  assert(
    await page.submit(form),
    "Private files may use their filename when Title is left blank.",
  );
});
Deno.test("Upload remembers an explicitly unchecked image-processing option", () => {
  const page = createUploadPage(deps);
  page.select("images");
  const form = new FormData();
  form.set("title", "Image");
  page.remember(form);
  const control = page.render().match(/<input[^>]*name="imageProcessing"[^>]*>/)
    ?.[0];
  assert(
    control !== undefined && !control.includes("checked"),
    "Rerender must not opt the learner back into image processing.",
  );
});
