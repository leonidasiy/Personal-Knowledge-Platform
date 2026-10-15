// @ts-check
/** Original Resonance artwork; no third-party animation code or assets. */
const star = '<path d="M12 1c1.6 7 2.4 7.8 11 11-8.6 3.2-9.4 4-11 11C10.4 16 9.6 15.2 1 12 9.6 8.8 10.4 8 12 1Z"/>';

export function sparkIcon() { return `<svg class="spark-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${star}</svg>`; }

export function pendingSpark() {
  return `<span class="spark-pending" aria-hidden="true"><svg viewBox="0 0 56 32" focusable="false"><ellipse cx="28" cy="16" rx="24" ry="10"/><g class="spark-satellite"><path d="m28 3 3 9 10 4-10 4-3 9-3-9-10-4 10-4Z"/></g><circle class="spark-moon" cx="48" cy="10" r="3"/></svg></span>`;
}

/** @type {Map<HTMLElement, () => void>} */
const scenes = new Map();
const stopEvents = ["wheel", "touchmove", "keydown", "resize", "hashchange", "pagehide"];
/** @type {MutationObserver|null} */ let removalObserver = null;

export function cancelSparkEffects() {
  for (const dispose of [...scenes.values()]) dispose();
}

/** @param {HTMLElement} target @param {"answer"|"preference"|"card"} kind */
export function playSpark(target, kind) {
  if (!target.isConnected || document.documentElement.dataset.motion === "off" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  scenes.get(target)?.();
  const bounds = target.getBoundingClientRect();
  if (bounds.bottom <= 0 || bounds.top >= innerHeight) return;
  const layer = document.createElement("div");
  layer.className = `spark-layer spark-${kind}`;
  layer.setAttribute("aria-hidden", "true");
  const x = Math.max(120, Math.min(innerWidth - 120, bounds.right - 34));
  const y = Math.max(120, Math.min(innerHeight - 60, bounds.top - 16));
  layer.style.setProperty("--spark-x", `${x}px`);
  layer.style.setProperty("--spark-y", `${y}px`);
  const medal = kind === "answer"
    ? '<circle cx="24" cy="24" r="21"/><path class="spark-check" d="m13 24 8 8 15-17"/>'
    : `<g transform="translate(8 8) scale(1.35)">${star}</g>`;
  layer.innerHTML = `<div class="spark-scene"><svg class="spark-orbit" viewBox="0 0 240 180" focusable="false"><ellipse cx="120" cy="92" rx="65" ry="22"/><path class="spark-trail" d="M31 124C45 79 117 119 149 64S185 20 207 35"/></svg><svg class="spark-medal" viewBox="0 0 48 48" focusable="false">${medal}</svg>${Array.from({ length: 8 }, (_, i) => `<svg class="spark-fragment" viewBox="0 0 24 24" style="--spark-index:${i}" focusable="false">${i % 3 === 0 ? '<path d="M5 3h6v18H5z"/>' : star}</svg>`).join("")}</div>`;
  document.body.append(layer);
  const timer = setTimeout(dispose, 1600);
  function dispose() {
    clearTimeout(timer);
    layer.remove();
    scenes.delete(target);
    if (scenes.size !== 0) return;
    removalObserver?.disconnect();
    removalObserver = null;
    for (const event of stopEvents) window.removeEventListener(event, cancelSparkEffects, true);
  }
  scenes.set(target, dispose);
  if (scenes.size === 1) {
    removalObserver = new MutationObserver(() => {
      for (const [element, remove] of scenes) if (!element.isConnected) remove();
    });
    removalObserver.observe(document.body, { childList: true, subtree: true });
    for (const event of stopEvents) window.addEventListener(event, cancelSparkEffects, { capture: true, passive: true });
  }
}
