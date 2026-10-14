// @ts-check
import { createYouTubeConnectionController } from "../src/startup/youtube-connection.js";

Deno.test("YouTube notice appears on selection and stays hidden after persisted acceptance", () => {
  const copy = JSON.parse(Deno.readTextFileSync("index.html").match(/<script id="app-copy" type="application\/json">([\s\S]*?)<\/script>/)?.[1] ?? "{}").discoverMarkup;
  class Element {
    hidden = true;
    innerHTML = "";
    /** @type {Map<string, (event:Event)=>void>} */ listeners = new Map();
    /** @param {string} name @param {(event:Event)=>void} listener */
    addEventListener(name, listener) { this.listeners.set(name, listener); }
  }
  class Input extends Element { checked = false; }
  class Form extends Element {
    /** @param {string} selector */ matches(selector) { return selector === "[data-youtube-policy-accept]"; }
  }
  const savedGlobals = ["HTMLElement", "HTMLInputElement", "HTMLFormElement"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  /** @type {string|null} */ let stored = null;
  let writes = 0;
  const provider = new Input(), mount = new Element();
  const root = /** @type {ParentNode} */ (/** @type {unknown} */ ({
    querySelector: (/** @type {string} */ selector) => selector === "[data-youtube-connection]" ? mount : selector.startsWith("input[") ? provider : null,
  }));
  try {
    for (const [name, value] of [["HTMLElement", Element], ["HTMLInputElement", Input], ["HTMLFormElement", Form]]) Object.defineProperty(globalThis, /** @type {string} */ (name), { configurable: true, value });
    const create = () => createYouTubeConnectionController({ storage: { getItem: () => stored, setItem: (_, value) => { stored = value; writes++; } }, now: () => "2026-10-14T00:00:00.000Z", markup: copy, onNotice: () => {}, onError: message => { throw new Error(message); }, rerender: () => {} });
    const controller = create(); controller.load(); controller.bind(root);
    if (!mount.hidden || mount.innerHTML) throw new Error("Policy must be absent before selection.");
    provider.checked = true; provider.listeners.get("change")?.(new Event("change"));
    if (mount.hidden || !mount.innerHTML.includes("data-youtube-policy-accept")) throw new Error("Checking YouTube must expose consent.");
    provider.checked = false; provider.listeners.get("change")?.(new Event("change"));
    if (!mount.hidden || mount.innerHTML) throw new Error("Unchecking YouTube must hide consent.");
    provider.checked = true; provider.listeners.get("change")?.(new Event("change"));
    const submit = new Event("submit", { cancelable: true }); Object.defineProperty(submit, "target", { value: new Form() });
    mount.listeners.get("submit")?.(submit);
    if (!submit.defaultPrevented || !controller.isAccepted() || writes !== 1) throw new Error("Explicit acceptance must persist once.");
    controller.bind(root);
    if (!mount.hidden || mount.innerHTML) throw new Error("Accepted policy must disappear.");
    const reopened = create(); reopened.load(); reopened.bind(root);
    if (!reopened.isAccepted() || !mount.hidden || mount.innerHTML || writes !== 1) throw new Error("Saved acceptance must survive reopening without another notice or write.");
  } finally {
    for (const [name, descriptor] of savedGlobals) {
      if (descriptor) Object.defineProperty(globalThis, /** @type {string} */ (name), /** @type {PropertyDescriptor} */ (descriptor));
      else Reflect.deleteProperty(globalThis, /** @type {string} */ (name));
    }
  }
});
