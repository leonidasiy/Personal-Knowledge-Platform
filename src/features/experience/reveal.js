// @ts-check
/** Content is visible by default; observation adds a one-time entrance.
 * @param {HTMLElement} root @param {Set<string>} seen
 * @param {typeof IntersectionObserver|null} Observer
 * @returns {IntersectionObserver|null}
 */
export function revealCards(root, seen, Observer) {
  if (Observer === null) return null;
  const observer = new Observer(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting || !(entry.target instanceof HTMLElement)) continue;
      const key = entry.target.dataset.reveal;
      if (key && !seen.has(key)) {
        seen.add(key);
        entry.target.classList.add("reveal-enter");
      }
      observer.unobserve(entry.target);
    }
  }, { threshold: 0, rootMargin: "0px 0px -24px 0px" });
  for (const element of root.querySelectorAll("[data-reveal]")) {
    if (element instanceof HTMLElement && !seen.has(element.dataset.reveal ?? "")) observer.observe(element);
  }
  return observer;
}
