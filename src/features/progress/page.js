// @ts-check
import { createShellMarkup } from "../../shell-markup.js";
const progressMarkup = createShellMarkup("progress-markup");
import { SUBJECTS } from "../knowledge-subjects/public.js";
import { isProgressSummary } from "./public.js";

/** @param {{readonly fetch:typeof fetch,readonly baseUrl:string,readonly escapeHtml:(value:string)=>string,readonly onChange:()=>void}} dependencies */
export function createProgressPage(dependencies) {
  if (typeof dependencies?.fetch !== "function" || !URL.canParse(dependencies.baseUrl) || typeof dependencies.escapeHtml !== "function" || typeof dependencies.onChange !== "function") throw new TypeError("Progress page dependencies are invalid.");
  let state = /** @type {{kind:"idle"|"loading"|"ready"|"error",summary:import("./public.js").ProgressSummary|null,message:string,failure:"network"|"timeout"|"malformed"|null}} */({ kind: "idle", summary: null, message: "", failure: null });
  let days = 30, subject = "";
  let generation = 0;
  const change = () => dependencies.onChange();
  async function load() {
    const requestGeneration = ++generation;
    state = { ...state, kind: "loading", message: "", failure: null }; change();
    const url = new URL("api/learning-generation/progress", dependencies.baseUrl); url.searchParams.set("days", String(days)); if (subject) url.searchParams.set("subject", subject);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
    try { const response = await (0, dependencies.fetch)(url, { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store", signal: controller.signal }); if (!response.ok) throw new Error("network"); const body = await response.json(); if (!body || !isProgressSummary(body.result)) throw new Error("malformed"); if (requestGeneration === generation) state = { kind: "ready", summary: body.result, message: "", failure: null }; }
    catch (error) { if (!(error instanceof Error)) throw error; if (requestGeneration === generation) { const failure = error instanceof SyntaxError || error.message === "malformed" ? "malformed" : controller.signal.aborted ? "timeout" : "network"; state = { ...state, kind: "error", message: failure === "timeout" ? "Progress took too long to load. Try again." : failure === "malformed" ? "Progress data could not be read. Try again." : "Progress is unavailable right now. Try again.", failure }; } }
    finally { clearTimeout(timer); }
    if (requestGeneration === generation) change();
  }
  function render() {
    const e = dependencies.escapeHtml;
    if (state.kind === "loading") return progressMarkup(3);
    if (state.kind === "error") return progressMarkup(4, e(state.message));
    const controls = `<form class="progress-controls" data-progress-controls><label>Period<select name="days">${[7,30,90].map(n => `<option value="${n}"${n === days ? " selected" : ""}>${n} days</option>`).join("")}</select></label><label>Primary subject<select name="subject"><option value="">All subjects</option>${SUBJECTS.map(s => `<option value="${e(s.id)}"${s.id === subject ? " selected" : ""}>${e(s.label)}</option>`).join("")}</select></label><button class="button primary">Update</button></form>`;
    if (state.summary === null) return progressMarkup(2, progressMarkup(1), controls);
    const s = state.summary, accuracy = s.attempts.accuracy === null ? "Unavailable" : `${Math.round(s.attempts.accuracy * 100)}%`, score = s.attempts.averageScore === null ? "Unavailable" : `${Math.round(s.attempts.averageScore * 100)}%`;
    const empty = s.attempts.count === 0 ? progressMarkup(0) : "";
    const heading = progressMarkup(1);
    const metrics = `<div class="progress-summary"><div><span>Answer accuracy</span><strong>${accuracy}</strong><small>${s.attempts.correct}/${s.attempts.count} attempts</small></div><div><span>Average score</span><strong>${score}</strong><small>${s.attempts.scoredCount} scored attempts</small></div><div><span>Review attempts</span><strong>${s.attempts.count}</strong><small>One per question per batch</small></div></div>`;
    return `<section class="wide-view progress-page" aria-labelledby="progress-title">${heading}<div class="progress-toolbar"><p class="progress-note">${e(s.period.startedOn)} — ${e(s.period.endedOn)} · UTC</p>${controls}</div>${metrics}${empty}<div class="progress-charts"><div class="progress-timeline">${chart(e,"Daily accuracy",s.daily,"line")}</div><div>${chart(e,"Activity calendar",s.activity,"activity")}</div><div>${chart(e,"Review accuracy by subject",s.subjects,"subjects")}</div></div></section>`;
  }
  /** @param {HTMLElement} root */
  function bind(root) {
    const form = /** @type {HTMLFormElement|null} */(root.querySelector("[data-progress-controls]"));
    form?.addEventListener("submit", event => { event.preventDefault(); const values = new FormData(form); days = Number(values.get("days")); subject = String(values.get("subject") ?? ""); void load(); }, { once: true });
    root.querySelector("[data-action=retry-progress]")?.addEventListener("click", () => void load(), { once: true });
    for (const plot of root.querySelectorAll("[data-progress-chart]")) {
      const tooltip = /** @type {HTMLElement} */(plot.querySelector("[role=tooltip]"));
      /** @param {Event} event */
      const show = event => {
        const point = event.target instanceof Element ? event.target.closest("[data-chart-value]") : null;
        if (!point) return;
        for (const other of root.querySelectorAll("[role=tooltip]")) /** @type {HTMLElement} */(other).hidden = true;
        tooltip.textContent = point.getAttribute("data-chart-value"); tooltip.hidden = false;
        const anchor = point.getBoundingClientRect(), bounds = plot.getBoundingClientRect();
        tooltip.style.left = `${Math.max(0, Math.min(anchor.left + anchor.width / 2 - bounds.left - tooltip.offsetWidth / 2, bounds.width - tooltip.offsetWidth))}px`;
        tooltip.style.top = `${Math.max(0, (anchor.top >= tooltip.offsetHeight + 8 ? anchor.top - tooltip.offsetHeight - 8 : anchor.bottom + 8) - bounds.top)}px`;
      };
      plot.addEventListener("pointerover", show);
      plot.addEventListener("focusin", show);
      plot.addEventListener("click", show);
      plot.addEventListener("pointerout", event => { if (/** @type {PointerEvent} */(event).pointerType !== "touch") tooltip.hidden = true; });
      plot.addEventListener("focusout", () => { tooltip.hidden = true; });
      plot.addEventListener("scroll", () => { tooltip.hidden = true; }, true);
    }
    root.addEventListener("pointerdown", event => {
      if (event.target instanceof Element && event.target.closest("[data-chart-value]")) return;
      for (const tooltip of root.querySelectorAll("[role=tooltip]")) /** @type {HTMLElement} */(tooltip).hidden = true;
    });
    root.addEventListener("keydown", event => {
      if (event.key === "Escape") for (const tooltip of root.querySelectorAll("[role=tooltip]")) /** @type {HTMLElement} */(tooltip).hidden = true;
    });
  }
  return freeze({ load, render, bind });
}
/** @param {(value:string)=>string} e @param {string} title @param {readonly any[]} rows @param {"line"|"subjects"|"activity"} kind */
function chart(e, title, rows, kind) {
  const id = `progress-${kind}-value`;
  /** @param {string} value */
  const point = value => `tabindex="0" role="img" aria-label="${e(value)}" data-chart-value="${e(value)}"`;
  let marks = "", caption = "", plot = "";
  if (kind === "subjects") {
    plot = rows.length ? `<div class="progress-subject-bars">${rows.map(r => `<div ${point(`${r.label}: ${r.accuracy === null ? "No review attempts" : `${percent(r.accuracy)} accuracy`}`)}><span>${e(r.label)}</span>${r.accuracy === null ? '<small>No review attempts</small>' : `<span class="progress-subject-bar" style="--bar-width:${r.accuracy*100}%" aria-hidden="true"></span>`}</div>`).join("")}</div>` : '<p>No classified knowledge points for this selection.</p>';
    caption = "Accuracy for the selected period. The five largest subject areas, ordered by knowledge points.";
  } else if (kind === "activity") {
    const max = Math.max(1, ...rows.map(r => r.studyBatches + r.reviewAttempts)), columns = Math.ceil(rows.length / 7), width = 600 / columns;
    marks = rows.map((r,i) => {
      const total = r.studyBatches + r.reviewAttempts;
      const value = `${r.date}: ${r.studyItems} knowledge points studied in ${r.studyBatches} batches, ${r.reviewAttempts} quiz attempts`;
      return `<g ${point(value)}><rect x="${10+Math.floor(i/7)*width}" y="${8+i%7*26}" width="${width-4}" height="22" fill="currentColor" opacity="${total === 0 ? .1 : .25+.75*total/max}"/></g>`;
    }).join("");
    plot = `<svg viewBox="0 0 620 196" aria-label="${e(title)} chart">${marks}</svg>`;
    caption = "Stronger shading means more study and review activity.";
  } else {
    if (!rows.some(r => r.count > 0)) return progressMarkup(5, e(title), progressMarkup(6));
    const x = (/** @type {number} */ i) => `${10+i*85/Math.max(1,rows.length-1)}%`, y = (/** @type {number} */ n) => 135-n*120;
    for (let i=0;i<rows.length;i++) {
      const r=rows[i], previous=rows[i-1];
      if (r.accuracy === null) continue;
      if (previous?.accuracy != null) marks += `<line x1="${x(i-1)}" y1="${y(previous.accuracy)}" x2="${x(i)}" y2="${y(r.accuracy)}" stroke="currentColor" stroke-width="2" pointer-events="none"/>`;
      const value = `${r.date}: ${percent(r.accuracy)} accuracy, ${r.correct}/${r.count} correct answers`;
      marks += `<g ${point(value)}><circle cx="${x(i)}" cy="${y(r.accuracy)}" r="12" fill="transparent"/><circle cx="${x(i)}" cy="${y(r.accuracy)}" r="4" fill="currentColor"/></g>`;
    }
    marks += `<g font-size="11" fill="currentColor"><text x="0" y="20">100%</text><text x="12" y="137">0%</text><text x="10%" y="160">${e(rows[0]?.date ?? "")}</text><text x="95%" y="160" text-anchor="end">${e(rows.at(-1)?.date ?? "")}</text></g>`;
    plot = `<div class="progress-plot"><svg height="170" style="min-width:${rows.length*28}px" aria-label="${e(title)} chart">${marks}</svg></div>`;
    caption = "Answer accuracy by day. Gaps mean no attempts.";
  }
  return `<section class="progress-chart" data-progress-chart><h2>${e(title)}</h2>${plot}<p>${e(caption)}</p><div class="progress-tooltip" id="${id}" role="tooltip" hidden></div></section>`;
}
/** @param {number|null} value */
function percent(value) { return value === null ? "Unavailable" : `${Math.round(value * 10000) / 100}%`; }
const freeze = Object.freeze;
