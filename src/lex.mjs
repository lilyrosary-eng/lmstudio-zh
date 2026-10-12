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

export function encode(value, quote) {
  const q = quote === '"' || quote === "'" ? quote : "`";
  let out = q;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const cp = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += "\\" + q;
    else if (ch === "`" && q === "`") out += "\\`";
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
      out.push(mk(code, start, i));
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
      out.push(mk(code, start, i));
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

function mk(code, start, end) {
  const raw = code.slice(start, end);
  const quote = raw[0];
  const value = decode(raw);
  return {
    start, end, quote, raw, value,
    // isKey：该字面量充当对象字面量的键——即紧随其后的字符是 ':'（"name": value）。
    // 注意不是「前面是 ':'」——那样会把普通取值（{height:"px"}）误判成键。
    isKey: code[end] === ":",
    hasSubstitution: quote === "`" && raw.includes("${"),
  };
}
