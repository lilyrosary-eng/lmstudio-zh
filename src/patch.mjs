import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync, mkdirSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { encode, decode } from "./lex.mjs";
import { locateLanguageModule, readCatalog, missingFromA, candidates } from "./extract.mjs";

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
const placeholders = (s) => (String(s).match(/\{\{[^}]*\}\}/g) ?? []).sort().join(" ");

export function validate(edit) {
  const { en, zh } = edit;
  if (typeof zh !== "string" || !zh.trim()) return { ok: false, reason: "empty target" };
  if (placeholders(en) !== placeholders(zh)) return { ok: false, reason: "placeholder mismatch" };
  if (en.length * 0.2 > zh.length) return { ok: false, reason: "target too short" };
  if (zh.length > en.length * 5) return { ok: false, reason: "target too long" };
  return { ok: true };
}

// 闸门 3.5：跨度独立复验。extract.candidates 的过滤发生在选计划时，apply 写文件是
// 另一个时刻——这里对每条待写入的 edit 重新按 start/end 切片，断言逐字节等于
// edit 记录的 original、首尾引号配对；B 层编辑还要求 decode(original) === en。
// 任一不符即拒绝该 edit（由 apply 执行并记入 pending.json），不是拒绝整个补丁。
// A 层编辑整体重写词条表 JSON，en 是报告占位串，跳过 decode 比对。
export function reverify(code, edit) {
  const slice = code.slice(edit.start, edit.end);
  if (slice !== edit.original) return false;
  if (slice.length < 2 || slice[0] !== slice.at(-1) || !/["'`]/.test(slice[0])) return false;
  if (edit.source === "A") return true;
  return decode(edit.original) === edit.en;
}

// 闸门 4：四项全过才算成功。
// 设计文档原本的四项是「编译 / 重扫字面量集合 / 由原文件+manifest 重算逐字节相等 /
// 大小变化」；byte-identical 蕴含字面量集合一致（计划外改动会破坏逐字节相等），
// 故以 edits-in-range 补上「区间不越界」这一项，四项命名为
// compiles / byte-identical / edits-in-range / size-delta。
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

// 把 decisions（[{en, zh, origin}]）变成字节编辑
// A 层：在 zh_CN 的 JSON.parse 字面量内增补缺失 key
export function planA(code, located, decisions) {
  const zh = readCatalog(code, located, "zh_CN");
  const en = readCatalog(code, located, "en");
  const byEn = new Map(decisions.map((d) => [d.en, d]));
  const edits = [];
  if (!zh) return edits;

  // 整份缺口只算一次——放在命名空间循环里会让 missingFromA 跑 10 遍
  // （每遍两次全文件扫描，真实 bundle 上约 40 秒）
  const miss = missingFromA(code, located);

  for (const [namespace, { data, span }] of Object.entries(zh)) {
    const added = {};
    for (const m of miss) {
      if (m.namespace !== namespace) continue;
      const zhText = byEn.get(m.en);
      if (!zhText) continue;
      const v = validate({ en: m.en, zh: zhText.zh });
      if (!v.ok) continue;
      added[m.key] = zhText.zh;
    }
    // 区分扁平键与嵌套路径：真实词条表里「键名本身含 /」的扁平条目（如
    // "notes/hint"）可以安全地顶层补入；嵌套路径（如 "uiControls/title"）
    // 不在 v1 自动补齐范围，留给人工。判据取英文词条表的顶层键集合。
    // brief 原稿的 k.includes("/") 会把 88 条缺口中 59 条可安全补入的
    // 扁平键一并跳过（Task 3 报告 §6.1）。
    const flatKeys = new Set(Object.keys(en?.[namespace]?.data ?? {}));
    let addedCount = 0;
    for (const [k, v] of Object.entries(added)) {
      if (!flatKeys.has(k)) continue;      // 嵌套路径：v1 不自动补齐
      data[k] = v;
      addedCount++;
    }
    if (addedCount === 0) continue;
    const replacement = encode(JSON.stringify(data), "'");
    edits.push({
      start: span.start, end: span.end,
      original: code.slice(span.start, span.end),
      replacement,
      en: "<A-layer additions>", zh: "<A-layer additions>", origin: "curated",
      source: "A",
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
    if (d.zh === c.text) continue;               // 恒等映射（LM Studio → LM Studio）：无操作，别进计划
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
      en: c.text, zh: d.zh, origin: d.origin, source: "B",
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

const manifestPath = (stateDir, hash) => join(stateDir, "manifests", `${hash}.json`);
const backupPath = (stateDir, hash) => join(stateDir, "backups", `${hash}.js`);

// 状态机对应设计文档 §9 的四行表：
//   patched  = 当前哈希 == 已打补丁的哈希      → 已是最新
//   clean    = 当前哈希 == manifest 的原始哈希 → 干净，可正常应用
//   foreign  = 两者都不是                     → 更新或手动动过，--force 才重新推导
//   unpatched= 不存在任何 manifest            → 首次运行，按原版处理
export function provenance(code, stateDir) {
  const hash = sha256(code);
  const dir = join(stateDir, "manifests");
  let any = false;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      let m;
      try { m = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
      any = true;
      if (m.patchedSha === hash) return { state: "patched", manifest: m, hash };
      if (m.originalSha === hash) return { state: "clean", manifest: m, hash };
    }
  }
  return { state: any ? "foreign" : "unpatched", manifest: null, hash };
}

// 闸门 3.5 的拒记入 pending.json。与 Task 6/7 translate 的 rejected 列表共用文件，
// 用不同 key 合并追加，不覆盖对方内容。
function recordSpanRejected(stateDir, rejected) {
  const path = join(stateDir, "pending.json");
  let doc = {};
  try { doc = JSON.parse(readFileSync(path, "utf8")); } catch { /* 不存在或损坏：从空开始 */ }
  if (!Array.isArray(doc.spanRejected)) doc.spanRejected = [];
  const at = new Date().toISOString();
  for (const e of rejected) {
    doc.spanRejected.push({ en: e.en, zh: e.zh, origin: e.origin, reason: "span-reverify-failed", at });
  }
  writeFileSync(path, JSON.stringify(doc, null, 2), "utf8");
}

// 事务性应用：闸门 3.5 复验 → 四道闸门 → 写临时文件 → 读回复验 → 原子 rename；
// 任何一步失败自动从备份回滚，目标文件不留半成品。
export function apply(target, original, patched, manifest, stateDir) {
  mkdirSync(join(stateDir, "manifests"), { recursive: true });
  mkdirSync(join(stateDir, "backups"), { recursive: true });

  // 闸门 3.5：在当前缓冲区上独立复验每条 edit；被拒的 edit 不进入补丁
  const kept = [], rejected = [];
  for (const e of manifest.edits) {
    if (reverify(original, e)) kept.push(e);
    else rejected.push(e);
  }
  if (rejected.length > 0) {
    patched = splice(original, kept);
    manifest = { ...manifest, edits: kept };
  }

  const v = verify(original, patched, manifest);
  if (!v.ok) return { ok: false, gates: v.gates, applied: false, rejected };

  const origHash = sha256(original);
  const backup = backupPath(stateDir, origHash);
  if (!existsSync(backup)) writeFileSync(backup, original, "utf8");

  const tmp = target + ".lmszh.tmp";
  try {
    writeFileSync(tmp, patched, "utf8");
    // 重新从磁盘读回验证，确保写入无损
    const roundtrip = readFileSync(tmp, "utf8");
    const v2 = verify(original, roundtrip, manifest);
    if (!v2.ok) { unlinkSync(tmp); return { ok: false, gates: v2.gates, applied: false, rejected }; }
    renameSync(tmp, target);
  } catch (e) {
    if (existsSync(tmp)) unlinkSync(tmp);
    copyFileSync(backup, target);          // 回滚
    return { ok: false, gates: v.gates, applied: false, error: String(e), rejected };
  }

  if (rejected.length > 0) recordSpanRejected(stateDir, rejected);

  try {
    const patchedHash = sha256(patched);
    const doc = JSON.stringify({ originalSha: origHash, patchedSha: patchedHash, edits: manifest.edits,
                                 target, at: new Date().toISOString() }, null, 2);
    // 补丁后哈希与原文件哈希各记一份：前者让 provenance 认出「已打补丁」，
    // 后者让还原后的原版仍被认出「干净」
    writeFileSync(manifestPath(stateDir, patchedHash.slice(0, 16)), doc, "utf8");
    writeFileSync(manifestPath(stateDir, origHash.slice(0, 16)), doc, "utf8");
  } catch (e) {
    // manifest 落盘失败：没有 manifest 的补丁无法验证/还原，回滚文件
    copyFileSync(backup, target);
    return { ok: false, gates: v.gates, applied: false, error: String(e), rejected };
  }

  return { ok: true, gates: v.gates, applied: true, backup, rejected };
}

export function restore(target, stateDir) {
  const dir = join(stateDir, "backups");
  if (!existsSync(dir)) return false;
  // 备份按内容哈希命名，字典序不等于时间序；按 mtime 取最新的一份
  // （brief 原稿按文件名排序，多版本备份时会取错文件）
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"))
    .map((f) => ({ name: f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => a.m - b.m);
  if (files.length === 0) return false;
  copyFileSync(join(dir, files[files.length - 1].name), target);
  return true;
}
