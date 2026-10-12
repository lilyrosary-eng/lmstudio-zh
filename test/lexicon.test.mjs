import { test } from "node:test";
import assert from "node:assert/strict";
import { load, lookup, upsert, saveLocal, loadLocal } from "../src/lexicon.mjs";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "lex-"));
  mkdirSync(join(d, "lexicon"), { recursive: true });
  return d;
}

test("lookup: curated entry wins over local", () => {
  const d = tmp();
  writeFileSync(join(d, "lexicon", "zh-CN.json"),
    JSON.stringify({ version: 1, entries: { "Clear": { zh: "清除", origin: "curated" } } }));
  writeFileSync(join(d, "lexicon.local.json"),
    JSON.stringify({ version: 1, entries: { "Clear": { zh: "清空", origin: "model" } } }));
  const lex = load(d, d);
  assert.equal(lookup(lex, "Clear"), "清除");
});

test("lookup: user origin overrides model but not curated", () => {
  const d = tmp();
  writeFileSync(join(d, "lexicon.local.json"),
    JSON.stringify({ version: 1, entries: {
      "Cancel": { zh: "取消", origin: "model" },
      "Reset":  { zh: "取消", origin: "user" } } }));
  const lex = load(d, d);
  assert.equal(lookup(lex, "Cancel"), "取消");
  assert.equal(lookup(lex, "Reset"), "取消");
});

test("upsert: new entry is retrievable", () => {
  const d = tmp();
  const lex = load(d, d);
  upsert(lex, "Rename", "重命名", "model");
  assert.equal(lookup(lex, "Rename"), "重命名");
});

test("lookup: unknown key returns undefined", () => {
  const d = tmp();
  assert.equal(lookup(load(d, d), "Nothing"), undefined);
});

test("saveLocal: persists model entries, drops curated ones", () => {
  const d = tmp();
  const lex = load(d, d);
  upsert(lex, "Rename", "重命名", "model");
  upsert(lex, "Clear", "清除", "curated");
  saveLocal(lex, d);
  const local = loadLocal(d);
  assert.equal(local.entries.has("Rename"), true);
  assert.equal(local.entries.has("Clear"), false);
});

test("curated lexicon: every entry preserves its placeholder set", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const data = JSON.parse(readFileSync(join(here, "..", "lexicon", "zh-CN.json"), "utf8"));
  const ph = (s) => (s.match(/\{\{[^}]+\}\}/g) ?? []).sort().join(",");
  for (const [en, v] of Object.entries(data.entries)) {
    assert.equal(ph(v.zh), ph(en), `placeholder mismatch: ${en}`);
  }
});

test("curated lexicon: has at least 70 entries", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const data = JSON.parse(readFileSync(join(here, "..", "lexicon", "zh-CN.json"), "utf8"));
  assert.ok(Object.keys(data.entries).length >= 70,
    `only ${Object.keys(data.entries).length} entries`);
});