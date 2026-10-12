import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { find, RELATIVE_TARGET } from "./discover.mjs";
import { load, loadLocal, upsert, saveLocal, stats } from "./lexicon.mjs";
import { locateLanguageModule, zhCatalog, enCatalog, missingFromA, candidates } from "./extract.mjs";
import { planForDecisions, splice, apply, restore, provenance, verify, sha256 } from "./patch.mjs";
import { fill as translateFill, listModels } from "./translate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TOOL_DIR = resolve(HERE, "..");
export const defaultStateDir = () => join(homedir(), ".lmstudio-zh");

// 每个被考虑的字符串都产生一条决策：
//   词典命中（人工/本地/用户）→ 带上译文与来源，apply 直接采用
//   未命中                     → zh 留空，进 translate 队列
// brief 原稿对词典命中「直接跳过」——那样人工词典的译文永远到不了补丁，
// 工具的核心目的（用词典打补丁）被架空。translate 的 todo 用 !d.zh 过滤，
// scan 的待翻译列表同理，都不会把已有译文当成待译项。
// located 为 null 表示「无 i18n 结构」，此时只扫 B 层硬编码字面量
export function decideUntranslated(code, located, lex, lexLocal) {
  const out = [];
  const seen = new Set();
  const consider = (text) => {
    if (!text || seen.has(text)) return;
    seen.add(text);
    const hit = lex.entries.get(text);
    if (hit) { out.push({ en: text, zh: hit.zh, origin: hit.origin }); return; }
    const local = lexLocal.entries.get(text);
    if (local) { out.push({ en: text, zh: local.zh, origin: local.origin }); return; }
    out.push({ en: text, zh: undefined, origin: "model" });
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

// brief 原稿用 argv.find(a => a === "--path")——那返回的是元素本身（"--path"），
// 不是它后面的路径值，导致 --path 永远指向一个叫 "--path" 的目录。
// 取 indexOf 处的下一个参数。
async function locateTarget(io) {
  const i = io.argv.indexOf("--path");
  const pathArg = (i >= 0 ? io.argv[i + 1] : undefined) ?? "";
  return find(pathArg.trim() ? { roots: [pathArg.trim()] } : {});
}

// LM Studio 运行时禁止改文件：会造成内存与磁盘不一致（设计文档 §10）。
// io.isAppClosed 是测试注入点——不开着 LM Studio 的机器上测试才确定。
// 真实探测：Windows 用 tasklist 过滤镜像名；Linux 用 pgrep 退出码
// （pgrep 有匹配时退出 0 并抛不出异常，无匹配退出 1 抛异常）。
function assertAppClosed(io) {
  if (typeof io.isAppClosed === "function") return io.isAppClosed();
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq LM Studio.exe", "/NH"], { encoding: "utf8" });
      return !out.includes("LM Studio.exe");
    }
    execFileSync("pgrep", ["-f", "LM Studio"], { stdio: ["ignore", "ignore", "ignore"] });
    return false;                                  // 退出码 0 = 有匹配
  } catch { return true; }                         // 探测工具缺失/无匹配：放行，由四道闸门兜底
}

// 写入前置检查。LM Studio 装在 Program Files 时，标准用户对目标目录只读——
// 设计文档曾假设「全程不需要管理员权限」，那只对 LOCALAPPDATA 式的每用户安装成立。
// 不预检的话，失败会推迟到写临时文件那一刻，且回滚路径再抛一个 EPERM，
// 用户看到的是两条互相掩映的权限错误。提前探明并给出可操作提示。
// 探测方式与 apply 的实际写入一致：在目标目录建临时文件 + 以 r+ 打开目标文件。
function assertTargetWritable(target, io) {
  const probe = target + ".lmszh.write-probe";
  try {
    const fd = openSync(probe, "w");
    closeSync(fd);
    unlinkSync(probe);
    closeSync(openSync(target, "r+"));
    return true;
  } catch (e) {
    if (e.code === "EACCES" || e.code === "EPERM") {
      io.err(`目标文件不可写：${target}`);
      io.err("LM Studio 安装在受保护目录（如 Program Files）下，标准用户无权写入。");
      io.err("请以管理员身份重新运行本工具（右键启动器 → 以管理员身份运行）。");
      return false;
    }
    return true;                                   // 其他错误交给后续流程报
  }
}

// 从官方已有译文采样 few-shot：英文值（en 词条表）→ 中文值（zh 词条表）同键配对，
// 保证模型产出的术语与既有风格一致（设计文档 §8）。
// brief 原稿只读 zh 词条表、拿键名当英文——那是标识符不是英文句子，示例是错的。
function sampleExisting(code, located, ns, limit) {
  const en = enCatalog(code, located)?.[ns]?.data;
  const zh = zhCatalog(code, located)?.[ns]?.data;
  if (!en || !zh) return [];
  const out = [];
  for (const [k, v] of Object.entries(en)) {
    const z = zh[k];
    if (typeof v === "string" && typeof z === "string" && /[\u3400-\u9fff]/.test(z)) {
      out.push([v, z]);
      if (out.length >= limit) break;
    }
  }
  return out;
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
      const todo = decideUntranslated(code, located, lex, lexLocal).filter((d) => !d.zh);
      // 缺口里已被词典（人工/本地）覆盖的条数——「全部有译文」的直接读数
      const aCovered = missing.filter((m) => lex.entries.has(m.en) || lexLocal.entries.has(m.en)).length;
      // 设计文档 §10：scan 支持 --json 导出（候选有近八千条，文本列表只是给人看的）
      if (io.argv.includes("--json")) {
        io.log(JSON.stringify({
          target: found.target, version: found.version,
          aLayerGaps: missing, bLayerCandidates: cands.length, untranslated: todo,
        }, null, 2));
        return 0;
      }
      io.log(`A 层缺口（官方词条表缺 zh）: ${missing.length}（已有译文 ${aCovered}，未覆盖 ${missing.length - aCovered}）`);
      for (const m of missing) io.log(`  [A] ${m.namespace} :: ${m.en}`);
      io.log(`B 层候选（硬编码英文）: ${cands.length}`);
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
      if (located) for (const ns of Object.keys(zhCatalog(code, located) ?? {}))
        for (const [en, zh] of sampleExisting(code, located, ns, 6)) fewShot.push({ en, zh });
      io.log(`共 ${todo.length} 条待翻译，分批调用本地模型…`);
      const res = await translateFill(todo, {
        model, fewShot,
        // 设计文档 §8：每批结果立即落盘，中断可续跑（brief 原稿在 fill 全部结束后
        // 才统一 upsert，中途 Ctrl-C 会丢掉整轮进度）
        onBatch: ({ filled, remaining }) => {
          for (const f of filled) upsert(lexLocal, f.en, f.zh, "model");
          saveLocal(lexLocal, stateDir);
          io.log(`  本批落盘 ${filled.length} 条，剩余约 ${remaining} 条…`);
        },
      });
      // pending.json 与 patch.mjs 闸门 3.5 的 spanRejected 共用文件：合并写入，
      // 不覆盖对方的内容（Task 4 报告 §6.1）
      let pendingDoc = {};
      try { pendingDoc = JSON.parse(readFileSync(join(stateDir, "pending.json"), "utf8")); } catch {}
      pendingDoc.at = new Date().toISOString();
      pendingDoc.rejected = res.rejected;
      writeFileSync(join(stateDir, "pending.json"),
        JSON.stringify(pendingDoc, null, 2), "utf8");
      io.log(`成功 ${res.filled.length} 条，拒绝 ${res.rejected.length} 条`);
      io.log(`待审队列已更新：${join(stateDir, "pending.json")}`);
      return 0;
    }

    case "apply": {
      const found = await locateTarget(io);
      if (!found) { io.err("未找到 LM Studio 安装"); return 1; }
      if (!assertTargetWritable(found.target, io)) return 1;
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
      if (r.rejected.length > 0) io.log(`${r.rejected.length} 处编辑因跨度复验失败被跳过（见 pending.json）`);
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
      if (!assertTargetWritable(found.target, io)) return 1;
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
