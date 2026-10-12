import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { candidatesFor, RELATIVE_TARGET, find } from "../src/discover.mjs";

test("RELATIVE_TARGET points at the renderer bundle", () => {
  assert.equal(
    RELATIVE_TARGET.replace(/\\/g, "/"),
    "resources/app/.webpack/renderer/main_window.js");
});

test("candidatesFor: windows uses LOCALAPPDATA and PROGRAMFILES", () => {
  const c = candidatesFor("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", PROGRAMFILES: "C:\\Program Files" });
  assert.ok(c.some((p) => p.includes("AppData")));
  assert.ok(c.some((p) => p.includes("Program Files")));
});

test("candidatesFor: linux covers deb, snap and flatpak roots", () => {
  // brief 原稿直接读真实 /var/lib/flatpak/app——在非 Linux 开发机上该目录不存在，
  // 测试必败。接口声明的第三个参数 fs 就是为注入准备的，用假 fs 验证 flatpak 分支。
  const fakeFs = {
    existsSync: (p) => p === "/var/lib/flatpak/app",
    readdirSync: () => ["ai.lmstudio.LMStudio", "org.other.App"],
  };
  const c = candidatesFor("linux", { HOME: "/home/u" }, fakeFs);
  assert.ok(c.includes("/opt/LM Studio"));
  assert.ok(c.includes("/snap/lm-studio/current"));
  assert.ok(c.some((p) => p.startsWith("/var/lib/flatpak/app/")));
  assert.ok(c.includes("/var/lib/flatpak/app/ai.lmstudio.LMStudio"));
  assert.ok(!c.some((p) => p.includes("org.other")));   // 只收 lmstudio 相关条目
});

test("find: returns null when the file does not exist", () => {
  assert.equal(find({ roots: ["/definitely/not/here"] }), null);
});

test("find: locates a synthetic install tree", () => {
  const root = mkdtempSync(join(tmpdir(), "lms-"));
  const target = join(root, ...RELATIVE_TARGET.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "stub", "utf8");
  writeFileSync(join(root, "resources", "app", "package.json"),
    JSON.stringify({ version: "0.4.99+1" }), "utf8");
  const found = find({ roots: [root] });
  assert.ok(found);
  assert.equal(found.target, target);
  assert.equal(found.version, "0.4.99+1");
});

test("find: reads version from an AppImage lib/resources layout", () => {
  // brief 原稿的版本查找固定在 <root>/resources/app/package.json，
  // AppImage 解包布局（<root>/lib/resources/...）下会漏读版本。
  const root = mkdtempSync(join(tmpdir(), "lms-appimage-"));
  const target = join(root, "lib", ...RELATIVE_TARGET.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "stub", "utf8");
  writeFileSync(join(root, "lib", "resources", "app", "package.json"),
    JSON.stringify({ version: "0.4.98+7" }), "utf8");
  const found = find({ roots: [root] });
  assert.ok(found);
  assert.equal(found.target, target);
  assert.equal(found.version, "0.4.98+7");
});

test("find: skips roots without the bundle and returns the first hit", () => {
  const empty = mkdtempSync(join(tmpdir(), "lms-empty-"));
  const root = mkdtempSync(join(tmpdir(), "lms-real-"));
  const target = join(root, ...RELATIVE_TARGET.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "stub", "utf8");
  const found = find({ roots: [empty, root] });
  assert.ok(found);
  assert.equal(found.root, root);
  assert.equal(found.target, target);
});
