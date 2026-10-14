// @ts-check

/** Decorative artwork; the surrounding heading and guidance describe the state.
 * @param {"feed"|"discover"|"library"|"review"|"upload"|"progress"} scene */
export function emptyArt(scene) {
  return `<svg class="empty-art" width="360" height="195" viewBox="0 0 480 260" aria-hidden="true" focusable="false"><use href="./assets/empty-states.svg#${scene}"></use></svg>`;
}
