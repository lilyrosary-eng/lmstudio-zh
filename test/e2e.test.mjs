import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, copyFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { main, defaultStateDir } from "../src/cli.mjs";
import { load } from "../src/lexicon.mjs";
import { locateLanguageModule, zhCatalog, missingFromA } from "../src/extract.mjs";
import { find, RELATIVE_TARGET } from "../src/discover.mjs";
import { provenance } from "../src/patch.mjs";

// 目标文件由 discover 动态定位（跨平台）；LMS_PATH 可覆盖。
// brief 原稿硬编码 Windows 路径——在 Linux 上这个 e2e 永远跑不了。
const REAL = process.env.LMS_PATH || find()?.target || "";
const enabled = process.env.LMS_E2E === "1" && REAL !== "";
const opts = { skip: enabled ? false : "需要 LMS_E2E=1 且 discover 能定位到 LM Studio（可用 LMS_PATH 覆盖）" };
const TOOL_DIR = join(fileURLToPath(import.meta.url), "..", "..");
// 真实安装可能已被本工具打过补丁（本机就是）。两种状态下验收断言不同：
// 原版 → apply 必须改动文件；已补丁 → apply 必须幂等无操作。
const livePatched = REAL !== "" && provenance(readFileSync(REAL, "utf8"), defaultStateDir()).state === "patched";

// 全部在临时目录的副本上运行，绝不触碰真实安装文件。
// 副本按真实安装布局摆放（<root>/resources/app/.webpack/renderer/…）——
// discover 的 --path 要的是安装根目录，不是文件路径。
function sandboxReal() {
  const d = mkdtempSync(join(tmpdir(), "e2e-"));
  const copy = join(d, ...RELATIVE_TARGET.split("/"));
  mkdirSync(dirname(copy), { recursive: true });
  copyFileSync(REAL, copy);
  return { d, copy };
}

// 副本上打补丁：isAppClosed 注入为 true——进程门保护的是真实安装的文件，
// 在副本上运行没有内存与磁盘不一致的风险（真实机器上 LM Studio 确实在跑，
// 不注入的话这个测试必败）。
function io(d, copy) {
  return { log() {}, err() {}, confirm: async () => true,
           stateDir: join(d, "state"), toolDir: TOOL_DIR,
           argv: ["--path", d, "--yes", "--force"],
           isAppClosed: () => true };
}

test("real bundle: structure locates and zh catalog parses", opts, () => {
  const code = readFileSync(REAL, "utf8");
  const located = locateLanguageModule(code);
  assert.ok(located, "应能定位 ChineseCNStrings");
  assert.ok(located.namespacesByLang.get("zh_CN"), "应有 zh_CN 命名空间");
  const zh = zhCatalog(code, located);
  assert.equal(Object.keys(zh).length, 10);
  assert.equal(typeof zh.sidebar.data.chat, "string");
});

test("real bundle: every A-layer gap is covered by the curated lexicon", opts, () => {
  const code = readFileSync(REAL, "utf8");
  const located = locateLanguageModule(code);
  const missing = missingFromA(code, located);
  const lex = load(mkdtempSync(join(tmpdir(), "nostate-")), TOOL_DIR);
  const uncovered = missing.filter((m) => !lex.entries.has(m.en));
  assert.equal(uncovered.length, 0,
    `未覆盖 ${uncovered.length} 条: ` + uncovered.slice(0, 10).map((u) => u.en).join(" | "));
});

test("real bundle: applying keeps the file syntactically valid", opts, async () => {
  const { d, copy } = sandboxReal();
  const original = readFileSync(copy, "utf8");
  const rc = await main(["apply", "--yes", "--force"], io(d, copy));
  assert.equal(rc, 0);
  const patched = readFileSync(copy, "utf8");
  if (livePatched) {
    // 真实安装已是本工具的补丁产物（本机即是）：apply 应幂等，不再改动
    assert.equal(patched, original, "已补丁的真实安装：apply 应为无操作");
  } else {
    assert.notEqual(patched, original, "文件应被修改");
  }
  new vm.Script(patched, { filename: "e2e.js" });          // 闸门 1
});

test("real bundle: restore returns byte-identical original", opts, async () => {
  const { d, copy } = sandboxReal();
  const original = readFileSync(copy, "utf8");
  await main(["apply", "--yes", "--force"], io(d, copy));
  await main(["restore", "--yes"], io(d, copy));
  assert.equal(readFileSync(copy, "utf8"), original);
});

test("real bundle: second apply is a no-op (idempotent)", opts, async () => {
  const { d, copy } = sandboxReal();
  const logs = [];
  const base = io(d, copy);
  assert.equal(await main(["apply", "--yes", "--force"], base), 0);
  const after = readFileSync(copy, "utf8");
  const rc = await main(["apply", "--yes", "--force"], { ...base, log: (m) => logs.push(String(m)) });
  assert.equal(rc, 0);
  assert.equal(readFileSync(copy, "utf8"), after, "第二次 apply 不应改动文件");
  // 已补丁的真实安装：第一次 apply 就是无操作（0 编辑时 CLI 不写 manifest），
  // 第二次同样报告无可应用改动——两种措辞都等价于幂等。
  assert.ok(logs.some((l) => l.includes("已是最新补丁") || l.includes("没有可应用的改动")),
    "应报告已是最新补丁或无可应用改动");
});
