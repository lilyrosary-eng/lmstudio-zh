import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { main, decideUntranslated } from "../src/cli.mjs";
import { load, upsert } from "../src/lexicon.mjs";
import { RELATIVE_TARGET } from "../src/discover.mjs";
import { MINI } from "../fixtures/mini-bundle.mjs";

// brief 原稿的 scaffold 把目标文件放在 <root>/mw.js——discover 找的是
// <root>/resources/app/.webpack/renderer/main_window.js，scan/apply 会直接
// 报「未找到安装」；且文件内容不含 ChineseCNStrings，apply 会在结构定位处
// 以 1 退出。改为按真实布局 + MINI 内容搭建。
function scaffold() {
  const root = mkdtempSync(join(tmpdir(), "cli-"));
  const target = join(root, ...RELATIVE_TARGET.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  const original = MINI + '\nvar label="Resume Download";var t="Clear";';
  writeFileSync(target, original, "utf8");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "tool", "lexicon"), { recursive: true });
  return { root, target, original, stateDir: join(root, "state"), toolDir: join(root, "tool") };
}

// 测试入口。isAppClosed 注入点让「LM Studio 是否在运行」变得确定——否则这些
// 测试在用户开着 LM Studio 的机器上会随机失败（真实机器上它确实在跑）。
// argv 与 args 保持一致：生产环境里 bin 把同一个 argv 数组同时传给两者，
// CLI 的 --path/--yes/--force 都从 io.argv 读。
function run(s, args, extra = {}) {
  return main(args, {
    log() {}, err() {}, confirm: async () => true,
    stateDir: s.stateDir, toolDir: s.toolDir,
    argv: ["--path", s.root, ...args.slice(1)],
    isAppClosed: () => true,
    ...extra,
  });
}

test("doctor: reports a missing install instead of crashing", async () => {
  // brief 原稿用 stateDir: "x" —— ensureState 会在当前目录建出 x/ 目录，
  // 测试给仓库留垃圾。用临时目录。
  const s = scaffold();
  const code = await run(s, ["doctor"], { argv: ["--path", "C:\\nope"] });
  assert.equal(code, 1);
});

test("doctor: reports a found install", async () => {
  const s = scaffold();
  const lines = [];
  const code = await run(s, ["doctor"], { log: (m) => lines.push(String(m)) });
  assert.equal(code, 0);
  assert.ok(lines.join("\n").includes(s.target));
});

test("scan: exits 0 and reports candidates", async () => {
  const s = scaffold();
  const lines = [];
  const code = await run(s, ["scan"], { log: (m) => lines.push(String(m)) });
  assert.equal(code, 0);
  const out = lines.join("\n");
  assert.ok(out.includes("Resume Download"));
  assert.ok(out.includes("A 层缺口"));
  assert.ok(out.includes("已有译文"));   // 覆盖读数：缺口里已有译文的条数
});

test("apply: with an empty dictionary is a no-op that still succeeds", async () => {
  const s = scaffold();
  const code = await run(s, ["apply", "--yes"]);
  assert.equal(code, 0);
  assert.equal(readFileSync(s.target, "utf8"), s.original);
});

test("apply: translates after the dictionary gains an entry", async () => {
  const s = scaffold();
  const lex = load(s.stateDir, s.toolDir);
  upsert(lex, "Resume Download", "继续下载", "curated");
  upsert(lex, "Clear", "清除", "curated");
  writeFileSync(join(s.toolDir, "lexicon", "zh-CN.json"),
    JSON.stringify({ version: 1, entries: Object.fromEntries(lex.entries) }), "utf8");

  const code = await run(s, ["apply", "--yes"]);
  assert.equal(code, 0);
  const after = readFileSync(s.target, "utf8");
  assert.ok(after.includes("继续下载"));
  assert.ok(after.includes("清除"));
});

test("apply: refuses while LM Studio is running and leaves the file untouched", async () => {
  // 设计文档 §10 的硬性要求：进程在运行则直接拒绝（内存与磁盘不一致）
  const s = scaffold();
  writeFileSync(join(s.toolDir, "lexicon", "zh-CN.json"), JSON.stringify({ version: 1, entries: {
    "Resume Download": { zh: "继续下载", origin: "curated" } } }), "utf8");
  const code = await run(s, ["apply", "--yes"], { isAppClosed: () => false });
  assert.equal(code, 1);
  assert.equal(readFileSync(s.target, "utf8"), s.original);
});

test("apply: refuses a foreign file without --force, proceeds with it", async () => {
  const s = scaffold();
  writeFileSync(join(s.toolDir, "lexicon", "zh-CN.json"), JSON.stringify({ version: 1, entries: {
    "Resume Download": { zh: "继续下载", origin: "curated" } } }), "utf8");
  assert.equal(await run(s, ["apply", "--yes"]), 0);            // 先打一次，产生 manifest
  writeFileSync(s.target, readFileSync(s.target, "utf8") + "\n// manually touched", "utf8");
  assert.equal(await run(s, ["apply", "--yes"]), 1);            // foreign 且无 --force → 拒绝
  assert.equal(await run(s, ["apply", "--yes", "--force"]), 0); // --force 放行（无可应用改动 → 0）
});

test("verify: passes on a freshly patched install", async () => {
  const s = scaffold();
  writeFileSync(join(s.toolDir, "lexicon", "zh-CN.json"), JSON.stringify({ version: 1, entries: {
    "Resume Download": { zh: "继续下载", origin: "curated" },
    "Clear": { zh: "清除", origin: "curated" } } }), "utf8");
  assert.equal(await run(s, ["apply", "--yes"]), 0);
  const lines = [];
  const code = await run(s, ["verify"], { log: (m) => lines.push(String(m)) });
  assert.equal(code, 0);
  assert.ok(lines.join("\n").includes("PASS"));
});

test("restore: returns the file to its original bytes", async () => {
  const s = scaffold();
  writeFileSync(join(s.toolDir, "lexicon", "zh-CN.json"), JSON.stringify({ version: 1, entries: {
    "Resume Download": { zh: "继续下载", origin: "curated" },
    "Clear": { zh: "清除", origin: "curated" } } }), "utf8");
  await run(s, ["apply", "--yes"]);
  const before = readFileSync(s.target, "utf8");
  assert.notEqual(before, s.original);
  await run(s, ["restore", "--yes"]);
  assert.equal(readFileSync(s.target, "utf8"), s.original);
});

test("unknown command exits 2 with usage", async () => {
  const s = scaffold();
  const lines = [];
  const code = await run(s, ["frobnicate"], { err: (m) => lines.push(String(m)) });
  assert.equal(code, 2);
  assert.ok(lines.join("\n").includes("未知命令"));
});

test("translate: requires --model and lists available ones", async () => {
  const s = scaffold();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: "stub-model" }] }) });
  try {
    const errs = [];
    const code = await run(s, ["translate"], { err: (m) => errs.push(String(m)) });
    assert.equal(code, 1);
    assert.ok(errs.join("\n").includes("--model"));
    assert.ok(errs.join("\n").includes("stub-model"));
  } finally { globalThis.fetch = orig; }
});

test("scan: --json emits machine-readable output", async () => {
  // 设计文档 §10：scan 支持 --json 导出（候选近八千条，文本列表只给人看）
  const s = scaffold();
  const lines = [];
  const code = await run(s, ["scan", "--json"], { log: (m) => lines.push(String(m)) });
  assert.equal(code, 0);
  const doc = JSON.parse(lines.join("\n"));
  assert.ok(Array.isArray(doc.aLayerGaps));
  assert.ok(doc.aLayerGaps.some((m) => m.en === "Only in English"));
  assert.ok(Array.isArray(doc.untranslated));
  assert.ok(doc.untranslated.some((d) => d.en === "Resume Download"));
  assert.equal(typeof doc.bLayerCandidates, "number");
});

test("decideUntranslated: reuses lexicon translations across runs", () => {
  // brief 原稿断言第二轮不再出现 "Clear"——那对应「词典命中即跳过」的语义，
  // 但 apply 需要词典译文进入补丁（见 cli.mjs 里 decideUntranslated 的修正）。
  // 正确的「复用」：第二轮仍带着已有译文出现，但 !d.zh 的待译过滤把它排除。
  const lex = { version: 1, entries: new Map([["Clear", { zh: "清除", origin: "model" }]]) };
  const code = 'var label="Resume Download";var t="Clear";';
  const first = decideUntranslated(code, null, { entries: new Map() }, lex);
  assert.deepEqual(first.map((d) => d.en).sort(), ["Clear", "Resume Download"]);
  assert.equal(first.find((d) => d.en === "Clear").zh, "清除");      // 本地译文被沿用
  assert.equal(first.find((d) => d.en === "Clear").origin, "model");
  const second = decideUntranslated(code, null, lex, { entries: new Map() });
  assert.deepEqual(second.map((d) => d.en).sort(), ["Clear", "Resume Download"]);
  assert.deepEqual(second.filter((d) => !d.zh).map((d) => d.en), ["Resume Download"]);  // 无需重译
});
