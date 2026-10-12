// lmstudio-zh 的零依赖 JS 字面量扫描器（叶子模块，不 import 任何项目模块）。
//
// 已知限制：
//   - 不支持旧式八进制转义（"\101"）。JS 里它是 "A"，本模块 decode 会得到 "101"。
//     严格模式下 webpack bundle 不含此类转义，故按已知限制接受；见 test/lex.test.mjs。
//   - 替换表达式 ${...} 内部的字符串不单独上报为字面量（见 scan 的模板串分支）。

// 判断一个 '/' 是正则字面量的开始还是除号。
// 若前一个有效 token 能结束一个表达式，则是除号：
//   标识符/数字字符（A-Za-z0-9_$）、')'、']'。
// 注意类里**没有** '}'——`if(a){}/re/.test(b)` 里的 '/' 确实是正则起始。
const EXPRESSION_ENDING = /[A-Za-z0-9_$)\]]/;

// 这些关键字后面可以跟正则字面量，因此不能按「表达式结束」处理。
// 漏掉任何一个都会把正则体里的英文串当成字面量挖出来，
// 下游会往正则内部写中文，静默改变匹配语义且不报语法错。
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "throw", "case", "typeof", "void", "delete",
  "in", "of", "yield", "await", "do", "else",
]);

// 这些控制流头之后可能出现无花括号的语句体：if(x)/re/.test(y)。
// 压缩代码里这种写法非常高频，'/' 在该位置是正则起始而不是除号。
const CONTROL_HEADS = new Set(["if", "while", "for", "with"]);

const SIMPLE_ESCAPES = {
  n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0",
  "\\": "\\", '"': '"', "'": "'", "`": "`", "/": "/",
};

export function decode(raw) {
  const body = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") { out += c; continue; }
    const n = body[++i];
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
    if (n === "\n") continue;                                              // 行接续 LF
    if (n === "\r") { if (body[i + 1] === "\n") i++; continue; }          // 行接续 CR / CRLF
    out += SIMPLE_ESCAPES[n] ?? n;
  }
  return out;
}

export function encode(value, quote) {
  const q = quote === '"' || quote === "'" ? quote : "`";
  let out = q;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const cp = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += "\\" + q;      // q 为反引号时这条同时处理 '`'
    // 反引号串里 '${' 会变成真插值，必须转义，否则会向 bundle 注入未定义变量。
    else if (q === "`" && ch === "$" && value[i + 1] === "{") out += "\\$";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20) out += "\\x" + cp.toString(16).padStart(2, "0");
    else out += ch;                      // 非 ASCII（含中文）原样输出
  }
  return out + q;
}

export function scan(code) {
  const n = code.length;
  const out = [];
  let i = 0;
  let lastToken = "";            // 上一个有效 token 的完整文本
  let tokenOpen = false;         // lastToken 是否仍在累积中（没被空白/符号切断）
  let lastTokenIsMember = false; // 该 token 是否经由 '.' 成员访问得到（o.delete 里的 delete）
  let pendingMember = false;     // 刚读到 '.'，下一个标识符即成员名
  let nextTokenIsRegex = false;  // 下一个 '/' 必为正则起始
  const parenHeads = [];         // 未闭合的 '(' 是否为控制流头

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
      out.push(mk(code, start, i));
      lastToken = '"';
      tokenOpen = false;
      lastTokenIsMember = false;
      pendingMember = false;
      nextTokenIsRegex = false;
      continue;
    }
    // 模板串
    if (c === "`") {
      const start = i;
      i++;
      let depth = 0;
      let hasSubstitution = false;
      let terminated = false;
      while (i < n) {
        const ch = code[i];
        if (ch === "\\") { i += 2; continue; }
        // 替换表达式内部的字符串/模板要整块消费。否则其中的 '${' 会再次把 depth 抬高、
        // 其中的 '}' 又可能把 depth 提前减掉，depth 永远回不到 0，模板串会一路吞到文件末尾
        // ——在 35MB bundle 上就是一个数 MB 的 raw，改它会毁掉后面全部内容。
        if (depth > 0 && (ch === '"' || ch === "'" || ch === "`")) {
          i = skipNested(code, i, ch);
          continue;
        }
        if (ch === "$" && code[i + 1] === "{") { depth++; hasSubstitution = true; i += 2; continue; }
        if (depth > 0 && ch === "}") { depth--; i++; continue; }
        // 到这里 depth 必为 0（>0 时的嵌套串已被上面整块消费）
        if (ch === "`") { i++; terminated = true; break; }
        i++;
      }
      out.push(mk(code, start, i, hasSubstitution));
      if (!terminated) {
        // 未闭合：raw 不以反引号结尾，tools/check-real-bundle.mjs 会把它计入 unterminated 并让
        // 校验失败。此后的内容已无法可靠切分，停止扫描而不是继续产出错误的字面量。
        break;
      }
      lastToken = '"';
      tokenOpen = false;
      lastTokenIsMember = false;
      pendingMember = false;
      nextTokenIsRegex = false;
      continue;
    }
    // 正则字面量
    if (c === "/") {
      const asRegex = nextTokenIsRegex || !endsExpression(lastToken, lastTokenIsMember);
      nextTokenIsRegex = false;
      pendingMember = false;
      tokenOpen = false;
      lastTokenIsMember = false;
      lastToken = "/";
      i++;
      if (!asRegex) continue;
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
      continue;
    }
    // 空白：只前进，不重置 lastToken。关键字与 '/' 之间本来就有空格
    // （`return /re/`），但 token 自身不能跨空白累积——否则 for (k in /re/)
    // 里的 in 会并成 "kin"，关键字判断永远不成立。
    if (/\s/.test(c)) { i++; tokenOpen = false; continue; }
    // 标识符/数字：累积成完整 token，才能识别 return / case / in / of 这类关键字
    if (/[A-Za-z0-9_$]/.test(c)) {
      if (!tokenOpen) {
        // 新 token 的首字符：结算上一个 token 留下的修饰
        lastTokenIsMember = pendingMember;
        pendingMember = false;
        nextTokenIsRegex = false;
        lastToken = "";
      }
      lastToken += c;
      tokenOpen = true;
      i++;
      continue;
    }
    // 符号
    const prevToken = lastToken;
    const prevWasMember = lastTokenIsMember;
    tokenOpen = false;
    nextTokenIsRegex = false;
    pendingMember = c === ".";
    lastTokenIsMember = false;
    lastToken = c;
    // 无花括号控制流头：if(x)/re/.test(y) —— 这里的 '/' 不是除号，
    // 因为该位置的目标符号是 ExpressionStatement，'/' 必定是正则起始。
    // 故在 '(' 处记下它前面是不是 if/while/for/with，闭合它之后强制走正则分支。
    // 成员调用不算：foo.if(x) 里的 if 只是属性名。
    if (c === "(") parenHeads.push(!prevWasMember && CONTROL_HEADS.has(prevToken));
    else if (c === ")") nextTokenIsRegex = parenHeads.pop() ?? false;
    i++;
  }
  return out;
}

// lastToken 能否结束一个表达式 → '/' 是除号而非正则起始。
function endsExpression(lastToken, isMember) {
  if (!lastToken) return false;
  // 关键字只在「作为关键字」时才算；o.delete / 2 的 delete 是属性名。
  if (!isMember && REGEX_PRECEDING_KEYWORDS.has(lastToken)) return false;
  return EXPRESSION_ENDING.test(lastToken.at(-1));
}

// 从起始引号处整块消费一个嵌套字面量，返回其后一个字符的下标。
// i 指向起始引号本身，循环从它的下一个字符开始。
function skipNested(code, i, quote) {
  const n = code.length;
  let depth = 0;
  i++;
  while (i < n) {
    const ch = code[i];
    if (ch === "\\") { i += 2; continue; }
    if (quote === "`") {
      if (ch === "$" && code[i + 1] === "{") { depth++; i += 2; continue; }
      if (depth > 0 && ch === "}") { depth--; i++; continue; }
      if (ch === "`" && depth === 0) { i++; break; }
    } else if (ch === quote) {
      i++;
      break;
    }
    i++;
  }
  return i;
}

function mk(code, start, end, hasSubstitution = false) {
  const raw = code.slice(start, end);
  const quote = raw[0];
  const value = decode(raw);
  return {
    start, end, quote, raw, value,
    // isKey：该字面量充当对象字面量的键——即紧随其后的字符是 ':'（"name": value）。
    // 注意不是「前面是 ':'」——那样会把普通取值（{height:"px"}）误判成键。
    // 取紧邻判定是刻意的：bundle 是压缩代码，键后通常没有空格；`{"chat" : "Chat"}` 这类
    // 带空格的写法会被判成非键，属于已知且接受的偏差。
    isKey: code[end] === ":",
    // 由 scan 在扫描时记录，不靠 raw.includes("${") 反推——后者会把转义过的 \${ 误判成真插值。
    hasSubstitution: quote === "`" && hasSubstitution,
  };
}
