import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../widget/scripts/widget.js", import.meta.url), "utf8");
const start = source.indexOf("function shortDevice");
const end = source.indexOf("\nfunction sideHidden", start);
if (start < 0 || end < 0) throw new Error("shortDevice not found");
const shortDevice = new Function(`${source.slice(start, end)}\nreturn shortDevice;`)() as (name: string) => string;

test("dock mic label keeps the product name", () => {
  assert.equal(shortDevice("Mikrofon (Auna)"), "Auna");
  assert.equal(shortDevice("Microphone (Auna Mic)"), "Auna");
  assert.equal(shortDevice("Headset Microphone (SteelSeries Arctis Nova Pro Wireless)"), "Arctis");
  assert.equal(shortDevice("Mikrofon (Arctis 7 Chat)"), "Arctis");
  assert.equal(shortDevice("Auna (Microphone)"), "Auna");
  assert.equal(shortDevice("Auna"), "Auna");
  assert.equal(shortDevice("Mic"), "Mic");
  assert.equal(shortDevice(""), "Mic");
});
