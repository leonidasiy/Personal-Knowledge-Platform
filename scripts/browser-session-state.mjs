// @ts-check

/** @typedef {{ readonly cookies: readonly unknown[], readonly origins: readonly unknown[] }} BrowserSessionState */
/** @typedef {{ readonly ok: true, readonly value: BrowserSessionState } | { readonly ok: false, readonly error: { readonly kind: "BrowserAcceptanceSessionStateMissing" | "BrowserAcceptanceSessionStateUnreadable" | "BrowserAcceptanceSessionStateMalformed" } }} LoadResult */
/** @typedef {{ readonly ok: true } | { readonly ok: false, readonly error: { readonly kind: "BrowserAcceptanceSessionStateWriteFailed" } }} SaveResult */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null; }
/** @param {unknown} value */
function errorCode(value) { return record(value) && typeof value.code === "string" ? value.code : ""; }
/** @param {unknown} value */
function validPath(value) { return typeof value === "string" && value.startsWith("/") && !value.split("/").includes("..") && value.endsWith("/storage-state.json"); }
/** @param {string} path */
function parentDirectory(path) { return path.slice(0, path.lastIndexOf("/")); }
/** @param {unknown} value */
function isolateState(value) {
  if (!record(value) || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) return null;
  return Object.freeze({ cookies: Object.freeze([...value.cookies]), origins: Object.freeze([...value.origins]) });
}

/**
 * @param {unknown} path
 * @param {unknown} [fileSystem]
 * @returns {Promise<LoadResult>}
 */
export async function loadBrowserSessionState(path, fileSystem) {
  if (!validPath(path) || !record(fileSystem) || typeof fileSystem.readFile !== "function") return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceSessionStateMalformed" }) };
  let serialized;
  try { serialized = await fileSystem.readFile(path, "utf8"); }
  catch (error) { return { ok: false, error: Object.freeze({ kind: errorCode(error) === "ENOENT" ? "BrowserAcceptanceSessionStateMissing" : "BrowserAcceptanceSessionStateUnreadable" }) }; }
  if (typeof serialized !== "string") return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceSessionStateMalformed" }) };
  let parsed;
  try { parsed = JSON.parse(serialized); } catch { return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceSessionStateMalformed" }) }; }
  const state = isolateState(parsed);
  return state === null ? { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceSessionStateMalformed" }) } : { ok: true, value: state };
}

/**
 * @param {unknown} path
 * @param {unknown} state
 * @param {unknown} [fileSystem]
 * @param {() => string} [createId]
 * @returns {Promise<SaveResult>}
 */
export async function saveBrowserSessionState(path, state, fileSystem, createId) {
  const isolated = isolateState(state);
  if (!validPath(path) || isolated === null || !record(fileSystem) || typeof fileSystem.mkdir !== "function" || typeof fileSystem.chmod !== "function" || typeof fileSystem.writeFile !== "function" || typeof fileSystem.rename !== "function" || typeof fileSystem.rm !== "function" || typeof createId !== "function") return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceSessionStateWriteFailed" }) };
  let temporary = "";
  try {
    const storagePath = /** @type {string} */ (path);
    const directory = parentDirectory(storagePath);
    const id = createId();
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error();
    temporary = `${storagePath}.tmp-${id}`;
    await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
    await fileSystem.chmod(directory, 0o700);
    await fileSystem.writeFile(temporary, JSON.stringify(isolated), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fileSystem.chmod(temporary, 0o600);
    await fileSystem.rename(temporary, storagePath);
    temporary = "";
    await fileSystem.chmod(storagePath, 0o600);
    return { ok: true };
  } catch {
    if (temporary !== "") try { await fileSystem.rm(temporary, { force: true }); } catch {}
    return { ok: false, error: Object.freeze({ kind: "BrowserAcceptanceSessionStateWriteFailed" }) };
  }
}
