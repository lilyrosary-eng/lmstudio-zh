import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// 优先级数字越大越优先。curated 是人工词典，永不被覆盖。
const PRIORITY = { model: 1, user: 2, curated: 3 };

// 人工词典是核心资产：损坏必须抛错。静默降级成空词典会让工具报告「无事可做」，
// 看起来像任务已经做完，实际上整本人工译文已经丢了。
function readCurated(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { throw new Error(`无法解析人工词典 ${path}: ${e.message}`); }
}

// lexicon.local.json 是可重建的运行时产物：损坏时降级为空是合理的，
// 但必须通过 onWarn 上报，否则这次降级在命令行上不可见。
function readLocal(path, onWarn) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { onWarn?.(`无法解析本地词典 ${path}，已按空词典继续: ${e.message}`); return null; }
}

export function emptyLexicon() {
  return { version: 1, entries: new Map() };
}

function ingest(lex, data) {
  if (!data || !data.entries) return;
  for (const [en, v] of Object.entries(data.entries)) {
    if (typeof v?.zh !== "string" || !v.zh) continue;
    // 未知 origin 一律拒绝：PRIORITY[unknown] 是 undefined，而 `3 >= undefined` 为 false，
    // 结果是一个被手工改坏的 lexicon.local.json 反而能覆盖 curated。
    // 用 hasOwn 而不是真值判断，"toString" 这类原型链上的 key 也进不来。
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
  // 非法 origin 是编程错误（不是用户数据），直接抛。
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