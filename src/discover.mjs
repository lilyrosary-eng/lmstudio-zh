import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, dirname } from "node:path";
import { homedir, platform } from "node:os";

export const RELATIVE_TARGET = "resources/app/.webpack/renderer/main_window.js";

// 候选安装根目录。fs 可注入：flatpak 分支要读 /var/lib/flatpak/app，
// 测试用假 fs 验证，不必依赖真实 Linux 环境。
export function candidatesFor(plat, env = process.env, fs = { existsSync, readdirSync }) {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (plat === "win32") {
    return [
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs", "LM Studio") : null,
      env.PROGRAMFILES ? join(env.PROGRAMFILES, "LM Studio") : null,
      "C:\\Program Files\\LM Studio",
      "C:\\Program Files (x86)\\LM Studio",
    ].filter(Boolean);
  }
  if (plat === "darwin") return ["/Applications/LM Studio.app/Contents/Resources"];
  // linux / bsd。构造的路径按定义是 POSIX 路径——即使用 Windows 开发机跑
  // 测试（plat 传 "linux"），也必须拼成斜杠形式，故用 posix.join 而非 join。
  return [
    "/opt/LM Studio",
    "/opt/lm-studio",
    "/usr/lib/lm-studio",
    "/usr/share/lm-studio",
    "/snap/lm-studio/current",
    posix.join(home, ".local/share/lm-studio"),
    posix.join(home, "AppImage/lm-studio"),
    ...flatpakRoots(fs),
  ].filter(Boolean);
}

// Flatpak 的安装 id 未知时，扫描 /var/lib/flatpak/app 下含 lmstudio 的条目
function flatpakRoots(fs) {
  const base = "/var/lib/flatpak/app";
  if (!fs.existsSync(base)) return [];
  try {
    return fs.readdirSync(base)
      .filter((n) => /lmstudio/i.test(n))
      .map((n) => posix.join(base, n));
  } catch { return []; }
}

// 两种布局都以此结尾：<root>/resources/app/.webpack/renderer/main_window.js
// 与 AppImage 解包后的 <root>/lib/resources/app/.webpack/renderer/main_window.js。
// package.json 在从目标文件往上两层的 app 目录里——相对于 target 推导，
// 两种布局都能读到（brief 原稿固定在 <root>/resources/app/package.json，
// lib 布局下会漏读版本）。
const pkgPathFor = (target) => join(dirname(target), "..", "..", "package.json");

function readVersion(target) {
  const pkg = pkgPathFor(target);
  if (!existsSync(pkg)) return null;
  try { return JSON.parse(readFileSync(pkg, "utf8")).version ?? null; } catch { return null; }
}

export function find({ roots } = {}) {
  const list = roots ?? candidatesFor(platform());
  for (const root of list) {
    const candidates = [
      join(root, ...RELATIVE_TARGET.split("/")),
      join(root, "lib", ...RELATIVE_TARGET.split("/")),
    ];
    for (const target of candidates) {
      if (!existsSync(target)) continue;
      return { target, version: readVersion(target), root, platform: platform() };
    }
  }
  return null;
}
