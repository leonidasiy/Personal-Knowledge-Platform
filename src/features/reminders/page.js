// @ts-check
/** @param {{client:ReturnType<import('./client.js').createReminderClient>,renderPreferences:()=>string,onChange:()=>void}} dependencies */
export function createSettingsPage(dependencies) {
  if (
    !dependencies?.client ||
    typeof dependencies.renderPreferences !== "function" ||
    typeof dependencies.onChange !== "function"
  ) throw new TypeError("SettingsPageDependenciesInvalid");
  const { client, onChange } = dependencies;
  /** Start before rendering so permission requests keep activation. @param {Promise<unknown>} operation */
  async function update(operation) {
    onChange();
    await operation;
    onChange();
  }
  async function load() {
    await update(client.load());
  }
  function render() {
    const view = client.view(),
      reminder = view.snapshot,
      busy = view.state === "saving" || view.state === "loading";
    const mutable = view.state === "ready",
      canEnable = view.supported && view.configured;
    const status = busy
      ? "Updating reminder settings…"
      : view.message || (!view.supported
        ? "This browser can’t receive reminder notifications."
        : !view.configured
        ? "Reminders aren’t configured on the server yet."
        : reminder?.enabled
        ? "One gentle reminder, unless you’ve already finished."
        : "Reminders are off. Enable them only on devices you want notified.");
    const zone = reminder?.timeZone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone;
    const delivery = reminder?.lastStatus === "sent"
      ? "Last send accepted by the push service—not proof it appeared on your phone."
      : reminder?.lastStatus === "delivery-failed"
      ? "Last send was not confirmed."
      : reminder?.lastStatus === "disabled-expired"
      ? "This subscription expired. Enable reminders again."
      : reminder?.lastStatus === "skipped"
      ? "Today’s reminder was skipped."
      : "No confirmed push send yet.";
    const version =
      `${reminder?.enabled}:${reminder?.time}:${reminder?.timeZone}`;
    return `<section class="wide-view settings-page" aria-labelledby="settings-title"><div class="section-heading"><div><p class="eyebrow">Settings · your personal space</p><h1 id="settings-title">Make yourself at home.</h1><p>A little less noise. A rhythm that feels like yours.</p></div></div>
      <section class="settings-preferences" aria-label="Workspace preferences">${dependencies.renderPreferences()}</section>
      <section class="settings-reminders" aria-labelledby="reminder-title"><h2 id="reminder-title">A moment to revisit</h2><p>A quiet invitation to return. Never a streak to defend.</p>
      <form data-reminder-form data-reminder-version="${
      escape(version)
    }" aria-busy="${busy}">
      <label class="switch-control"><span><strong>Enable on this device</strong><small>Optional browser notifications</small></span><input name="enabled" data-focus-key="reminder-enabled" type="checkbox"${
      reminder?.enabled ? " checked" : ""
    }${
      !mutable || (!canEnable && !reminder?.enabled) ? " disabled" : ""
    }></label>
      <label class="settings-label">Reminder time<input name="time" data-focus-key="reminder-time" type="time" required value="${
      escape(reminder?.time ?? "20:00")
    }"${!mutable ? " disabled" : ""}></label>
      <p class="settings-form-note">Timezone: ${
      escape(zone)
    }. Follows this device when you open or resume the app.</p>
      <p class="settings-form-note">Permission: ${escape(view.permission)}. ${
      escape(delivery)
    }${
      reminder?.skippedDate
        ? ` Skipped date: ${escape(reminder.skippedDate)}.`
        : ""
    }</p>
      <p data-reminder-status role="status">${
      escape(status)
    }</p><div class="state-actions">
      ${
      view.state === "error"
        ? '<button class="button secondary" type="button" data-action="retry-reminders" data-focus-key="retry-reminders">Retry</button>'
        : ""
    }
      <button class="button secondary" type="button" data-action="skip-reminder" data-focus-key="skip-reminder"${
      !reminder?.enabled || !mutable ? " disabled" : ""
    }>Skip today</button>
      <button class="button secondary" type="button" data-action="test-reminder" data-focus-key="test-reminder"${
      !reminder?.enabled || !mutable || !canEnable ? " disabled" : ""
    }>Test notification</button>
      <button class="button primary" data-focus-key="save-reminder"${
      !mutable || (!canEnable && !reminder?.enabled) ? " disabled" : ""
    }>Save reminder</button></div></form>
      <p class="settings-form-note">Finishing a Review batch skips the reminder. When no review is due, a completed study batch counts. Incorrect answers count too. Delivery is best-effort; Android controls notification sounds.</p></section>
      </section>`;
  }
  /** @param {HTMLElement} root */
  function bind(root) {
    const form = root.querySelector("[data-reminder-form]");
    if (form instanceof HTMLFormElement) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const enabled = form.elements.namedItem("enabled"),
          time = form.elements.namedItem("time");
        if (
          enabled instanceof HTMLInputElement &&
          time instanceof HTMLInputElement
        ) {
          void update(
            client.save({ enabled: enabled.checked, time: time.value }),
          );
        }
      });
    }
    root.querySelector('[data-action="retry-reminders"]')?.addEventListener(
      "click",
      () => void load(),
    );
    root.querySelector('[data-action="skip-reminder"]')?.addEventListener(
      "click",
      () => void update(client.skip()),
    );
    root.querySelector('[data-action="test-reminder"]')?.addEventListener(
      "click",
      () => void update(client.test()),
    );
  }
  return Object.freeze({
    load,
    render,
    bind,
    syncTimeZone: () => update(client.syncTimeZone()),
  });
}
/** @param {string} value */
function escape(value) {
  return value.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
}
