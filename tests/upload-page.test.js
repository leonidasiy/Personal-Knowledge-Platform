// @ts-check
import { SourceLibraryGatewayClient } from "../src/features/source-library/gateway.js";
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
        (input === "pdf"),
      "Only PDF has an optional image setting.",
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
  assert(page.render().includes('<form data-upload-form="source-a" aria-busy="false">'), "Bound source key and truthful busy state must be HTML attributes.");
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
      assert(!form.has("attested"), "No obsolete rights attestation is sent.");
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
      !page.render().includes('name="attested"'),
    "Retained file is visible without an attestation gate.",
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
Deno.test("PDF remembers an explicitly unchecked image-processing option", () => {
  const page = createUploadPage(deps);
  page.select("pdf");
  const form = new FormData();
  form.set("title", "PDF");
  page.remember(form);
  const control = page.render().match(/<input[^>]*name="imageProcessing"[^>]*>/)
    ?.[0];
  assert(
    control !== undefined && !control.includes("checked"),
    "Rerender must not opt the learner back into image processing.",
  );
});

Deno.test("Selected-source prefill stays exact, editable, and local through Upload mode changes", async () => {
  const page = createUploadPage(deps);
  const title = 'Actual <source> & title ' + '長'.repeat(200);
  await page.load("#upload", {title});
  assert(page.render().includes('value="Actual &lt;source&gt; &amp; title ' + '長'.repeat(200) + '"'), "Prefill exact selected title, escaped without inventing or truncating it.");
  const draft = new FormData(); draft.set("title", "My edited title"); draft.set("content", "Private synthetic draft");
  page.remember(draft);
  for (const mode of ["documents", "pdf", "images", "text"]) {
    page.select(mode);
    assert(page.render().includes('value="My edited title"'), "Mode/rerender must not reapply source title.");
  }
  for (const length of [300, 301]) {
    await page.load("#upload", {title: "x".repeat(length)});
    assert(page.render().includes('value="' + "x".repeat(length) + '"'), "Prefill never truncates an actual title at the length boundary.");
  }
  const oversized = new FormData(); oversized.set("title", "x".repeat(301)); oversized.set("content", "Synthetic material"); oversized.set("attested", "on");
  assert(!await page.submit(oversized) && page.render().includes("Enter a title of 1–300 characters."), "Existing title-size validation remains explicit.");
  await page.load("#upload");
  assert(page.render().includes('name="title" value=""'), "Unrelated new Upload remains blank.");
});
Deno.test("Upload prefill rejects missing titles and ambiguous bound-route combinations", async () => {
  const page = createUploadPage(deps);
  for (const title of ["", " "]) {
    let rejected = false;
    try { await page.load("#upload", {title}); } catch(error) { rejected = error instanceof TypeError; }
    assert(rejected, "Invalid public prefill must fail explicitly.");
  }
  let rejected = false;
  try { await page.load("#upload?sourceId=source-a&runId=run-a", {title:"Conflicting title"}); } catch(error) { rejected = error instanceof TypeError; }
  assert(rejected, "Prefill cannot override a bound source context.");
});

Deno.test("Upload authorizes text/documents/images without checkbox; image mode ignores stale state", async () => {
  /** @type {FormData[]} */ const received = [];
  const page = createUploadPage({...deps, upload:async (_id,form) => { received.push(form); return {ok:true,message:"Uploaded"}; }});
  for (const input of ["text","documents","images"]) {
    page.select(input);
    const form = new FormData(); form.set("title","Owned material");
    if(input === "text") form.set("content","Synthetic notes");
    else form.set("file",new File(["fixture"],input === "images" ? "image.png" : "notes.txt"));
    form.set("imageProcessing","off");
    assert(await page.submit(form),"Checkbox-free material must reach upload.");
    assert(!page.render().includes('name="attested"'),"Rights checkbox is removed.");
  }
  assert(received[2].get("imageProcessing") === "on","Images always use image mode.");
  page.select("pdf"); assert(!/name="imageProcessing"[^>]*checked/.test(page.render()),"Switching to PDF stays text-first.");
});

Deno.test("Upload bounds selected filenames behind an accessible full-name disclosure", () => {
  const page = createUploadPage(deps);
  for (const input of ["documents", "pdf", "images"]) {
    page.select(input);
    assert(page.render().includes('data-upload-files hidden'), "Empty selection has no disclosure.");
    const name = 'long <synthetic> & filename '.repeat(10) + (input === "pdf" ? ".pdf" : input === "images" ? ".png" : ".txt");
    const form = new FormData(); form.set("title", "Keep my title");
    form.set("file", new File(["fixture"], name)); page.remember(form);
    const html = page.render();
    assert(html.includes('aria-describedby="upload-filenames"'), "Native input retains full filename description.");
    assert(html.includes('data-focus-key="upload-filenames"'), "Background processing rerenders must preserve disclosure focus.");
    assert(html.includes('<details data-upload-files>') && html.includes('<summary data-focus-key="upload-filenames">Selected filenames</summary>'), "Long names start collapsed behind a keyboard disclosure.");
    assert(html.includes('id="upload-filenames">' + name.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")), "Full filename remains escaped and untruncated.");
    assert(html.includes('value="Keep my title"'), "Filename never replaces an edited title.");
    page.remember(new FormData());
    assert(!page.render().includes('data-upload-files hidden'), "Memory-backed selection survives a native-input rerender.");
  }
});
Deno.test("PDF pages has a short label and associated examples without changing text-first defaults", () => {
  const page = createUploadPage(deps); page.select("pdf");
  const html = page.render();
  assert(html.includes('<label>PDF pages<input') && html.includes('aria-describedby="upload-pages-help"'), "Short pages label points to helper.");
  assert(html.includes('<small id="upload-pages-help">Blank means all; e.g. 1,3-5. Page selection applies when image processing is enabled.</small>'), "Range syntax and conditional behavior stay accessible.");
  assert(!/name="imageProcessing"[^>]*checked/.test(html), "PDF stays text-first.");
});

Deno.test("Upload Link requires editable title, owned interest and safe URL without file/attestation", async () => {
  let extracts=0, uploads=0;
  const page=createUploadPage({...deps,upload:async()=>{uploads++;return {ok:true,message:"unused"};},fetch:async(url,init)=>{
    if(String(url).includes("api/source-library?"))return Response.json({result:{items:[],interestAreas:[{id:"area-a",ownerId:"owner-a",title:"Music",provenance:"configured"}],nextCursor:null}});
    assert(String(url).endsWith("/extract"),"Link must use the same explicit extraction endpoint as Discover");
    const command=JSON.parse(String(init?.body));extracts++;
    assert(command.title==="Edited link" && command.interestAreaId==="area-a" && command.url==="https://publisher.example/lesson","Exact edited link input must be submitted");
    assert(Object.keys(command).length===4,"Only title, URL, interest and idempotency key reach extraction");
    return Response.json({result:{source,reused:false},workflow:{runId:"run-a",reused:false}});
  }});
  await page.load("#upload",{title:"Initial title"});await page.select("link");
  const html=page.render();assert(html.includes('>Link</option>')&&html.includes('name="url"')&&html.includes('name="interest-area"'),"Link exposes native URL and interest controls");
  assert(!html.includes('type="file"')&&!html.includes('name="attested"'),"No upload file or additional rights gate");
  for(const change of [{title:""},{url:"https://127.0.0.1/"},{interest:"foreign"},{url:"javascript:alert(1)"}]){
    const form=new FormData();form.set("title",change.title??"Edited link");form.set("url",change.url??"https://publisher.example/lesson");form.set("interest-area",change.interest??"area-a");
    assert(!await page.submit(form),"Invalid Link must not reach transport");
  }
  const form=new FormData();form.set("title","Edited link");form.set("url","https://publisher.example/lesson");form.set("interest-area","area-a");form.set("content","stale private text");form.set("attested","on");
  assert(await page.submit(form),"Valid Link starts extraction");assert(extracts===1&&uploads===0,"Link must never create a private file source");
  assert(page.render().includes('value="Edited link"'),"Title stays editable after start");
});

Deno.test("Link help describes URL extraction and other modes preserve upload guidance", async () => {
  const page=createUploadPage({...deps,fetch:async()=>Response.json({result:{items:[],interestAreas:[],nextCursor:null}})});
  await page.select("link");
  const html=page.render();
  assert(html.includes("Use a public HTTPS page and choose an interest area. Extraction processes this page and linked pages within its source."),"Link-specific help explains the bounded URL workflow.");
  assert(!html.includes("20 MiB")&&!html.includes("100 MiB")&&!html.includes("vision model"),"Link must not display image/PDF upload guidance.");
  for(const mode of ["text","documents","pdf","images"]){
    await page.select(mode);
    assert(page.render().includes("Images are limited to 20 MiB each; the total upload limit is 100 MiB. Image processing sends selected images or PDF pages to the vision model."),"Preserve existing helper for "+mode);
  }
});
Deno.test("Link errors are actionable typed projections without arbitrary diagnostics or draft loss", async () => {
  const cases=[
    [401,"ignored","Sign in to this app, then retry your Link."],
    [403,"ignored","Your account cannot add this Link. Check your access with the app owner."],
    [422,"KnowledgePageAuthenticationRequired","This source requires sign-in. Use a publicly accessible page or upload material you are authorized to use."],
    [422,"KnowledgePagePaywallDetected","This source is behind a paywall. Use a publicly accessible page or upload material you are authorized to use."],
    [422,"KnowledgePageBotAccessDenied","This source blocks automated access. Use another public page or upload material you are authorized to use."],
    [422,"KnowledgePageRateLimited","This source is receiving too many requests. Wait, then retry your Link."],
    [422,"KnowledgePageTypeUnsupported","This page format cannot be extracted. Choose an HTML page or upload a supported document."],
    [422,"SourceExtractionFormatUnsupported","This page format cannot be extracted. Choose an HTML page or upload a supported document."],
    [422,"KnowledgePageFetchFailed","The source page could not be fetched. Check that it opens publicly, then retry."],
    [422,"KnowledgeBrowserNavigationFailed","The source page could not be fetched. Check that it opens publicly, then retry."],
    [422,"KnowledgeBrowserTimedOut","The source took too long to respond. Retry later or choose another public page."],
    [422,"KnowledgeBrowserNavigationRejected","This Link was blocked by source safety checks. Choose a public HTTPS page within the source."],
    [422,"KnowledgeBrowserNetworkRejected","This Link was blocked by source safety checks. Choose a public HTTPS page within the source."],
    [422,"SourceExtractionUrlInvalid","This Link was blocked by source safety checks. Choose a public HTTPS page within the source."],
    [422,"KnowledgePageLoginRequired","The extraction service returned an unrecognized failure. Keep your draft and contact support before retrying."],
    [422,"__proto__","The extraction service returned an unrecognized failure. Keep your draft and contact support before retrying."],
    [422,"toString","The extraction service returned an unrecognized failure. Keep your draft and contact support before retrying."],
    [422,"SourceGatewayUnauthorized","The extraction service returned an unrecognized failure. Keep your draft and contact support before retrying."],
    [422,'<img src=x onerror="alert(1)"> secret diagnostic',"The extraction service returned an unrecognized failure. Keep your draft and contact support before retrying."],
    [200,"malformed","The extraction service returned an invalid response. Keep your draft and contact support before retrying."],
    [0,"fetch","The extraction service could not be reached. Check your connection, then retry."],
    [0,"timeout","The extraction request timed out. Retry later; keep the same Link to avoid a duplicate."],
  ];
  for(const [status,kind,expected] of cases){
    const page=createUploadPage({...deps,fetch:async(url)=>{
      if(String(url).includes("api/source-library?"))return Response.json({result:{items:[],interestAreas:[{id:"area-a",ownerId:"owner-a",title:"Music",provenance:"configured"}],nextCursor:null}});
      if(kind==="fetch")throw new TypeError("Internal transport diagnostic");
      if(kind==="timeout")return await new Promise(()=>{});
      return Response.json({error:kind,diagnosticToken:"internal-auth-token",message:"private arbitrary prose"},{status:Number(status)});
    }});
    await page.select("link");
    const form=new FormData();form.set("title",'Draft <title> & "quoted"');form.set("url","https://publisher.example/lesson");form.set("interest-area","area-a");
    assert(!await page.submit(form),"Failure must remain a failure: "+kind);
    const html=page.render();
    assert(html.includes(String(expected)),"Actionable error for "+kind+": "+html);
    assert((Number(status)!==422 || !html.includes(String(kind)))&&!html.includes("internal-auth-token")&&!html.includes("private arbitrary prose")&&!html.includes("Internal transport diagnostic"),"Technical diagnostics must stay internal: "+kind);
    assert(html.includes('value="Draft &lt;title&gt; &amp; &quot;quoted&quot;"')&&html.includes('value="https://publisher.example/lesson"')&&html.includes('value="area-a" selected'),"Failures preserve escaped editable draft.");
  }
});

Deno.test("Link interest-load errors use readable copy and gateway retains diagnostic identity", async () => {
  for(const status of [401,403]){
    const page=createUploadPage({...deps,fetch:async()=>Response.json({error:"Private access diagnostic"},{status})});await page.select("link");
    const html=page.render();
    assert(html.includes(status===401 ? "Sign in to this app" : "Check your access with the app owner"),"Interest loader explains access recovery.");
    assert(!html.includes("SourceGateway")&&!html.includes("Private access diagnostic"),"Interest loader hides technical diagnostics.");
  }
  const failureKind='<img src=x onerror="alert(1)"> private failure diagnostic';
  const gateway=new SourceLibraryGatewayClient({baseUrl:deps.baseUrl,timeoutMs:100,fetch:async()=>Response.json({error:failureKind},{status:422})});
  const result=await gateway.extract({title:"Draft",url:"https://publisher.example/lesson",interestAreaId:"area-a",idempotencyKey:"fixture"});
  assert(!result.ok&&result.error.kind==="SourceGatewayRejected"&&result.error.failureKind===failureKind,"Display copy must not overwrite the internal typed failure.");
});
