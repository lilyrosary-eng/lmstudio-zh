import { test } from "node:test";
import assert from "node:assert/strict";
import { scan, decode, encode } from "../src/lex.mjs";

test("scan: finds a simple double-quoted literal with exact span", () => {
  const code = `const a="hello";`;
  const lits = scan(code);
  assert.equal(lits.length, 1);
  assert.equal(lits[0].value, "hello");
  assert.equal(lits[0].quote, '"');
  assert.equal(code.slice(lits[0].start, lits[0].end), '"hello"');
});

test("scan: escaped quote does not terminate the literal", () => {
  const code = String.raw`var s="a\"b";var t=1;`;
  const lits = scan(code);
  assert.equal(lits.length, 1);
  assert.equal(lits[0].value, 'a"b');
});

test("scan: regex containing a quote is not treated as a string", () => {
  const code = String.raw`var re=/"unclosed/g; var s="real";`;
  const lits = scan(code);
  assert.equal(lits.length, 1);
  assert.equal(lits[0].value, "real");
});

test("scan: division after an identifier is not a regex", () => {
  const code = String.raw`var x=a/b/c; var s="after";`;
  const lits = scan(code);
  assert.equal(lits.length, 1);
  assert.equal(lits[0].value, "after");
});

test("scan: single-quoted literal keeps its quote type", () => {
  const lits = scan(`var s='hi';`);
  assert.equal(lits[0].quote, "'");
  assert.equal(lits[0].value, "hi");
});

test("scan: a quoted object key is flagged as isKey", () => {
  const lits = scan(`var o={"height":1};`);
  assert.equal(lits.length, 1);
  assert.equal(lits[0].value, "height");
  assert.equal(lits[0].isKey, true);
});

test("scan: an object value is not flagged as isKey", () => {
  const lits = scan(`var o={height:"px"};`);
  assert.equal(lits.length, 1);
  assert.equal(lits[0].value, "px");
  assert.equal(lits[0].isKey, false);
});

test("scan: a bare-identifier key leaves its value unflagged", () => {
  const lits = scan(`({chat:"Chat"})`);
  assert.equal(lits.length, 1);
  assert.equal(lits[0].value, "Chat");
  assert.equal(lits[0].isKey, false);
});

test("scan: a standalone literal is not flagged as isKey", () => {
  const lits = scan(`var s="Resume Download";`);
  assert.equal(lits.length, 1);
  assert.equal(lits[0].value, "Resume Download");
  assert.equal(lits[0].isKey, false);
});

test("scan: template with substitution sets hasSubstitution", () => {
  const lits = scan("var s=`n=${x} tok`;");
  assert.equal(lits[0].quote, "`");
  assert.equal(lits[0].hasSubstitution, true);
});

test("scan: line comment contents are ignored", () => {
  const lits = scan(`// "ghost"\nvar s="real";`);
  assert.equal(lits.length, 1);
  assert.equal(lits[0].value, "real");
});

test("decode: unicode escape and line continuation", () => {
  assert.equal(decode(String.raw`"A"`), "A");
  assert.equal(decode(String.raw`"\u0041"`), "A");
  assert.equal(decode('"a\\\nb"'), "ab");
});

test("scan: spans are exact for a realistic minified fragment", () => {
  const code = String.raw`t.exports=JSON.parse('{"chat":"Chat"}')`;
  const lits = scan(code);
  assert.equal(lits.length, 1);
  assert.equal(JSON.parse(lits[0].value).chat, "Chat");
  assert.equal(code.slice(lits[0].start, lits[0].end), String.raw`'{"chat":"Chat"}'`);
});

test("encode: round-trips through decode for both quote types", () => {
  for (const q of ['"', "'"]) {
    const v = `Reasoning Budget "x" it's \\ ok \n`;
    assert.equal(decode(encode(v, q)), v);
  }
});

test("encode: escapes the matching quote only", () => {
  assert.equal(encode(`a"b`, "'"), `'a"b'`);
  assert.equal(encode(`a'b`, '"'), `"a'b"`);
  assert.equal(encode(`a'b`, "'"), `'a\\'b'`);
});

test("encode: preserves CJK verbatim", () => {
  assert.equal(encode("推理预算", '"'), '"推理预算"');
});

test("encode: escapes ${ inside a backtick literal", () => {
  const v = "cost ${price} USD";
  assert.equal(decode(encode(v, "`")), v);
  assert.equal(encode(v, "`"), "`cost \\${price} USD`");
});

test("encode: ${ is inert and left unescaped in quotes", () => {
  const v = "cost ${price} USD";
  assert.equal(encode(v, '"'), '"cost ${price} USD"');
  assert.equal(encode(v, "'"), "'cost ${price} USD'");
});

test("encode: backtick output never contains an unescaped ${", () => {
  for (const v of ["cost ${price} USD", "${", "a${b}c${d}e", "$${x}", "\\${y}"]) {
    assert.doesNotMatch(encode(v, "`"), /(?<!\\)\$\{/, `unescaped \${ in ${JSON.stringify(v)}`);
    assert.equal(decode(encode(v, "`")), v);
  }
});

// --- 模板串：替换表达式内部的嵌套字符串必须整块消费 ---

test("scan: a ${ inside a nested string does not swallow the rest of the file", () => {
  const code = 'var t=`${"${"}`; var s="after";';
  const lits = scan(code);
  // decode 只做转义还原、不求值替换表达式，因此 value 是模板串的字面内文。
  assert.deepEqual(lits.map((l) => l.value), ['${"${"}', "after"]);
  assert.equal(lits[0].raw, '`${"${"}`');
  assert.equal(lits[0].hasSubstitution, true);
  for (const l of lits) assert.equal(code.slice(l.start, l.end), l.raw);
});

test("scan: an unterminated template is surfaced, not silently closed", () => {
  const lits = scan('var t=`never closed; var s="after";');
  assert.equal(lits.length, 1);
  // 未闭合的 raw 不以反引号结尾，tools/check-real-bundle.mjs 会把它计入 unterminated。
  assert.notEqual(lits[0].raw.at(-1), "`");
});

test("scan: hasSubstitution is false for an escaped \\${", () => {
  const lits = scan('var t=`a\\${b}c`;');
  assert.equal(lits[0].hasSubstitution, false);
  assert.equal(lits[0].value, "a${b}c");
});

// 记录在案的取舍：替换表达式内部的字符串不单独上报为字面量。
// 它们仍属于外层模板串的 raw，因此仍可被整体替换，但 Task 3 的候选提取看不到它们。
test("scan: strings inside a substitution are not reported as separate literals", () => {
  const lits = scan('var s=`x${ cond ? "Yes" : "No" }y`;');
  assert.equal(lits.length, 1);
  assert.equal(lits[0].quote, "`");
  assert.equal(lits[0].hasSubstitution, true);
});

// --- decode：行接续含 CR 与 CRLF ---

test("decode: CR and CRLF are line continuations", () => {
  assert.equal(decode('"a\\\nb"'), "ab");
  assert.equal(decode('"a\\\rb"'), "ab");
  assert.equal(decode('"a\\\r\nb"'), "ab");
});

// --- '/' 是正则还是除号：关键字后面可以跟正则 ---

test("scan: a regex after return is not harvested as a literal", () => {
  assert.deepEqual(scan('function f(){return /"ghost"/.test(s);}'), []);
});

test("scan: a regex after case is not harvested as a literal", () => {
  assert.deepEqual(scan('switch(x){case /"ghost"/.test(s):break;}'), []);
});

test("scan: division after an identifier still beats the keyword rule", () => {
  const lits = scan('var x=a/b/c; var s="after";');
  assert.deepEqual(lits.map((l) => l.value), ["after"]);
});

// --- 其余覆盖补齐 ---

test("scan: block comment contents are ignored", () => {
  const lits = scan('/* "ghost" */ var s="real";');
  assert.equal(lits.length, 1);
  assert.equal(lits[0].value, "real");
});

test("scan: every span slices back to its own raw across a multi-literal sample", () => {
  const code = `var a="one";var re=/"skip"/g;var b='two';var c=\`tpl \${x}\`;var d={"k":"v"};`;
  const lits = scan(code);
  assert.deepEqual(lits.map((l) => l.value), ["one", "two", "tpl ${x}", "k", "v"]);
  for (const l of lits) assert.equal(code.slice(l.start, l.end), l.raw);
});

// --- round 3: '/' 分类的根因修正 ---

// 关键字同名的成员属性不是关键字。误判会让 '/' 走正则分支，而正则分支永远不产出字面量，
// 一路吞到 EOF 也不会有任何告警——后面的字面量全部丢失。
test("scan: a property named like a keyword is not a regex-preceding keyword", () => {
  for (const k of ["delete", "in", "of", "case", "void", "return", "throw",
                   "typeof", "yield", "await", "do", "else"]) {
    const lits = scan(`var q = o.${k} / 2; var s = "Chat";`);
    assert.deepEqual(lits.map((l) => l.value), ["Chat"], `o.${k} / 2`);
  }
});

// token 不能跨空白累积：for (k in /re/) 里的 in 必须被认成关键字。
test("scan: a regex after in / of inside a for head is not harvested", () => {
  assert.deepEqual(
    scan("for(var k in /[']/g){}var a=\"Chat\";var b=\"after\";").map((l) => l.value),
    ["Chat", "after"]);
  assert.deepEqual(
    scan("for(var k of /[']/g){}var a=\"Chat\";var b=\"after\";").map((l) => l.value),
    ["Chat", "after"]);
});

// 无花括号的控制流头：if(x)/re/.test(y) —— 目标符号是 ExpressionStatement，'/' 是正则起始。
test("scan: a regex after a braceless control-flow head is not harvested", () => {
  assert.deepEqual(
    scan('if(x)/[\'"]/.test(y);var a="Chat";var b="it\'s ok";var c="Resume";').map((l) => l.value),
    ["Chat", "it's ok", "Resume"]);
  assert.deepEqual(
    scan('while(n)/[a\']/.test(m);var a="Download";var b="ok";').map((l) => l.value),
    ["Download", "ok"]);
  assert.deepEqual(scan('for(;;)/[\'"]/.test(y);var a="Chat";').map((l) => l.value), ["Chat"]);
  assert.deepEqual(scan('with(o)/[\'"]/.test(y);var a="Chat";').map((l) => l.value), ["Chat"]);
  assert.deepEqual(scan('{lbl: if(x)/[\'"]/.test(y);var a="Chat";}').map((l) => l.value), ["Chat"]);
});

test("scan: division after a call is still division", () => {
  assert.deepEqual(scan('var q = f(x) / 2; var s = "Chat";').map((l) => l.value), ["Chat"]);
  assert.deepEqual(scan('var q = f(x)(y) / 2; var s = "Chat";').map((l) => l.value), ["Chat"]);
  assert.deepEqual(scan('if(a){/re/.test(b)}var s = "Chat";').map((l) => l.value), ["Chat"]);
});
