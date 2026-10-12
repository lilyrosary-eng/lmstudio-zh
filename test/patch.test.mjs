import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode } from "../src/lex.mjs";
import { splice, validate, verify, planA, planB, planForDecisions, reverify, apply, restore, provenance, sha256 } from "../src/patch.mjs";
import { MINI } from "../fixtures/mini-bundle.mjs";
import { locateLanguageModule } from "../src/extract.mjs";

// ---- Step 1: splice 与 validate ----

test("splice: applies edits by descending start offset", () => {
  const code = "aaa bbb ccc";
  const out = splice(code, [
    { start: 8, end: 11, replacement: "CCC" },
    { start: 4, end: 7, replacement: "BBB" },
  ]);
  assert.equal(out, "aaa BBB CCC");
});

test("splice: rejects overlapping edits", () => {
  assert.throws(() => splice("abcdef", [
    { start: 0, end: 3, replacement: "X" },
    { start: 2, end: 5, replacement: "Y" },
  ]), /overlap/);
});

test("validate: rejects placeholder mismatch", () => {
  const e = { en: "Move {{count}} chats", zh: "移动对话", origin: "model" };
  assert.equal(validate(e).ok, false);
});

test("validate: accepts identical placeholder sets in any order", () => {
  const e = { en: "{{a}} of {{b}}", zh: "{{b}} / {{a}}", origin: "model" };
  assert.equal(validate(e).ok, true);
});

test("validate: rejects out-of-range length", () => {
  assert.equal(validate({ en: "Go", zh: "走".repeat(50), origin: "model" }).ok, false);
  assert.equal(validate({ en: "a".repeat(400), zh: "短", origin: "model" }).ok, false);
});

test("validate: accepts compact Chinese translations of short English labels", () => {
  // EN→ZH 场景：中文天然紧凑。原固定 0.2× 下限实测误杀两批——
  // Integrations(12)→集成(2) 一批误杀 35 条；Yes(3)→是(1)/No(3)→否(1)/
  // New(3)→新(1) 这类单字合法译文整类被拒。下限改为随源长度缩放。
  assert.equal(validate({ en: "Integrations", zh: "集成", origin: "model" }).ok, true);
  assert.equal(validate({ en: "Yes", zh: "是", origin: "model" }).ok, true);
  assert.equal(validate({ en: "No", zh: "否", origin: "model" }).ok, true);
  assert.equal(validate({ en: "New", zh: "新", origin: "model" }).ok, true);
  // 长文截断仍然拒绝：10 字符以上要求 ≥10% 长度
  assert.equal(validate({ en: "a".repeat(40), zh: "短", origin: "model" }).ok, false);
  assert.equal(validate({ en: "a".repeat(100), zh: "一二三", origin: "model" }).ok, false);
});

test("validate: rejects empty or already-CJK target", () => {
  assert.equal(validate({ en: "Clear", zh: "", origin: "model" }).ok, false);
  assert.equal(validate({ en: "Clear", zh: "清除", origin: "curated" }).ok, true);
});

// ---- Step 5: 四道闸门 ----

test("verify: passes when patched is exactly original+edits", () => {
  const original = 'var s="Clear";';
  // "Clear" 字面量（含引号）位于 6..13；brief 原稿的 8..13 会切出 'ear";'，
  // 拼出的结果是未闭合字符串，compiles 门必败——按字面量真实边界修正。
  const edits = [{ start: 6, end: 13, replacement: '"清除"' }];
  const patched = splice(original, edits);
  const r = verify(original, patched, { edits });
  assert.equal(r.ok, true);
  assert.equal(r.gates.length, 4);
  assert.ok(r.gates.every((g) => g.ok));
});

test("verify: gate 3 catches a stray extra change", () => {
  const original = 'var s="Clear";';
  const edits = [{ start: 6, end: 13, replacement: '"清除"' }];
  const tampered = splice(original, edits) + "\nvar evil=1;";
  const r = verify(original, tampered, { edits });
  assert.equal(r.ok, false);
  assert.equal(r.gates.find((g) => g.name === "byte-identical").ok, false);
});

test("verify: gate 1 catches broken syntax", () => {
  const original = 'var s="Clear";';
  const edits = [{ start: 6, end: 13, replacement: '"清除" +' }];
  const patched = splice(original, edits);
  const r = verify(original, patched, { edits });
  assert.equal(r.ok, false);
  assert.equal(r.gates.find((g) => g.name === "compiles").ok, false);
});

// ---- Step 9: 编辑计划 ----

test("planA: adds the missing key into the zh_CN chat namespace", () => {
  const located = locateLanguageModule(MINI);
  // brief 原稿用 "仅英文"（3 字符），通不过设计文档的 0.2× 下限（17×0.2=3.4），
  // validate 会拒绝它、planA 返回 0 条——换一个等价的 4 字符译文。
  const edits = planA(MINI, located, [{ en: "Only in English", zh: "仅有英文", origin: "curated" }]);
  assert.equal(edits.length, 1);
  const out = splice(MINI, edits);
  assert.ok(out.includes('"onlyInEn":"仅有英文"'));
  assert.ok(out.includes('"rename":"重命名"'));   // 既有中文未被破坏
});

test("planA: is a no-op when there is nothing to add", () => {
  const located = locateLanguageModule(MINI);
  assert.equal(planA(MINI, located, []).length, 0);
});

test("planB: replaces an exact dictionary hit outside language modules", () => {
  const code = MINI + '\nvar label="Resume Download";';
  const located = locateLanguageModule(code);
  const edits = planB(code, located, [{ en: "Resume Download", zh: "继续下载", origin: "model" }]);
  assert.equal(edits.length, 1);
  assert.equal(splice(code, edits).includes('"继续下载"'), true);
});

test("planB: ignores non-dictionary strings", () => {
  const code = MINI + '\nvar label="Resume Download";';
  const located = locateLanguageModule(code);
  assert.equal(planB(code, located, []).length, 0);
});

test("planB: skips identity mappings (LM Studio to LM Studio)", () => {
  // 词典里的自映射条目（专有名词标记）不应产生编辑——否则预览与 manifest
  // 里会出现一堆"改不改都一样"的条目
  const code = MINI + '\nvar a="LM Studio";var b="GPU";';
  const located = locateLanguageModule(code);
  const edits = planB(code, located, [
    { en: "LM Studio", zh: "LM Studio", origin: "curated" },
    { en: "GPU", zh: "GPU", origin: "curated" },
  ]);
  assert.equal(edits.length, 0);
});

test("planB: rejects a decision whose placeholders do not match", () => {
  const code = MINI + '\nvar label="Moved {{count}} chats";';
  const located = locateLanguageModule(code);
  const edits = planB(code, located, [{ en: "Moved {{count}} chats", zh: "移动对话", origin: "model" }]);
  assert.equal(edits.length, 0);
});

// ---- 闸门 3.5: 跨度独立复验 ----

test("reverify: accepts an edit whose span matches the buffer", () => {
  const code = 'var label="Resume Download";';
  const e = { start: 10, end: 27, original: '"Resume Download"', en: "Resume Download", zh: "继续下载", origin: "model" };
  assert.equal(reverify(code, e), true);
});

test("reverify: rejects a stale, mis-sized or mislabeled span", () => {
  const code = 'var label="Resume Download";';
  // 跨度内容与记录不符
  assert.equal(reverify(code, { start: 10, end: 27, original: '"Stale text"', en: "Stale text" }), false);
  // 宽度不对：切出来的不是同一个字面量
  assert.equal(reverify(code, { start: 10, end: 20, original: '"Resume Download"', en: "Resume Download" }), false);
  // 引号不配对
  assert.equal(reverify(code, { start: 10, end: 27, original: '"Resume Download', en: "Resume Download" }), false);
  // decode(original) 与 en 不符
  assert.equal(reverify(code, { start: 10, end: 27, original: '"Resume Download"', en: "Wrong en" }), false);
});

test("reverify: A-layer edits skip the decode comparison", () => {
  // A 层编辑整体重写词条表 JSON，en 是报告占位串，不能与 decode(original) 比对
  const code = "var x='abc';";
  const e = { start: 6, end: 11, original: "'abc'", en: "<A-layer additions>", zh: "<A-layer additions>", origin: "curated", source: "A" };
  assert.equal(reverify(code, e), true);
});

// ---- Step 12: 事务性 apply / restore / provenance ----

// 注：brief 原稿的事务测试有三处缺陷，已修正——
//   ① 偏移 8..23 在 'var s="Resume Download";' 上切出的是 'sume Download";'，
//      拼结果是未闭合字符串，compiles 门必败；字面量（含引号）真实边界是 6..23。
//   ② 编辑对象缺 original 字段（brief 自己的 Edit 接口要求它有），闸门 3.5 无从复验。
//   ③ en 用 "x"/"y" 占位，与 decode(original) 不符会被 3.5 拒绝；改用真实英文。
const ORIGINAL = 'var s="Resume Download";';
const EDIT = { start: 6, end: 23, replacement: '"继续下载"', en: "Resume Download", zh: "继续下载", origin: "model", original: '"Resume Download"' };

test("apply: writes target, records manifest, verify passes", () => {
  const d = mkdtempSync(join(tmpdir(), "patch-"));
  const target = join(d, "mw.js");
  writeFileSync(target, ORIGINAL, "utf8");
  const patched = splice(ORIGINAL, [EDIT]);
  const r = apply(target, ORIGINAL, patched, { edits: [EDIT] }, d);
  assert.equal(r.ok, true);
  assert.equal(readFileSync(target, "utf8"), patched);
  assert.ok(existsSync(r.backup));
});

test("apply: refuses when a gate fails and leaves target untouched", () => {
  const d = mkdtempSync(join(tmpdir(), "patch-"));
  const target = join(d, "mw.js");
  writeFileSync(target, ORIGINAL, "utf8");
  const broken = { ...EDIT, replacement: '"继续下载" +' };
  const patched = splice(ORIGINAL, [broken]);
  const r = apply(target, ORIGINAL, patched, { edits: [broken] }, d);
  assert.equal(r.ok, false);
  assert.equal(readFileSync(target, "utf8"), ORIGINAL);
});

test("apply: drops edits that fail span reverification and records them", () => {
  const d = mkdtempSync(join(tmpdir(), "patch-"));
  const target = join(d, "mw.js");
  const original = 'var s="Resume Download";var t="Clear";';
  writeFileSync(target, original, "utf8");
  const good = { start: 6, end: 23, replacement: '"继续下载"', en: "Resume Download", zh: "继续下载", origin: "model", original: '"Resume Download"' };
  const stale = { start: 30, end: 37, replacement: '"清除"', en: "Clear", zh: "清除", origin: "model", original: '"NOT IN BUFFER"' };
  const r = apply(target, original, splice(original, [good, stale]), { edits: [good, stale] }, d);
  assert.equal(r.ok, true);
  assert.equal(r.rejected.length, 1);
  // 只有通过复验的编辑被写入；被拒的那条保持原样
  assert.equal(readFileSync(target, "utf8"), splice(original, [good]));
  const pending = JSON.parse(readFileSync(join(d, "pending.json"), "utf8"));
  assert.equal(pending.spanRejected.length, 1);
  assert.equal(pending.spanRejected[0].en, "Clear");
});

test("restore: puts the original back", () => {
  const d = mkdtempSync(join(tmpdir(), "patch-"));
  const target = join(d, "mw.js");
  writeFileSync(target, ORIGINAL, "utf8");
  apply(target, ORIGINAL, splice(ORIGINAL, [EDIT]), { edits: [EDIT] }, d);
  assert.equal(restore(target, d), true);
  assert.equal(readFileSync(target, "utf8"), ORIGINAL);
});

test("provenance: reports unpatched, clean, patched, foreign", () => {
  const d = mkdtempSync(join(tmpdir(), "patch-"));
  const target = join(d, "mw.js");
  writeFileSync(target, ORIGINAL, "utf8");
  mkdirSync(join(d, "manifests"), { recursive: true });
  // 空 manifests 目录 = 从未打过补丁
  assert.equal(provenance(ORIGINAL, d).state, "unpatched");

  const patched = splice(ORIGINAL, [EDIT]);
  apply(target, ORIGINAL, patched, { edits: [EDIT] }, d);
  assert.equal(provenance(patched, d).state, "patched");
  // 原版内容对应 manifest 的 originalSha —— 设计文档 §9 的「干净」态
  assert.equal(provenance(ORIGINAL, d).state, "clean");
  assert.equal(provenance("something else entirely", d).state, "foreign");
});

test("planForDecisions: combines A and B layers", () => {
  const code = MINI + '\nvar label="Resume Download";';
  const edits = planForDecisions(code, [
    { en: "Only in English", zh: "仅有英文", origin: "curated" },
    { en: "Resume Download", zh: "继续下载", origin: "model" },
  ]);
  assert.equal(edits.length, 2);
  const out = splice(code, edits);
  assert.ok(out.includes('"onlyInEn":"仅有英文"'));
  assert.ok(out.includes('"继续下载"'));
  assert.equal(verify(code, out, { edits }).ok, true);
});
