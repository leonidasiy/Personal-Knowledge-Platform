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
    const metrics = `<div class="progress-summary"><div><span>Answer accuracy</span><strong>${accuracy}</strong><small>${s.attempts.correct}/${s.attempts.count} attempts</small></div><div><span>Average score</span><strong>${score}</strong><small>${s.attempts.scoredCount} scored attempts</small></div><div><span>Review attempts</span><strong>${s.attempts.count}</strong><small>One per question per batch</small></div><div><span>Recovery after error</span><strong>${percent(s.recovery.accuracy)}</strong><small>${s.recovery.recovered}/${s.recovery.eligible} eligible revisits</small></div></div>`;
    return `<section class="wide-view progress-page" aria-labelledby="progress-title">${heading}<div class="progress-toolbar"><p class="progress-note">${e(s.period.startedOn)} — ${e(s.period.endedOn)} · UTC</p>${controls}</div>${metrics}${empty}<div class="progress-charts"><div>${chart(e,"Daily accuracy",s.daily,"line")}${table(e,"Daily accuracy", ["Date","Correct","Attempts","Accuracy"], s.daily.map(r => [r.date,r.correct,r.count,percent(r.accuracy)]))}</div><div>${chart(e,"Spacing intervals",s.intervals,"bar")}${table(e,"Spacing intervals", ["Interval","Correct","Attempts","Accuracy"], s.intervals.map(r => [r.label,r.correct,r.count,percent(r.accuracy)]))}</div><div>${chart(e,"Activity calendar",s.activity,"activity")}${table(e,"Activity", ["Date","Study batches","Items studied","Review attempts"], s.activity.map(r => [r.date,r.studyBatches,r.studyItems,r.reviewAttempts]))}</div><div class="progress-subjects">${chart(e,"Primary subjects",s.subjects,"bar")}${table(e,"Primary subjects", ["Subject","Correct","Attempts","Accuracy"], s.subjects.map(r => [r.label,r.correct,r.count,percent(r.accuracy)]))}</div></div><div class="progress-observations"><section><h2>Recovery after an incorrect answer</h2><p>Recovery after a prior incorrect attempt and at least one elapsed day: ${s.recovery.recovered}/${s.recovery.eligible} (${percent(s.recovery.accuracy)}).</p></section><section><h2>Recorded activity</h2><p>Activity records show completed study batches and review attempts. They do not measure mastery or transfer.</p></section></div></section>`;
  }
  /** @param {HTMLElement} root */
  function bind(root) { const form = /** @type {HTMLFormElement|null} */(root.querySelector("[data-progress-controls]")); form?.addEventListener("submit", event => { event.preventDefault(); const values = new FormData(form); days = Number(values.get("days")); subject = String(values.get("subject") ?? ""); void load(); }, { once: true }); root.querySelector("[data-action=retry-progress]")?.addEventListener("click", () => void load(), { once: true }); }
  return freeze({ load, render, bind });
}
/** @param {(value:string)=>string} escapeHtml @param {string} title @param {string[]} headings @param {(string|number)[][]} rows */
function table(escapeHtml, title, headings, rows) { return `<details class="progress-table"><summary>${escapeHtml(title)} data table</summary><table><thead><tr>${headings.map(h => `<th scope="col">${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${escapeHtml(String(value))}</td>`).join("")}</tr>`).join("")}</tbody></table></details>`; }
/** @param {(value:string)=>string} e @param {string} title @param {readonly any[]} rows @param {"line"|"bar"|"activity"} kind */
function chart(e, title, rows, kind) {
  const label = (/** @type {{label?:string,date?:string}} */ r) => r.label ?? r.date ?? "";
  let marks = "", caption = "", dimensions = 'viewBox="0 0 620 170"';
  if (kind !== "activity" && !rows.some(r => r.count > 0)) return progressMarkup(5, e(title), progressMarkup(kind === "line" ? 6 : title === "Spacing intervals" ? 7 : 8));
  if (kind === "activity") {
    const max = Math.max(1, ...rows.map(r => r.studyBatches + r.reviewAttempts));
    const columns = Math.ceil(rows.length / 7), size = Math.min(19, 580 / columns);
    dimensions = `viewBox="36 4 ${columns * size + 8} 140" style="max-width:${columns * size * 1.6 + 12}px"`;
    marks = rows.map((r,i) => {
      const total = r.studyBatches + r.reviewAttempts;
      return `<rect x="${40+Math.floor(i/7)*size}" y="${8+i%7*size}" width="${size-3}" height="${size-3}" fill="currentColor" opacity="${total === 0 ? .1 : .25+.75*total/max}"><title>${e(r.date)}: ${r.studyBatches} study batches, ${r.reviewAttempts} attempts</title></rect>`;
    }).join("");
    caption = `${rows[0]?.date} – ${rows.at(-1)?.date} · darker cells mean more recorded activity, not better recall.`;
  } else if (kind === "line") {
    const x = (/** @type {number} */ i) => 40+i*550/Math.max(1,rows.length-1), y = (/** @type {number} */ n) => 135-n*120;
    /** @type {string[]} */ let segment = [];
    const flush = () => { if (segment.length > 1) marks += `<polyline points="${segment.join(" ")}" fill="none" stroke="currentColor" stroke-width="2"/>`; segment = []; };
    for (let i=0;i<rows.length;i++) {
      const r=rows[i];
      if (r.accuracy === null) { flush(); continue; }
      segment.push(`${x(i)},${y(r.accuracy)}`);
      marks += `<circle cx="${x(i)}" cy="${y(r.accuracy)}" r="3" fill="currentColor"><title>${e(label(r))}: ${percent(r.accuracy)} · ${r.correct}/${r.count}</title></circle>`;
    }
    flush();
    marks += `<g font-size="11" fill="currentColor"><text x="0" y="20">100%</text><text x="12" y="137">0%</text><text x="40" y="160">${e(rows[0]?.date ?? "")}</text><text x="590" y="160" text-anchor="end">${e(rows.at(-1)?.date ?? "")}</text></g>`;
    caption = "Full-credit answers / recorded attempts. Gaps mean no attempts; they are not zero scores.";
  } else {
    const active = rows.filter(r => r.count > 0);
    if (active.length === 0) return progressMarkup(5, e(title), "");
    const step = 550 / active.length, width = Math.min(52,step*.7);
    marks = active.map((r,i) => {
      const x=40+i*step, short=String(label(r)).split(" ")[0].slice(0,12);
      return `<rect x="${x}" y="${135-r.accuracy*110}" width="${width}" height="${r.accuracy*110}" fill="currentColor"><title>${e(label(r))}: ${percent(r.accuracy)} · ${r.correct}/${r.count}</title></rect><g font-size="10" fill="currentColor"><text x="${x}" y="${125-r.accuracy*110}">${percent(r.accuracy)}</text><text x="${x}" y="155">${e(short)}</text></g>`;
    }).join("");
    caption = "Answer accuracy by group. Empty groups are omitted; exact counts and full labels are in the data table.";
  }
  return `<section class="progress-chart"><h2>${e(title)}</h2><svg ${dimensions} role="img" aria-label="${e(title)} chart">${marks}</svg><p>${e(caption)}</p></section>`;
}
/** @param {number|null} value */
function percent(value) { return value === null ? "Unavailable" : `${Math.round(value * 100)}%`; }
const freeze = Object.freeze;
