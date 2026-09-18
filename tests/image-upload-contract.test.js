// @ts-check
import { packImageBundle, parseImageBundle, parsePdfPageRange } from "../src/features/knowledge-workflows/image-upload.js";

Deno.test("PDF selection defaults to every page and accepts print-style ranges", () => {
  const all = parsePdfPageRange("", 6);
  if (!all.ok || all.value.join(",") !== "1,2,3,4,5,6") throw new Error("All-page default failed.");
  const picked = parsePdfPageRange("1, 3-5, 3", 6);
  if (!picked.ok || picked.value.join(",") !== "1,3,4,5") throw new Error("Print-style range failed.");
  for (const expression of ["0", "7", "5-3", "1,,2", "a", "1-", "-2"]) {
    if (parsePdfPageRange(expression, 6).ok) throw new Error(`Accepted invalid range: ${expression}`);
  }
});

Deno.test("image bundle retains physical page anchors and rejects mismatched content", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const packed = packImageBundle([{ name: "page 2", locator: "page:2", mediaType: "image/png", bytes: png }, { name: "page 4", locator: "page:4", mediaType: "image/png", bytes: png }]);
  if (!packed.ok) throw new Error(packed.error.kind);
  const parsed = parseImageBundle(packed.value);
  if (!parsed.ok || parsed.value.length !== 2 || parsed.value[1].locator !== "page:4") throw new Error("Physical page identity was lost.");
  const forged = packImageBundle([{ name: "wrong", locator: "page:1", mediaType: "image/jpeg", bytes: png }]);
  if (forged.ok) throw new Error("Mismatched MIME/signature accepted.");
  const truncated = parseImageBundle(packed.value.slice(0, -1));
  if (truncated.ok) throw new Error("Truncated bundle accepted.");
});
