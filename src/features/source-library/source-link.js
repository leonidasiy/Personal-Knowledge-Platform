// @ts-check

/** Local document identities are stable; their links use the current authenticated backend.
 * @param {string} value @returns {string} */
export function sourceHref(value) {
  return value.replace(/^https:\/\/local-resonance\.invalid(?=\/api\/private-documents\/)/u, "");
}
