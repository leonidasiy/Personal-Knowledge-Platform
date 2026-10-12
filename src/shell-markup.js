// @ts-check

/** Static markup comes from the cached shell; callers escape inserted values.
 * @param {string} id
 * @returns {(index:number,...values:(string|boolean|number)[])=>string} */
export function createShellMarkup(id) {
  /** @param {number} index @param {(string|boolean|number)[]} values */
  return function (index, ...values) {
    const content = document.getElementById(id)?.textContent;
    const parts = content ? JSON.parse(content)[index] : null;
    if (!Array.isArray(parts) || parts.length !== values.length + 1 || parts.some(part => typeof part !== "string")) {
      throw new TypeError(`ShellMarkup${content ? "Invalid" : "Unavailable"}:${id}`);
    }
    return parts.slice(1).reduce((html, part, slot) => html + values[slot] + part, parts[0]);
  };
}
