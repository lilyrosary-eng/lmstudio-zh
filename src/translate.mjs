import { validate } from "./patch.mjs";

export const DEFAULT_BASE = "http://127.0.0.1:1234/v1";

// 条目形状兼容：brief 的 buildBatches 测试用纯字符串，parseReply 测试用
// { en, text }，Task 7 的 decideUntranslated 产出 { en, zh, origin }（没有 text）。
// 三种形状语义相同（待译原文），统一经 textOf 取值。
const textOf = (it) => typeof it === "string" ? it : (it.text ?? it.en);

export function buildBatches(items, maxChars = 3000) {
  const out = [];
  let cur = [], size = 0;
  for (const it of items) {
    const w = textOf(it).length + 24;
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
  const list = items.map((x) => JSON.stringify(textOf(x))).join(",\n  ");
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
    "",
    // 关键约束在用户轮里重复一遍：模型对用户消息里的指令遵循得比系统提示更稳，
    // 且 brief 原稿把占位符规则只放在 SYSTEM 中，用户轮没有任何提醒。
    "要求：只输出 JSON 数组；必须原样保留所有 {{变量}} 占位符；保留 <tag> 与 **粗体** 等标记结构。",
  ].join("\n");
}

const ph = (s) => (String(s).match(/\{\{[^}]*\}\}/g) ?? []).sort().join(" ");

export function parseReply(raw, items) {
  const filled = [], rejected = [];
  const known = new Map(items.map((i) => [textOf(i), i]));
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return { filled, rejected: items.map((i) => ({ en: textOf(i), reason: "unparsable" })) };
  let arr;
  try { arr = JSON.parse(raw.slice(start, end + 1)); }
  catch { return { filled, rejected: items.map((i) => ({ en: textOf(i), reason: "unparsable" })) }; }
  if (!Array.isArray(arr)) return { filled, rejected: items.map((i) => ({ en: textOf(i), reason: "unparsable" })) };

  const seen = new Set();
  for (const entry of arr) {
    const en = entry?.en, zh = entry?.zh;
    if (typeof en !== "string" || typeof zh !== "string") continue;
    if (!known.has(en)) { rejected.push({ en, reason: "unknown-source" }); continue; }
    if (seen.has(en)) continue;                       // 去重：同一条目多次返回，取第一份
    seen.add(en);
    const v = validate({ en, zh });
    // validate 的 reason 是空格分隔的人话（"placeholder mismatch"），
    // 本模块的拒绝原因统一连字符风格
    if (!v.ok) { rejected.push({ en, reason: String(v.reason).replace(/ /g, "-") }); continue; }
    filled.push({ en, zh, origin: "model" });
  }
  for (const i of items) {
    const t = textOf(i);
    if (!filled.some((f) => f.en === t) && !rejected.some((r) => r.en === t))
      rejected.push({ en: t, reason: "not-returned" });
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

// 逐批调用；每批结果通过 onBatch 交还调用方，由调用方立刻落盘（可中断续跑）
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
