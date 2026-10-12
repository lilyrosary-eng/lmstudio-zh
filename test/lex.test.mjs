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
