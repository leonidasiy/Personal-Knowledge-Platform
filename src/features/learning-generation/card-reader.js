// @ts-check

export function createCardReader() {
  /** @type {HTMLElement | null} */ let root = null;
  /** @type {{ id: string, utterance: SpeechSynthesisUtterance } | null} */ let active = null;

  /** @param {string} [message] @param {string} [id] */
  function update(message = "", id = "") {
    root?.querySelectorAll("[data-read-knowledge]").forEach(button => {
      const reading = button.getAttribute("data-read-knowledge") === active?.id;
      button.textContent = reading ? "Stop" : "Read";
      button.setAttribute("aria-pressed", String(reading));
      const status = button.parentElement?.querySelector("[data-reading-status]");
      if (status) status.textContent = button.getAttribute("data-read-knowledge") === id ? message : "";
    });
  }

  function stop() {
    if (active === null) return;
    active = null;
    globalThis.speechSynthesis.cancel();
    update();
  }

  /** @param {Element} button */
  function read(button) {
    const id = button.getAttribute("data-read-knowledge") ?? "";
    if (active?.id === id) { stop(); return; }
    stop();
    if (typeof globalThis.speechSynthesis === "undefined" || typeof globalThis.SpeechSynthesisUtterance !== "function") {
      update("Read aloud is unavailable in this browser.", id);
      return;
    }
    const text = button.closest(".learning-card")?.querySelector(".card-knowledge")?.textContent?.trim();
    if (!text) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = document.documentElement.lang || navigator.language;
    utterance.onend = () => { if (active?.utterance === utterance) { active = null; update(); } };
    utterance.onerror = () => {
      if (active?.utterance !== utterance) return;
      active = null;
      update("Could not read this card. Try again or check your device’s speech settings.", id);
    };
    active = { id, utterance };
    update();
    try {
      const voices = speechSynthesis.getVoices().filter(voice => voice.localService);
      utterance.voice = voices.find(voice => voice.lang === utterance.lang)
        ?? voices.find(voice => voice.lang.split("-")[0] === utterance.lang.split("-")[0])
        ?? null;
      speechSynthesis.speak(utterance);
    } catch {
      stop();
      update("Could not read this card. Try again or check your device’s speech settings.", id);
    }
  }

  /** @param {HTMLElement} element */
  function bind(element) {
    root = element;
    const buttons = root.querySelectorAll("[data-read-knowledge]");
    if (active && !Array.from(buttons).some(button => button.getAttribute("data-read-knowledge") === active?.id)) stop();
    update();
    buttons.forEach(button => button.addEventListener("click", () => read(button)));
  }

  return { bind, stop };
}
