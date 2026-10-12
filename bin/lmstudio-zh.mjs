#!/usr/bin/env node
import { main } from "../src/cli.mjs";

const io = {
  log: (m) => console.log(m),
  err: (m) => console.error(m),
  confirm: async (question) => {
    if (!process.stdin.isTTY) { console.error("非交互环境，请加 --yes"); return false; }
    process.stdout.write(`${question} [y/N] `);
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question("")).trim().toLowerCase();
    rl.close();
    return a === "y" || a === "yes";
  },
  argv: process.argv.slice(2),
};

// 顶层兜底：把异常变成一行可读错误而不是堆栈——CLI 的用户不是 Node 开发者
try {
  process.exit(await main(process.argv.slice(2), io));
} catch (e) {
  console.error(`[lmstudio-zh] ${e?.message ?? e}`);
  process.exit(1);
}
