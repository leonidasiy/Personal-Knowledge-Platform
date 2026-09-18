// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/** @typedef {{ readonly kind: "PrivateDocumentCommandInvalid" } | { readonly kind: "PrivateDocumentNotFound" } | { readonly kind: "PrivateDocumentNotPrivate" } | { readonly kind: "PrivateDocumentDisabled" } | { readonly kind: "PrivateDocumentSourceReadFailed" } | { readonly kind: "PrivateDocumentWorkflowReadFailed" } | { readonly kind: "PrivateDocumentMaterialReadFailed" } | { readonly kind: "PrivateDocumentContentReadFailed" }} PrivateDocumentReadFailure */

/** @typedef {{readonly id:string,readonly ownerId:string,readonly origin?:string,readonly state:string,readonly title:string,readonly revision:number,readonly canonicalUrl:string}} PrivateSource */
/** @typedef {{readonly ownerId:string,readonly runId:string,readonly sourceId:string,readonly sourceRevision:number,readonly state:string}} PrivateRun */
/** @typedef {{readonly ownerId:string,readonly runId:string,readonly objectKey:string,readonly material:{readonly sourceId:string,readonly sourceRevision:number,readonly sourceUrl:string,readonly fileName:string,readonly mediaType:string}}} PrivateMaterial */
/** @typedef {{ readonly source: { read: (ownerId:string,sourceId:string)=>Promise<Result<PrivateSource|null,unknown>> }, readonly workflow: { latest: (ownerId:string,sourceId:string,sourceRevision:number)=>Promise<Result<PrivateRun|null,unknown>> }, readonly material: { read: (ownerId:string,runId:string)=>Promise<Result<PrivateMaterial|null,unknown>> }, readonly content: { read: (ownerId:string,objectKey:string)=>Promise<Result<Uint8Array,unknown>> }}} PrivateDocumentReadDependencies */
/** @param {PrivateDocumentReadDependencies} dependencies */
export function createPrivateDocumentReadService(dependencies) {
  if (typeof dependencies?.source?.read !== "function" || typeof dependencies.workflow?.latest !== "function" || typeof dependencies.material?.read !== "function" || typeof dependencies.content?.read !== "function") throw new TypeError("Private document read dependencies are invalid.");
  return Object.freeze({
    /** @param {unknown} command @returns {Promise<Result<{readonly status:"pending",readonly title:string,readonly sourceId:string,readonly runId:string|null}|{readonly status:"attached",readonly title:string,readonly sourceId:string,readonly runId:string,readonly fileName:string,readonly mediaType:string,readonly bytes:Uint8Array}, PrivateDocumentReadFailure>>} */
    async read(command) {
      const value = /** @type {{ ownerId?: unknown, sourceId?: unknown }} */ (command);
      if (typeof value?.ownerId !== "string" || value.ownerId.trim() === "" || typeof value.sourceId !== "string" || value.sourceId.trim() === "") return { ok: false, error: { kind: "PrivateDocumentCommandInvalid" } };
      const ownerId = value.ownerId.trim();
      const sourceId = value.sourceId.trim();
      const source = await dependencies.source.read(ownerId, sourceId);
      if (!source.ok) return { ok: false, error: { kind: "PrivateDocumentSourceReadFailed" } };
      if (source.value === null) return { ok: false, error: { kind: "PrivateDocumentNotFound" } };
      if (source.value.ownerId !== ownerId || source.value.id !== sourceId) return { ok: false, error: { kind: "PrivateDocumentNotFound" } };
      if (source.value.origin !== "private-document") return { ok: false, error: { kind: "PrivateDocumentNotPrivate" } };
      if (source.value.state !== "active") return { ok: false, error: { kind: "PrivateDocumentDisabled" } };
      const latest = await dependencies.workflow.latest(ownerId, source.value.id, source.value.revision);
      if (!latest.ok) return { ok: false, error: { kind: "PrivateDocumentWorkflowReadFailed" } };
      if (latest.value === null) return { ok: true, value: { status: "pending", title: source.value.title, sourceId: source.value.id, runId: null } };
      if (latest.value.ownerId !== ownerId || latest.value.sourceId !== source.value.id || latest.value.sourceRevision !== source.value.revision) return { ok: false, error: { kind: "PrivateDocumentWorkflowReadFailed" } };
      const material = await dependencies.material.read(ownerId, latest.value.runId);
      if (!material.ok) return { ok: false, error: { kind: "PrivateDocumentMaterialReadFailed" } };
      if (material.value === null) return { ok: true, value: { status: "pending", title: source.value.title, sourceId: source.value.id, runId: latest.value.runId } };
      if (material.value.ownerId !== ownerId || material.value.runId !== latest.value.runId || material.value.material.sourceId !== source.value.id || material.value.material.sourceRevision !== source.value.revision || material.value.material.sourceUrl !== source.value.canonicalUrl) return { ok: false, error: { kind: "PrivateDocumentMaterialReadFailed" } };
      const content = await dependencies.content.read(ownerId, material.value.objectKey);
      if (!content.ok) return { ok: false, error: { kind: "PrivateDocumentContentReadFailed" } };
      return { ok: true, value: { status: "attached", title: source.value.title, sourceId: source.value.id, runId: latest.value.runId, fileName: material.value.material.fileName, mediaType: material.value.material.mediaType, bytes: content.value } };
    },
  });
}
