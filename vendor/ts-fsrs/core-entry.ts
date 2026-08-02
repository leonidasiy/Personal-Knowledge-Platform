/*! ts-fsrs v5.4.1 (FSRS-6.0) focused browser entry | MIT | See ./LICENSE */
import { FSRSAlgorithm } from "./src/algorithm.ts";
import { createEmptyCard, generatorParameters } from "./src/default.ts";
import BasicScheduler from "./src/impl/basic_scheduler.ts";
import { Rating } from "./src/models.ts";
import type { Card, DateInput, FSRSParameters, Grade } from "./src/models.ts";

export { createEmptyCard };
export const AGAIN = Rating.Again;
export const GOOD = Rating.Good;

export function createFocusedScheduler(
  requestRetention: number,
  maximumInterval: number,
  enableFuzz: boolean,
  enableShortTerm: boolean,
  learningSteps: FSRSParameters["learning_steps"],
  relearningSteps: FSRSParameters["relearning_steps"],
) {
  const algorithm = new FSRSAlgorithm(generatorParameters({
    request_retention: requestRetention,
    maximum_interval: maximumInterval,
    enable_fuzz: enableFuzz,
    enable_short_term: enableShortTerm,
    learning_steps: learningSteps,
    relearning_steps: relearningSteps,
  }));
  return (card: Card, now: DateInput, rating: Grade) =>
    new BasicScheduler(card, now, algorithm).review(rating).card;
}
