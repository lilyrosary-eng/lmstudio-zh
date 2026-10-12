import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// 优先级数字越大越优先。curated 是人工词典，永不被覆盖。
const PRIORITY = { model: 1, user: 2, curated: 3 };

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

export function emptyLexicon() {
  return { version: 1, entries: new Map() };
}

function ingest(lex, data) {
  if (!data || !data.entries) return;
  for (const [en, v] of Object.entries(data.entries)) {
    if (typeof v?.zh !== "string" || !v.zh) continue;
    const prev = lex.entries.get(en);
    if (prev && PRIORITY[prev.origin] >= PRIORITY[v.origin]) continue;
    lex.entries.set(en, { zh: v.zh, origin: v.origin });
  }
}

export function loadLocal(stateDir) {
  const lex = emptyLexicon();
  ingest(lex, readJson(join(stateDir, "lexicon.local.json"), null));
  return lex;
}

export function load(stateDir, toolDir) {
  const lex = emptyLexicon();
  ingest(lex, readJson(join(toolDir, "lexicon", "zh-CN.json"), null));
  ingest(lex, readJson(join(stateDir, "lexicon.local.json"), null));
  return lex;
}

export function lookup(lex, en) {
  return lex.entries.get(en)?.zh;
}

export function upsert(lex, en, zh, origin) {
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