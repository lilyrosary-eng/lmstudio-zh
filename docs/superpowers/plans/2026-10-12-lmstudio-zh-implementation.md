# LM Studio 简体中文补丁工具 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个跨平台、版本无关的 CLI 工具，把 LM Studio 的 i18n 词条表（A 层 88 条缺口）与硬编码英文（B 层约 2214 条）汉化，并用四道闸门证明「除被精确命中的字面量字节外，文件其余部分逐字节不变」。

**Architecture:** 纯 Node.js ESM、零运行时依赖。工具与 LM Studio 之间只通过「结构契约」耦合（搜索 `e.ChineseCNStrings=` 赋值关系，绝不硬编码 module id）。核心不变式：补丁文件 == 由原文件 + 计划重算的结果，此性质在 verify 阶段被逐字节证明。

**Tech Stack:** Node.js ≥ 18（ESM）、`node:test` 内置测试框架、`node:vm` 做语法门。**不引入任何第三方依赖。**

## Global Constraints

以下约束对**每个** task 隐式生效：

- **零第三方依赖**：`package.json` 的 `dependencies` 必须始终为空（`{}`）。不得 `npm install` 任何东西。
- **模块系统**：全部 ESM（`"type": "module"`），文件后缀 `.mjs`。
- **测试框架**：Node 内置 `node:test` + `node:assert/strict`。不得引入 jest / vitest / mocha。
- **绝不硬编码 module id**：代码中不得出现 `72114` 或任何字面量数字形式的 webpack module id。用 `e.ChineseCNStrings=` 做结构定位。
- **翻译词典以英文原文为 key**：词典条目的 key 永远是英文字面量本身，绝不记录字节偏移。
- **只改值不改键**：绝不移除对象字面量的键。
- **不改写已有官方译文**：`zh_CN` 命名空间中已存在的条目永远保持原样。
- **不触碰非 zh_CN 语言模块**：补丁必须排除全部 37 个其他语言模块的字节区间。
- **不触碰 Chromium `.pak` 文件**：只操作 `resources/app/.webpack/renderer/main_window.js`。
- **代码目录**：`C:\Users\Rosary\lmstudio-zh\`（Linux 上 `~/lmstudio-zh/`）。
- **状态目录**：`C:\Users\Rosary\.lmstudio-zh\`（Linux 上 `~/.lmstudio-zh/`）。**禁止写入 `~/.lmstudio/`**。
- **转义规则**：回写字符串时必须使用与原字面量相同的引号类型（`"`→`"`，`'`→`'`），并按该类型转义。
- **Node 运行时**：工具自身需要 Node ≥ 18。启动器负责探测系统 node → LM Studio 自带 node。

---

## File Structure

```
C:\Users\Rosary\lmstudio-zh\
  package.json                       { "type": "module", "dependencies": {} }
  bin/lmstudio-zh.mjs                CLI 入口（薄，仅解析 argv 并调用 cli.main）
  src/
    lex.mjs                          零依赖 JS 字面量扫描器 + 编解码
    lexicon.mjs                      双语词典读写、合并、来源优先级
    extract.mjs                      结构定位 i18n 目录 + 候选筛选（A 层 + B 层）
    patch.mjs                        计划 → 应用 → 四道闸门验证 → 还原
    discover.mjs                     跨平台定位安装目录与目标文件
    translate.mjs                    本机 LM Studio API 批量翻译
    cli.mjs                          命令编排
  lexicon/
    zh-CN.json                       人工词典（committed，origin=curated）
    short-words.json                 短 UI 词白名单（无空格的候选依据）
  test/
    lex.test.mjs
    lexicon.test.mjs
    extract.test.mjs
    patch.test.mjs
    discover.test.mjs
    translate.test.mjs
    cli.test.mjs
  fixtures/
    mini-bundle.mjs                  手写的仿真 bundle（供测试用，不依赖真实安装）
```

**文件职责（每个文件只做一件事）：**

| 文件 | 唯一职责 |
|---|---|
| `lex.mjs` | 在 JS 源码中找出所有字符串/模板字面量的精确字节区间；编解码字符串值。不认识 LM Studio。 |
| `lexicon.mjs` | 词典的持久化与查询。含来源优先级合并逻辑。不认识 JS。 |
| `extract.mjs` | 认识 LM Studio 的结构契约：定位 `ChineseCNStrings`、拆词条表、按规则筛候选。 |
| `patch.mjs` | 认识字节：把「译文决策」变成「字节区间编辑」，并执行四道闸门。不认识 LM Studio 语义。 |
| `discover.mjs` | 只做文件系统探测，跨平台。 |
| `translate.mjs` | 只做 HTTP 调用与批次管理。 |
| `cli.mjs` | 只做编排与输出。 |

---

## Task 1: 字面量扫描器（`lex.mjs`）

这是全工具的地基——后面所有安全性保证都建立在「扫描器给出的字节区间绝对准确」之上。必须先独立做完并测透。

**Files:**
- Create: `src/lex.mjs`
- Create: `test/lex.test.mjs`
- Create: `tools/check-real-bundle.mjs`
- Create: `package.json`

**Interfaces:**
- Consumes: 无（叶子模块）
- Produces:
  - `scan(code: string): Literal[]`
  - `decode(raw: string): string`
  - `encode(value: string, quote: '"' | "'" | '`'): string`

  其中 `Literal = { start: number, end: number, quote: '"' | "'" | '`', raw: string, value: string, isKey: boolean, hasSubstitution: boolean }`
  - `start`/`end` 为该字面量**含引号**的字节区间（左闭右开）
  - `isKey` 表示该字面量在源码中充当对象字面量的键
  - `hasSubstitution` 仅对反引号有意义：是否含 `${...}` 插值

---

- [ ] **Step 1: 创建 package.json 与测试骨架**

`package.json`：

```json
{
  "name": "lmstudio-zh",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "lmstudio-zh": "./bin/lmstudio-zh.mjs" },
  "dependencies": {},
  "engines": { "node": ">=18" },
  "scripts": { "test": "node --test test/" }
}
```

`test/lex.test.mjs` 开头：

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { scan, decode, encode } from "../src/lex.mjs";
```

- [ ] **Step 2: 写第一个失败测试**

```javascript
test("scan: finds a simple double-quoted literal with exact span", () => {
  const code = `const a="hello";`;
  const lits = scan(code);
  assert.equal(lits.length, 1);
  assert.equal(lits[0].value, "hello");
  assert.equal(lits[0].quote, '"');
  assert.equal(code.slice(lits[0].start, lits[0].end), '"hello"');
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test test/lex.test.mjs`
Expected: FAIL — `Cannot find module '../src/lex.mjs'`

- [ ] **Step 4: 实现 scan / decode 的最小版本**

`src/lex.mjs`：

```javascript
// 判断一个 '/' 是正则字面量的开始还是除号。
// 规则：若前一个有效字符能结束一个表达式（标识符、数字、`)`、`]`、`}`），则是除号。
const EXPRESSION_ENDING = /[A-Za-z0-9_$)\]]/;

export function decode(raw) {
  const quote = raw[0];
  const body = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") { out += c; continue; }
    const n = body[++i];
    const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0",
                     "\\": "\\", '"': '"', "'": "'", "`": "`", "/": "/" };
    if (n === "u") {
      if (body[i + 1] === "{") {
        const close = body.indexOf("}", i + 2);
        out += String.fromCodePoint(parseInt(body.slice(i + 2, close), 16));
        i = close;
      } else {
        out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16));
        i += 4;
      }
      continue;
    }
    if (n === "x") { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16)); i += 2; continue; }
    if (n === "\n") continue;           // 行接续
    out += simple[n] ?? n;
  }
  return out;
}

export function scan(code) {
  const n = code.length;
  const out = [];
  let i = 0;
  let lastSig = "";

  while (i < n) {
    const c = code[i];

    // 行注释
    if (c === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    // 块注释
    if (c === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      if (close < 0) break;
      i = close + 2;
      continue;
    }
    // 普通字符串
    if (c === '"' || c === "'") {
      const start = i;
      i++;
      while (i < n) {
        if (code[i] === "\\") { i += 2; continue; }
        if (code[i] === c) { i++; break; }
        i++;
      }
      out.push(mk(code, start, i, lastSig));
      lastSig = '"';
      continue;
    }
    // 模板串
    if (c === "`") {
      const start = i;
      i++;
      let depth = 0;
      while (i < n) {
        if (code[i] === "\\") { i += 2; continue; }
        if (code[i] === "$" && code[i + 1] === "{") { depth++; i += 2; continue; }
        if (depth > 0 && code[i] === "}") { depth--; i++; continue; }
        if (code[i] === "`" && depth === 0) { i++; break; }
        i++;
      }
      out.push(mk(code, start, i, lastSig));
      lastSig = '"';
      continue;
    }
    // 正则字面量
    if (c === "/") {
      if (!EXPRESSION_ENDING.test(lastSig)) {
        i++;
        let inClass = false;
        while (i < n) {
          if (code[i] === "\\") { i += 2; continue; }
          if (code[i] === "[") inClass = true;
          else if (code[i] === "]") inClass = false;
          else if (code[i] === "/" && !inClass) { i++; break; }
          else if (code[i] === "\n") break;
          i++;
        }
        while (i < n && /[gimsuyd]/.test(code[i])) i++;
        lastSig = "/";
        continue;
      }
      i++;
      lastSig = "/";
      continue;
    }
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out;
}

function mk(code, start, end, lastSig) {
  const raw = code.slice(start, end);
  const quote = raw[0];
  const value = decode(raw);
  return {
    start, end, quote, raw, value,
    isKey: lastSig === ":",
    hasSubstitution: quote === "`" && raw.includes("${"),
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/lex.test.mjs`
Expected: PASS

- [ ] **Step 6: 补齐边界用例测试**

追加到 `test/lex.test.mjs`（每个用例都是独立的失败→实现循环，但为篇幅合并列出，实施时逐条跑）：

```javascript
test("scan: escaped quote does not terminate the literal", () => {
  const code = String.raw`var s="a\"b";var t=1;`;
  const lits = scan(code);
  assert.equal(lits.length, 1);
  assert.equal(lits[0].value, 'a"b');
});

test("scan: regex containing a quote is not treated as a string", () => {
  const code = String.raw`var re=/"unclosed/g; var s="real";`;
  const lits = scan(code);
  assert.equal(lits.length, 1);
  assert.equal(lits[0].value, "real");
});

test("scan: division after an identifier is not a regex", () => {
  const code = String.raw`var x=a/b/c; var s="after";`;
  const lits = scan(code);
  assert.equal(lits.length, 1);
  assert.equal(lits[0].value, "after");
});

test("scan: single-quoted literal keeps its quote type", () => {
  const lits = scan(`var s='hi';`);
  assert.equal(lits[0].quote, "'");
  assert.equal(lits[0].value, "hi");
});

test("scan: object key is flagged via preceding colon", () => {
  const lits = scan(`({chat:"Chat"})`);
  assert.equal(lits[0].isKey, true);
});

test("scan: object value is not flagged as key", () => {
  const lits = scan(`({t:"Chat"})`);
  assert.equal(lits[0].isKey, false);
});

test("scan: template with substitution sets hasSubstitution", () => {
  const lits = scan("var s=`n=${x} tok`;");
  assert.equal(lits[0].quote, "`");
  assert.equal(lits[0].hasSubstitution, true);
});

test("scan: line comment contents are ignored", () => {
  const lits = scan(`// "ghost"\nvar s="real";`);
  assert.equal(lits.length, 1);
  assert.equal(lits[0].value, "real");
});

test("decode: unicode escape and line continuation", () => {
  assert.equal(decode(String.raw`"A"`), "A");
  assert.equal(decode(String.raw`"a\<newline>b"`), "ab");
});

test("scan: spans are exact for a realistic minified fragment", () => {
  const code = String.raw`t.exports=JSON.parse('{"chat":"Chat"}')`;
  const lits = scan(code);
  assert.equal(lits.length, 1);
  assert.equal(JSON.parse(lits[0].value).chat, "Chat");
  assert.equal(code.slice(lits[0].start, lits[0].end), String.raw`'{"chat":"Chat"}'`);
});
```

- [ ] **Step 7: 实现 encode 并测试**

追加到 `src/lex.mjs`：

```javascript
export function encode(value, quote) {
  const q = quote === '"' || quote === "'" ? quote : "`";
  let out = q;
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += "\\" + q;
    else if (ch === "`" && q === "`") out += "\\`";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20) out += "\\x" + cp.toString(16).padStart(2, "0");
    else out += ch;                      // 非 ASCII（含中文）原样输出
  }
  return out + q;
}
```

追加测试：

```javascript
test("encode: round-trips through decode for both quote types", () => {
  for (const q of ['"', "'"]) {
    const v = `Reasoning Budget "x" it's \\ ok \n`;
    assert.equal(decode(encode(v, q)), v);
  }
});

test("encode: escapes the matching quote only", () => {
  assert.equal(encode(`a"b`, "'"), `'a"b'`);
  assert.equal(encode(`a'b`, '"'), `"a'b"`);
  assert.equal(encode(`a'b`, "'"), `'a\\'b'`);
});

test("encode: preserves CJK verbatim", () => {
  assert.equal(encode("推理预算", '"'), '"推理预算"');
});
```

- [ ] **Step 8: 运行全部测试**

Run: `node --test test/lex.test.mjs`
Expected: 全部 PASS

- [ ] **Step 9: 对真实 bundle 做一次精度校验（提交校验脚本，不作为单元测试）**

把校验脚本提交进仓库，使 `span-mismatch` 这个真实回归信号可复现（不要只用临时脚本）：

`tools/check-real-bundle.mjs`：

```javascript
// 用法: node tools/check-real-bundle.mjs [path-to-main_window.js]
import { readFileSync } from "node:fs";
import { scan, decode } from "../src/lex.mjs";

const file = process.argv[2]
  ?? String.raw`C:\Program Files\LM Studio\resources\app\.webpack\renderer\main_window.js`;
const code = readFileSync(file, "utf8");
const lits = scan(code);

let decodeMismatch = 0, spanMismatch = 0, unterminated = 0, overlong = 0;
for (const l of lits) {
  if (decode(l.raw) !== l.value) decodeMismatch++;
  if (code.slice(l.start, l.end) !== l.raw) spanMismatch++;
  if (!/^["'`]/.test(l.raw) || l.raw.at(-1) !== l.raw[0]) unterminated++;
  if (l.raw.length > 500) overlong++;
}

console.log(`literals       : ${lits.length}`);
console.log(`isKey-true     : ${lits.filter((l) => l.isKey).length}`);
console.log(`decode-mismatch: ${decodeMismatch}`);
console.log(`span-mismatch  : ${spanMismatch}`);
console.log(`unterminated   : ${unterminated}`);
console.log(`overlong(>500) : ${overlong}`);

// span-mismatch 与 unterminated 必须为 0；非 0 说明扫描器有缺陷，停止后续任务。
if (spanMismatch !== 0 || unterminated !== 0) {
  console.error("FAIL — 扫描器存在缺陷，停止。");
  process.exit(1);
}
console.log("OK");
```

Run: `node tools/check-real-bundle.mjs`
Expected: `literals 394006`、`isKey-true 8006`、`decode-mismatch 0`、`span-mismatch 0`、
`unterminated 0`、`overlong(>500)` 为个位数、`OK`

> `overlong(>500)` 统计的是「扫描器把一整段真实代码误当成了一个字面量」的跨度。
> 当前实测约 54 条、共约 1.3MB。Task 3 的 `isCandidate` 以 `length > 500` 拒绝它们，
> 因此不会被打补丁；这里是让该损失保持可见，而不是静默。

若 `span-mismatch` 或 `unterminated` 非 0，**停止**并报告，不要继续 Task 2——
说明扫描器有缺陷，后面所有安全性保证都是空话。

- [ ] **Step 10: Commit**

```bash
git init
git add package.json src/lex.mjs test/lex.test.mjs tools/check-real-bundle.mjs
git commit -m "feat(lex): zero-dependency JS literal scanner with exact spans"
```

---

## Task 2: 双语词典（`lexicon.mjs`）

**Files:**
- Create: `src/lexicon.mjs`
- Create: `test/lexicon.test.mjs`
- Create: `lexicon/zh-CN.json`

**Interfaces:**
- Consumes: 无（叶子模块）
- Produces:
  - `load(stateDir, toolDir): Lexicon`
  - `loadLocal(stateDir): Lexicon`
  - `lookup(lex, en): string | undefined`
  - `upsert(lex, en, zh, origin): void` — origin: "curated" | "model" | "user"
  - `saveLocal(lex, stateDir): void` — 仅把 `origin !== "curated"` 的条目落盘
  - `stats(lex): { total, curated, model, user }`

  其中 `Lexicon = { entries: Map<string, {zh: string, origin: "curated"|"model"|"user"}>, version: number }`

  **两条不可协商的健壮性要求：**

  1. `origin` 必须是 `"curated"` / `"model"` / `"user"` 之一。**未知 origin 一律拒绝写入**——不得让
     `PRIORITY[unknown]` 得到 `undefined` 并参与比较：`undefined >= 3` 为 false，结果是一个被手工改坏的
     `lexicon.local.json` 里的 `"origin": "typo"` 反而会覆盖 curated，正好摧毁这套优先级系统存在的唯一
     理由。`upsert` 同样要拒绝非法 origin。
  2. 读取 JSON 失败时**不得静默降级**。`zh-CN.json` 损坏必须抛出带文件路径的明确错误（人工词典丢失
     不能是静默的）；`lexicon.local.json` 损坏才允许降级为空（运行时产物，可重建），但必须可被察觉。

---

- [ ] **Step 1: 写失败测试**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, lookup, upsert, saveLocal, loadLocal } from "../src/lexicon.mjs";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/lexicon.test.mjs`
Expected: FAIL — `Cannot find module '../src/lexicon.mjs'`

- [ ] **Step 3: 实现**

`src/lexicon.mjs`：

```javascript
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// 优先级数字越大越优先。curated 是人工词典，永不被覆盖。
const PRIORITY = { model: 1, user: 2, curated: 3 };

// 人工词典（committed）：损坏必须报错，不能静默降级成「没有可翻译的东西」
function readCurated(path) {
  if (!existsSync(path)) return null;                 // 缺失不是错误
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { throw new Error(`无法解析人工词典 ${path}: ${e.message}`); }
}

// 运行时产物（可重建）：损坏可降级为空，但必须可被察觉
function readLocal(path, onWarn) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { onWarn?.(`本地词典已损坏，已忽略：${path} (${e.message})`); return null; }
}

export function emptyLexicon() {
  return { version: 1, entries: new Map() };
}

function ingest(lex, data) {
  if (!data || !data.entries) return;
  for (const [en, v] of Object.entries(data.entries)) {
    if (typeof v?.zh !== "string" || !v.zh) continue;
    // 未知 origin 一律拒绝：PRIORITY[unknown] 是 undefined，参与比较会击穿优先级
    if (!Object.hasOwn(PRIORITY, v.origin)) continue;
    const prev = lex.entries.get(en);
    if (prev && PRIORITY[prev.origin] >= PRIORITY[v.origin]) continue;
    lex.entries.set(en, { zh: v.zh, origin: v.origin });
  }
}

export function loadLocal(stateDir, onWarn) {
  const lex = emptyLexicon();
  ingest(lex, readLocal(join(stateDir, "lexicon.local.json"), onWarn));
  return lex;
}

export function load(stateDir, toolDir, onWarn) {
  const lex = emptyLexicon();
  ingest(lex, readCurated(join(toolDir, "lexicon", "zh-CN.json")));
  ingest(lex, readLocal(join(stateDir, "lexicon.local.json"), onWarn));
  return lex;
}

export function lookup(lex, en) {
  return lex.entries.get(en)?.zh;
}

export function upsert(lex, en, zh, origin) {
  if (!Object.hasOwn(PRIORITY, origin)) throw new Error(`非法 origin: ${origin}`);
  const prev = lex.entries.get(en);
  if (prev && PRIORITY[prev.origin] >= PRIORITY[origin]) return;
  lex.entries.set(en, { zh, origin });
}

export function saveLocal(lex, stateDir) {
  const out = { version: lex.version, entries: {} };
  for (const [en, v] of lex.entries) if (v.origin !== "curated") out.entries[en] = v;
  writeFileSync(join(stateDir, "lexicon.local.json"), JSON.stringify(out, null, 2), "utf8");
}

export function stats(lex) {
  const s = { total: lex.entries.size, curated: 0, model: 0, user: 0 };
  for (const v of lex.entries.values()) s[v.origin]++;
  return s;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/lexicon.test.mjs`
Expected: PASS

- [ ] **Step 5: 用已验证的真实数据建立人工词典种子**

把 §2.2 的 88 条缺失 key 的译文写进 `lexicon/zh-CN.json`。key 是**英文原文**（即 EN 词条表里的值），不是 key 名。

```json
{
  "version": 1,
  "entries": {
    "Clear last used model": { "zh": "清除最近使用的模型", "origin": "curated" },
    "Failed to clear last used model.": { "zh": "清除最近使用的模型失败。", "origin": "curated" },
    "Failed to sign out of the plugin": { "zh": "退出插件登录失败", "origin": "curated" },
    "Failed to cancel plugin authentication": { "zh": "取消插件认证失败", "origin": "curated" },
    "{{percentage}}% draft tokens accepted": { "zh": "已接受 {{percentage}}% 草稿 token", "origin": "curated" },
    "Accepted {{accepted}}/{{total}} draft tokens": { "zh": "已接受 {{accepted}}/{{total}} 个草稿 token", "origin": "curated" },
    "Reasoning Budget": { "zh": "推理预算", "origin": "curated" },
    "Token budget for thinking: off for unrestricted, 0 for immediate end, N > 0 for token budget": { "zh": "思考的 token 预算：关闭表示不限制，0 表示立即结束，N > 0 表示 token 预算", "origin": "curated" },
    "Chat Template": { "zh": "对话模板", "origin": "curated" },
    "The template used by engine protocol for chat, tools, reasoning, and multimodal formatting. Changing this requires reloading the model.": { "zh": "引擎协议用于对话、工具、推理和多模态格式化的模板。更改此项需要重新加载模型。", "origin": "curated" },
    "Max Concurrent Predictions": { "zh": "最大并发预测数", "origin": "curated" },
    "Maximum number of predictions the model can run at a given time. The speed of each individual prediction may decrease with concurrency, but each prediction will start faster and higher total throughput can be achieved": { "zh": "模型同一时间可运行的最大预测数。并发数升高时，单个预测的速度可能下降，但每个预测启动更快，总吞吐量可以更高", "origin": "curated" },
    "Unified KV Cache": { "zh": "统一 KV 缓存", "origin": "curated" },
    "Controls whether concurrent predictions share a single KV cache, saving memory. Disabling this ensures each prediction can utilize the full context length, at the cost of using more memory": { "zh": "控制并发预测是否共享同一个 KV 缓存，以节省显存。关闭后可确保每个预测都能用满上下文长度，但会占用更多显存", "origin": "curated" },
    "Context Checkpoints": { "zh": "上下文检查点", "origin": "curated" },
    "Maximum number of context checkpoints to keep per slot. Lower values reduce RAM usage for SWA/recurrent models. 0 disables checkpoints.": { "zh": "每个槽位保留的上下文检查点上限。数值越低，SWA/循环模型的内存占用越小。0 表示禁用检查点。", "origin": "curated" },
    "Reasoning Budget Message": { "zh": "推理预算提示消息", "origin": "curated" },
    "Message injected before the end-of-thinking tag when reasoning budget is exhausted (default: none)": { "zh": "推理预算耗尽时，在思考结束标签之前插入的消息（默认：无）", "origin": "curated" },
    "Number of layers for which to force MoE weights onto CPU": { "zh": "强制将 MoE 权重放到 CPU 的层数", "origin": "curated" },
    "Number of layers to force the experts into CPU. Saves VRAM and can be faster than partial GPU offload. Not recommended if the model fits entirely in VRAM.": { "zh": "强制将专家层放入 CPU 的层数。节省显存，可能比部分 GPU 卸载更快。若模型能完全装入显存则不推荐使用。", "origin": "curated" },
    "Specifies the number of layers to force the expert into CPU. Leaves attention layers on GPU, saving VRAM while keeping inference fairly fast.": { "zh": "指定强制将专家层放入 CPU 的层数。注意力层仍保留在 GPU 上，在保持较快推理速度的同时节省显存。", "origin": "curated" },
    "Automatic Optimize Based on Hardware": { "zh": "根据硬件自动优化", "origin": "curated" },
    "Let llama.cpp choose context and GPU placement at load time based on available memory": { "zh": "加载时由 llama.cpp 根据可用显存自动选择上下文长度与 GPU 分配方案", "origin": "curated" },
    "Maximum number of prompt tokens to process in one chunk. Larger values may improve performance, but can use more memory": { "zh": "单批次处理的提示词 token 上限。较大的值可能提升性能，但会占用更多内存", "origin": "curated" },
    "Automatic Context Sizing": { "zh": "自动上下文长度", "origin": "curated" },
    "Let the MLX runtime choose a safe context length at load time based on available memory": { "zh": "加载时由 MLX 运行时根据可用内存自动选择安全的上下文长度", "origin": "curated" },
    "Save": { "zh": "保存", "origin": "curated" },
    "Save your changes to the preset.": { "zh": "将你的更改保存到预设中。", "origin": "curated" },
    "New fields detected. You will be able to choose which changes to include in the preset.": { "zh": "检测到新字段。你将可以选择要将哪些更改纳入预设。", "origin": "curated" },
    "Hold": { "zh": "按住", "origin": "curated" },
    "to choose which changes to save to the preset.": { "zh": "以选择要保存到预设中的更改。", "origin": "curated" },
    "to save all changes.": { "zh": "以保存全部更改。", "origin": "curated" },
    "to only save changes to fields that are already included in the preset.": { "zh": "以仅保存预设中已有字段的更改。", "origin": "curated" },
    "Failed to save changes to the preset.": { "zh": "保存更改到预设失败。", "origin": "curated" },
    "Choose which changes to include in the preset.": { "zh": "选择要纳入预设的更改。", "origin": "curated" },
    "No changes to save.": { "zh": "没有需要保存的更改。", "origin": "curated" },
    "Unrestricted": { "zh": "不限制", "origin": "curated" },
    "Allow Remote MCP": { "zh": "允许远程 MCP", "origin": "curated" },
    "Allow using MCPs that are not in your mcp.json. These MCP connections are ephemeral, only existing as long as the request. At the moment, only remote MCPs are supported.": { "zh": "允许使用 mcp.json 中未定义的 MCP。这些 MCP 连接是临时的，仅在请求期间有效。目前仅支持远程 MCP。", "origin": "curated" },
    "Don't allow server requests to use MCP": { "zh": "不允许服务器请求使用 MCP", "origin": "curated" },
    "Allow connection to remote MCP servers": { "zh": "允许连接到远程 MCP 服务器", "origin": "curated" },
    "Failed to start the server": { "zh": "启动服务器失败", "origin": "curated" },
    "Failed to stop the server": { "zh": "停止服务器失败", "origin": "curated" },
    "OpenAI-like": { "zh": "类 OpenAI", "origin": "curated" },
    "Advanced interface for generating model responses. Create stateful interactions by passing the id of a previous responses as input to the next.": { "zh": "用于生成模型回复的高级接口。将上一次回复的 id 作为下一次输入即可创建有状态的交互。", "origin": "curated" },
    "List available models": { "zh": "列出可用模型", "origin": "curated" },
    "Load a model with options": { "zh": "带选项加载模型", "origin": "curated" },
    "Download a model": { "zh": "下载模型", "origin": "curated" },
    "Chat with a model. Supports stateful multi-turn conversations and MCP": { "zh": "与模型对话。支持有状态的多轮对话与 MCP", "origin": "curated" },
    "Get the status of a model download": { "zh": "获取模型下载状态", "origin": "curated" },
    "Anthropic-compatible": { "zh": "兼容 Anthropic", "origin": "curated" },
    "Navigation Bar position": { "zh": "导航栏位置", "origin": "curated" },
    "Top": { "zh": "顶部", "origin": "curated" },
    "Left": { "zh": "左侧", "origin": "curated" },
    "Model Defaults": { "zh": "模型默认值", "origin": "curated" },
    "Minimum AutoFit context length": { "zh": "AutoFit 最小上下文长度", "origin": "curated" },
    "Require AutoFit to provide at least this many tokens of context. Models that cannot meet this minimum will fail to load.": { "zh": "要求 AutoFit 至少提供这么多 token 的上下文。无法满足该最小值的模型将加载失败。", "origin": "curated" },
    "(Not recommended) Always allow 'Load Anyway' without holding Alt/Option": { "zh": "（不推荐）始终允许直接点击「仍要加载」，无需按住 Alt/Option", "origin": "curated" },
    "Default Context Length": { "zh": "默认上下文长度", "origin": "curated" },
    "Model Maximum": { "zh": "模型最大值", "origin": "curated" },
    "Custom value": { "zh": "自定义值", "origin": "curated" },
    "Use the maximum context length supported by each model.": { "zh": "使用每个模型所支持的最大上下文长度。", "origin": "curated" },
    "Set the default context length for loading new models. If the model's supported maximum context length is lower, that value will be used.": { "zh": "设置加载新模型时使用的默认上下文长度。若模型支持的最大上下文长度更低，则使用该值。", "origin": "curated" },
    "Invalid context length value. Using {{value}}": { "zh": "上下文长度值无效，正在使用 {{value}}", "origin": "curated" },
    "Invalid context length value. Should be in the range of 1 and 2^30. Using {{value}}": { "zh": "上下文长度值无效，应在 1 到 2^30 之间，正在使用 {{value}}", "origin": "curated" },
    "The higher the context length, the more memory the model will take. If you are unsure, don't change the default": { "zh": "上下文长度越大，模型占用的内存越多。如果不确定，请勿修改默认值", "origin": "curated" },
    "JIT-loaded models will be automatically unloaded after being idle for the specified duration.": { "zh": "JIT 加载的模型在空闲指定时长后会被自动卸载。", "origin": "curated" },
    "Indexing models...": { "zh": "正在索引模型...", "origin": "curated" },
    "Estimated Memory Usage": { "zh": "预计显存占用", "origin": "curated" },
    "Total": { "zh": "总计", "origin": "curated" },
    "GPU": { "zh": "GPU", "origin": "curated" },
    "Memory estimate unavailable for this model": { "zh": "无法估算该模型的显存占用", "origin": "curated" },
    "Not enough resources to load the model with the current settings": { "zh": "当前设置下资源不足，无法加载该模型", "origin": "curated" },
    "Options": { "zh": "选项", "origin": "curated" },
    "It appears your system does not have enough memory to load this model.": { "zh": "你的系统似乎没有足够的内存来加载该模型。", "origin": "curated" },
    "You can adjust the model loading guardrails in settings or hold <altOptionKey /> to load anyway.": { "zh": "你可以在设置中调整模型加载保护阈值，或按住 <altOptionKey /> 强制加载。", "origin": "curated" },
    "Loading a model that is too large may overload your system and cause it to freeze.": { "zh": "加载过大的模型可能导致系统超载并卡死。", "origin": "curated" },
    "Switch model source": { "zh": "切换模型来源", "origin": "curated" },
    "Reset to default": { "zh": "重置为默认值", "origin": "curated" },
    "There are multiple available source files for this model.": { "zh": "该模型有多个可用的源文件。", "origin": "curated" },
    "Variants": { "zh": "变体", "origin": "curated" },
    "Beta": { "zh": "测试版", "origin": "curated" },
    "Off": { "zh": "关闭", "origin": "curated" },
    "Remote": { "zh": "远程", "origin": "curated" },
    "LM Studio": { "zh": "LM Studio", "origin": "curated" }
  }
}
```

- [ ] **Step 6: 加一个校验测试，保证词典 key 的占位符集合合法**

追加到 `test/lexicon.test.mjs`：

```javascript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
```

- [ ] **Step 7: 运行全部测试**

Run: `node --test test/lexicon.test.mjs`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/lexicon.mjs test/lexicon.test.mjs lexicon/zh-CN.json
git commit -m "feat(lexicon): bilingual dictionary with source-priority merge"
```

---

## Task 3: 结构定位与候选筛选（`extract.mjs`）

**Files:**
- Create: `src/extract.mjs`
- Create: `test/extract.test.mjs`
- Create: `fixtures/mini-bundle.mjs`
- Create: `lexicon/short-words.json`
- Modify: `tools/check-real-bundle.mjs`

**Interfaces:**
- Consumes: `scan` from `lex.mjs`
- Produces:
  - `locateLanguageModule(code): { namespacesByLang: Map<string, { [ns]: modId }> } | null`
  - `readCatalog(code, located, lang): { [namespace]: { modId, span, data } }`
  - `allLanguageModules(code, located): Span[]` — **全部**语言命名空间模块的字节区间（用于排除）
  - `zhCatalog(code, located)` / `enCatalog(code, located)` — 同上的简写
  - `candidates(code, located): Candidate[]` — B 层候选
  - `missingFromA(code, located): MissingEntry[]` — A 层缺口
  - `isCandidate(text, isKey): boolean`
  - `isPhantomSpan(raw): boolean` — 幻影跨度守卫（见 Step 8）

  其中 `Span = { start, end }`，`Candidate = { text, span, quote, hasSubstitution, source: "B" }`，`MissingEntry = { namespace, key, en }`

---

- [ ] **Step 1: 写 fixtures/mini-bundle.mjs（仿真 bundle）**

```javascript
// 一个结构上模仿真实 LM Studio bundle 的最小样本。
// 真实 bundle 中对应的模块 id 是 72114；这里刻意用别的数字，
// 以证明实现不依赖具体 id。
export const MINI = `(()=>{
var __webpack_modules__={
38801:(t,e)=>{"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.EnglishStrings=e.ChineseCNStrings=e.SwedishStrings=void 0;const r=(t=>t.default)(a(10001)),i=(t=>t.default)(a(10002)),o=(t=>t.default)(a(10003)),p=(t=>t.default)(a(10004));const en={sidebar:r,chat:i,config:o,models:p};e.EnglishStrings=en;const zh={sidebar:(t=>t.default)(a(20001)),chat:(t=>t.default)(a(20002)),config:(t=>t.default)(a(20003)),models:(t=>t.default)(a(20004))};e.ChineseCNStrings=zh;const sw={sidebar:(t=>t.default)(a(30001)),chat:(t=>t.default)(a(30002)),config:(t=>t.default)(a(30003)),models:(t=>t.default)(a(30004))};e.SwedishStrings=sw},
10001:t=>{"use strict";t.exports=JSON.parse('{"chat":"Chat","discover":"Discover","runtimes":"Runtime","settings":"Settings"}')},
10002:t=>{"use strict";t.exports=JSON.parse('{"send":"Send message","stop":"Stop generating","rename":"Rename chat","onlyInEn":"Only in English"}')},
10003:t=>{"use strict";t.exports=JSON.parse('{"contextLength":"Context Length","onlyInEn":"Another English only"}')},
10004:t=>{"use strict";t.exports=JSON.parse('{"pinned":"Pinned","onlyInEn":"Third English only"}')},
20001:t=>{"use strict";t.exports=JSON.parse('{"chat":"\\u804a\\u5929","discover":"\\u53d1\\u73b0","runtimes":"\\u8fd0\\u884c\\u73af\\u5883","settings":"\\u8bbe\\u7f6e"}')},
20002:t=>{"use strict";t.exports=JSON.parse('{"send":"\\u53d1\\u9001\\u6d88\\u606f","stop":"\\u505c\\u6b62\\u751f\\u6210","rename":"\\u91cd\\u547d\\u540d"}')},
20003:t=>{"use strict";t.exports=JSON.parse('{"contextLength":"\\u4e0a\\u4e0b\\u6587\\u957f\\u5ea6"}')},
20004:t=>{"use strict";t.exports=JSON.parse('{"pinned":"\\u5df2\\u56fa\\u5b9a"}')},
30001:t=>{"use strict";t.exports=JSON.parse('{"chat":"Chatt","discover":"Uppt\\u00e4ck","runtimes":"Runtime","settings":"Inst\\u00e4llningar"}')},
30002:t=>{"use strict";t.exports=JSON.parse('{"send":"Skicka meddelande","stop":"Stoppa generering","rename":"Byt namn"}')},
30003:t=>{"use strict";t.exports=JSON.parse('{"contextLength":"Kontextl\\u00e4ngd"}')},
30004:t=>{"use strict";t.exports=JSON.parse('{"pinned":"F\\u00e4st"}')}
};
function a(id){return {default:__webpack_modules__[id]};}
return __webpack_modules__;})()`;
```

> 注意：真实 bundle 中语言对象是 `{sidebar: X.default, ...}` 且变量通过 `n(a(id))` 引入。上面为可读性写成内联形式。`locateLanguageModule` 必须同时支持这两种写法。

- [ ] **Step 2: 写失败测试**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { MINI } from "../fixtures/mini-bundle.mjs";
import { locateLanguageModule, readCatalog, allLanguageModules, zhCatalog, enCatalog, candidates, missingFromA }
  from "../src/extract.mjs";

test("locateLanguageModule: finds zh_CN namespaces without knowing the module id", () => {
  const m = locateLanguageModule(MINI);
  assert.ok(m, "should locate");
  assert.deepEqual(Object.keys(m.namespacesByLang.get("zh_CN")).sort(),
    ["chat", "config", "models", "sidebar"]);
});

test("readCatalog: parses zh_CN sidebar and decodes escapes", () => {
  const m = locateLanguageModule(MINI);
  const cat = readCatalog(MINI, m, "zh_CN");
  assert.equal(cat.sidebar.data.chat, "聊天");
});

test("readCatalog: en catalog has the key zh lacks", () => {
  const m = locateLanguageModule(MINI);
  const en = readCatalog(MINI, m, "en");
  const zh = readCatalog(MINI, m, "zh_CN");
  assert.equal(en.chat.data.onlyInEn, "Only in English");
  assert.equal(zh.chat.data.onlyInEn, undefined);
});

test("allLanguageModules: spans do not overlap and cover every namespace module", () => {
  const m = locateLanguageModule(MINI);
  const spans = allLanguageModules(MINI, m);
  assert.ok(spans.length >= 12);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i].start >= spans[i-1].end);
});

test("missingFromA: reports en keys absent from zh", () => {
  const m = locateLanguageModule(MINI);
  const miss = missingFromA(MINI, m);
  const keys = miss.map((x) => x.key);
  assert.deepEqual(keys.sort(), ["Another English only", "Only in English", "Third English only"]);
  assert.equal(miss[0].en, "Another English only");
});

test("locateLanguageModule: returns null on an incompatible bundle", () => {
  assert.equal(locateLanguageModule("var x=1;"), null);
});
```

- [ ] **Step 3: 运行确认失败**

Run: `node --test test/extract.test.mjs`
Expected: FAIL — `Cannot find module '../src/extract.mjs'`

- [ ] **Step 4: 实现 locateLanguageModule**

`src/extract.mjs` 开头：

```javascript
import { scan, decode } from "./lex.mjs";

// 定位「导出各语言 *Strings 对象」的那个模块。
// 不依赖 module id，只依赖结构：
//   ① 存在形如  e.ChineseCNStrings=<ident>;  的赋值
//   ② 在同一模块内能找到 <ident>={ns:<ident2>.default, ...}  或 {ns:(...)(a(ID)), ...}
//
// 返回 namespacesByLang: Map<lang, { [namespace]: modId }>
export function locateLanguageModule(code) {
  // 收集所有 e.<Lang>Strings=<ident>; 形式的赋值
  const assigns = new Map();
  for (const m of code.matchAll(/e\.([A-Za-z_$][\w$]*Strings)=([A-Za-z_$][\w$]*);/g)) {
    assigns.set(m[1], m[2]);
  }
  if (assigns.size === 0) return null;
  if (!assigns.has("ChineseCNStrings")) return null;

  // 只在这个模块的范围内工作：从第一个赋值往前找到模块起点，之后往后找到模块终点。
  const firstIdx = code.indexOf("e." + [...assigns.keys()][0] + "=");
  const modStart = findModuleStart(code, firstIdx);
  const modEnd = findModuleEnd(code, firstIdx);
  if (modStart < 0 || modEnd < 0) return null;
  const modText = code.slice(modStart, modEnd);

  // 建立「本模块内标识符 → module id」映射，支持 X=n(a(ID)) 与 X=(...)(a(ID)) 两种写法
  const varToId = new Map();
  for (const m of modText.matchAll(
        /(?<![\w$])([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\s*\(\s*)?a\((\d+)\)\s*\)?/g)) {
    varToId.set(m[1], m[2]);
  }

  const namespacesByLang = new Map();
  for (const [lang, ident] of assigns) {
    const obj = findNamespaceObject(modText, ident);
    if (!obj) return null;
    const ns = {};
    for (const [name, ref] of Object.entries(obj)) {
      const id = resolveRef(ref, modText, varToId);
      if (id == null) return null;
      ns[name] = id;
    }
    namespacesByLang.set(lang, ns);
  }
  return { namespacesByLang, varToId };
}
```

辅助函数（同一文件）：

```javascript
// 从 idx 往回找最近的 "NNNNN:(function...)|(...)=>{" 或 ",NNNNN:" 模块起始
function findModuleStart(code, idx) {
  const re = /(?:^|[,{}])\d{2,6}:\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)\s*\{/g;
  let best = -1, m;
  while ((m = re.exec(code)) && m.index < idx) best = m.index;
  return best;
}

// 从 idx 往后找下一个模块起始
function findModuleEnd(code, idx) {
  const re = /[,{}]\d{2,6}:\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)\s*\{/g;
  re.lastIndex = idx;
  const m = re.exec(code);
  return m ? m.index + 1 : code.length;
}

// 找到 "<ident>={" 或 ",<ident>={" 开头的对象字面量，返回其正文
function findNamespaceObject(modText, ident) {
  const re = new RegExp(`(?:const\\s+|,)\\s*${ident}\\s*=\\s*\\{`);
  const m = re.exec(modText);
  if (!m) return null;
  const brace = m.index + m[0].length - 1;
  const end = matchBrace(modText, brace);
  const body = modText.slice(brace + 1, end - 1);
  const out = {};
  for (const kv of body.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*([^,}]+)/g)) {
    out[kv[1]] = kv[2].trim();
  }
  return Object.keys(out).length ? out : null;
}

function matchBrace(text, brace) {
  let d = 0;
  for (let i = brace; i < text.length; i++) {
    if (text[i] === "{") d++;
    else if (text[i] === "}") { d--; if (d === 0) return i + 1; }
  }
  return text.length;
}

// ref 形如 "r.default" 或 "(t=>t.default)(a(10001))"
function resolveRef(ref, modText, varToId) {
  const direct = /^([A-Za-z_$][\w$]*)\.default$/.exec(ref);
  if (direct) return varToId.get(direct[1]);
  const inline = /a\((\d+)\)/.exec(ref);
  if (inline) return inline[1];
  return null;
}
```

- [ ] **Step 5: 运行测试**

Run: `node --test test/extract.test.mjs`
Expected: PASS（若 `findModuleStart` 的模块边界判定失败，用真实 bundle 打印 `modText.length` 辅助调试，但**不得硬编码边界**）

- [ ] **Step 6: 实现 readCatalog / allLanguageModules / zhCatalog / enCatalog**

```javascript
// 读取某语言各命名空间模块里的 JSON.parse('...') 内容
export function readCatalog(code, located, lang) {
  const ns = located.namespacesByLang.get(lang);
  if (!ns) return null;
  const out = {};
  for (const [name, modId] of Object.entries(ns)) {
    const span = findJsonParseSpan(code, modId);
    if (!span) return null;
    try { out[name] = { modId, span: span.span, data: JSON.parse(span.value) }; }
    catch { return null; }
  }
  return out;
}

// 找到 "NNNNN:<fn>=>{" 后第一个 JSON.parse(' 的字面量区间
function findJsonParseSpan(code, modId) {
  const head = new RegExp(`[,{]\\s*${modId}\\s*:\\s*(?:function\\s*\\([^)]*\\)|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`).exec(code);
  if (!head) return null;
  const j = code.indexOf("JSON.parse(", head.index);
  if (j < 0 || j - head.index > 600) return null;
  const lits = scan(code.slice(j));
  const lit = lits.find((l) => l.quote === "'" || l.quote === '"');
  if (!lit) return null;
  const start = j + lit.start, end = j + lit.end;
  return { start, end, value: decode(code.slice(start, end)) };
}

// 全部语言模块的字节区间——补丁必须排除这些区间
export function allLanguageModules(code, located) {
  const spans = [];
  for (const ns of located.namespacesByLang.values()) {
    for (const modId of Object.values(ns)) {
      const s = findJsonParseSpan(code, modId);
      if (s) spans.push({ start: s.start, end: s.end });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  // 去重重叠
  return spans.filter((s, i) => i === 0 || s.start >= spans[i - 1].end);
}

export const zhCatalog = (code, located) => readCatalog(code, located, "zh_CN");
export const enCatalog = (code, located) => readCatalog(code, located, "en");

// A 层缺口：英文词条表里有、中文词条表里没有
export function missingFromA(code, located) {
  const en = enCatalog(code, located);
  const zh = zhCatalog(code, located);
  if (!en || !zh) return [];
  const out = [];
  for (const [namespace, { data }] of Object.entries(en)) {
    const zdata = zh[namespace]?.data ?? {};
    for (const [key, value] of flatten(data)) {
      const dotted = joinPath(key, zdata);
      if (dotted === undefined) out.push({ namespace, key, en: value });
    }
  }
  return out;
}

function flatten(o, p = []) {
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...flatten(v, [...p, k]));
    else out.push([[...p, k].join("/"), v]);
  }
  return out;
}
function joinPath(dotted, obj) {
  const parts = dotted.split("/");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}
```

- [ ] **Step 7: 运行测试**

Run: `node --test test/extract.test.mjs`
Expected: PASS

- [ ] **Step 8: 实现 B 层候选筛选 `candidates`**

先写 `lexicon/short-words.json`（无空格的短 UI 词白名单）：

```json
["Clear", "Rename", "Save", "Delete", "Cancel", "Close", "Apply", "Reset", "Load",
 "Unload", "Edit", "Copy", "Paste", "Copy", "Refresh", "Retry", "Continue", "Submit",
 "Enable", "Disable", "Enabled", "Disabled", "Options", "Advanced", "Details",
 "Default", "Custom", "Auto", "Beta", "Top", "Left", "Right", "Bottom", "Total",
 "GPU", "CPU", "RAM", "VRAM", "Off", "On", "Remote", "Local", "Variants",
 "Capabilities", "Integrations", "Format", "Permissions", "Info", "Help", "New",
 "Open", "Export", "Import", "Preview", "Download", "Upload", "Start", "Stop",
 "Pause", "Resume", "Search", "Filter", "Sort", "Select", "Choose", "None", "All",
 "Yes", "No", "Done", "Error", "Warning", "Install", "Uninstall", "Update", "Move",
 "Rename", "Duplicate", "Hide", "Show", "More", "Less", "Add", "Remove", "Change",
 "Unchanged", "Latest", "Alphabetical", "Permissions", "Integrations", "OCR", "MTP"]
```

`src/extract.mjs` 追加：

```javascript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as pathJoin } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHORT_WORDS = new Set(
  JSON.parse(readFileSync(pathJoin(HERE, "..", "lexicon", "short-words.json"), "utf8"))
);

// 拒绝规则——命中即淘汰，优先级最高
const DENY = [
  /^https?:\/\//i, /^wss?:\/\//i, /^mailto:/i,
  /^[A-Za-z]:[\\/]/, /^\/(?:usr|opt|etc|var|home)\//, /^\.{1,2}\//,
  /^\/[\w.\-\/]+$/,                      // 绝对路径
  /^[A-Z][A-Z0-9_]{2,}$/,                // 全大写错误码：NOT_READY
  /^[a-z0-9:_\-\/\[\]\.%()#]+$/,         // CSS / Tailwind 类名
  /^[0-9a-fA-F]{16,}$/,                  // hex blob
  /^[A-Za-z_$][\w$]*$/,                  // 裸标识符（无空格且非白名单）
  /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/,
  /^[<{[]/, /[>}\]]$/,                   // 以 HTML/JSON 符号开头或结尾
  /\\n|\\r|\\t/,                          // 含控制转义
];
const hasCJK = (s) => /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(s);

export function isCandidate(text, isKey, raw) {
  if (isKey) return false;                       // 只翻值
  if (!text || text.length < 2 || text.length > 500) return false;
  if (hasCJK(text)) return false;                // 已翻译
  for (const re of DENY) if (re.test(text)) return false;
  if (!/[A-Za-z]/.test(text)) return false;      // 必须含拉丁字母
  if (SHORT_WORDS.has(text)) return true;        // 无空格但属短 UI 词
  if (!text.includes(" ")) return false;
  return /[A-Z]/.test(text);                     // 多词需含大写字母
}

// 幻影跨度守卫。扫描器在极少数构造上会把一整段真实代码并进一个字面量。
// 实测：overlong(>500) 共 7,696 条 / 10.4MB，但其中 84% 是 LM Studio 自己的
// i18n 词条表与 tailwind CSS 等合法内嵌数据——所以单看长度无法区分数据与代码。
// 再叠加「形似代码」特征后收敛到 101 条 / 1.5MB，逐条检查全部是被吞掉的真实
// 压缩 JS（webpack 模块体、class、this.、Object.defineProperty…）。
//
// 关键：判据用的是 raw（跨度的原始宽度），不是解码后的 value——实测存在
// raw 长 36 字符、value 仅 30 字符的幻影，只过滤 value 会漏掉。
export function isPhantomSpan(raw) {
  if (raw.length <= 500) return false;
  return /function|=>|===|var\s|class\s|this\./.test(raw);
}

// B 层候选：bundle 内、不属于任何语言模块区间的自然语言字面量
export function candidates(code, located) {
  const excluded = allLanguageModules(code, located);
  const inExcluded = (pos) => excluded.some((s) => pos >= s.start && pos < s.end);
  const out = [];
  for (const lit of scan(code)) {
    if (inExcluded(lit.start)) continue;
    if (isPhantomSpan(lit.raw)) continue;          // 幻影跨度：绝不翻译
    if (!isCandidate(lit.value, lit.isKey)) continue;
    out.push({ text: lit.value, span: { start: lit.start, end: lit.end },
               quote: lit.quote, hasSubstitution: lit.hasSubstitution, source: "B" });
  }
  return out;
}
```

- [ ] **Step 9: 追加候选筛选测试**

```javascript
test("isCandidate: rejects identifiers, urls, paths, css, error codes", async () => {
  const { isCandidate } = await import("../src/extract.mjs");
  for (const bad of ["deleteFile", "https://lmstudio.ai", "/usr/lib/x.so",
                     "text-foreground", "NOT_READY", "a1b2c3d4e5f6a7b8",
                     "modelDownloadSourceSchema", "func.def"]) {
    assert.equal(isCandidate(bad, false), false, `should reject ${bad}`);
  }
});

test("isCandidate: accepts natural UI text and whitelisted short words", async () => {
  const { isCandidate } = await import("../src/extract.mjs");
  assert.equal(isCandidate("Resume Download", false), true);
  assert.equal(isCandidate("Export as PDF (.pdf)", false), true);
  assert.equal(isCandidate("Clear", false), true);
  assert.equal(isCandidate("Clear", true), false);      // 键不翻
});

test("isCandidate: rejects already-translated text", async () => {
  const { isCandidate } = await import("../src/extract.mjs");
  assert.equal(isCandidate("已下载", false), false);
});

test("isPhantomSpan: flags swallowed code, not embedded data", async () => {
  const { isPhantomSpan } = await import("../src/extract.mjs");
  // 被吞掉的真实压缩 JS：长度大且形似代码
  assert.equal(isPhantomSpan("x".repeat(600) + "function a(){}"), true);
  assert.equal(isPhantomSpan("x".repeat(600) + "var q=1"), true);
  assert.equal(isPhantomSpan("x".repeat(600) + "this.a=1"), true);
  // 合法内嵌数据：长度大但无形似代码特征
  assert.equal(isPhantomSpan('{"chat":"Chat","discover":"Discover"}'), false);
  assert.equal(isPhantomSpan(".a{color:red;padding:0}"), false);
  // 正常短字面量一律不是幻影
  assert.equal(isPhantomSpan('"Resume Download"'), false);
  assert.equal(isPhantomSpan("x".repeat(600)), false);   // 长但无形似代码特征
});

test("candidates: phantom spans are never candidates", () => {
  const evil = 'var a="' + "x".repeat(600) + "function q(){}=1;var b=1;" + '";var c="Resume Download";';
  const m = locateLanguageModule(evil);
  const c = candidates(evil, m);
  assert.equal(c.some((x) => x.text.includes("function q")), false);
});

test("candidates: language module literals are excluded", () => {
  const m = locateLanguageModule(MINI);
  const c = candidates(MINI, m);
  assert.equal(c.some((x) => x.text === "Chatt"), false);   // 瑞典语模块
  assert.equal(c.some((x) => x.text === "聊天"), false);    // zh 模块（已有 CJK）
});
```

- [ ] **Step 10: 运行全部测试**

Run: `node --test test/extract.test.mjs`
Expected: PASS

- [ ] **Step 11: 对真实 bundle 校验 A 层缺口数应为 88**

Run:
```bash
node -e "import('./src/extract.mjs').then(async m=>{const fs=await import('node:fs');const c=fs.readFileSync(String.raw\`C:\Program Files\LM Studio\resources\app\.webpack\renderer\main_window.js\`,'utf8');const loc=m.locateLanguageModule(c);console.log('langs',[...loc.namespacesByLang.keys()].length);const miss=m.missingFromA(c,loc);console.log('A-layer missing:',miss.length);})"
```
Expected: `langs 38` 与 `A-layer missing: 88`

若不是 88，**停止并报告**——说明结构定位或 flatten/joinPath 的键路径处理与之前实测不一致。

- [ ] **Step 12: Commit**

```bash
git add src/extract.mjs test/extract.test.mjs fixtures/mini-bundle.mjs lexicon/short-words.json
git commit -m "feat(extract): structural i18n catalog location and candidate filtering"
```

---

## Task 4: 补丁核心与四道闸门（`patch.mjs`）

整个工具的风险集中在这里。

**Files:**
- Create: `src/patch.mjs`
- Create: `test/patch.test.mjs`

**Interfaces:**
- Consumes: `encode` from `lex.mjs`；`locateLanguageModule`, `readCatalog`, `allLanguageModules`, `missingFromA` from `extract.mjs`
- Produces:
  - `planA(code, located, decisions): Edit[]` — A 层编辑计划
  - `planB(code, located, decisions): Edit[]` — B 层编辑计划
  - `planForDecisions(code, decisions): Edit[]`
  - `splice(code, edits): string`
  - `validate(edit): { ok, reason? }` — 闸门 3 的逐条校验
  - `reverify(code, edit): boolean` — **闸门 3.5：独立复验跨度**（见下）
  - `verify(original, patched, manifest): GateResult` — 闸门 4 的四项
  - `apply(target, original, patched, stateDir): ApplyResult`
  - `restore(target, stateDir): boolean`
  - `provenance(code, stateDir): { state, manifest }`

  其中 `Edit = { start, end, original, replacement, en, zh, origin }`

### 闸门 3.5 — 跨度独立复验

`extract.candidates` 的过滤发生在**选计划**时，而 `apply` 写文件是另一个时刻、另一段代码路径。
扫描器的幻影跨度（把一整段真实压缩 JS 并进一个字面量）在此处被二次独立拦截：

对每条待写入的 edit，重新用 `lex` 在当前缓冲区上按该 edit 的 `start`/`end` 切片，
断言切片结果 **逐字节等于** edit 记录的 `original`，且 `original` 的首尾引号配对、
且 `decode(original)` 等于 edit 记录的 `en`。任一不符即拒绝该 edit（不是拒绝整个补丁），
并把它记入 `pending.json`。

这与闸门 4 的「由原文件 + manifest 重算」是不同层面的检查：闸门 4 证明「补丁没做计划外的事」，
闸门 3.5 证明「计划本身建立在真实跨度上」。

---

- [ ] **Step 1: 写失败测试——编辑计划与 splice**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { encode } from "../src/lex.mjs";
import { splice, validate, verify, planA, planB, planForDecisions } from "../src/patch.mjs";
import { MINI } from "../fixtures/mini-bundle.mjs";

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

test("validate: rejects empty or already-CJK target", () => {
  assert.equal(validate({ en: "Clear", zh: "", origin: "model" }).ok, false);
  assert.equal(validate({ en: "Clear", zh: "清除", origin: "curated" }).ok, true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/patch.test.mjs`
Expected: FAIL — `Cannot find module '../src/patch.mjs'`

- [ ] **Step 3: 实现 splice 与 validate**

`src/patch.mjs`：

```javascript
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { encode } from "./lex.mjs";
import { locateLanguageModule, readCatalog, allLanguageModules, missingFromA } from "./extract.mjs";

export const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// edits 必须按 start 升序且互不重叠
export function splice(code, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) throw new Error(`overlapping edits at ${sorted[i].start}`);
  }
  let out = "", prev = 0;
  for (const e of sorted) {
    out += code.slice(prev, e.start) + e.replacement;
    prev = e.end;
  }
  return out + code.slice(prev);
}

// 闸门 3：占位符集合必须完全一致
const placeholders = (s) => (String(s).match(/\{\{[^}]*\}\}/g) ?? []).sort().join(" ");

export function validate(edit) {
  const { en, zh } = edit;
  if (typeof zh !== "string" || !zh.trim()) return { ok: false, reason: "empty target" };
  if (placeholders(en) !== placeholders(zh)) return { ok: false, reason: "placeholder mismatch" };
  if (en.length * 0.2 > zh.length) return { ok: false, reason: "target too short" };
  if (zh.length > en.length * 5) return { ok: false, reason: "target too long" };
  return { ok: true };
}
```

- [ ] **Step 4: 运行测试**

Run: `node --test test/patch.test.mjs`
Expected: PASS

- [ ] **Step 5: 写失败测试——四道闸门**

```javascript
import vm from "node:vm";
import { sha256, splice, verify } from "../src/patch.mjs";

test("verify: passes when patched is exactly original+edits", () => {
  const original = 'var s="Clear";';
  const edits = [{ start: 8, end: 13, replacement: '"清除"' }];
  const patched = splice(original, edits);
  const r = verify(original, patched, { edits });
  assert.equal(r.ok, true);
  assert.equal(r.gates.length, 4);
  assert.ok(r.gates.every((g) => g.ok));
});

test("verify: gate 3 catches a stray extra change", () => {
  const original = 'var s="Clear";';
  const edits = [{ start: 8, end: 13, replacement: '"清除"' }];
  const tampered = splice(original, edits) + "\nvar evil=1;";
  const r = verify(original, tampered, { edits });
  assert.equal(r.ok, false);
  assert.equal(r.gates.find((g) => g.name === "byte-identical").ok, false);
});

test("verify: gate 1 catches broken syntax", () => {
  const original = 'var s="Clear";';
  const edits = [{ start: 8, end: 13, replacement: '"清除" +' }];
  const patched = splice(original, edits);
  const r = verify(original, patched, { edits });
  assert.equal(r.ok, false);
  assert.equal(r.gates.find((g) => g.name === "compiles").ok, false);
});
```

- [ ] **Step 6: 实现 verify**

```javascript
// 闸门 4：四项全过才算成功
export function verify(original, patched, manifest) {
  const gates = [];

  // ① 语法门
  let compiles = true, err = null;
  try { new vm.Script(patched, { filename: "patched.js" }); }
  catch (e) { compiles = false; err = e.message; }
  gates.push({ name: "compiles", ok: compiles, detail: err });

  // ② 由原文件 + manifest 重算，应逐字节等于实际文件
  const recomputed = splice(original, manifest.edits);
  const byteIdentical = recomputed === patched;
  gates.push({
    name: "byte-identical", ok: byteIdentical,
    detail: byteIdentical ? null : "patched file contains changes outside the planned edits",
  });

  // ③ 编辑区间必须与 manifest 一致（防止越界替换）
  const inRange = manifest.edits.every((e) => e.start >= 0 && e.end <= original.length && e.start <= e.end);
  gates.push({ name: "edits-in-range", ok: inRange, detail: null });

  // ④ 大小变化符合预期
  const expected = original.length + manifest.edits.reduce((a, e) => a + e.replacement.length - (e.end - e.start), 0);
  const sizeOk = expected === patched.length;
  gates.push({ name: "size-delta", ok: sizeOk, detail: sizeOk ? null : `expected ${expected}, got ${patched.length}` });

  return { ok: gates.every((g) => g.ok), gates };
}
```

> 注：单元测试里验证的是 4 项中的 3 项命名（`compiles` / `byte-identical` / `edits-in-range` / `size-delta`），
> 其中 `byte-identical` 就是「不变式被证明」的那一步。

- [ ] **Step 7: 运行测试**

Run: `node --test test/patch.test.mjs`
Expected: PASS

- [ ] **Step 8: 实现 A 层与 B 层编辑计划**

```javascript
`src/patch.mjs` 顶部已从 `extract.mjs` 静态导入 `candidates`（`extract.mjs` 不导入 `patch.mjs`，无循环依赖），因此直接调用：

```javascript
// 把 decisions（[{en, zh, origin}]）变成字节编辑
// A 层：在 zh_CN 的 JSON.parse 字面量内增补缺失 key
export function planA(code, located, decisions) {
  const zh = readCatalog(code, located, "zh_CN");
  const byEn = new Map(decisions.map((d) => [d.en, d]));
  const edits = [];
  if (!zh) return edits;

  for (const [namespace, { data, span }] of Object.entries(zh)) {
    const added = {};
    let dirty = false;
    for (const miss of missingFromA(code, located)) {
      if (miss.namespace !== namespace) continue;
      const zhText = byEn.get(miss.en);
      if (!zhText) continue;
      const v = validate({ en: miss.en, zh: zhText.zh });
      if (!v.ok) continue;
      added[miss.key] = zhText.zh;
      dirty = true;
    }
    if (!dirty) continue;
    // 保持原有嵌套形态：只在顶层补 key（顶层键名即 miss.key 的第一段）
    for (const [k, v] of Object.entries(added)) {
      if (k.includes("/")) continue;      // 嵌套路径不在 v1 自动补齐范围，人工处理
      data[k] = v;
    }
    const replacement = encode(JSON.stringify(data), "'");
    edits.push({
      start: span.start, end: span.end,
      original: code.slice(span.start, span.end),
      replacement,
      en: "<A-layer additions>", zh: "<A-layer additions>", origin: "curated",
    });
  }
  return edits;
}

// B 层：bundle 内非语言模块的字面量，逐条精确替换
export function planB(code, located, decisions) {
  const byEn = new Map(decisions.map((d) => [d.en, d]));
  const edits = [];
  for (const c of candidates(code, located)) {
    const d = byEn.get(c.text);
    if (!d) continue;
    const v = validate({ en: c.text, zh: d.zh });
    if (!v.ok) continue;
    if (c.hasSubstitution) {
      // 含 ${} 的模板串：占位符是 ${...} 而非 {{...}}，额外要求 ${} 序列一致
      const sub = (s) => (s.match(/\$\{[^}]*\}/g) ?? []).sort().join(" ");
      if (sub(c.text) !== sub(d.zh)) continue;
    }
    edits.push({
      start: c.span.start, end: c.span.end,
      original: code.slice(c.span.start, c.span.end),
      replacement: encode(d.zh, c.quote),
      en: c.text, zh: d.zh, origin: d.origin,
    });
  }
  return edits;
}

// 合并 A、B 两层计划
export function planForDecisions(code, decisions) {
  const located = locateLanguageModule(code);
  if (!located) throw new Error("incompatible bundle: ChineseCNStrings not found");
  return [...planA(code, located, decisions), ...planB(code, located, decisions)];
}
```

**删除**任何形如 `importExtract()` 的延迟引用辅助函数——`candidates` 已在文件顶部静态导入。

- [ ] **Step 9: 追加计划测试**

```javascript
test("planA: adds the missing key into the zh_CN chat namespace", () => {
  const located = locateLanguageModule(MINI);
  const edits = planA(MINI, located, [{ en: "Only in English", zh: "仅英文", origin: "curated" }]);
  assert.equal(edits.length, 1);
  const out = splice(MINI, edits);
  assert.ok(out.includes('"onlyInEn":"仅英文"'));
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

test("planB: rejects a decision whose placeholders do not match", () => {
  const code = MINI + '\nvar label="Moved {{count}} chats";';
  const located = locateLanguageModule(code);
  const edits = planB(code, located, [{ en: "Moved {{count}} chats", zh: "移动对话", origin: "model" }]);
  assert.equal(edits.length, 0);
});
```

- [ ] **Step 10: 运行测试**

Run: `node --test test/patch.test.mjs`
Expected: PASS

- [ ] **Step 11: 实现事务性 apply / restore / provenance**

```javascript
const manifestPath = (stateDir, hash) => join(stateDir, "manifests", `${hash}.json`);
const backupPath = (stateDir, hash) => join(stateDir, "backups", `${hash}.js`);

export function provenance(code, stateDir) {
  const hash = sha256(code).slice(0, 16);
  const mp = manifestPath(stateDir, hash);
  if (!existsSync(mp)) return { state: "unpatched", manifest: null, hash };
  const manifest = JSON.parse(readFileSync(mp, "utf8"));
  if (manifest.patchedSha === hash) return { state: "patched", manifest, hash };
  return { state: "foreign", manifest, hash };
}

// 事务性应用：写临时文件 → 验证 → 原子 rename；失败自动还原
export function apply(target, original, patched, manifest, stateDir) {
  mkdirSync(join(stateDir, "manifests"), { recursive: true });
  mkdirSync(join(stateDir, "backups"), { recursive: true });

  const v = verify(original, patched, manifest);
  if (!v.ok) return { ok: false, gates: v.gates, applied: false };

  const origHash = sha256(original);
  const backup = backupPath(stateDir, origHash);
  if (!existsSync(backup)) writeFileSync(backup, original, "utf8");

  const tmp = target + ".lmszh.tmp";
  try {
    writeFileSync(tmp, patched, "utf8");
    // 重新从磁盘读回验证，确保写入无损
    const roundtrip = readFileSync(tmp, "utf8");
    const v2 = verify(original, roundtrip, manifest);
    if (!v2.ok) { unlinkSync(tmp); return { ok: false, gates: v2.gates, applied: false }; }
    renameSync(tmp, target);
  } catch (e) {
    if (existsSync(tmp)) unlinkSync(tmp);
    copyFileSync(backup, target);          // 回滚
    return { ok: false, gates: v.gates, applied: false, error: String(e) };
  }

  const patchedHash = sha256(patched);
  writeFileSync(manifestPath(stateDir, patchedHash.slice(0, 16)),
    JSON.stringify({ originalSha: origHash, patchedSha: patchedHash, edits: manifest.edits,
                     target, at: new Date().toISOString() }, null, 2), "utf8");
  // 原文件哈希的 manifest 也要记一份，便于回滚后仍能识别
  writeFileSync(manifestPath(stateDir, origHash.slice(0, 16)),
    JSON.stringify({ originalSha: origHash, patchedSha: patchedHash, edits: manifest.edits,
                     target, at: new Date().toISOString() }, null, 2), "utf8");

  return { ok: true, gates: v.gates, applied: true, backup };
}

export function restore(target, stateDir) {
  const dir = join(stateDir, "backups");
  if (!existsSync(dir)) return false;
  // 选出最新的备份
  const files = readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
  if (files.length === 0) return false;
  const src = join(dir, files[files.length - 1]);
  copyFileSync(src, target);
  return true;
}
```

在顶部 import 中补 `readdirSync`。

- [ ] **Step 12: 追加事务测试**

```javascript
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, restore, provenance, sha256 } from "../src/patch.mjs";
import { locateLanguageModule } from "../src/extract.mjs";

test("apply: writes target, records manifest, verify passes", () => {
  const d = mkdtempSync(join(tmpdir(), "patch-"));
  const target = join(d, "mw.js");
  const original = 'var s="Resume Download";';
  writeFileSync(target, original, "utf8");
  const edits = [{ start: 8, end: 23, replacement: '"继续下载"', en: "Resume Download", zh: "继续下载", origin: "model" }];
  const patched = splice(original, edits);
  const r = apply(target, original, patched, { edits }, d);
  assert.equal(r.ok, true);
  assert.equal(readFileSync(target, "utf8"), patched);
  assert.ok(existsSync(r.backup));
});

test("apply: refuses when a gate fails and leaves target untouched", () => {
  const d = mkdtempSync(join(tmpdir(), "patch-"));
  const target = join(d, "mw.js");
  const original = 'var s="Resume Download";';
  writeFileSync(target, original, "utf8");
  const edits = [{ start: 8, end: 23, replacement: '"继续下载" +', en: "x", zh: "y", origin: "model" }];
  const patched = splice(original, edits);
  const r = apply(target, original, patched, { edits }, d);
  assert.equal(r.ok, false);
  assert.equal(readFileSync(target, "utf8"), original);
});

test("restore: puts the original back", () => {
  const d = mkdtempSync(join(tmpdir(), "patch-"));
  const target = join(d, "mw.js");
  const original = 'var s="Resume Download";';
  writeFileSync(target, original, "utf8");
  const edits = [{ start: 8, end: 23, replacement: '"继续下载"', en: "x", zh: "y", origin: "model" }];
  apply(target, original, splice(original, edits), { edits }, d);
  assert.equal(restore(target, d), true);
  assert.equal(readFileSync(target, "utf8"), original);
});

test("provenance: reports unpatched, patched, foreign", () => {
  const d = mkdtempSync(join(tmpdir(), "patch-"));
  const target = join(d, "mw.js");
  const original = 'var s="Resume Download";';
  writeFileSync(target, original, "utf8");
  mkdirSync(join(d, "manifests"), { recursive: true });
  assert.equal(provenance(original, d).state, "unpatched");

  const edits = [{ start: 8, end: 23, replacement: '"继续下载"', en: "x", zh: "y", origin: "model" }];
  const patched = splice(original, edits);
  apply(target, original, patched, { edits }, d);
  assert.equal(provenance(patched, d).state, "patched");
  assert.equal(provenance("something else entirely", d).state, "foreign");
});
```

- [ ] **Step 13: 运行全部测试**

Run: `node --test test/patch.test.mjs`
Expected: PASS

- [ ] **Step 14: Commit**

```bash
git add src/patch.mjs test/patch.test.mjs
git commit -m "feat(patch): byte-splice planner with four verification gates"
```

---

## Task 5: 跨平台安装发现（`discover.mjs`）

**Files:**
- Create: `src/discover.mjs`
- Create: `test/discover.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `candidatesFor(platform, env, fs): string[]` — 候选安装根目录
  - `find(opts?): { target, version, root, platform } | null`
  - `RELATIVE_TARGET` — 常量

---

- [ ] **Step 1: 写失败测试**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { candidatesFor, RELATIVE_TARGET, find } from "../src/discover.mjs";

test("RELATIVE_TARGET points at the renderer bundle", () => {
  assert.equal(
    RELATIVE_TARGET.replace(/\\/g, "/"),
    "resources/app/.webpack/renderer/main_window.js");
});

test("candidatesFor: windows uses LOCALAPPDATA and PROGRAMFILES", () => {
  const c = candidatesFor("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", PROGRAMFILES: "C:\\Program Files" });
  assert.ok(c.some((p) => p.includes("AppData")));
  assert.ok(c.some((p) => p.includes("Program Files")));
});

test("candidatesFor: linux covers deb, snap and flatpak roots", () => {
  const c = candidatesFor("linux", { HOME: "/home/u" });
  assert.ok(c.includes("/opt/LM Studio"));
  assert.ok(c.includes("/snap/lm-studio/current"));
  assert.ok(c.some((p) => p.startsWith("/var/lib/flatpak/app/")));
});

test("find: returns null when the file does not exist", () => {
  assert.equal(find({ roots: ["/definitely/not/here"] }), null);
});

test("find: locates a synthetic install tree", () => {
  const root = mkdtempSync(join(tmpdir(), "lms-"));
  const target = join(root, ...RELATIVE_TARGET.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "stub", "utf8");
  writeFileSync(join(root, "resources", "app", "package.json"),
    JSON.stringify({ version: "0.4.99+1" }), "utf8");
  const found = find({ roots: [root] });
  assert.ok(found);
  assert.equal(found.target, target);
  assert.equal(found.version, "0.4.99+1");
});
```

顶部补 import：

```javascript
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/discover.test.mjs`
Expected: FAIL — `Cannot find module '../src/discover.mjs'`

- [ ] **Step 3: 实现**

`src/discover.mjs`：

```javascript
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

export const RELATIVE_TARGET = "resources/app/.webpack/renderer/main_window.js";

export function candidatesFor(plat, env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (plat === "win32") {
    return [
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs", "LM Studio") : null,
      env.PROGRAMFILES ? join(env.PROGRAMFILES, "LM Studio") : null,
      "C:\\Program Files\\LM Studio",
      "C:\\Program Files (x86)\\LM Studio",
    ].filter(Boolean);
  }
  if (plat === "darwin") return ["/Applications/LM Studio.app/Contents/Resources"];
  // linux / bsd
  return [
    "/opt/LM Studio",
    "/opt/lm-studio",
    "/usr/lib/lm-studio",
    "/usr/share/lm-studio",
    "/snap/lm-studio/current",
    join(home, ".local/share/lm-studio"),
    join(home, "AppImage/lm-studio"),
    ...flatpakRoots(),
  ].filter(Boolean);
}

// Flatpak 的安装 id 未知时，扫描 /var/lib/flatpak/app 下含 lmstudio 的条目
function flatpakRoots() {
  const base = "/var/lib/flatpak/app";
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base)
      .filter((n) => /lmstudio/i.test(n))
      .map((n) => join(base, n));
  } catch { return []; }
}
```

`src/discover.mjs` 顶部的 fs import 写全：

```javascript
import { existsSync, readFileSync, readdirSync } from "node:fs";
```

```javascript
export function find({ roots, path } = {}) {
  const list = roots ?? candidatesFor(platform());
  for (const root of list) {
    const base = path ? root : root;
    // AppImage 解包后 resources 在 <root>/resources 或 <root>/lib/resources
    const candidates = [
      join(base, ...RELATIVE_TARGET.split("/")),
      join(base, "lib", ...RELATIVE_TARGET.split("/")),
      join(base, "resources", "app", ".webpack", "renderer", "main_window.js"),
    ];
    for (const target of candidates) {
      if (!existsSync(target)) continue;
      const pkg = join(base, "resources", "app", "package.json");
      let version = null;
      if (existsSync(pkg)) {
        try { version = JSON.parse(readFileSync(pkg, "utf8")).version ?? null; } catch {}
      }
      return { target, version, root: base, platform: platform() };
    }
  }
  return null;
}
```

- [ ] **Step 4: 运行测试**

Run: `node --test test/discover.test.mjs`
Expected: PASS

- [ ] **Step 5: 对本机做一次真实探测**

Run: `node -e "import('./src/discover.mjs').then(m=>console.log(m.find()))"`
Expected: 输出含 `C:\Program Files\LM Studio\...\main_window.js` 与 `0.4.21+2`

- [ ] **Step 6: Commit**

```bash
git add src/discover.mjs test/discover.test.mjs
git commit -m "feat(discover): cross-platform install location detection"
```

---

## Task 6: 本地模型翻译（`translate.mjs`）

**Files:**
- Create: `src/translate.mjs`
- Create: `test/translate.test.mjs`

**Interfaces:**
- Consumes: `upsert` from `lexicon.mjs`；`saveLocal` from `lexicon.mjs`
- Produces:
  - `buildBatches(items, maxChars): string[][]`
  - `buildPrompt(items, fewShot): string`
  - `parseReply(raw, items): { filled: Decision[], rejected: Rejection[] }`
  - `fill(items, opts): Promise<{ filled, rejected }>`
  - `listModels(baseUrl): Promise<string[]>`

  其中 `Decision = { en, zh, origin: "model" }`，`Rejection = { en, reason }`

---

- [ ] **Step 1: 写失败测试（不需要真实服务器）**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBatches, buildPrompt, parseReply } from "../src/translate.mjs";

test("buildBatches: respects maxChars", () => {
  const items = ["aaaa", "bbbb", "cccc", "dddd"];
  const b = buildBatches(items, 10);
  assert.ok(b.every((g) => g.length <= 2));
  assert.equal(b.flat().length, 4);
});

test("parseReply: accepts a JSON array of {en, zh}", () => {
  const items = [{ en: "Clear", text: "Clear" }];
  const raw = '[{"en":"Clear","zh":"清除"}]';
  const r = parseReply(raw, items);
  assert.equal(r.filled.length, 1);
  assert.equal(r.filled[0].zh, "清除");
});

test("parseReply: rejects entries whose placeholders do not match", () => {
  const items = [{ en: "Move {{count}} chats", text: "Move {{count}} chats" }];
  const raw = '[{"en":"Move {{count}} chats","zh":"移动对话"}]';
  const r = parseReply(raw, items);
  assert.equal(r.filled.length, 0);
  assert.equal(r.rejected[0].reason, "placeholder-mismatch");
});

test("parseReply: rejects unknown source strings", () => {
  const r = parseReply('[{"en":"Not In List","zh":"不在列表"}]', [{ en: "Clear", text: "Clear" }]);
  assert.equal(r.filled.length, 0);
  assert.equal(r.rejected[0].reason, "unknown-source");
});

test("parseReply: survives malformed output without throwing", () => {
  const r = parseReply("sorry I cannot do that", [{ en: "Clear", text: "Clear" }]);
  assert.equal(r.filled.length, 0);
});

test("buildPrompt: includes the items and the few-shot examples", () => {
  const p = buildPrompt([{ en: "Clear", text: "Clear" }], [{ en: "Chat", zh: "聊天" }]);
  assert.ok(p.includes("Clear"));
  assert.ok(p.includes("聊天"));
  assert.ok(p.includes("{{"));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/translate.test.mjs`
Expected: FAIL — `Cannot find module '../src/translate.mjs'`

- [ ] **Step 3: 实现**

`src/translate.mjs`：

```javascript
import { validate } from "./patch.mjs";

export const DEFAULT_BASE = "http://127.0.0.1:1234/v1";

export function buildBatches(items, maxChars = 3000) {
  const out = [];
  let cur = [], size = 0;
  for (const it of items) {
    const w = it.text.length + 24;
    if (cur.length && size + w > maxChars) { out.push(cur); cur = []; size = 0; }
    cur.push(it); size += w;
  }
  if (cur.length) out.push(cur);
  return out;
}

const SYSTEM = [
  "你是 LM Studio 的专业中文本地化译者。",
  "规则：",
  "1. 只输出 JSON 数组，不要任何解释或 markdown 代码块。",
  "2. 每个元素形如 {\"en\": <原英文>, \"zh\": <中文译文>}。",
  "3. 必须原样保留所有 {{变量}} 占位符，数量与名称都不变。",
  "4. 保留 <custom-link>...</custom-link>、**粗体** 等标记结构。",
  "5. 术语沿用示例中的既有译法，保持全应用一致。",
  "6. 保留专有名词原文：LM Studio、OpenAI、Anthropic、Hugging Face、MCP、token、GPU、CPU、VRAM、API。",
].join("\n");

export function buildPrompt(items, fewShot = []) {
  const ex = fewShot.map((x) => `{"en":${JSON.stringify(x.en)},"zh":${JSON.stringify(x.zh)}}`).join(",\n  ");
  const list = items.map((x) => JSON.stringify(x.text)).join(",\n  ");
  return [
    "参考示例（术语必须保持一致）：",
    "[",
    "  " + ex,
    "]",
    "",
    "请翻译以下英文界面字符串：",
    "[",
    "  " + list,
    "]",
  ].join("\n");
}

const ph = (s) => (String(s).match(/\{\{[^}]*\}\}/g) ?? []).sort().join(" ");

export function parseReply(raw, items) {
  const filled = [], rejected = [];
  const known = new Map(items.map((i) => [i.text, i]));
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return { filled, rejected: items.map((i) => ({ en: i.text, reason: "unparsable" })) };
  let arr;
  try { arr = JSON.parse(raw.slice(start, end + 1)); }
  catch { return { filled, rejected: items.map((i) => ({ en: i.text, reason: "unparsable" })) }; }
  if (!Array.isArray(arr)) return { filled, rejected: items.map((i) => ({ en: i.text, reason: "unparsable" })) };

  for (const entry of arr) {
    const en = entry?.en, zh = entry?.zh;
    if (typeof en !== "string" || typeof zh !== "string") continue;
    if (!known.has(en)) { rejected.push({ en, reason: "unknown-source" }); continue; }
    const v = validate({ en, zh });
    if (!v.ok) { rejected.push({ en, reason: v.reason }); continue; }
    filled.push({ en, zh, origin: "model" });
  }
  for (const i of items) {
    if (!filled.some((f) => f.en === i.text) && !rejected.some((r) => r.en === i.text))
      rejected.push({ en: i.text, reason: "not-returned" });
  }
  return { filled, rejected };
}

async function chat(baseUrl, model, prompt, { signal } = {}) {
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model, temperature: 0.2,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
    }),
    signal,
  });
  if (!r.ok) throw new Error(`LM Studio API ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? "";
}

export async function listModels(baseUrl = DEFAULT_BASE) {
  const r = await fetch(`${baseUrl}/models`);
  if (!r.ok) throw new Error(`LM Studio API ${r.status}`);
  const j = await r.json();
  return (j.data ?? []).map((m) => m.id).filter(Boolean);
}

// 逐批调用；每批结果由调用方立刻落盘（可中断续跑）
export async function fill(items, { baseUrl = DEFAULT_BASE, model, fewShot = [], onBatch } = {}) {
  const filled = [], rejected = [];
  for (const batch of buildBatches(items)) {
    const raw = await chat(baseUrl, model, buildPrompt(batch, fewShot));
    const r = parseReply(raw, batch);
    filled.push(...r.filled);
    rejected.push(...r.rejected);
    onBatch?.({ filled: r.filled, rejected: r.rejected, remaining: items.length - filled.length - rejected.length });
  }
  return { filled, rejected };
}
```

- [ ] **Step 4: 运行测试**

Run: `node --test test/translate.test.mjs`
Expected: PASS

- [ ] **Step 5: 对本机 LM Studio 做连通性检查**

先确认服务在跑：

Run: `netstat -ano | Select-String ":1234"`
若无输出，先启动 LM Studio 并在设置中启用本地服务，然后：

Run: `node -e "import('./src/translate.mjs').then(async m=>console.log(await m.listModels()))"`
Expected: 打印出已安装模型 id 列表

若失败，**不要继续**——Task 7 的 `translate` 命令依赖它。记录下来，先完成其他 task。

- [ ] **Step 6: Commit**

```bash
git add src/translate.mjs test/translate.test.mjs
git commit -m "feat(translate): local LM Studio API batch translation with validation"
```

---

## Task 7: CLI 编排与启动器

**Files:**
- Create: `bin/lmstudio-zh.mjs`
- Create: `src/cli.mjs`
- Create: `test/cli.test.mjs`
- Create: `launch/lmstudio-zh.cmd`
- Create: `launch/lmstudio-zh.sh`

**Interfaces:**
- Consumes: 全部前述模块
- Produces:
  - `main(argv, io): Promise<number>` — 返回退出码；`io = { log, err, confirm, stateDir, toolDir, argv }`
  - `decideUntranslated(code, located, lex, lexLocal): Decision[]`

---

- [ ] **Step 1: 写失败测试**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { main, decideUntranslated } from "../src/cli.mjs";
import { load, upsert } from "../src/lexicon.mjs";

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), "cli-"));
  const target = join(root, "mw.js");
  writeFileSync(target, 'var label="Resume Download";var t="Clear";', "utf8");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "tool", "lexicon"), { recursive: true });
  return { root, target, stateDir: join(root, "state"), toolDir: join(root, "tool") };
}

test("doctor: reports a missing install instead of crashing", async () => {
  const io = { log(){}, err(){}, confirm: async () => false,
               stateDir: "x", toolDir: "y",
               argv: ["--path", "C:\\nope"] };
  const code = await main(["doctor"], io);
  assert.equal(code, 1);
});

test("scan: exits 0 and reports candidates", async () => {
  const s = scaffold();
  const lines = [];
  const io = { log: (m) => lines.push(String(m)), err(){}, confirm: async () => false,
               stateDir: s.stateDir, toolDir: s.toolDir, argv: ["--path", s.root] };
  const code = await main(["scan"], io);
  assert.equal(code, 0);
  assert.ok(lines.join("\n").includes("Resume Download"));
});

test("apply: with an empty dictionary is a no-op that still succeeds", async () => {
  const s = scaffold();
  const io = { log(){}, err(){}, confirm: async () => true,
               stateDir: s.stateDir, toolDir: s.toolDir, argv: ["--path", s.root] };
  const code = await main(["apply", "--yes"], io);
  assert.equal(code, 0);
  assert.equal(readFileSync(s.target, "utf8"), 'var label="Resume Download";var t="Clear";');
});

test("apply: translates after the dictionary gains an entry", async () => {
  const s = scaffold();
  const lex = load(s.stateDir, s.toolDir);
  upsert(lex, "Resume Download", "继续下载", "curated");
  upsert(lex, "Clear", "清除", "curated");
  writeFileSync(join(s.toolDir, "lexicon", "zh-CN.json"),
    JSON.stringify({ version: 1, entries: Object.fromEntries(lex.entries) }), "utf8");

  const io = { log(){}, err(){}, confirm: async () => true,
               stateDir: s.stateDir, toolDir: s.toolDir, argv: ["--path", s.root] };
  const code = await main(["apply", "--yes"], io);
  assert.equal(code, 0);
  const after = readFileSync(s.target, "utf8");
  assert.ok(after.includes("继续下载"));
  assert.ok(after.includes("清除"));
});

test("restore: returns the file to its original bytes", async () => {
  const s = scaffold();
  writeFileSync(join(s.toolDir, "lexicon", "zh-CN.json"), JSON.stringify({ version: 1, entries: {
    "Resume Download": { zh: "继续下载", origin: "curated" },
    "Clear": { zh: "清除", origin: "curated" } } }), "utf8");
  const io = { log(){}, err(){}, confirm: async () => true,
               stateDir: s.stateDir, toolDir: s.toolDir, argv: ["--path", s.root] };
  await main(["apply", "--yes"], io);
  const before = readFileSync(s.target, "utf8");
  assert.notEqual(before, 'var label="Resume Download";var t="Clear";');
  await main(["restore", "--yes"], io);
  assert.equal(readFileSync(s.target, "utf8"), 'var label="Resume Download";var t="Clear";');
});

test("decideUntranslated: reuses local-model translations across runs", () => {
  const lex = { version: 1, entries: new Map([["Clear", { zh: "清除", origin: "model" }]]) };
  const code = 'var label="Resume Download";var t="Clear";';
  const first = decideUntranslated(code, null, { entries: new Map() }, lex);
  assert.deepEqual(first.map((d) => d.en).sort(), ["Clear", "Resume Download"]);
  const second = decideUntranslated(code, null, lex, { entries: new Map() });
  assert.deepEqual(second.map((d) => d.en), ["Resume Download"]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/cli.test.mjs`
Expected: FAIL — `Cannot find module '../src/cli.mjs'`

- [ ] **Step 3: 实现 cli.mjs**

`src/cli.mjs`：

```javascript
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { find, RELATIVE_TARGET } from "./discover.mjs";
import { load, loadLocal, lookup, upsert, saveLocal, stats } from "./lexicon.mjs";
import { locateLanguageModule, missingFromA, candidates } from "./extract.mjs";
import { planForDecisions, splice, apply, restore, provenance, verify, sha256 } from "./patch.mjs";
import { fill as translateFill, listModels } from "./translate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TOOL_DIR = resolve(HERE, "..");
export const defaultStateDir = () => join(homedir(), ".lmstudio-zh");

// 词典已覆盖 → 直接采用；未覆盖 → 留给本地模型
// located 为 null 表示「无 i18n 结构」，此时只扫 B 层硬编码字面量
export function decideUntranslated(code, located, lex, lexLocal) {
  const out = [];
  const seen = new Set();
  const consider = (text) => {
    if (!text || seen.has(text)) return;
    if (lookup(lex, text)) return;               // 人工词典命中
    const local = lexLocal.entries.get(text);
    if (local) { out.push({ en: text, zh: local.zh, origin: local.origin }); seen.add(text); return; }
    out.push({ en: text, zh: undefined, origin: "model" });
    seen.add(text);
  };
  if (located) for (const m of missingFromA(code, located)) consider(m.en);
  for (const c of candidates(code, located ?? EMPTY_LOCATED)) consider(c.text);
  return out;
}

// located 为 null 时的替身：没有任何语言模块区间，等于「不排除任何区间」
const EMPTY_LOCATED = { namespacesByLang: new Map() };

function ensureState(stateDir) {
  for (const d of ["", "manifests", "backups", "logs"]) mkdirSync(join(stateDir, d), { recursive: true });
}

async function locateTarget(io) {
  const pathArg = (io.argv.find((a) => a === "--path") ?? "").trim();
  return find(pathArg ? { roots: [pathArg] } : {});
}

// LM Studio 运行时禁止改文件：会造成内存与磁盘不一致
function assertAppClosed(io) {
  const { execFileSync } = process.binding ? {} : {};
  // 用平台无关的方式粗略检查
  try {
    const ps = process.platform === "win32" ? "tasklist" : "pgrep";
    const args = process.platform === "win32"
      ? ["/FI", "IMAGENAME eq LM Studio.exe", "/NH"]
      : ["-f", "LM Studio"];
    const out = require("node:child_process").execFileSync(ps, args, { encoding: "utf8" });
    if (out.includes("LM Studio") || out.trim().length > 0) return false;
  } catch {}
  return true;
}

export async function main(args, io) {
  const cmd = args[0];
  const stateDir = io.stateDir ?? defaultStateDir();
  ensureState(stateDir);
  const toolDir = io.toolDir ?? TOOL_DIR;
  const lex = load(stateDir, toolDir, io.err);
  const lexLocal = loadLocal(stateDir, io.err);

  switch (cmd) {
    case "doctor": {
      const found = await locateTarget(io);
      if (!found) { io.err(`未找到 LM Studio 安装。搜索路径：${RELATIVE_TARGET}`);
                    io.err("可用 --path <LM Studio 安装根目录> 手动指定。"); return 1; }
      io.log(`platform : ${found.platform}`);
      io.log(`root     : ${found.root}`);
      io.log(`version  : ${found.version}`);
      io.log(`target   : ${found.target}`);
      const code = readFileSync(found.target, "utf8");
      const p = provenance(code, stateDir);
      io.log(`state    : ${p.state}`);
      io.log(`lexicon  : ${JSON.stringify(stats(lex))}`);
      return 0;
    }

    case "scan": {
      const found = await locateTarget(io);
      if (!found) { io.err("未找到 LM Studio 安装"); return 1; }
      const code = readFileSync(found.target, "utf8");
      const located = locateLanguageModule(code);
      if (!located) { io.err("不兼容：未找到 ChineseCNStrings，该版本结构已变化"); return 1; }
      const missing = missingFromA(code, located);
      const cands = candidates(code, located);
      io.log(`A 层缺口（官方词条表缺 zh）: ${missing.length}`);
      for (const m of missing) io.log(`  [A] ${m.namespace} :: ${m.en}`);
      io.log(`B 层候选（硬编码英文）: ${cands.length}`);
      const todo = decideUntranslated(code, located, lex, lexLocal).filter((d) => !d.zh);
      io.log(`待翻译（词典未覆盖）: ${todo.length}`);
      for (const d of todo) io.log(`  ? ${d.en}`);
      return 0;
    }

    case "translate": {
      const found = await locateTarget(io);
      if (!found) { io.err("未找到 LM Studio 安装"); return 1; }
      const code = readFileSync(found.target, "utf8");
      const located = locateLanguageModule(code);
      const todo = decideUntranslated(code, located, lex, lexLocal).filter((d) => !d.zh);
      if (todo.length === 0) { io.log("没有待翻译条目"); return 0; }
      const model = (io.argv.find((a) => a.startsWith("--model=")) ?? "").split("=")[1];
      if (!model) { io.err("请用 --model=<模型 id> 指定模型。可用模型：");
                    io.err((await listModels()).join(", ")); return 1; }
      const fewShot = [];
      for (const ns of Object.keys(zhCatalog(code, located) ?? {}))
        for (const [en, zh] of sampleExisting(code, located, ns, 6)) fewShot.push({ en, zh });
      io.log(`共 ${todo.length} 条待翻译，分批调用本地模型…`);
      const res = await translateFill(todo, {
        model, fewShot,
        onBatch: ({ remaining }) => io.log(`  剩余 ${remaining} 条…`),
      });
      for (const f of res.filled) upsert(lexLocal, f.en, f.zh, "model");
      saveLocal(lexLocal, stateDir);
      writeFileSync(join(stateDir, "pending.json"),
        JSON.stringify({ at: new Date().toISOString(), rejected: res.rejected }, null, 2), "utf8");
      io.log(`成功 ${res.filled.length} 条，拒绝 ${res.rejected.length} 条`);
      io.log(`已写入 ${join(stateDir, "pending.json")}（拒绝原因）`);
      return 0;
    }

    case "apply": {
      const found = await locateTarget(io);
      if (!found) { io.err("未找到 LM Studio 安装"); return 1; }
      if (!assertAppClosed(io)) { io.err("LM Studio 正在运行，请先完全退出再打补丁"); return 1; }
      const code = readFileSync(found.target, "utf8");
      const p = provenance(code, stateDir);
      if (p.state === "patched") { io.log("已是最新补丁，无需重复应用"); return 0; }
      if (p.state === "foreign") {
        if (!io.argv.includes("--force")) {
          io.err("当前文件既非原版也非本工具打过补丁（可能是更新或手动改动）。");
          io.err("加 --force 可基于现有内容重新推导。"); return 1;
        }
      }
      const located = locateLanguageModule(code);
      if (!located) { io.err("不兼容：未找到 ChineseCNStrings"); return 1; }
      const decisions = decideUntranslated(code, located, lex, lexLocal).filter((d) => d.zh);
      const edits = planForDecisions(code, decisions);
      if (edits.length === 0) { io.log("没有可应用的改动"); return 0; }
      io.log(`将应用 ${edits.length} 处改动：`);
      for (const e of edits.slice(0, 40))
        io.log(`  ${e.en}  ->  ${e.zh}`);
      if (edits.length > 40) io.log(`  … 另有 ${edits.length - 40} 处`);
      if (!io.argv.includes("--yes")) {
        const ok = await io.confirm(`确认应用这 ${edits.length} 处改动？`);
        if (!ok) { io.log("已取消"); return 0; }
      }
      const patched = splice(code, edits);
      const r = apply(found.target, code, patched, { edits }, stateDir);
      if (!r.ok) {
        io.err("补丁失败，已自动回滚。失败闸门：");
        for (const g of r.gates.filter((x) => !x.ok)) io.err(`  ${g.name}: ${g.detail ?? ""}`);
        return 1;
      }
      io.log(`已应用 ${edits.length} 处改动，四道闸门全部通过。`);
      io.log(`备份：${r.backup}`);
      return 0;
    }

    case "verify": {
      const found = await locateTarget(io);
      if (!found) { io.err("未找到 LM Studio 安装"); return 1; }
      const code = readFileSync(found.target, "utf8");
      const p = provenance(code, stateDir);
      if (!p.manifest) { io.err("没有 manifest，无法验证"); return 1; }
      const origHash = p.manifest.originalSha;
      const backup = join(stateDir, "backups", `${origHash}.js`);
      if (!existsSync(backup)) { io.err(`找不到原始备份 ${backup}`); return 1; }
      const original = readFileSync(backup, "utf8");
      const r = verify(original, code, p.manifest);
      for (const g of r.gates) io.log(`  ${g.ok ? "PASS" : "FAIL"}  ${g.name}${g.detail ? " — " + g.detail : ""}`);
      return r.ok ? 0 : 1;
    }

    case "restore": {
      const found = await locateTarget(io);
      if (!found) { io.err("未找到 LM Studio 安装"); return 1; }
      if (!io.argv.includes("--yes")) {
        const ok = await io.confirm("确认还原为原版？");
        if (!ok) { io.log("已取消"); return 0; }
      }
      const ok = restore(found.target, stateDir);
      io.log(ok ? "已还原" : "没有可用的备份");
      return ok ? 0 : 1;
    }

    case "all": {
      for (const c of ["doctor", "scan", "translate", "apply"]) {
        io.log(`\n=== ${c} ===`);
        const rc = await main([c, ...args.slice(1)], io);
        if (rc !== 0) return rc;
      }
      return 0;
    }

    default:
      io.err(`未知命令：${cmd}`);
      io.err("可用命令：doctor | scan | translate | apply | verify | restore | all");
      return 2;
  }
}
```

`src/cli.mjs` 需要 `extract.mjs` 额外导出 `zhCatalog`（供 few-shot 采样用）：

```javascript
export const zhCatalog = (code, located) => readCatalog(code, located, "zh_CN");
```

`cli.mjs` 顶部 import 相应补上：
`import { locateLanguageModule, zhCatalog, missingFromA, candidates } from "./extract.mjs";`

然后在 `cli.mjs` 中加入两个小工具函数：

```javascript
// 从官方已有中文里采样 few-shot，保证模型产出的术语与既有风格一致
function sampleExisting(code, located, ns, limit) {
  const data = zhCatalog(code, located)?.[ns]?.data;
  if (!data) return [];
  const out = [];
  for (const [en, zh] of flattenPairs(data)) {
    if (typeof zh === "string" && /[\u3400-\u9fff]/.test(zh)) { out.push([en, zh]); if (out.length >= limit) break; }
  }
  return out;
}
function flattenPairs(o, p = []) {
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...flattenPairs(v, [...p, k]));
    else out.push([[...p, k].join("/"), v]);
  }
  return out;
}
```

并在 `translate` 分支里把 fewShot 的构造替换为：

```javascript
      const fewShot = [];
      for (const ns of Object.keys(zhCatalog(code, located) ?? {}))
        for (const [en, zh] of sampleExisting(code, located, ns, 6)) fewShot.push({ en, zh });

- [ ] **Step 4: 运行测试**

Run: `node --test test/cli.test.mjs`
Expected: PASS

- [ ] **Step 5: 实现入口 bin/lmstudio-zh.mjs**

```javascript
#!/usr/bin/env node
import { main } from "../src/cli.mjs";
import { defaultStateDir } from "../src/cli.mjs";
import { existsSync } from "node:fs";

if (!existsSync(defaultStateDir())) {
  // ensureState 在 main 里会创建
}

const io = {
  log: (m) => console.log(m),
  err: (m) => console.error(m),
  confirm: async (question) => {
    if (!process.stdin.isTTY) { console.error("非交互环境，请加 --yes"); return false; }
    process.stdout.write(`${question} [y/N] `);
    const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question("")).trim().toLowerCase();
    rl.close();
    return a === "y" || a === "yes";
  },
  argv: process.argv.slice(2),
};

process.exit(await main(process.argv.slice(2), io));
```

- [ ] **Step 6: 写启动器**

`launch/lmstudio-zh.cmd`：

```bat
@echo off
setlocal
set "SCRIPT_DIR=%~dp0.."
where node >nul 2>nul
if %ERRORLEVEL%==0 (
  node "%SCRIPT_DIR%\bin\lmstudio-zh.mjs" %*
  exit /b %ERRORLEVEL%
)
set "FALLBACK=%USERPROFILE%\.lmstudio\.internal\utils\node.exe"
if exist "%FALLBACK%" (
  "%FALLBACK%" "%SCRIPT_DIR%\bin\lmstudio-zh.mjs" %*
  exit /b %ERRORLEVEL%
)
echo [lmstudio-zh] 未找到 Node.js。请安装 Node.js 18+ 或确认 LM Studio 已安装。
exit /b 1
```

`launch/lmstudio-zh.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v node >/dev/null 2>&1; then
  exec node "$HERE/bin/lmstudio-zh.mjs" "$@"
fi

# 回退到 LM Studio 自带的 Node（AppImage 解包目录）
for candidate in \
  "$HERE/lmstudio/resources/app/.webpack/bin/node" \
  "$HOME/.local/share/lm-studio/resources/app/.webpack/bin/node" \
  "/opt/LM Studio/resources/app/.webpack/bin/node"; do
  if [ -x "$candidate" ]; then
    exec "$candidate" "$HERE/bin/lmstudio-zh.mjs" "$@"
  fi
done

echo "[lmstudio-zh] 未找到 Node.js。请安装 Node.js 18+ 或确认 LM Studio 已安装。" >&2
exit 1
```

- [ ] **Step 7: 运行全量测试**

Run: `node --test test/`
Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add bin/lmstudio-zh.mjs src/cli.mjs test/cli.test.mjs launch/
git commit -m "feat(cli): command orchestration and cross-platform launchers"
```

---

## Task 8: 端到端验收（对真实安装）

前面 7 个 task 全部用仿真数据。这一步对**真实安装**跑通，是最终的「可交付」判定。

**Files:**
- Create: `test/e2e.test.mjs`

**Interfaces:**
- Consumes: `cli.mjs` 全部
- Produces: 无新接口，仅验收

---

- [ ] **Step 1: 写端到端测试（默认跳过，需 `LMS_E2E=1` 才跑）**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { main } from "../src/cli.mjs";
import { load } from "../src/lexicon.mjs";
import { locateLanguageModule, zhCatalog, missingFromA } from "../src/extract.mjs";

const REAL = String.raw`C:\Program Files\LM Studio\resources\app\.webpack\renderer\main_window.js`;
const TOOL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const enabled = process.env.LMS_E2E === "1";
const opts = { skip: enabled ? false : "需要 LMS_E2E=1 且本机已安装 LM Studio" };

function sandboxReal() {
  const d = mkdtempSync(join(tmpdir(), "e2e-"));
  const copy = join(d, "main_window.js");
  copyFileSync(REAL, copy);
  return { d, copy };
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
  const stateDir = join(d, "state");
  const original = readFileSync(copy, "utf8");
  const io = { log(){}, err(){}, confirm: async () => true, stateDir, toolDir: TOOL_DIR, argv: ["--path", copy] };
  const rc = await main(["apply", "--yes", "--force"], io);
  assert.equal(rc, 0);
  const patched = readFileSync(copy, "utf8");
  assert.notEqual(patched, original, "文件应被修改");
  new vm.Script(patched, { filename: "e2e.js" });          // 闸门 1
});

test("real bundle: restore returns byte-identical original", opts, async () => {
  const { d, copy } = sandboxReal();
  const stateDir = join(d, "state");
  const original = readFileSync(copy, "utf8");
  const io = { log(){}, err(){}, confirm: async () => true, stateDir, toolDir: TOOL_DIR, argv: ["--path", copy] };
  await main(["apply", "--yes", "--force"], io);
  await main(["restore", "--yes"], io);
  assert.equal(readFileSync(copy, "utf8"), original);
});
```

> 这些测试全部在**临时目录的副本**上运行，绝不触碰真实安装文件。

- [ ] **Step 2: 运行单元测试（不含 e2e）**

Run: `node --test test/lex.test.mjs test/lexicon.test.mjs test/extract.test.mjs test/patch.test.mjs test/discover.test.mjs test/translate.test.mjs test/cli.test.mjs`
Expected: 全部 PASS，e2e 文件被 skip

- [ ] **Step 3: 对真实安装跑 e2e（在副本上，不动真实文件）**

Run: `$env:LMS_E2E="1"; node --test test/e2e.test.mjs`
Expected: 全部 PASS

若「A-layer gaps are all covered」失败，把失败条目补进 `lexicon/zh-CN.json` 后重跑，直到 `uncovered.length === 0`。

- [ ] **Step 4: 真实安装上做一次人工验收**

**先完全退出 LM Studio**（托盘图标也要退出），然后：

Run: `.\launch\lmstudio-zh.cmd doctor`
Expected: 显示 version `0.4.21+2`、state、lexicon 统计

Run: `.\launch\lmstudio-zh.cmd scan`
Expected: A 层缺口数、B 层候选数、待翻译数

Run: `.\launch\lmstudio-zh.cmd apply`
Expected: 打印改动预览 → 确认 → 应用 → 报告四道闸门通过

**启动 LM Studio**，逐页检查：侧边栏、聊天、发现、我的模型、下载、设置、开发者。
重点确认之前是英文的地方现在是中文，且没有出现乱码、方括号、`{{}}` 残留。

若发现问题：用 `.\launch\lmstudio-zh.cmd restore --yes` 还原，把问题记录下来，修正词典或规则后重跑。

- [ ] **Step 5: 验证幂等——再次运行 apply 应无操作**

Run: `.\launch\lmstudio-zh.cmd apply`
Expected: `已是最新补丁，无需重复应用`

- [ ] **Step 6: Commit**

```bash
git add test/e2e.test.mjs
git commit -m "test: end-to-end acceptance against the real installation"
```

---

## Task 9: 打包为可分发工具

**Files:**
- Create: `README.md`

---

- [ ] **Step 1: 写 README**

```markdown
# lmstudio-zh

LM Studio 简体中文补丁工具。补齐官方词条表缺口，并汉化界面中硬编码的英文串。

## 特性

- **版本无关**：词典以英文原文为 key。LM Studio 升级后跑一次，旧译文全部自动复用。
- **可证明安全**：四道闸门保证「除被精确命中的字面量字节外，文件其余部分逐字节不变」。
- **可还原**：备份自动保存，`restore` 一键回到原版。
- **零依赖**：只需 Node.js 18+，无需 npm install。

## 用法

```bash
lmstudio-zh doctor      # 检测安装、版本、补丁状态
lmstudio-zh scan        # 列出未翻译条目
lmstudio-zh translate --model=<模型id>   # 用本机模型补齐
lmstudio-zh apply       # 打补丁（先预览再确认）
lmstudio-zh verify      # 重跑四道闸门
lmstudio-zh restore     # 还原
lmstudio-zh all         # 一条龙
```

### Windows

```bat
launch\lmstudio-zh.cmd doctor
```

### Linux (Ubuntu)

```bash
chmod +x launch/lmstudio-zh.sh
./launch/lmstudio-zh.sh doctor
```

启动器会依次尝试：系统 `node` → LM Studio 自带的 Node。

### 常用参数

| 参数 | 说明 |
|---|---|
| `--path <目录>` | 手动指定 LM Studio 安装根目录 |
| `--yes` | 跳过确认（用于非交互环境） |
| `--force` | 对「既非原版也非本工具补丁」的文件强制重新推导 |
| `--model=<id>` | `translate` 指定本机模型 |

## 工作原理

LM Studio 的界面文本分两层：

1. **A 层** — 官方 i18n 词条表。打包为 webpack 模块 `t.exports=JSON.parse('...')`，
   由 `ChineseCNStrings` 聚合。0.4.21+2 中共 1437 个英文 key，其中 88 个缺少中文。
2. **B 层** — 直接硬编码在 bundle 里的英文字面量，没有 key 可查，约 2214 条。

本工具按**结构**定位（搜索 `e.ChineseCNStrings=` 赋值），不硬编码任何 module id，
因此在版本更新后依然可用。

## 目录

- 代码与人工词典：`~/lmstudio-zh/`（可 git 版本化）
- 运行时状态、备份、待审队列：`~/.lmstudio-zh/`

## 限制

- Chromium 原生字符串（文件对话框、右键菜单）由 `locales/*.pak` 控制，跟随操作系统语言，本工具不修改。
- LM Studio 自动更新后需要重新运行一次 `lmstudio-zh apply`。
- 脚本必须先完全退出 LM Studio 才能打补丁。

## 免责声明

本工具与 LM Studio 官方无关。修改应用文件可能导致更新失败或功能异常，
请务必使用 `restore` 保留回退能力。
```

- [ ] **Step 2: 验证 README 中的命令与实现一致**

Run: `node bin/lmstudio-zh.mjs doctor`
Expected: 正常输出（找不到 LM Studio 时退出码 1，属预期——此时应带 `--path`）

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README with usage, architecture, and limitations"
```

---

## 完成标准

- [ ] `node --test test/` 全部通过（e2e 默认 skip）
- [ ] `LMS_E2E=1 node --test test/e2e.test.mjs` 全部通过
- [ ] `lmstudio-zh scan` 报告 A 层缺口为 0（或全部有译文）
- [ ] `lmstudio-zh apply` 四道闸门全过，且文件仍能被 `vm.Script` 编译
- [ ] 真实 LM Studio 中界面无英文残留、无乱码、无 `{{}}` 残留
- [ ] `lmstudio-zh apply` 二次运行报告「已是最新补丁」
- [ ] `lmstudio-zh restore` 后文件与原版逐字节一致
- [ ] `package.json` 的 `dependencies` 仍为 `{}`