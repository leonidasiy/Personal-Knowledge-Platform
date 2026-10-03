// @ts-check
/** @param {string} hash @param {string} search */
export function parseAppRoute(hash, search) {
  if (!hash) {
    const view = new URLSearchParams(search).get("view");
    if (view === "library" || view === "review") {
      return { view, discoveryItemId: null };
    }
  }
  const [view, section, rawPromptId] = hash.split("?", 1)[0].replace(/^#/, "")
    .split("/");
  let discoveryItemId = null;
  if (view === "discover" && section === "item" && rawPromptId) {
    try {
      discoveryItemId = decodeURIComponent(rawPromptId);
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
      discoveryItemId = null;
    }
  }
  return {
    view: view === "discover" || view === "review" || view === "library" ||
        view === "progress" || view === "settings" || view === "upload"
      ? view
      : "feed",
    discoveryItemId,
  };
}

/** @param {"feed" | "discover" | "review" | "library" | "progress" | "upload"} view @param {string} label @param {string} activeView @param {boolean} [hasNotification] */
export function renderNavigationButton(
  view,
  label,
  activeView,
  hasNotification = false,
) {
  const active = activeView === view;
  const icon = {
    feed: "m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z",
    discover: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-6-3-2 4-4 2 2-4Z",
    review: "M4 9a8 8 0 1 1 0 7M4 3v6h6m2-2v5l3 2",
    library: "M3 4h7v16H3Zm11 0h7v16h-7ZM3 8h7m4 0h7",
    upload: "M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5",
    progress: "M3 3v18h18M6 15l4-5 4 3 6-8",
  }[view];
  return `
    <button type="button" data-view="${view}" data-focus-key="nav-${view}" class="${
    active ? "active" : ""
  }" ${active ? 'aria-current="page"' : ""}>
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icon}"/></svg><span class="nav-label">${
    label.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  }</span>${
    hasNotification
      ? '<span class="nav-notification-dot" aria-label="Review due"></span>'
      : ""
  }
    </button>
  `;
}
