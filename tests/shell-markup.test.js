// @ts-check
import { createShellMarkup } from "../src/shell-markup.js";

Deno.test("cached shell markup preserves values and rejects missing or malformed templates", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  let content = JSON.stringify([["<p>", ":", "</p>"]]);
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    getElementById: () => ({ textContent: content }),
  } });
  try {
    const render = createShellMarkup("fixture");
    if (render(0, 0, false) !== "<p>0:false</p>") throw new Error("Inserted values changed.");
    for (const invalid of ["", "[]", '[["one"]]', '[["one",2,"three"]]']) {
      content = invalid;
      let failure;
      try { render(0, "a", "b"); } catch (error) { failure = error; }
      if (!(failure instanceof TypeError) || failure.message !== `ShellMarkup${content ? "Invalid" : "Unavailable"}:fixture`) {
        throw new Error("Invalid shell template was accepted or lost its diagnostic.");
      }
    }
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
