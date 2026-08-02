import type { Card, DateInput, Grade } from "./src/models.ts";

export const AGAIN: Grade;
export const GOOD: Grade;

export function createEmptyCard(now?: DateInput): Card;

export function createFocusedScheduler(
  requestRetention: number,
  maximumInterval: number,
  enableFuzz: boolean,
  enableShortTerm: boolean,
  learningSteps: readonly string[],
  relearningSteps: readonly string[],
): (card: Card, now: DateInput, rating: Grade) => Card;
