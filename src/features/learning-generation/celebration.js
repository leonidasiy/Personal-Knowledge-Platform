// @ts-check
import { createShellMarkup } from "../../shell-markup.js";
const goalMarkup = createShellMarkup("learning-goal-markup");

/** @param {number} studied @param {number} remainingReview */
export function learningCelebrationMarkup(studied, remainingReview) {
  return goalMarkup(0, String(studied), remainingReview > 0 ? goalMarkup(2, String(remainingReview), remainingReview === 1 ? "" : "s") : goalMarkup(3));
}

/** @param {number} reviewed */
export function reviewCelebrationMarkup(reviewed) {
  return goalMarkup(4, String(reviewed), reviewed === 1 ? "" : "s");
}

/** @param {"learning" | "review"} kind @param {number} count @param {number} [remainingReview] */
export function showGoalCelebration(kind, count, remainingReview = 0) {
  const dialog = document.createElement("dialog");
  dialog.className = `learning-goal-dialog ${kind}-celebration`;
  dialog.setAttribute("aria-labelledby", `${kind}-goal-title`);
  dialog.setAttribute("aria-describedby", `${kind}-goal-description`);
  dialog.innerHTML = kind === "review" ? reviewCelebrationMarkup(count) : learningCelebrationMarkup(count, remainingReview);
  const returnFocus = document.querySelector(`[data-action='refresh-learner-${kind === "review" ? "review" : "feed"}']`);
  dialog.querySelector("[data-goal-dismiss]")?.addEventListener("click", () => dialog.close());
  dialog.querySelector("[data-goal-review]")?.addEventListener("click", () => dialog.close("review"));
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (dialog.returnValue !== "review" && returnFocus instanceof HTMLElement) returnFocus.focus();
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
}
