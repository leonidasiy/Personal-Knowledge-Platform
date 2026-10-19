import assert from "node:assert/strict";
import { test } from "node:test";
import { createCardReader } from "../src/features/learning-generation/card-reader.js";

function globals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
}

test("card reading speaks only knowledge, prefers local voices, stops and survives rerenders", t => {
  const spoken = [];
  let cancellations = 0, fail = false;
  const remote = { lang: "en", localService: false };
  const local = { lang: "en-US", localService: true };
  class Utterance { constructor(text) { this.text = text; } }
  globals(t, { SpeechSynthesisUtterance: Utterance, speechSynthesis: {
    getVoices: () => [remote, local],
    speak: utterance => { if (fail) throw Error("Unavailable"); spoken.push(utterance); },
    cancel: () => { cancellations++; },
  }, document: { documentElement: { lang: "en" } } });
  function button(id) {
    const status = { textContent: "" }, attributes = { "data-read-knowledge": id };
    return {
      attributes, status, textContent: "Read", click: () => {},
      getAttribute: name => attributes[name],
      setAttribute: (name, value) => { attributes[name] = value; },
      parentElement: { querySelector: () => status },
      closest: () => ({ querySelector: () => ({ textContent: `Knowledge ${id} & context.` }) }),
      addEventListener(_event, listener) { this.click = listener; },
    };
  }
  const reader = createCardReader();
  let first = button("one"), second = button("two");
  reader.bind({ querySelectorAll: () => [first, second] });
  first.click();
  assert.equal(spoken[0].text, "Knowledge one & context.");
  assert.equal(spoken[0].voice, local);
  assert.equal(first.textContent, "Stop");
  assert.equal(first.attributes["aria-pressed"], "true");
  first = button("one");
  reader.bind({ querySelectorAll: () => [first, second] });
  assert.equal(first.textContent, "Stop", "Current playback survives DOM replacement");
  second.click();
  spoken[0].onerror();
  assert.equal(second.textContent, "Stop", "Canceled utterances cannot clear the new playback");
  assert.equal(first.textContent, "Read");
  assert.equal(cancellations, 1);
  second.click();
  assert.equal(cancellations, 2);
  assert.equal(second.textContent, "Read");
  first.click();
  spoken.at(-1).onend();
  assert.equal(first.textContent, "Read");
  first.click();
  spoken.at(-1).onerror();
  assert.match(first.status.textContent, /Could not read/);
  fail = true;
  first.click();
  assert.equal(first.textContent, "Read");
  assert.match(first.status.textContent, /Could not read/);
  fail = false;
  first.click();
  reader.bind({ querySelectorAll: () => [] });
  assert.equal(cancellations, 4, "Leaving the card stops playback");
  reader.stop();
});

test("unsupported speech reports an accessible message without throwing", t => {
  globals(t, { speechSynthesis: undefined, SpeechSynthesisUtterance: undefined });
  const status = { textContent: "" };
  let click;
  const button = { getAttribute: () => "one", setAttribute: () => {}, parentElement: { querySelector: () => status }, addEventListener: (_event, listener) => { click = listener; } };
  const reader = createCardReader();
  reader.bind({ querySelectorAll: () => [button] });
  click();
  assert.match(status.textContent, /unavailable in this browser/);
});
