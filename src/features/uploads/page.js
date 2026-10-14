// @ts-check
import { emptyArt } from "../../empty-state.js";
import { createShellMarkup } from "../../shell-markup.js";
import { validateSubmittedLink } from "../source-library/submitted-link.js";
import { SourceLibraryGatewayClient } from "../source-library/gateway.js";
/** @typedef {"text"|"documents"|"pdf"|"images"|"link"} UploadInput */
/** @typedef {{readonly title:string,readonly reason?:string}} UploadPrefill */
/** @typedef {{readonly source:import('../source-library/contracts.js').LibrarySource,readonly runId:string,readonly reason:string}} UploadContext */
/** @typedef {{readonly fetch:typeof fetch,readonly baseUrl:string,readonly onChange:()=>void,readonly createId:()=>string,readonly onExtracted?:(sourceId:string)=>void,readonly onRenamed:(sourceId:string,title:string)=>void,readonly upload:(sourceId:string,form:FormData,context:UploadContext|null)=>Promise<{readonly ok:boolean,readonly message:string}>}} UploadDependencies */
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
  /** @type {readonly import("../source-library/contracts.js").SourceInterestArea[]} */ let areas = [];
  /** @type {{fingerprint:string,key:string}|null} */ let linkAttempt = null;
  let title = "";
  let prefillReason = "";
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
      input !== "text" && input !== "link" &&
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
    if (!(form instanceof FormData)) throw new TypeError("UploadDraftInvalid");
    if (input === "link") return submitLink(form);
    const selected = new FormData();
    for (
      const key of [
        "title",
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
    if (input === "images") selected.set("imageProcessing", "on");
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
  async function submitLink(form) {
    const command = {title:form.get("title"),url:form.get("url"),interestAreaId:form.get("interest-area"),idempotencyKey:"pending"};
    const checked = validateSubmittedLink(command);
    remember(form);
    if (!checked.ok || !areas.some(area=>area.id===command.interestAreaId) || context !== null) {
      message = checked.ok ? shellMarkup(30) : shellMarkup(31,checked.error.field);
      dependencies.onChange();return false;
    }
    const fingerprint = JSON.stringify([command.title,command.url,command.interestAreaId]);
    if (linkAttempt?.fingerprint !== fingerprint) linkAttempt={fingerprint,key:`link:${dependencies.createId()}`};
    const current=generation;busy=true;dependencies.onChange();
    try {
      const result=await gateway.extract({...command,idempotencyKey:linkAttempt.key});
      if(current!==generation)return false;
      if(!result.ok) {message=shellMarkup(32,linkFailureMessage(result.error));return false;}
      message=shellMarkup(33);
      dependencies.onExtracted?.(result.value.source.id);return true;
    } finally {busy=false;dependencies.onChange();}
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
  /** @param {string} hash @param {UploadPrefill|null} [prefill] */
  async function load(hash, prefill = null) {
    if (typeof hash !== "string" || prefill !== null &&
      (hash !== "#upload" || typeof prefill.title !== "string" || !prefill.title.trim() ||
        prefill.reason !== undefined && (typeof prefill.reason !== "string" || !prefill.reason.trim()))) {
      throw new TypeError("UploadPrefillInvalid");
    }
    const current = ++generation;
    context = null;
    draft = new FormData();
    input = "text";
    renameAttempt = null;
    linkAttempt = null;
    areas = [];
    title = prefill?.title ?? "";
    prefillReason = prefill?.reason ?? "";
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
  async function select(value) {
    if (
      !["text", "documents", "pdf", "images", "link"].includes(value)
    ) throw new TypeError("UploadInputInvalid");
    if (value === "link" && context !== null) throw new TypeError("UploadLinkContextInvalid");
    if (input !== value) {
      for (const key of ["content", "file", "pageRange", "imageProcessing", "url", "interest-area"]) {
        draft.delete(key);
      }
    }
    input = /** @type {UploadInput} */ (value);
    dependencies.onChange();
    if (input === "link") {
      const current=generation;
      const result=await gateway.browse({limit:1});
      if(current!==generation || input!=="link")return;
      areas=result.ok ? result.value.interestAreas : [];
      message=result.ok ? "" : shellMarkup(34,linkFailureMessage(result.error));
      dependencies.onChange();
    }
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
    const control = input === "link"
      ? shellMarkup(29,escape(String(draft.get("url")??"")),areas.map(area=>shellMarkup(7,escape(area.id),draft.get("interest-area")===area.id?" selected":"",escape(area.title))).join(""))
      : input === "text"
      ? shellMarkup(2, escape(String(draft.get("content") ?? "")))
      : shellMarkup(3, shellMarkup(input === "documents" ? 21 : input === "pdf" ? 22 : 23), input === "images" ? "multiple" : "", input === "documents"
          ? ".txt,.md,.pptx"
          : input === "pdf"
          ? ".pdf"
          : ".png,.jpg,.jpeg,.webp,.gif", files.length ? "" : " required", shellMarkup(4, files.length ? "" : " hidden", files.map((file) => escape(/** @type {File} */ (file).name)).join(
              ", ",
            )));
    const reason = context?.reason ?? prefillReason;
    return shellMarkup(5, (!files.length && !String(draft.get("content") ?? draft.get("url") ?? "").trim() ? emptyArt("library") : "") + (reason ? shellMarkup(6, escape(reason)) : ""), escape(context?.source.id ?? ""), busy, escape(title), context !== null || input === "text" || input === "link" ? " required" : "", ["text", "documents", "pdf", "images", ...(context === null ? ["link"] : [])].map((value, index) =>
        shellMarkup(24 + index, input === value ? " selected" : "")
      ).join(""), control, input === "pdf"
        ? shellMarkup(8, draft.has("imageProcessing")
            ? draft.get("imageProcessing") === "on" ? " checked" : ""
            : "")
        : "", input === "pdf"
        ? shellMarkup(9, escape(String(draft.get("pageRange") ?? "")))
        : "", shellMarkup(input === "link" ? 37 : 38), context === null
        ? ""
        : shellMarkup(10), busy ? " disabled" : "", busy ? input === "link" ? shellMarkup(35) : "Uploading…" : input === "link" ? shellMarkup(36) : shellMarkup(20), escape(message));
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
      if (event.target === form.querySelector('[name="file"]')) dependencies.onChange();
    });
    choice?.addEventListener("change", () => {
      void select(choice.value);
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

const shellMarkup = createShellMarkup("upload-markup");

/** Project known typed failures to copy; retain gateway/server diagnostics internally.
 * @param {import("../source-library/gateway.js").SourceGatewayFailure} error */
function linkFailureMessage(error) {
  /** @type {Record<string,number>} */
  const messages = error.kind === "SourceGatewayRejected" ? {
    KnowledgePageAuthenticationRequired:41, KnowledgePagePaywallDetected:42,
    KnowledgePageBotAccessDenied:43, KnowledgePageRateLimited:44,
    KnowledgePageTypeUnsupported:45, SourceExtractionFormatUnsupported:45,
    KnowledgePageFetchFailed:46, KnowledgeBrowserNavigationFailed:46,
    KnowledgeBrowserTimedOut:47,
    KnowledgeBrowserNavigationRejected:48, KnowledgeBrowserNetworkRejected:48, SourceExtractionUrlInvalid:48,
  } : {
    SourceGatewayUnauthenticated:39, SourceGatewayUnauthorized:40,
    SourceGatewayResponseInvalid:50, SourceGatewayUnavailable:51,
    SourceGatewayTimedOut:52, SourceGatewayCommandInvalid:53,
  };
  const kind = error.kind === "SourceGatewayRejected" ? error.failureKind : error.kind;
  return shellMarkup(Object.hasOwn(messages,kind) ? messages[kind] : 49);
}
