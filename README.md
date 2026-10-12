# lmstudio-zh

LM Studio 简体中文补丁工具。补齐官方词条表缺口（A 层），并汉化界面中硬编码的英文串（B 层）。

## 特性

- **版本无关**：词典以英文原文为 key，不记录任何字节偏移或 module id。LM Studio 升级后跑一次 `apply`，旧译文全部自动复用。
- **可证明安全**：四道闸门保证「除被精确命中的字面量字节外，文件其余部分逐字节不变」——补丁结果由原文件 + 计划重算并逐字节比对，任一闸门失败自动回滚。
- **可还原**：每次打补丁前自动备份，`restore` 一键回到原版。
- **零依赖**：纯 Node.js 内置模块，只需 Node.js 18+，无需 `npm install`。

## 用法

```bash
lmstudio-zh doctor      # 检测安装、版本、补丁状态、词典统计
lmstudio-zh scan        # 列出 A 层缺口与 B 层候选（--json 导出机器可读格式）
lmstudio-zh translate --model=<模型id>   # 用本机模型批量补齐缺口
lmstudio-zh apply       # 打补丁（先打印改动预览，确认后执行）
lmstudio-zh verify      # 从备份 + manifest 重跑四道闸门
lmstudio-zh restore     # 还原为原版
lmstudio-zh all         # doctor → scan → translate → apply 一条龙
```

不安装直接运行：`node bin/lmstudio-zh.mjs <命令>`。

### Windows

```bat
launch\lmstudio-zh.cmd doctor
```

### Linux (Ubuntu)

```bash
chmod +x launch/lmstudio-zh.sh
./launch/lmstudio-zh.sh doctor
```

启动器的 Node 探测链：系统 `node` → LM Studio 自带的 Node
（Windows: `~/.lmstudio/.internal/utils/node.exe`；Linux: `.deb` 安装与 AppImage 解包目录内）。
都找不到时报错并给出安装指引。

### Linux 支持现状（诚实说明）

| 项目 | 状态 |
|---|---|
| 安装发现 | 代码覆盖 `.deb`（`/opt`、`/usr/lib`、`/usr/share`、snap、flatpak、AppImage 解包目录、`~/.local/share`），flatpak 分支用注入 fs 单测覆盖；**未在真实 Linux 机器上实测过路径命中** |
| 补丁核心 | 平台无关（纯 fs 操作 + POSIX 路径拼接），Windows 上对 34.5MB 真实 bundle 完整验证 |
| 启动器 `.sh` | 已逐行复查（POSIX、`exec` 直传退出码、可执行位已入 git）；**未实机运行** |
| 进程检测 | Windows 用 `tasklist`；Linux 用 `pgrep -f`（退出码语义）——后者未实机验证 |
| 权限 | 装在 `/opt` 等受保护目录需要 `sudo`；工具会预检并提示（与 Windows 的 Program Files 同机制） |
| AppImage | 定位解包目录可行；**重新封包（unsquashfs → mksquashfs）未实现**，属设计文档 §13 的待定项 |

首次在 Ubuntu 上使用时，建议先 `./launch/lmstudio-zh.sh doctor` 确认安装被发现、
版本正确，再继续 `scan` / `apply`。

### 常用参数

| 参数 | 说明 |
|---|---|
| `--path <目录>` | 手动指定 LM Studio 安装**根目录**（含 `resources/app/...` 的那层） |
| `--yes` | 跳过确认（用于非交互环境） |
| `--force` | 对「既非原版也非本工具补丁」的文件强制重新推导 |
| `--model=<id>` | `translate` 指定本机模型（`doctor` 不列模型，先跑 `lmstudio-zh translate` 看报错里的可用列表） |
| `--json` | `scan` 输出 JSON（`aLayerGaps` / `bLayerCandidates` / `untranslated`） |

## 工作原理

LM Studio 的界面文本分两层：

1. **A 层 — 官方 i18n 词条表。** 打包为 webpack 模块 `t.exports=JSON.parse('...')`，
   由导出 `ChineseCNStrings` 的模块按命名空间聚合（0.4.21+2 中 10 个命名空间、
   1437 个英文 key，其中 88 个没有中文译文）。本工具在 zh_CN 词条表内补齐缺失 key。
2. **B 层 — 硬编码英文。** 直接写在 bundle 里的英文字面量，没有 key，官方翻译流程
   覆盖不到。0.4.21+2 实测 12,492 处出现 / 7,848 个唯一值（其中多数是 React 等库的
   内部消息，对补丁无害——只有精确命中词典的串才会被替换）。

本工具按**结构**定位（搜索 `e.ChineseCNStrings=` 赋值关系），不硬编码任何 module id
或字节偏移，因此版本更新后依然可用。工作流程：

```
discover   定位安装与目标文件（跨平台路径表）
extract    重新枚举当前版本的字符串全集，找出 A 层缺口与 B 层候选
lexicon    英文原文作 key 查词典：命中 → 沿用；未命中 → 进 translate 队列
translate  调用本机 LM Studio API 批量翻译，每批立即落盘（可中断续跑）
patch      生成字节编辑计划 → 四道闸门验证 → 临时文件 → 原子 rename
```

## 目录

| 位置 | 内容 |
|---|---|
| 工具目录（本仓库） | 代码、测试、人工词典 `lexicon/zh-CN.json`（可 git 版本化） |
| `~/.lmstudio-zh/` | 运行时状态：`lexicon.local.json`（模型译文）、`pending.json`（待审队列）、`manifests/`、`backups/`、`logs/` |

状态目录刻意不放 `~/.lmstudio/`——那是 LM Studio 自己的配置目录。

## 限制

- Chromium 原生字符串（文件对话框、右键菜单）由 `locales/*.pak` 控制，跟随操作系统语言，本工具不修改。
- LM Studio 自动更新后需要重新运行一次 `lmstudio-zh apply`（词典自动复用，只需处理新增条目）。
- 打补丁前必须**完全退出** LM Studio（含托盘图标）——运行中改文件会造成内存与磁盘不一致，工具会检测并拒绝。
- **安装在 `C:\Program Files` 等受保护目录时，需要以管理员身份运行**（右键启动器 → 以管理员身份运行）。
  每用户安装（`%LOCALAPPDATA%\Programs`）不需要。工具会在计划前预检写入权限并给出提示。
- B 层候选里的库内部英文（表单校验消息等）默认不翻译；它们不在词典中，永远不会被触碰。

## 免责声明

本工具与 LM Studio 官方无关。修改应用文件可能导致更新失败或功能异常，
请务必使用 `restore` 保留回退能力，并在打补丁前确认备份已生成。
