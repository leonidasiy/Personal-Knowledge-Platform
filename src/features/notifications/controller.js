// @ts-check

const freeze = Object.freeze;

/**
 * @typedef {"notice" | "error"} NotificationKind
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly kind: NotificationKind,
 *   readonly message: string
 * }} AppNotification
 */

/**
 * @typedef {{
 *   readonly durationMs: number,
 *   readonly createId: () => string,
 *   readonly now: () => number,
 *   readonly setTimer: (callback: () => void, delayMs: number) => number,
 *   readonly clearTimer: (timerId: number) => void,
 *   readonly onChange: (notification: AppNotification | null) => void
 * }} NotificationDependencies
 */

export class NotificationController {
  /** @type {NotificationDependencies} */
  #dependencies;
  /** @type {AppNotification | null} */
  #current = null;
  /** @type {number | null} */
  #timerId = null;
  /** @type {number} */
  #remainingMs;
  /** @type {number} */
  #deadlineMs = 0;

  /** @param {NotificationDependencies} dependencies */
  constructor(dependencies) {
    if (
      !Number.isFinite(dependencies.durationMs) ||
      dependencies.durationMs <= 0 ||
      typeof dependencies.createId !== "function" ||
      typeof dependencies.now !== "function" ||
      typeof dependencies.setTimer !== "function" ||
      typeof dependencies.clearTimer !== "function" ||
      typeof dependencies.onChange !== "function"
    ) {
      throw new TypeError("Notification dependencies are invalid.");
    }
    this.#dependencies = dependencies;
    this.#remainingMs = dependencies.durationMs;
  }

  /** @returns {AppNotification | null} */
  current() {
    return this.#current;
  }

  /**
   * @param {{ readonly kind: NotificationKind, readonly message: string } | null} input
   * @returns {AppNotification | null}
   */
  replace(input) {
    if (input === null) {
      this.dismiss();
      return null;
    }
    if (
      (input.kind !== "notice" && input.kind !== "error") ||
      typeof input.message !== "string" ||
      input.message.trim() === ""
    ) {
      throw new TypeError("Notification input is invalid.");
    }
    const message = input.message.trim();
    if (
      this.#current?.kind === input.kind &&
      this.#current.message === message
    ) {
      return this.#current;
    }
    this.#cancelTimer();
    const id = this.#dependencies.createId();
    if (typeof id !== "string" || id.trim() === "") {
      throw new TypeError("Notification identity is invalid.");
    }
    this.#current = freeze({ id, kind: input.kind, message });
    this.#remainingMs = this.#dependencies.durationMs;
    this.#schedule();
    this.#dependencies.onChange(this.#current);
    return this.#current;
  }

  /** @param {string | null} [notificationId] */
  dismiss(notificationId = null) {
    if (
      this.#current === null ||
      (notificationId !== null && notificationId !== this.#current.id)
    ) {
      return;
    }
    this.#cancelTimer();
    this.#current = null;
    this.#remainingMs = this.#dependencies.durationMs;
    this.#deadlineMs = 0;
    this.#dependencies.onChange(null);
  }

  /** @param {string} notificationId */
  pause(notificationId) {
    if (
      this.#current?.id !== notificationId ||
      this.#timerId === null
    ) {
      return;
    }
    this.#remainingMs = Math.max(
      0,
      this.#deadlineMs - this.#dependencies.now(),
    );
    this.#cancelTimer();
  }

  /** @param {string} notificationId */
  resume(notificationId) {
    if (
      this.#current?.id !== notificationId ||
      this.#timerId !== null
    ) {
      return;
    }
    if (this.#remainingMs <= 0) {
      this.dismiss(notificationId);
      return;
    }
    this.#schedule();
  }

  #schedule() {
    if (this.#current === null) return;
    const notificationId = this.#current.id;
    this.#deadlineMs = this.#dependencies.now() + this.#remainingMs;
    this.#timerId = this.#dependencies.setTimer(() => {
      this.#timerId = null;
      this.dismiss(notificationId);
    }, this.#remainingMs);
  }

  #cancelTimer() {
    if (this.#timerId === null) return;
    this.#dependencies.clearTimer(this.#timerId);
    this.#timerId = null;
  }
}

/**
 * @param {NotificationDependencies & { readonly root: HTMLElement, readonly document: Document }} dependencies
 */
export function installNotificationController(dependencies) {
  const controller = new NotificationController(dependencies);
  dependencies.root.addEventListener("click", (event) => {
    const close = event.target instanceof Element
      ? event.target.closest("[data-dismiss-notification]")
      : null;
    if (close !== null) {
      controller.dismiss(close.getAttribute("data-dismiss-notification"));
    }
  });
  for (
    const [eventName, paused] of /** @type {const} */ ([
      ["pointerover", true],
      ["pointerout", false],
      ["focusin", true],
      ["focusout", false],
    ])
  ) {
    dependencies.root.addEventListener(eventName, (event) => {
      updateNotificationPause(controller, event, paused);
    });
  }
  dependencies.document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") controller.dismiss();
  });
  return controller;
}

/** @param {NotificationController} controller @param {string | null} notice @param {string | null} errorMessage */
export function synchronizeNotification(controller, notice, errorMessage) {
  controller.replace(
    errorMessage !== null
      ? { kind: "error", message: errorMessage }
      : notice !== null
      ? { kind: "notice", message: notice }
      : null,
  );
}

/**
 * @param {AppNotification | null} notification
 * @param {(value: string) => string} escapeHtml
 */
export function renderNotification(notification, escapeHtml) {
  if (notification === null) return "";
  const id = escapeHtml(notification.id);
  return `<div class="toast${
    notification.kind === "error" ? " error" : ""
  }" role="${
    notification.kind === "error" ? "alert" : "status"
  }" data-notification-id="${id}"><p>${
    escapeHtml(notification.message)
  }</p><button class="toast-close" type="button" aria-label="Close notification" data-dismiss-notification="${id}"><span aria-hidden="true">&times;</span></button></div>`;
}

/**
 * @param {NotificationController} controller
 * @param {Event} event
 * @param {boolean} paused
 */
export function updateNotificationPause(controller, event, paused) {
  const target = event.target instanceof Element
    ? event.target.closest("[data-notification-id]")
    : null;
  if (target === null) return;
  const related =
    "relatedTarget" in event && event.relatedTarget instanceof Node
      ? event.relatedTarget
      : null;
  if (related !== null && target.contains(related)) return;
  const id = target.getAttribute("data-notification-id");
  if (id === null) return;
  if (paused) controller.pause(id);
  else controller.resume(id);
}

export {};
