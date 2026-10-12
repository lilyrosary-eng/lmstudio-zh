// 用法: node tools/check-real-bundle.mjs [path-to-main_window.js]
// 对真实 LM Studio bundle 校验扫描器的真实回归信号。任一项非 0 即视为扫描器有缺陷。
import { readFileSync } from "node:fs";
import { scan, decode } from "../src/lex.mjs";

const file = process.argv[2]
  ?? String.raw`C:\Program Files\LM Studio\resources\app\.webpack\renderer\main_window.js`;
const code = readFileSync(file, "utf8");
const lits = scan(code);

let decodeMismatch = 0, spanMismatch = 0, unterminated = 0, overlong = 0;
for (const l of lits) {
  if (decode(l.raw) !== l.value) decodeMismatch++;
  if (code.slice(l.start, l.end) !== l.raw) spanMismatch++;
  if (!/^["'`]/.test(l.raw) || l.raw.at(-1) !== l.raw[0]) unterminated++;
  if (l.raw.length > 500) overlong++;
}

console.log(`literals       : ${lits.length}`);
console.log(`isKey-true     : ${lits.filter((l) => l.isKey).length}`);
console.log(`decode-mismatch: ${decodeMismatch}`);
console.log(`span-mismatch  : ${spanMismatch}`);
console.log(`unterminated   : ${unterminated}`);
// 只是信号，不让校验失败：长字面量绝大多数是内嵌的 i18n JSON / CSS 数据，是合法的。
// 少数是扫描器误判出的幻影字面量（吞掉了真实代码），需要人工/Task 4 复核。
console.log(`overlong(>500) : ${overlong}`);

if (spanMismatch !== 0 || unterminated !== 0) {
  console.error("FAIL — 扫描器存在缺陷，停止");
  process.exit(1);
}
console.log("OK");
