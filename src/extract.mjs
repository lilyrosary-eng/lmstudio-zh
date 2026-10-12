import { scan } from "./lex.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as pathJoin } from "node:path";

// 定位「导出各语言 *Strings 对象」的那个模块。
// 不依赖 module id，只依赖结构：
//   ① 存在形如  e.ChineseCNStrings=<ident>;  的赋值
//   ② 在同一模块内能找到 <ident>={ns:<ident2>.default, ...}  或 {ns:(...)(a(ID)), ...}
// 返回 namespacesByLang: Map<lang, { [namespace]: modId }>
//
// 语言键的归一化：bundle 里的导出名是 ChineseCNStrings / EnglishStrings，
// 而下游（zhCatalog / enCatalog / Task 4）按 zh_CN / en 取用。
// 先去掉 Strings 后缀得到语言名，再查别名表；其余语言保留语言名
// （allLanguageModules 排除时需要全部语言，名字无所谓）。
const LANG_ALIAS = new Map([["ChineseCN", "zh_CN"], ["English", "en"]]);

export function locateLanguageModule(code) {
  // 锚点必须是 e.ChineseCNStrings= 本身，不能拿「全文第一个 e.*Strings= 赋值」
  // 当锚点：真实 bundle 里存在无关模块的同形赋值（实测 e.stopStrings=t}，
  // 全文共 40 处匹配、其中 2 处是噪声），拿噪声当锚点会定位到错误的模块。
  // 两个出现位置（=void 0 链与真实赋值）都位于语言目录模块内，均可作锚。
  const anchor = code.indexOf("e.ChineseCNStrings=");
  if (anchor < 0) return null;

  // 只在这个模块的范围内工作：从锚点往前找到模块起点，之后往后找到模块终点。
  const modStart = findModuleStart(code, anchor);
  const modEnd = findModuleEnd(code, anchor);
  if (modStart < 0 || modEnd < 0) return null;
  const modText = code.slice(modStart, modEnd);

  // 收集本模块内所有 e.<Lang>Strings=<ident> 形式的赋值。
  // 终止符取 [;}] 而非仅 ;：语言目录模块的最后一个赋值以模块收尾的 '}' 结尾
  // （真实 bundle 中 e.GaeilgeStrings=Go}，fixture 中 e.SwedishStrings=sw}），
  // 只认分号会漏掉整整一门语言。
  const assigns = new Map();
  for (const m of modText.matchAll(/e\.([A-Za-z_$][\w$]*Strings)=([A-Za-z_$][\w$]*)[;}]/g)) {
    assigns.set(m[1], m[2]);
  }
  if (assigns.size === 0) return null;
  if (!assigns.has("ChineseCNStrings")) return null;

  // 建立「本模块内标识符 → module id」映射，支持 X=n(a(ID)) 与 X=(...)(a(ID)) 两种写法。
  // 第二种写法（先 (t=>t.default) 再调 a(ID)）的前缀是一对括号而不是标识符，
  // 故可选的括号前缀有两种形态：ident( 或 (<无括号表达式>)(
  const varToId = new Map();
  for (const m of modText.matchAll(
        /(?<![\w$])([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\s*\(\s*|\([^()]*\)\s*\(\s*)?a\((\d+)\)\s*\)?/g)) {
    varToId.set(m[1], m[2]);
  }

  const namespacesByLang = new Map();
  for (const [lang, ident] of assigns) {
    const obj = findNamespaceObject(modText, ident);
    if (!obj) return null;
    const ns = {};
    for (const [name, ref] of Object.entries(obj)) {
      // 真实 bundle 中部分语言缺命名空间时写 shared:void 0（如越南语、捷克语）。
      // 该语言没有这个命名空间模块，跳过即可；若因此返回 null，整个定位会失败。
      if (/^void\s+0$/.test(ref)) continue;
      const id = resolveRef(ref, modText, varToId);
      if (id == null) return null;
      ns[name] = id;
    }
    const bare = lang.replace(/Strings$/, "");
    namespacesByLang.set(LANG_ALIAS.get(bare) ?? bare, ns);
  }
  return { namespacesByLang, varToId };
}

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

// ref 形如 "r.default"（变量经 X=n(a(ID)) 绑定）、"(t=>t.default)(a(10001))"（内联），
// 或裸标识符 "r"（变量经 X=(t=>t.default)(a(ID)) 绑定，.default 已在绑定表达式里取出）。
// 三种形态在真实 bundle 与 fixture 中都出现，缺一种都会让整个定位返回 null。
function resolveRef(ref, modText, varToId) {
  const direct = /^([A-Za-z_$][\w$]*)\.default$/.exec(ref);
  if (direct) return varToId.get(direct[1]);
  const inline = /a\((\d+)\)/.exec(ref);
  if (inline) return inline[1];
  const bare = /^([A-Za-z_$][\w$]*)$/.exec(ref);
  if (bare) return varToId.get(bare[1]);
  return null;
}

// 读取某语言各命名空间模块里的 JSON.parse('...') 内容
export function readCatalog(code, located, lang) {
  const ns = located.namespacesByLang.get(lang);
  if (!ns) return null;
  const lits = scan(code);
  const heads = moduleHeads(code);
  const out = {};
  for (const [name, modId] of Object.entries(ns)) {
    const span = findJsonParseSpan(code, modId, lits, heads);
    if (!span) return null;
    try { out[name] = { modId, span: { start: span.start, end: span.end }, data: JSON.parse(span.value) }; }
    catch { return null; }
  }
  return out;
}

// 一次正则扫描建立「module id → 模块头位置」映射（同 id 多处命中取第一处，
// 与逐个 id 各扫一遍的语义一致）。不能让每个命名空间各建一个正则扫全文——
// 380 个模块 × 34MB 是 candidates() 耗时的主要来源（实测约 20 秒）。
function moduleHeads(code) {
  const heads = new Map();
  const re = /[,{]\s*(\d{2,6})\s*:\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
  for (const m of code.matchAll(re)) if (!heads.has(m[1])) heads.set(m[1], m.index);
  return heads;
}

// 找到 "NNNNN:<fn>=>{" 后第一个 JSON.parse(' 的字面量区间。
// lits 必须是 scan(code) 的完整结果（按 start 升序），heads 是 moduleHeads(code)
// 的结果——两者都由调用方一次扫描取得。不能在这里 scan(code.slice(j))：
// 那会把 j 到文件尾（平均 17MB）重扫一遍。
function findJsonParseSpan(code, modId, lits, heads) {
  const headIdx = heads.get(modId);
  if (headIdx == null) return null;
  // JSON.parse( 必须紧跟在模块头之后（实测距离 34 字符）；只在 601 字节的
  // 窗口里找，与「全文找第一个再判断 > 600」语义等价，但避免了 380 次
  // 对 34MB 的 indexOf。
  const k = code.slice(headIdx, headIdx + 601).indexOf("JSON.parse(");
  if (k < 0 || k > 600) return null;
  const lit = firstLiteralAtOrAfter(lits, headIdx + k);
  if (!lit || (lit.quote !== "'" && lit.quote !== '"')) return null;
  return { start: lit.start, end: lit.end, value: lit.value };
}

// 字面量按 start 升序排列，二分找第一个 start >= pos 的字面量
function firstLiteralAtOrAfter(lits, pos) {
  let lo = 0, hi = lits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lits[mid].start < pos) lo = mid + 1; else hi = mid;
  }
  return lits[lo];
}

// 全部语言模块的字节区间——补丁必须排除这些区间
export function allLanguageModules(code, located) {
  return languageModuleSpans(code, located, scan(code), moduleHeads(code));
}

function languageModuleSpans(code, located, lits, heads) {
  const spans = [];
  for (const ns of located.namespacesByLang.values()) {
    for (const modId of Object.values(ns)) {
      const s = findJsonParseSpan(code, modId, lits, heads);
      if (s) spans.push({ start: s.start, end: s.end });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  // 去重重叠
  return spans.filter((s, i) => i === 0 || s.start >= spans[i - 1].end);
}

export const zhCatalog = (code, located) => readCatalog(code, located, "zh_CN");
export const enCatalog = (code, located) => readCatalog(code, located, "en");

// A 层缺口：英文词条表里有、中文词条表里没有。
// 路径必须用段数组传递，不能用 "/" 拼接再 split：真实词条表里存在键名本身
// 含 "/" 的扁平条目（如 "addMessageButtonText/toolTip"），拼接口径会把它们
// 误判成嵌套路径并按层级深查，实测由此产生 572 条假缺口（660 vs 88）。
export function missingFromA(code, located) {
  const en = enCatalog(code, located);
  const zh = zhCatalog(code, located);
  if (!en || !zh) return [];
  const out = [];
  for (const [namespace, { data }] of Object.entries(en)) {
    const zdata = zh[namespace]?.data ?? {};
    for (const [path, value] of flatten(data)) {
      if (lookupPath(zdata, path) === undefined) {
        out.push({ namespace, key: path.join("/"), en: value });
      }
    }
  }
  return out;
}

function flatten(o, p = []) {
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...flatten(v, [...p, k]));
    else out.push([[...p, k], v]);
  }
  return out;
}
function lookupPath(obj, path) {
  let cur = obj;
  for (const p of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SHORT_WORDS = new Set(
  JSON.parse(readFileSync(pathJoin(HERE, "..", "lexicon", "short-words.json"), "utf8"))
);

// 拒绝规则——命中即淘汰（但位于白名单检查之后，见 isCandidate 内的顺序说明）
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

// SVG 路径数据（图标库）：形如 "M0 0h24v24H0z"、"M3 3l18 18"、"M12 12m-9 0a9 9…"。
// 它们含空格与大写字母，能骗过下面的自然语言规则——实测占 B 层候选唯一值的
// 75%（25694/34027，出现次数最高的一条 7640 次）。这类数据一旦被翻译写回，
// 界面图标会全部损坏，且四道闸门拦不住它（译文是合法字符串、占位符也一致）。
// 判据：以路径命令字母开头、整体仅由路径命令字符与数字/分隔符构成。
// 长跨度（≥10 且含数字）直接判；短片段（图标库的 subpath，如 "M7 10l6 0"）
// 以 M+绝对坐标开头且 ≥6 字符也判——它们长度不足 10 会漏网，
// 而一旦被译成中文，对应图标会被替换成文字。
const SVG_PATH = /^[MmLlHhVvCcSsQqTtAaZz][MmLlHhVvCcSsQqTtAaZz0-9\s.,+-]*$/;
const isSvgPath = (t) => {
  if (!SVG_PATH.test(t)) return false;
  if (t.length >= 10 && /\d/.test(t)) return true;
  return t.length >= 6 && /^[Mm]\d/.test(t);
};

// 奇数个双引号 = 运行时字符串拼接的半段（如 'Unknown language: "'）；
// 奇数个反引号 = 模板串片段（如 "Cannot `"）。两者都不是完整 UI 文案——
// 实测译掉它们会把报错消息变成半中半英、把模板拼进反引号。
// 只数双引号与反引号，不数单引号（英文所有格 "Don't" 是合法 UI 词）。
const oddCount = (s, ch) => {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n % 2 === 1;
};

export function isCandidate(text, isKey, raw) {
  if (isKey) return false;                       // 只翻值
  if (!text || text.length < 2 || text.length > 500) return false;
  // UI 层上限 25 字符：实测 B 层候选唯一值按长度分布，≤25 是按钮/选项/设置标签
  // （设计文档 §2.2 点名的样例全部 ≤21 字符），26 以上几乎全是库内部消息
  // （asn1/router/React 校验）与文档式长句——用户裁定可见控件要翻、文档不翻。
  // >25 字符的 curated 条目全部走 A 层路径（实测 B 层候选零依赖），
  // 加上限不破坏任何现有译文。
  if (text.length > 25) return false;
  if (hasCJK(text)) return false;                // 已翻译
  if (text !== text.trim()) return false;        // 边缘空白：内部字符串特征，UI 标签不会有
  if (isSvgPath(text)) return false;             // SVG 路径数据：翻不得，写回会毁掉图标
  if (oddCount(text, '"')) return false;         // 拼接半段：译掉会毁掉运行时消息
  if (oddCount(text, "`")) return false;         // 模板片段：译掉会毁掉模板
  // 白名单必须先于拒绝规则：DENY 里的裸标识符规则会毙掉所有无空格词，
  // 而白名单词（Clear / GPU / OCR…）恰恰全是无空格的。规则与白名单冲突时，
  // 人工白名单是更具体的意图，优先。
  if (SHORT_WORDS.has(text)) return true;        // 无空格但属短 UI 词
  for (const re of DENY) if (re.test(text)) return false;
  if (!/[A-Za-z]/.test(text)) return false;      // 必须含拉丁字母
  if (!text.includes(" ")) return false;
  return /[A-Z]/.test(text);                     // 多词需含大写字母
}

// 幻影跨度守卫。扫描器在极少数构造上会把一整段真实代码并进一个字面量。
// 实测：overlong(>500) 共 7,696 条 / 10.4MB，但其中 84% 是 LM Studio 自己的
// i18n 词条表与 tailwind CSS 等合法内嵌数据——所以单看长度无法区分数据与代码。
// 再叠加「形似代码」特征后收敛到 107 条 / 1.49MB，逐条检查全部是被吞掉的真实
// 压缩 JS（webpack 模块体、class、this.、Object.defineProperty…）。
//
// 关键：判据用的是 raw（跨度的原始宽度），不是解码后的 value——实测存在
// raw 长 36 字符、value 仅 30 字符的幻影，只过滤 value 会漏掉。
export function isPhantomSpan(raw) {
  if (raw.length <= 500) return false;
  return /function|=>|===|var\s|class\s|this\./.test(raw);
}

// bundle 里被当作对象键使用的标识符集合。两个来源：
//   ① 非引号键 {Word: / ,Word: —— 注册表/枚举的标准写法，扫描器看不见
//      （实测 LM Studio 的模型面板注册表就是 const B={Info:X,Load:Y,...}）
//   ② 引号键 "Word": —— 扫描器的 isKey 已标记，跳过语言模块区间
// 以及以裸数组元素 / case 标签形式出现的单词集合。
// 防护规则：单词候选若**既是对象键、又是数组元素或 case 标签**，说明它是喂给
// 查找表的键（实测 ["Info","Load"] → B[t] → undefined.displayName 崩溃）——
// 一律不翻。仅作值出现（label:"Top"）或仅被属性访问的枚举键（{Top:"top"}）是
// 安全的，不误杀。漏翻胜过翻崩。
function codeUsageSets(code, lits, inExcluded) {
  const keys = new Set(), arrayWords = new Set(), caseWords = new Set();
  for (const l of lits) {
    if (l.isKey && !inExcluded(l.start)) keys.add(l.value);
  }
  for (const m of code.matchAll(/[{,;]\s*([A-Za-z_$][\w$]*)\s*:/g)) keys.add(m[1]);
  for (const m of code.matchAll(/[\[,]\s*(["'`])([A-Za-z_$][\w$]*)\1(?=\s*[,\]])/g)) arrayWords.add(m[2]);
  for (const m of code.matchAll(/case\s+(["'`])([A-Za-z_$][\w$]*)\1\s*:/g)) caseWords.add(m[2]);
  return { keys, arrayWords, caseWords };
}

// B 层候选：bundle 内、不属于任何语言模块区间的自然语言字面量
export function candidates(code, located) {
  const lits = scan(code);
  const heads = moduleHeads(code);
  // located 为 null（结构定位失败的 bundle）时没有需要排除的语言区间，
  // 按空区间集合继续——调用方用 candidates 做候选体检时不应因此崩溃。
  const excluded = located ? languageModuleSpans(code, located, lits, heads) : [];
  // excluded 按 start 升序且不重叠：二分找最后一个 end <= pos 的区间，
  // 只需再判断 pos 是否落在它的 [start, end) 内。38 万字面量 × 线性扫 380
  // 个区间是 1.4 亿次比较，二分后约 300 万次。
  const inExcluded = (pos) => {
    let lo = 0, hi = excluded.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (excluded[mid].end <= pos) lo = mid + 1; else hi = mid;
    }
    return lo < excluded.length && pos >= excluded[lo].start;
  };
  const { keys, arrayWords, caseWords } = codeUsageSets(code, lits, inExcluded);
  const isLookupKey = (w) => keys.has(w) && (arrayWords.has(w) || caseWords.has(w));
  const out = [];
  for (const lit of lits) {
    if (inExcluded(lit.start)) continue;
    if (isPhantomSpan(lit.raw)) continue;          // 幻影跨度：绝不翻译
    if (!isCandidate(lit.value, lit.isKey)) continue;
    // 注册表键防护：只影响单词候选（键集合里只有标识符形状的串）
    if (!lit.value.includes(" ") && isLookupKey(lit.value)) continue;
    out.push({ text: lit.value, span: { start: lit.start, end: lit.end },
               quote: lit.quote, hasSubstitution: lit.hasSubstitution, source: "B" });
  }
  return out;
}
