import { test } from "node:test";
import assert from "node:assert/strict";
import { load, lookup, upsert, saveLocal, loadLocal, stats } from "../src/lexicon.mjs";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "lex-"));
  mkdirSync(join(d, "lexicon"), { recursive: true });
  return d;
}

// 造一份 stateDir/toolDir 合一的小词典，用于钉住来源优先级。
function seeded(curated, local) {
  const d = tmp();
  if (curated) writeFileSync(join(d, "lexicon", "zh-CN.json"), JSON.stringify({ version: 1, entries: curated }));
  if (local) writeFileSync(join(d, "lexicon.local.json"), JSON.stringify({ version: 1, entries: local }));
  return load(d, d);
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

// --- 来源优先级：curated > user > model。非法 origin 一律不参与比较 ---

test("ingest: curated beats a model entry", () => {
  const lex = seeded({ Clear: { zh: "清除", origin: "curated" } },
                     { Clear: { zh: "清空", origin: "model" } });
  assert.equal(lookup(lex, "Clear"), "清除");
});

test("ingest: a user entry beats a model entry", () => {
  const lex = seeded({ Clear: { zh: "清空", origin: "model" } },
                     { Clear: { zh: "用户校正", origin: "user" } });
  assert.equal(lookup(lex, "Clear"), "用户校正");
});

test("ingest: curated beats a user entry", () => {
  const lex = seeded({ Clear: { zh: "清除", origin: "curated" } },
                     { Clear: { zh: "用户改的", origin: "user" } });
  assert.equal(lookup(lex, "Clear"), "清除");
});

// PRIORITY[unknown] 是 undefined，`3 >= undefined` 为 false——不显式拒绝的话，
// 一个被手工改坏的 lexicon.local.json 就能覆盖掉人工译文。
test("ingest: an unknown origin cannot overwrite a curated entry", () => {
  const lex = seeded({ Clear: { zh: "清除", origin: "curated" } },
                     { Clear: { zh: "清空", origin: "typo" } });
  assert.equal(lookup(lex, "Clear"), "清除");
});

test("ingest: an unknown origin is not stored at all", () => {
  const lex = seeded(null, { Clear: { zh: "清空", origin: "typo" } });
  assert.equal(lex.entries.has("Clear"), false);
  assert.deepEqual(stats(lex), { total: 0, curated: 0, model: 0, user: 0 });
});

test("ingest: an origin inherited from the prototype chain is rejected", () => {
  const lex = seeded({ Clear: { zh: "清除", origin: "curated" } },
                     { Clear: { zh: "清空", origin: "toString" } });
  assert.equal(lookup(lex, "Clear"), "清除");
});

// --- upsert：非法 origin 是编程错误（抛），合法 origin 只能升级不能降级 ---

test("upsert: an illegal origin throws", () => {
  const lex = seeded(null, null);
  assert.throws(() => upsert(lex, "X", "y", "bogus"), /origin/);
});

test("upsert: an origin inherited from the prototype chain throws", () => {
  const lex = seeded(null, null);
  assert.throws(() => upsert(lex, "X", "y", "toString"), /origin/);
});

test("upsert: a user entry upgrades an existing model entry", () => {
  const lex = seeded(null, null);
  upsert(lex, "Clear", "清空", "model");
  upsert(lex, "Clear", "用户校正", "user");
  assert.equal(lookup(lex, "Clear"), "用户校正");
});

test("upsert: refuses to downgrade curated to model", () => {
  const lex = seeded({ Clear: { zh: "清除", origin: "curated" } }, null);
  upsert(lex, "Clear", "清空", "model");
  assert.equal(lookup(lex, "Clear"), "清除");
});

test("upsert: refuses to downgrade curated to user", () => {
  const lex = seeded({ Clear: { zh: "清除", origin: "curated" } }, null);
  upsert(lex, "Clear", "用户改的", "user");
  assert.equal(lookup(lex, "Clear"), "清除");
});

test("upsert: refuses to downgrade user to model", () => {
  const lex = seeded(null, null);
  upsert(lex, "Clear", "用户校正", "user");
  upsert(lex, "Clear", "清空", "model");
  assert.equal(lookup(lex, "Clear"), "用户校正");
});

// --- 词典文件损坏：缺失不是错误，损坏是 ---

test("load: a corrupt curated dictionary throws and names the file", () => {
  const d = tmp();
  const p = join(d, "lexicon", "zh-CN.json");
  writeFileSync(p, "{ not json");
  let err = null;
  try { load(d, d); } catch (e) { err = e; }
  assert.ok(err, "人工词典损坏必须抛错，不能静默降级成空词典");
  assert.ok(err.message.includes(p), `error should name ${p}: ${err.message}`);
});

// 本地词典可重建，降级为空是合理的，但必须让调用方能把它打印出来。
test("load: a corrupt local dictionary degrades but is reported", () => {
  const d = tmp();
  writeFileSync(join(d, "lexicon", "zh-CN.json"),
    JSON.stringify({ version: 1, entries: { Clear: { zh: "清除", origin: "curated" } } }));
  const p = join(d, "lexicon.local.json");
  writeFileSync(p, "{ not json");
  const warnings = [];
  const lex = load(d, d, (msg) => warnings.push(msg));
  assert.equal(lookup(lex, "Clear"), "清除");
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(p), `warning should name ${p}: ${warnings[0]}`);
});

test("loadLocal: a corrupt local dictionary degrades but is reported", () => {
  const d = tmp();
  const p = join(d, "lexicon.local.json");
  writeFileSync(p, "{ not json");
  const warnings = [];
  assert.equal(loadLocal(d, (msg) => warnings.push(msg)).entries.size, 0);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(p), `warning should name ${p}: ${warnings[0]}`);
});

test("load: both dictionaries missing is not an error", () => {
  const d = tmp();
  const warnings = [];
  const lex = load(d, d, (msg) => warnings.push(msg));
  assert.equal(lex.entries.size, 0);
  assert.deepEqual(warnings, []);
});