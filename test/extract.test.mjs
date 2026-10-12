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
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i].start >= spans[i - 1].end);
});

test("missingFromA: reports en keys absent from zh", () => {
  const m = locateLanguageModule(MINI);
  const miss = missingFromA(MINI, m);
  // key 是词条在词条表中的键路径（Task 4 回写定位用），en 是待翻译的英文原文。
  // 计划原稿把 x.key 当作英文值来断言，与 MissingEntry = { namespace, key, en }
  // 的接口定义矛盾（三个缺失条目的 key 都是 onlyInEn），按接口定义修正。
  assert.deepEqual(miss.map((x) => x.en).sort(),
    ["Another English only", "Only in English", "Third English only"]);
  assert.deepEqual(miss.map((x) => x.key), ["onlyInEn", "onlyInEn", "onlyInEn"]);
  assert.equal(miss[0].namespace, "chat");
  assert.equal(miss[0].en, "Only in English");
});

test("locateLanguageModule: returns null on an incompatible bundle", () => {
  assert.equal(locateLanguageModule("var x=1;"), null);
});

test("missingFromA: a flat key containing a slash is not mistaken for a nested path", () => {
  // 回归：真实词条表里「键名含 / 的扁平条目」与「嵌套对象」混合存在。
  // 按 "/" 拼接路径再拆分深查，会把前者误判成缺失——实测 660 vs 88 的
  // 572 条假缺口全部来源于此。
  const src = MINI
    .replace('{"send":"Send message"', '{"send":"Send message","notes/hint":"Save notes"')
    .replace(String.raw`{"send":"\u53d1\u9001\u6d88\u606f"`,
             String.raw`{"send":"\u53d1\u9001\u6d88\u606f"` + ',"notes/hint":"保存笔记"');
  const m = locateLanguageModule(src);
  const miss = missingFromA(src, m);
  assert.equal(miss.some((x) => x.key === "notes/hint"), false);   // 扁平键：zh 有，不是缺口
});

test("missingFromA: a genuinely nested missing path is still reported", () => {
  const src = MINI.replace('{"send":"Send message"',
    '{"send":"Send message","uiControls":{"title":"Display Settings"}');
  const m = locateLanguageModule(src);
  const miss = missingFromA(src, m);
  assert.ok(miss.some((x) => x.namespace === "chat" && x.key === "uiControls/title"
    && x.en === "Display Settings"));
});

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
  assert.equal(isCandidate("Open in New Window", false), true);   // 18 字符，设计文档点名的 UI 串
  assert.equal(isCandidate("Clear", false), true);
  assert.equal(isCandidate("Clear", true), false);      // 键不翻
});

test("isCandidate: rejects documentation-length strings (UI-tier cap)", async () => {
  // 用户裁定：按钮/选项/设置等可见控件要翻，文档长句不翻。
  // 25 字符是实测分界线：以上几乎全是库内部消息与文档式描述。
  const { isCandidate } = await import("../src/extract.mjs");
  assert.equal(isCandidate("Maximum Concurrent Predictions", false), false);            // 30
  assert.equal(isCandidate("Cannot access window outside of the DOM", false), false);   // 40
  assert.equal(isCandidate("This value does not match the required pattern", false), false); // 50
  // 边界：25 字符放行，26 字符拒绝
  assert.equal(isCandidate("Select all of these items", false), true);       // 25
  assert.equal(isCandidate("Select all of these items now", false), false);  // 30
});

test("isCandidate: rejects already-translated text", async () => {
  const { isCandidate } = await import("../src/extract.mjs");
  assert.equal(isCandidate("已下载", false), false);
});

test("isCandidate: rejects SVG path data and edge-whitespace strings", async () => {
  const { isCandidate } = await import("../src/extract.mjs");
  // 真实 bundle 中出现 7640 次的图标路径：含空格与大写字母，但它是数据不是文案
  for (const path of ["M0 0h24v24H0z", "M3 3l18 18",
                     "M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0",
                     "M7 10l6 0", "M10 7l0 6", "M3 4v4h4"]) {   // 最后三条是短 subpath 片段
    assert.equal(isCandidate(path, false), false, `should reject ${path}`);
  }
  assert.equal(isCandidate(" useId ", false), false);        // 边缘空白：内部串特征
  // 与路径形状相邻的合法 UI 串必须存活（含非路径命令字母）
  assert.equal(isCandidate("Move to Top", false), true);
  assert.equal(isCandidate("Select all", false), true);
});

test("isCandidate: every whitelisted short word is a candidate", async () => {
  // 白名单与过滤规则必须自洽：白名单里的词若被规则毙掉，该词就永远无法被 B 层写回
  const { isCandidate } = await import("../src/extract.mjs");
  const { readFileSync } = await import("node:fs");
  const words = JSON.parse(readFileSync(new URL("../lexicon/short-words.json", import.meta.url), "utf8"));
  for (const w of words) assert.equal(isCandidate(w, false), true, `whitelisted word rejected: ${w}`);
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

test("zhCatalog/enCatalog: shorthand returns the same shape as readCatalog", () => {
  const m = locateLanguageModule(MINI);
  assert.equal(zhCatalog(MINI, m).models.data.pinned, "已固定");
  assert.equal(enCatalog(MINI, m).models.data.pinned, "Pinned");
});

test("locateLanguageModule: a namespace bound to void 0 is skipped, not fatal", () => {
  // 真实 bundle 中部分语言缺命名空间时写 shared:void 0（如越南语）。
  // 这类语言的该命名空间应被跳过，而不是让整个定位失败返回 null。
  const src = MINI.replace("const sw={sidebar:(t=>t.default)(a(30001)),chat:(t=>t.default)(a(30002)),config:(t=>t.default)(a(30003)),models:(t=>t.default)(a(30004))};e.SwedishStrings=sw",
    "const sw={sidebar:(t=>t.default)(a(30001)),chat:(t=>t.default)(a(30002)),config:void 0,models:(t=>t.default)(a(30004))};e.SwedishStrings=sw");
  const m = locateLanguageModule(src);
  assert.ok(m, "should still locate");
  assert.deepEqual(Object.keys(m.namespacesByLang.get("Swedish")).sort(), ["chat", "models", "sidebar"]);
});
