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
        entry.target.addEventListener("animationend", () => seen.add(key), { once: true });
        entry.target.classList.remove("reveal-pending");
        entry.target.classList.add("reveal-enter");
      }
      observer.unobserve(entry.target);
    }
  }, { threshold: 0, rootMargin: "0px 0px -96px 0px" });
  for (const element of root.querySelectorAll("[data-reveal]")) {
    if (element instanceof HTMLElement && !seen.has(element.dataset.reveal ?? "")) {
      element.classList.add("reveal-pending");
      observer.observe(element);
    }
  }
  return observer;
}
