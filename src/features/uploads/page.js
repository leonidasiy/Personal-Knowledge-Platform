// @ts-check
import { SourceLibraryGatewayClient } from "../source-library/gateway.js";
/** @typedef {"text"|"documents"|"pdf"|"images"} UploadInput */
/** @typedef {{readonly source:import('../source-library/contracts.js').LibrarySource,readonly runId:string,readonly reason:string}} UploadContext */
/** @typedef {{readonly fetch:typeof fetch,readonly baseUrl:string,readonly onChange:()=>void,readonly createId:()=>string,readonly onRenamed:(sourceId:string,title:string)=>void,readonly upload:(sourceId:string,form:FormData,context:UploadContext|null)=>Promise<{readonly ok:boolean,readonly message:string}>}} UploadDependencies */
/** @param {UploadDependencies} dependencies */
export function createUploadPage(dependencies) {
  if (
    typeof dependencies?.fetch !== "function" ||
    !URL.canParse(dependencies.baseUrl) ||
    typeof dependencies.onChange !== "function" ||
    typeof dependencies.createId !== "function" ||
    typeof dependencies.upload !== "function" ||
    typeof dependencies.onRenamed !== "function"
  ) throw new TypeError("UploadPageDependenciesInvalid");
  /** @type {UploadInput} */ let input = "text";
  let title = "";
  let draft = new FormData();
  let busy = false;
  const gateway = new SourceLibraryGatewayClient({
    fetch: dependencies.fetch,
    baseUrl: dependencies.baseUrl,
    timeoutMs: 4_000,
  });
  /** @type {UploadContext|null} */ let context = null;
  let state = "ready", message = "", generation = 0;
  /** @type {{fingerprint:string,key:string}|null} */ let renameAttempt = null;
  /** Keep in memory only; uploaded content never enters storage or the URL. @param {FormData} form */
  function remember(form) {
    if (!(form instanceof FormData)) throw new TypeError("UploadDraftInvalid");
    if (
      input !== "text" &&
      !form.getAll("file").some((value) =>
        value instanceof File && value.size > 0
      )
    ) {
      const retained = draft.getAll("file").filter((value) =>
        value instanceof File && value.size > 0
      );
      if (retained.length) {
        form.delete("file");
        for (const file of retained) form.append("file", file);
      }
    }
    if (
      (input === "images" || input === "pdf") && !form.has("imageProcessing")
    ) form.set("imageProcessing", "off");
    draft = form;
    const value = form.get("title");
    if (typeof value === "string") title = value;
  }
  /** @param {FormData} form */
  async function submit(form) {
    if (busy || state !== "ready") return false;
    const selected = new FormData();
    for (
      const key of [
        "title",
        "attested",
        ...(input === "text" ? ["content"] : ["file"]),
        ...(input === "pdf"
          ? ["pageRange", "imageProcessing"]
          : input === "images"
          ? ["imageProcessing"]
          : []),
      ]
    ) {
      for (const value of form.getAll(key)) selected.append(key, value);
    }
    form = selected;
    remember(form);
    if (
      (!title.trim() && (context !== null || input === "text")) ||
      title.trim().length > 300
    ) {
      message = shellMarkup(11);
      dependencies.onChange();
      return false;
    }
    const files = form.getAll("file").filter((value) =>
      value instanceof File && value.size > 0
    );
    const supported = input === "documents"
      ? /\.(txt|md|pptx)$/iu
      : input === "pdf"
      ? /\.pdf$/iu
      : /\.(png|jpe?g|webp|gif)$/iu;
    if (
      input !== "text" &&
      (files.length === 0 ||
        files.some((file) =>
          !supported.test(/** @type {File} */ (file).name)
        ) || input !== "images" && files.length !== 1)
    ) {
      message = shellMarkup(12);
      dependencies.onChange();
      return false;
    }
    if (input === "text" && !String(form.get("content") ?? "").trim()) {
      message = shellMarkup(13);
      dependencies.onChange();
      return false;
    }
    if (form.get("attested") !== "on") {
      message =
        shellMarkup(14);
      dependencies.onChange();
      return false;
    }
    const current = generation;
    if (context !== null && !await saveTitle(form)) return false;
    if (generation !== current) return false;
    busy = true;
    dependencies.onChange();
    try {
      const result = await dependencies.upload(
        context?.source.id ?? "",
        form,
        context,
      );
      if (generation !== current) return false;
      message = result.ok
        ? result.message
        : `${
          context === null ? "" : "Title saved. "
        }Upload failed: ${result.message} Your draft is ready to retry.`;
      return result.ok;
    } finally {
      busy = false;
      dependencies.onChange();
    }
  }
  /** @param {FormData} form */
  async function saveTitle(form) {
    if (!(form instanceof FormData) || state !== "ready" || context === null) {
      return false;
    }
    const value = form.get("title");
    if (
      typeof value !== "string" || !value.trim() || value.trim().length > 300
    ) {
      message = shellMarkup(15);
      dependencies.onChange();
      return false;
    }
    title = value.trim();
    if (title === context.source.title) return true;
    const fingerprint = JSON.stringify([
      context.source.id,
      context.runId,
      context.source.revision,
      context.source.title,
      title,
    ]);
    if (renameAttempt?.fingerprint !== fingerprint) {
      renameAttempt = { fingerprint, key: `rename:${dependencies.createId()}` };
    }
    const current = generation;
    const bound = context;
    const result = await gateway.rename({
      sourceId: context.source.id,
      runId: context.runId,
      expectedRevision: context.source.revision,
      expectedTitle: context.source.title,
      title,
      idempotencyKey: renameAttempt.key,
    });
    if (generation !== current) {
      if (result.ok) {
        dependencies.onRenamed(bound.source.id, result.value.title);
      }
      return false;
    }
    if (!result.ok) {
      if (
        result.error.kind === "SourceGatewayRejected" &&
          ["SourceRenameConflict", "SourceUploadContextUnavailable"].includes(
            result.error.failureKind,
          ) ||
        result.error.kind === "SourceGatewayUnauthorized" ||
        result.error.kind === "SourceGatewayUnauthenticated"
      ) state = "unavailable";
      message =
        shellMarkup(16);
      dependencies.onChange();
      return false;
    }
    context = {
      ...context,
      source: { ...context.source, title: result.value.title },
    };
    dependencies.onRenamed(context.source.id, context.source.title);
    message = shellMarkup(17);
    renameAttempt = null;
    dependencies.onChange();
    return true;
  }
  /** @param {string} hash */
  async function load(hash) {
    const current = ++generation;
    context = null;
    draft = new FormData();
    input = "text";
    renameAttempt = null;
    title = "";
    message = "";
    const [route, query] = hash.split("?");
    if (route !== "#upload") {
      state = "unavailable";
      dependencies.onChange();
      return;
    }
    if (query === undefined) {
      state = "ready";
      dependencies.onChange();
      return;
    }
    const params = new URLSearchParams(query);
    const sourceId = params.get("sourceId"), runId = params.get("runId");
    if (
      !sourceId?.trim() || !runId?.trim() ||
      params.getAll("sourceId").length !== 1 ||
      params.getAll("runId").length !== 1
    ) {
      state = "unavailable";
      dependencies.onChange();
      return;
    }
    state = "loading";
    dependencies.onChange();
    const result = await gateway.uploadContext({ sourceId, runId });
    if (generation !== current) return;
    if (!result.ok) {
      state = "unavailable";
      message =
        shellMarkup(18);
    } else {
      context = result.value;
      title = context.source.title;
      state = "ready";
    }
    dependencies.onChange();
  }
  /** @param {string} value */
  function select(value) {
    if (
      value !== "text" && value !== "documents" && value !== "pdf" &&
      value !== "images"
    ) throw new TypeError("UploadInputInvalid");
    if (input !== value) {
      for (const key of ["content", "file", "pageRange", "imageProcessing"]) {
        draft.delete(key);
      }
    }
    input = value;
    dependencies.onChange();
  }
  function render() {
    if (state === "loading") {
      return shellMarkup(0);
    }
    if (state === "unavailable") {
      return shellMarkup(1, escape(
          message ||
            shellMarkup(19),
        ));
    }
    const files = draft.getAll("file").filter((value) =>
      value instanceof File && value.size > 0
    );
    const control = input === "text"
      ? shellMarkup(2, escape(String(draft.get("content") ?? "")))
      : shellMarkup(3, input === "documents"
          ? "Choose a document"
          : input === "pdf"
          ? "Choose a PDF"
          : "Choose images", input === "images" ? "multiple" : "", input === "documents"
          ? ".txt,.md,.pptx"
          : input === "pdf"
          ? ".pdf"
          : ".png,.jpg,.jpeg,.webp,.gif", files.length ? "" : " required", files.length
          ? shellMarkup(4, files.map((file) => escape(/** @type {File} */ (file).name)).join(
              ", ",
            ))
          : "");
    return shellMarkup(5, context === null
        ? ""
        : shellMarkup(6, escape(context.reason)), busy, escape(title), context !== null || input === "text" ? " required" : "", ([
        ["text", "Paste text"],
        ["documents", "Documents"],
        ["pdf", "PDF"],
        ["images", "Images"],
      ]).map(([value, label]) =>
        shellMarkup(7, value, input === value ? " selected" : "", label)
      ).join(""), control, input === "pdf" || input === "images"
        ? shellMarkup(8, draft.has("imageProcessing")
            ? draft.get("imageProcessing") === "on" ? " checked" : ""
            : input === "images"
            ? " checked"
            : "")
        : "", input === "pdf"
        ? shellMarkup(9, escape(String(draft.get("pageRange") ?? "")))
        : "", draft.get("attested") === "on" ? " checked" : "", context === null
        ? ""
        : shellMarkup(10), busy ? " disabled" : "", busy ? "Uploading…" : shellMarkup(20), escape(message));
  }
  /** @param {HTMLElement} root */
  function bind(root) {
    const form = /** @type {HTMLFormElement|null} */ (root.querySelector(
      "[data-upload-form]",
    ));
    if (form === null) return;
    const choice = /** @type {HTMLSelectElement|null} */ (root.querySelector(
      "[data-upload-input]",
    ));
    form.addEventListener("input", () => remember(new FormData(form)));
    form.addEventListener("change", (event) => {
      if (event.target !== choice) remember(new FormData(form));
    });
    choice?.addEventListener("change", () => {
      select(choice.value);
      /** @type {HTMLSelectElement|null} */ (root.querySelector(
        "[data-upload-input]",
      ))?.focus();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submit(new FormData(form));
    });
    root.querySelector("[data-upload-save-title]")?.addEventListener(
      "click",
      () => {
        remember(new FormData(form));
        void saveTitle(draft);
      },
    );
  }
  return Object.freeze({
    select,
    render,
    load,
    saveTitle,
    submit,
    remember,
    bind,
  });
}
/** @param {string} value */
function escape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  ).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Static markup is part of the cached shell; values are escaped by callers.
 * @param {number} index @param {...(string|boolean|number)} values */
function shellMarkup(index, ...values) {
  const content = document.getElementById("upload-markup")?.textContent;
  if (!content) throw new TypeError("ShellMarkupUnavailable:upload-markup");
  const templates = JSON.parse(content);
  const parts = templates[index];
  if (!Array.isArray(parts) || parts.length !== values.length + 1 || parts.some(part => typeof part !== "string")) {
    throw new TypeError("ShellMarkupInvalid:upload-markup");
  }
  return parts.reduce((html, part, slot) => html + (slot === 0 ? "" : values[slot - 1]) + part, "");
}
