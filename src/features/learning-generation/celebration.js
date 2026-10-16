// @ts-check
import { createShellMarkup } from "../../shell-markup.js";
const goalMarkup = createShellMarkup("learning-goal-markup");

import { sparkIcon } from "../experience/spark.js";

/** @param {number} studied @param {number} remainingReview */
export function learningCelebrationMarkup(studied, remainingReview) {
  const stars = Array.from({ length: 8 }, (_, index) => goalMarkup(1, String(index), sparkIcon())).join("");
  return goalMarkup(0, stars, String(studied), remainingReview > 0 ? goalMarkup(2, String(remainingReview), remainingReview === 1 ? "" : "s") : goalMarkup(3));
}

/** @param {number} studied @param {number} remainingReview */
export function showLearningCelebration(studied, remainingReview) {
  const dialog = document.createElement("dialog");
  dialog.className = "learning-goal-dialog";
  dialog.setAttribute("aria-labelledby", "learning-goal-title");
  dialog.setAttribute("aria-describedby", "learning-goal-description");
  dialog.innerHTML = learningCelebrationMarkup(studied, remainingReview);
  const returnFocus = document.querySelector("[data-action='refresh-learner-feed']");
  dialog.querySelector("[data-goal-dismiss]")?.addEventListener("click", () => dialog.close());
  dialog.querySelector("[data-goal-review]")?.addEventListener("click", () => dialog.close("review"));
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (dialog.returnValue !== "review" && returnFocus instanceof HTMLElement) returnFocus.focus();
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
}
