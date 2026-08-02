// @ts-check

/** @import { Choice, Grade, Question, QuestionFailure, QuestionResponse, Result } from "./contracts.js" */

export class LocalQuestionGrader {
  /** @type {(questionId: string) => Question | null} */
  #resolveQuestion;

  /**
   * @param {{ readonly resolveQuestion?: (questionId: string) => Question | null }} [dependencies]
   */
  constructor(dependencies = {}) {
    this.#resolveQuestion = dependencies.resolveQuestion ?? (() => null);
  }

  /**
   * @param {unknown} questionDocument
   * @param {unknown} responseDocument
   * @returns {Result<Grade, QuestionFailure>}
   */
  grade(questionDocument, responseDocument) {
    const validQuestion = validateQuestion(questionDocument);
    if (!validQuestion.ok) return validQuestion;
    const question = validQuestion.value;
    if (
      !isRecord(responseDocument) || typeof responseDocument.kind !== "string"
    ) {
      return invalidResponse("document");
    }
    const response = /** @type {QuestionResponse} */ (responseDocument);

    if (
      question.kind === "single-choice" || question.kind === "multiple-choice"
    ) {
      if (response.kind !== "choice") return mismatch("choice");
      if (
        !Array.isArray(response.selectedChoiceIds) ||
        response.selectedChoiceIds.length === 0 ||
        !response.selectedChoiceIds.every((/** @type {string} */ id) =>
          typeof id === "string" && id.trim() !== ""
        )
      ) return invalidResponse("selectedChoiceIds");
      const available = new Set(
        question.choices.map((/** @type {Choice} */ choice) => choice.id),
      );
      for (const choiceId of response.selectedChoiceIds) {
        if (!available.has(choiceId)) {
          return { ok: false, error: { kind: "ChoiceUnknown", choiceId } };
        }
      }
      return grade(
        arraysEqual(
            uniqueSorted(response.selectedChoiceIds),
            uniqueSorted(question.correctChoiceIds),
          )
          ? "correct"
          : "incorrect",
        [],
        question.explanation,
      );
    }

    if (question.kind === "fill-blank") {
      if (response.kind !== "fill") return mismatch("fill");
      if (
        response.blankId !== question.blankId ||
        typeof response.text !== "string"
      ) return invalidResponse("blankId");
      const normalizedResponse = normalize(response.text);
      if (normalizedResponse === "") return invalidResponse("text");
      return grade(
        question.acceptedAnswers.some((/** @type {string} */ answer) =>
            normalize(answer) === normalizedResponse
          )
          ? "correct"
          : "incorrect",
        [],
        question.explanation,
      );
    }

    if (question.kind === "case-study") {
      if (response.kind !== "case-study") return mismatch("case-study");
      if (
        !Array.isArray(response.childResponses) ||
        response.childResponses.length !== question.childQuestionIds.length ||
        !response.childResponses.every((/** @type {unknown} */ item) =>
          isRecord(item) && nonEmpty(item.questionId) &&
          isRecord(item.response) &&
          typeof item.response.kind === "string" &&
          item.response.kind !== "case-study"
        )
      ) return invalidResponse("childResponses");
      const byId = new Map(response.childResponses.map((
        /** @type {{ readonly questionId: string, readonly response: Exclude<QuestionResponse, { readonly kind: "case-study" }> }} */ item,
      ) => [
        item.questionId,
        item.response,
      ]));
      if (byId.size !== response.childResponses.length) {
        return invalidResponse("childResponses");
      }
      /** @type {Grade[]} */
      const childGrades = [];
      for (const questionId of question.childQuestionIds) {
        const child = this.#resolveQuestion(questionId);
        if (child === null || child.kind === "case-study") {
          return {
            ok: false,
            error: { kind: "QuestionReferenceUnknown", questionId },
          };
        }
        const childResponse = byId.get(questionId);
        if (childResponse === undefined) {
          return invalidResponse("childResponses");
        }
        const result = this.grade(child, childResponse);
        if (!result.ok) return result;
        childGrades.push(result.value);
      }
      const status = childGrades.some((item) => item.status === "incorrect")
        ? "incorrect"
        : childGrades.some((item) => item.status === "review-required")
        ? "review-required"
        : "correct";
      return grade(
        status,
        childGrades.flatMap((item) => item.matchedConcepts),
        question.explanation,
      );
    }

    if (response.kind !== "text") return mismatch("text");
    if (typeof response.text !== "string") return invalidResponse("text");
    const normalizedResponse = normalize(response.text);
    if (normalizedResponse === "") return invalidResponse("text");
    const matchedConcepts = question.expectedConcepts.filter((
      /** @type {string} */ concept,
    ) => includesPhrase(normalizedResponse, normalize(concept)));
    const wordCount = normalizedResponse.split(" ").filter(Boolean).length;
    const status =
      matchedConcepts.length === question.expectedConcepts.length &&
        wordCount >= question.minimumWords
        ? "correct"
        : wordCount < question.minimumWords
        ? "incorrect"
        : "review-required";
    return grade(status, matchedConcepts, question.explanation);
  }
}

/**
 * @param {unknown} value
 * @returns {Result<Question, QuestionFailure>}
 */
function validateQuestion(value) {
  if (!isRecord(value)) return invalidQuestion("document");
  const kind = value.kind;
  if (
    kind !== "single-choice" && kind !== "multiple-choice" &&
    kind !== "fill-blank" && kind !== "free-response" &&
    kind !== "case-study"
  ) {
    return {
      ok: false,
      error: {
        kind: "QuestionKindUnsupported",
        value: typeof kind === "string" ? kind : "",
      },
    };
  }
  if (
    !nonEmpty(value.id) || !nonEmpty(value.prompt) ||
    !nonEmpty(value.explanation) || !positiveInteger(value.version) ||
    !positiveInteger(value.contentVersion) ||
    !nonEmpty(value.contentId) || !nonEmpty(value.scorerVersion) ||
    !nonEmpty(value.generatorVersion) || !nonEmpty(value.provenance) ||
    !nonEmptyStrings(value.knowledgeUnitIds) ||
    !nonEmptyStrings(value.sourceAnchorIds)
  ) return invalidQuestion("metadata");
  const question = /** @type {Question} */ (value);

  if (kind === "single-choice" || kind === "multiple-choice") {
    if (
      !Array.isArray(question.choices) || question.choices.length < 2 ||
      question.choices.some((/** @type {Choice} */ choice) =>
        !isRecord(choice) || !nonEmpty(choice.id) || !nonEmpty(choice.label)
      ) ||
      new Set(question.choices.map((/** @type {Choice} */ choice) => choice.id))
          .size !==
        question.choices.length ||
      !nonEmptyStrings(question.correctChoiceIds) ||
      question.correctChoiceIds.some((/** @type {string} */ id) =>
        !question.choices.some((/** @type {Choice} */ choice) =>
          choice.id === id
        )
      )
    ) return invalidQuestion("choices");
  } else if (kind === "fill-blank") {
    if (
      !nonEmpty(question.blankId) ||
      !nonEmptyStrings(question.acceptedAnswers)
    ) return invalidQuestion("acceptedAnswers");
  } else if (kind === "free-response") {
    if (
      !positiveInteger(question.minimumWords) ||
      !nonEmptyStrings(question.expectedConcepts)
    ) return invalidQuestion("openResponseRubric");
  } else if (
    !nonEmpty(question.stimulus) ||
    !nonEmptyStrings(question.childQuestionIds) ||
    new Set(question.childQuestionIds).size !== question.childQuestionIds.length
  ) return invalidQuestion("caseStudy");
  return { ok: true, value: question };
}

/**
 * @param {Grade["status"]} status
 * @param {readonly string[]} concepts
 * @param {string} explanation
 * @returns {Result<Grade, QuestionFailure>}
 */
function grade(status, concepts, explanation) {
  return {
    ok: true,
    value: Object.freeze({
      status,
      matchedConcepts: Object.freeze([...concepts]),
      explanation,
    }),
  };
}

/** @param {"choice" | "fill" | "text" | "case-study"} expected */
function mismatch(expected) {
  return {
    ok: false,
    error: /** @type {const} */ ({
      kind: "ResponseKindMismatch",
      expected,
    }),
  };
}

/** @param {string} field */
function invalidQuestion(field) {
  return {
    ok: false,
    error: /** @type {const} */ ({ kind: "QuestionInvalid", field }),
  };
}

/** @param {string} field */
function invalidResponse(field) {
  return {
    ok: false,
    error: /** @type {const} */ ({ kind: "ResponseInvalid", field }),
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** @param {unknown} value @returns {value is readonly [string, ...string[]]} */
function nonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0 &&
    value.every((item) => nonEmpty(item));
}

/** @param {unknown} value */
function positiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** @param {readonly string[]} values */
function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

/** @param {readonly string[]} left @param {readonly string[]} right */
function arraysEqual(left, right) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

/** @param {string} value */
function normalize(value) {
  return value.toLocaleLowerCase("en-US").normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** @param {string} haystack @param {string} needle */
function includesPhrase(haystack, needle) {
  return ` ${haystack} `.includes(` ${needle} `);
}
