import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBatches, buildPrompt, parseReply, fill, listModels, DEFAULT_BASE } from "../src/translate.mjs";

test("buildBatches: respects maxChars", () => {
  const items = ["aaaa", "bbbb", "cccc", "dddd"];
  const b = buildBatches(items, 10);
  assert.ok(b.every((g) => g.length <= 2));
  assert.equal(b.flat().length, 4);
});

test("buildBatches: packs multiple items when the budget allows", () => {
  // brief 原稿的 maxChars=10 让每批只能装 1 条（w=28），batching 逻辑实际没被走到。
  // 60 的预算应装下 2 条（28+28=56），4 条分 2 批。
  const items = ["aaaa", "bbbb", "cccc", "dddd"];
  const b = buildBatches(items, 60);
  assert.equal(b.length, 2);
  assert.deepEqual(b.map((g) => g.length), [2, 2]);
});

test("parseReply: accepts a JSON array of {en, zh}", () => {
  const items = [{ en: "Clear", text: "Clear" }];
  const raw = '[{"en":"Clear","zh":"清除"}]';
  const r = parseReply(raw, items);
  assert.equal(r.filled.length, 1);
  assert.equal(r.filled[0].zh, "清除");
  assert.equal(r.filled[0].origin, "model");
});

test("parseReply: rejects entries whose placeholders do not match", () => {
  const items = [{ en: "Move {{count}} chats", text: "Move {{count}} chats" }];
  const raw = '[{"en":"Move {{count}} chats","zh":"移动对话"}]';
  const r = parseReply(raw, items);
  assert.equal(r.filled.length, 0);
  // validate 的 reason 用空格分隔（"placeholder mismatch"），本模块的拒绝原因
  // 统一连字符风格——brief 原稿直接透传，测试断言的是连字符形式。
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
  assert.equal(r.rejected[0].reason, "unparsable");
});

test("parseReply: reports items the model did not return", () => {
  const r = parseReply('[{"en":"Clear","zh":"清除"}]', [{ en: "Clear", text: "Clear" }, { en: "Rename", text: "Rename" }]);
  assert.equal(r.filled.length, 1);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].reason, "not-returned");
  assert.equal(r.rejected[0].en, "Rename");
});

test("parseReply: dedupes repeated entries, first one wins", () => {
  const raw = '[{"en":"Clear","zh":"清除"},{"en":"Clear","zh":"清空"}]';
  const r = parseReply(raw, [{ en: "Clear", text: "Clear" }]);
  assert.equal(r.filled.length, 1);
  assert.equal(r.filled[0].zh, "清除");
});

test("parseReply: works on Task 7's item shape (en only, no text)", () => {
  // Task 7 的 decideUntranslated 产出 { en, zh, origin }——没有 text 字段。
  // 两个 brief 之间的形状冲突在此锁定：本模块必须两种形状都能吃。
  const r = parseReply('[{"en":"Clear","zh":"清除"}]', [{ en: "Clear", zh: undefined, origin: "model" }]);
  assert.equal(r.filled.length, 1);
  assert.equal(r.filled[0].en, "Clear");
});

test("buildPrompt: includes the items and the few-shot examples", () => {
  const p = buildPrompt([{ en: "Clear", text: "Clear" }], [{ en: "Chat", zh: "聊天" }]);
  assert.ok(p.includes("Clear"));
  assert.ok(p.includes("聊天"));
  // 占位符约束必须出现在用户消息里——brief 原稿只把它放在 SYSTEM 中，
  // buildPrompt 的输出不含 "{{"，模型对用户轮里的约束遵循得更稳。
  assert.ok(p.includes("{{"));
});

// ---- 以下用桩替换全局 fetch，不需要真实 LM Studio 服务 ----

function stubFetch(impl) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = orig; };
}

test("fill: posts one request per batch and returns validated decisions", async () => {
  const seen = [];
  const restore = stubFetch(async (url, opts) => {
    seen.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ choices: [{ message: { content: '[{"en":"Clear","zh":"清除"}]' } }] }) };
  });
  try {
    const r = await fill([{ en: "Clear" }], { model: "qwen" });
    assert.equal(r.filled.length, 1);
    assert.equal(r.filled[0].zh, "清除");
    assert.equal(seen.length, 1);
    assert.ok(seen[0].url.endsWith("/chat/completions"));
    assert.equal(seen[0].body.model, "qwen");
    assert.ok(seen[0].body.messages[0].content.includes("{{"));   // system 提示带占位符规则
  } finally { restore(); }
});

test("fill: propagates API errors", async () => {
  const restore = stubFetch(async () => ({ ok: false, status: 404, text: async () => "model not loaded" }));
  try {
    await assert.rejects(() => fill([{ en: "Clear" }], { model: "x" }), /404/);
  } finally { restore(); }
});

test("listModels: returns ids from the API", async () => {
  const restore = stubFetch(async (url) => {
    assert.ok(String(url).endsWith("/models"));
    return { ok: true, json: async () => ({ data: [{ id: "qwen" }, { id: null }, { id: "zai" }] }) };
  });
  try {
    assert.deepEqual(await listModels("http://127.0.0.1:1234/v1"), ["qwen", "zai"]);
  } finally { restore(); }
});

test("DEFAULT_BASE points at the local LM Studio server", () => {
  assert.equal(DEFAULT_BASE, "http://127.0.0.1:1234/v1");
});
