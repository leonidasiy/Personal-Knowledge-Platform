// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/**
 * Run a Workflow step from the authoritative D1 snapshot. Workflow retries
 * replay the callback, so a closure-captured run is unsafe for persistence
 * work. Reloading inside the callback makes a completed replay a typed no-op.
 *
 * @template Run, Value, LoadError, ExecuteError
 * @param {{
 *   readonly step: { readonly do: <T>(name: string, callback: () => Promise<T>) => Promise<T> },
 *   readonly name: string,
 *   readonly load: () => Promise<Result<Run, LoadError>>,
 *   readonly execute: (run: Run) => Promise<Result<Value, ExecuteError>>,
 * }} dependencies
 * @returns {Promise<Result<Value, LoadError | ExecuteError>>}
 */
export async function executeAuthoritativeWorkflowStep(dependencies) {
  if (typeof dependencies?.step?.do !== "function" || typeof dependencies.name !== "string" || dependencies.name.trim() === "" || typeof dependencies.load !== "function" || typeof dependencies.execute !== "function") throw new TypeError("Authoritative Workflow step dependencies are invalid.");
  return dependencies.step.do(dependencies.name, async () => {
    const loaded = await dependencies.load();
    if (!loaded.ok) return loaded;
    return dependencies.execute(loaded.value);
  });
}
