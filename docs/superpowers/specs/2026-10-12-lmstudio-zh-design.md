# LM Studio 简体中文补丁工具 — 设计文档

- 日期：2026-10-12
- 目标版本：LM Studio 0.4.21+2（Windows x64）
- 代码目录：`C:\Users\Rosary\lmstudio-zh\`
- 运行时状态目录：`C:\Users\Rosary\.lmstudio-zh\`

---

## 1. 目标与验收标准

用户当前已在 LM Studio 设置中选择 `zh_CN`，官方简体翻译也在运行，但界面中文**覆盖不全**，体验割裂。

本次要交付一个工具，验收标准：

| # | 标准 | 验证方式 |
|---|---|---|
| 1 | 每次 LM Studio 版本更新后，一条命令即可重新完成汉化 | 模拟换版本后重跑 `all`，老译文全部自动复用 |
| 2 | 补丁「百分百有效」——要么全部生效，要么完全不变 | 四道闸门全过才算成功，任一失败自动回滚 |
| 3 | 全量——A 层缺口 + B 层硬编码英文 | A 层补齐至 100%；B 层候选全部有译文或明确进入待审队列 |
| 4 | 防误伤——非目标字符串零改动 | 逐字节证明：补丁结果 == 原文件 + 计划重算 |
| 5 | Windows 与 Ubuntu 均可运行 | `discover` 覆盖各平台路径；启动器自带 Node 探测链 |

**明确不做**：不改动已有 1349 条官方译文（经人工维护，质量可信），只补缺失项。

---

## 2. 已验证的事实基线

以下均为对本机安装实测得出，非推测。

### 2.1 应用层只有一个接触面

| 文件 | 大小 | 结论 |
|---|---|---|
| `resources/app/.webpack/renderer/main_window.js` | 35.2 MB | **唯一补丁目标** |
| `resources/app/.webpack/main/index.js` | 22.8 MB | 无 UI 文本（全是 API 路由名 / schema key / 错误码 / 日志串） |
| `resources/app/.webpack/main/main_window_preload.js` | 0.7 MB | 同上 |
| `locales/*.pak`（Chromium） | 53 个语言 | **不碰**，跟随系统区域设置，格式不可安全修改 |

### 2.2 目标文件的两层结构

**A 层 — i18n 词条表**

导出各语言 `*Strings` 对象的那个模块（0.4.21+2 中 id 为 `72114`，**每次构建都会变**），
其结构为
`{sidebar: M1.default, chat: M2.default, config: M3.default, ...}`，共 10 个命名空间。
每个命名空间模块形如 `NNNNN:t=>{"use strict";t.exports=JSON.parse('{...}')}`。

| 命名空间 | EN key | zh 缺失 |
|---|---:|---:|
| sidebar | 7 | 0 |
| chat | 201 | 6 |
| config | 526 | 33 |
| discover | 26 | 0 |
| developer | 141 | 17 |
| download | 34 | 0 |
| settings | 183 | 16 |
| models | 111 | 15 |
| onboarding | 22 | 0 |
| shared | 186 | 1 |
| **合计** | **1437** | **88（6.1%）** |

另有 2 条形如 `{{tokensPerSecond}} token/s` 的漏译条目。

**B 层 — 硬编码英文**

bundle 内不属于任何语言模块的英文 UI 字面量，约 **2214 条唯一值 / 2658 处出现**。
高频示例：`Clear`、`Rename`、`Resume Download`、`Export as PDF (.pdf)`、`Clear chat`、
`Capabilities`、`Open in New Window`、`Date created`、`More options`、`Enabled`。

这层是「难受」的主要来源——它们没有 key，任何官方翻译流程都覆盖不到。

### 2.3 结构契约（非坐标契约）

**module id 每次构建都会变**。这正是社区汉化补丁（`C2H12O6/lm-studio-simplified-chinese`、
`iori7126/lmstudio-zh-cn-patch`、`Venshell/lmstudio-zh-cn`）在版本更新后失效的原因——
它们把字符串替换逻辑与具体位置/版本绑定。

本工具**只依赖结构**（`e.ChineseCNStrings=` 赋值关系 + `JSON.parse('...')` 模块形态），
每次运行重新发现，绝不硬编码 module id、字节偏移或版本号。

### 2.4 可行性已实测

- `vm.Script` 编译 35 MB 压缩 bundle：**333 ms，编译通过** → 可作为补丁后的语法级安全网
- 零依赖字面量扫描器：**297 ms，识别 382,068 个字面量**（379,383 字符串 + 2,685 模板串），
  每个带精确字节区间

---

## 3. 架构

纯 Node.js ESM，**零运行时依赖**（不引第三方 parser）。分发简单是「一键」的前提。

```
src/
  discover.mjs   跨平台定位安装目录与目标文件
  lex.mjs        零依赖 JS 字面量扫描器
  extract.mjs    拆 A 层 + 收集 B 层候选
  lexicon.mjs    双语词典读写与合并（核心持久资产）
  translate.mjs  调用本机 LM Studio API 批量补缺口
  patch.mjs      计划 → 应用 → 验证 → 还原（事务核心）
  cli.mjs        命令编排
```

依赖方向单向：`cli → {discover, extract, translate, patch} → {lex, lexicon}`。
`lex` 与 `lexicon` 是叶子，不依赖任何其他模块，可独立测试。

### 3.1 模块接口

```js
// discover.mjs
discover.find(opts?)              → { target, version, root, platform } | null
discover.candidatesFor(plat, env) → string[]
discover.RELATIVE_TARGET          → "resources/app/.webpack/renderer/main_window.js"

// lex.mjs
lex.scan(code)                    → Literal[]
lex.decode(raw)                   → string
lex.encode(value, quote)          → string     // 与原 quote 类型匹配的转义
  // Literal = { start, end, quote, raw, value, isKey, hasSubstitution }

// extract.mjs
extract.locateLanguageModule(code)          → { namespacesByLang } | null
extract.readCatalog(code, located, lang)    → { [ns]: { modId, span, data } }
extract.zhCatalog(code, located)            → 同上，zh_CN
extract.enCatalog(code, located)            → 同上，en
extract.allLanguageModules(code, located)   → Span[]      // 全部语言模块区间，用于排除
extract.candidates(code, located)           → Candidate[] // B 层候选
extract.missingFromA(code, located)         → MissingEntry[]
extract.isCandidate(text, isKey)            → boolean

// lexicon.mjs
lexicon.load(stateDir, toolDir)  → Lexicon
lexicon.loadLocal(stateDir)      → Lexicon
lexicon.lookup(lex, en)          → string | undefined
lexicon.upsert(lex, en, zh, origin) → void   // origin: "curated" | "model" | "user"
lexicon.saveLocal(lex, stateDir) → void
lexicon.stats(lex)               → { total, curated, model, user }

// translate.mjs
translate.buildBatches(items, maxChars)   → string[][]
translate.buildPrompt(items, fewShot)     → string
translate.parseReply(raw, items)          → { filled, rejected }
translate.fill(items, opts)               → Promise<{ filled, rejected }>
translate.listModels(baseUrl)             → Promise<string[]>

// patch.mjs
patch.planA(code, located, decisions) → Edit[]
patch.planB(code, located, decisions) → Edit[]
patch.planForDecisions(code, decisions) → Edit[]
patch.splice(code, edits)             → string
patch.validate(edit)                  → { ok, reason? }
patch.verify(original, patched, manifest) → { ok, gates }
patch.apply(target, original, patched, manifest, stateDir) → { ok, gates, applied, backup? }
patch.restore(target, stateDir)       → boolean
patch.provenance(code, stateDir)      → { state, manifest|null, hash }
patch.sha256(str)                     → string
  // Edit = { start, end, original, replacement, en, zh, origin }

// cli.mjs
cli.main(argv, io)                    → Promise<number>   // 退出码
cli.decideUntranslated(code, located, lex, lexLocal) → Decision[]
  // io = { log, err, confirm, stateDir, toolDir, argv }
```

---

## 4. 分发层

```
<TOOL>/  =  C:\Users\Rosary\lmstudio-zh\
  bin/lmstudio-zh.mjs
  src/*.mjs
  lexicon/zh-CN.json          人工词典，版本化，纳入 git
  launch/lmstudio-zh.cmd      Windows 启动器
  launch/lmstudio-zh.sh       Ubuntu 启动器

<STATE>/ =  C:\Users\Rosary\.lmstudio-zh\
  lexicon.local.json          本地模型产出的增量译文
  pending.json                待人工审阅队列
  manifests/<version>-<hash>.json
  backups/
  logs/
```

**两处关键取舍：**

1. **状态目录刻意不进 `~/.lmstudio/`** —— 那是 LM Studio 自己的配置目录，
   掺入文件有可能干扰其文件监听与配置同步。
2. **备份放状态目录，不放 `Program Files`** —— 打补丁与还原全程
   **不需要管理员权限**；应用目录中永远只存在一个被修改过的文件。

**Node 运行时探测链**：`系统 node` → `LM Studio 自带 node`（Windows:
`~/.lmstudio/.internal/utils/node.exe`；Linux: 从 AppImage 解包目录内取）
→ 都不可用时报错并给出安装指引。

---

## 5. 应用层与补丁面

### 5.1 A 层处理

1. **按结构定位**导出 `EnglishStrings` 与 `ChineseCNStrings` 的模块——
   即形如 `e.ChineseCNStrings=Lo;` 且同作用域内有 `Lo={sidebar:X.default,chat:Y.default,...}`
   的那个模块。当前 0.4.21+2 中它的 id 是 `72114`，但**该 id 每次构建都会变，不得硬编码**
2. 由上一步得到各命名空间对应的 module id（同样每次重新发现）
3. 对每个命名空间模块，提取 `JSON.parse('...')` 中的字面量 → `JSON.parse` → 得到词条表
4. 与英文词条表对比，找出 zh 缺失的 key
5. 译文填入后重新序列化，按原 quote 类型转义，**按原字节区间回写**
6. 保持 JSON 结构的嵌套形态不变

若结构定位失败（找不到导出 `ChineseCNStrings` 的模块），视为不兼容版本，
**直接报错退出且不做任何修改**——绝不猜。

### 5.2 B 层处理

在 bundle 中所有不属于任何语言模块的字符串字面量里筛选候选（见 §6 闸门 1），
经词典精确匹配后替换。

### 5.3 语言模块隔离

其他 37 种语言的模块中存在英文残留词（如西语里的 `"chat":"Chat"`）。
补丁**显式排除所有非 `zh_CN` 的语言模块字节区间**，既防误伤也不越界。

---

## 6. 防误伤机制（核心）

**不变式：补丁完成后，除被精确命中的字面量字节区间外，文件其余部分逐字节不变。**

### 闸门 1 — 候选过滤

38 万字面量筛至约 2000 候选，需同时满足：

- **自然语言**：含空格且有大写开头词，或命中短 UI 词白名单（`Clear` / `Rename` / `Save` …）
- 长度 2–500

拒绝规则优先级最高，命中即淘汰：

| 类别 | 示例 |
|---|---|
| URL | `https://…`、`ws://…`、`mailto:` |
| 文件路径 | `C:\…`、`/usr/…`、`./…` |
| 标识符 / 路由名 | `deleteFile`、`modelDownloadSourceSchema` |
| 全大写错误码 | `NOT_READY`、`func.def` |
| CSS / Tailwind 类名 | `text-foreground`、`overlay-1` |
| 十六进制 / base64 blob | — |
| JSON 片段、括号平衡串 | — |
| 非 zh_CN 语言模块区间内的一切字面量 | — |

### 模板串（反引号）策略

bundle 中有 2,685 个模板串。v1 的处理规则：

- 含 `${...}` 插值的模板串，**只有当译文的 `${...}` 表达式序列与原文完全一致时**才允许替换；
  不一致则跳过并记入待审队列
- 不含插值的模板串，按普通字符串处理

宁可漏翻，不可错翻。

### 闸门 2 — 词典精确匹配

**只有完整落在词典中的英文原文才会被替换。词典即白名单。**

这条规则本身消灭了绝大部分误伤可能：`Cannot access window outside of the DOM`
不在词典中，永远不会被触碰。

### 闸门 3 — 补丁前校验

| 检查 | 说明 |
|---|---|
| 占位符完整性 | 译文须含与原文**完全相同的** `{{var}}` 集合，否则硬拒绝（少一个 `{{count}}` 会渲染出花括号或崩溃） |
| 长度合理性 | 译文长度须落在原文的 0.2×–5× 区间外（挡模型截断与胡言乱语） |
| 键值判定 | 只翻**值**，绝不翻对象**键**；依据字面量前一个非空白字符是否为 `:` |
| 编码正确性 | 按原 quote 类型正确转义 |

### 闸门 4 — 补丁后验证

四项全过才算成功，任一失败自动从备份回滚：

1. `vm.Script(patched)` **编译通过**（实测 333 ms）——语法坏了会白屏
2. 重新扫描补丁后文件，字面量集合 == 预期集合
3. **由原文件 + manifest 重新推导出补丁结果，与实际文件逐字节相等** ← 不变式被证明的那一步
4. 文件大小变化符合预期

---

## 7. 词典设计（版本无关的关键）

**词典以英文原文为 key。**

```json
{
  "version": 3,
  "entries": {
    "Clear":                       { "zh": "清除", "origin": "curated" },
    "Reasoning Budget":            { "zh": "推理预算", "origin": "curated" },
    "{{percentage}}% draft tokens accepted": {
      "zh": "已接受 {{percentage}}% 草稿 token", "origin": "curated"
    }
  }
}
```

版本无关性正源于此：**从不记录位置，只记录「这句英文该显示什么中文」**。

```
LM Studio 升级
  ↓  版本号变、module id 变、字节全变
discover  找到新的 main_window.js
  ↓
extract   重新枚举当前版本的字符串全集
  ↓
lexicon   英文原文作 key  ├─ 命中 → 沿用已有译文   ← 旧版本成果自动复用
                       └─ 未命中 → 进 translate 队列
  ↓
patch     只替换命中项
```

升级后跑一次，1000 条老译文一条不丢，只需翻译新增的几十条。

**来源优先级**：`zh-CN.json`（人工词典，committed） > `lexicon.local.json`（本地模型产出，
可被人工覆盖） > 现有官方译文（只读，永不改写）。

---

## 8. 本地模型翻译

- 端点：本机 LM Studio `http://127.0.0.1:1234/v1/chat/completions`
- 模型：用户已安装的本地模型（`~/.lmstudio/hub/models` 下已有 qwen / zai 系列）
- 批量策略：按 token 预算分组，每批结果**立即落盘**到 `lexicon.local.json`，中断可续跑
- 提示词要素：
  - 目标英文串 + 少量上下文（所属命名空间）
  - **官方已有的 1349 条译文作为 few-shot 示例**，保证术语与既有风格一致
  - 术语表约束（token / context / KV cache / runtime 等固定译法）
  - 强制保留全部 `{{var}}` 占位符
- 输出校验：JSON 数组解析、占位符集合比对、长度区间、去重
- 产出进入 `pending.json` 待审队列，用户确认后回写词典

---

## 9. 幂等与「更新后一键」

manifest 记录源文件 SHA-256。重跑时按当前哈希判断：

| 当前哈希 | 判断 | 动作 |
|---|---|---|
| == 已打补丁的哈希 | 已是最新 | 报告并退出 |
| == manifest 中的原始哈希 | 干净 | 正常应用 |
| 两者都不是 | 用户或更新动过 | **从零重新推导**——安全，因词典按英文原文匹配，与位置无关 |

**首次运行**（不存在任何 manifest）：一律按「原始、未打补丁」处理，生成新 manifest。
若发现目标文件已含中文译文但无对应 manifest，说明是历史补丁或手动改动——
此时不信任现有内容，按 §5 从零重新枚举并重新应用。

---

## 10. CLI

```
lmstudio-zh doctor      检测安装、版本、当前状态、Node 环境
lmstudio-zh scan        列出未翻译候选（支持 --json 导出）
lmstudio-zh translate   用本机模型补缺口 → 待审队列
lmstudio-zh apply       生成计划 → 展示 diff → 确认后打补丁
lmstudio-zh verify      重跑四道闸门
lmstudio-zh restore     一键还原
lmstudio-zh all         doctor → scan → translate → apply 一条龙
```

**`apply` 的行为约定：**
- 默认先打印将要改动的内容供确认，不静默改文件
- `--yes` 跳过确认
- 运行前检查 LM Studio 进程；**进程在运行则直接拒绝**（改动会造成内存与磁盘不一致）
- 写临时文件 → 验证 → 原子 rename，避免中途失败留下半成品

---

## 11. 跨平台发现

| 平台 | 探测路径 |
|---|---|
| Windows | `%LOCALAPPDATA%\Programs\LM Studio`、`%PROGRAMFILES%\LM Studio`、`%PROGRAMFILES(X86)%\LM Studio` |
| Linux (.deb) | `/opt/LM Studio`、`/opt/lm-studio`、`/usr/lib/lm-studio` |
| Linux (AppImage) | 需 `--appimage-extract` 后对解包目录操作；回写需 `squashfs-tools`（`unsquashfs` + `mksquashfs` + 重新封装），列为已知外部依赖 |
| Linux (Flatpak) | `/var/lib/flatpak/app/…` |
| Linux (Snap) | `/snap/lm-studio/current` |
| 任意 | `--path` 手动指定根目录 |

各路径下统一以 `resources/app/.webpack/renderer/main_window.js` 为落地目标。

---

## 12. 范围之外

- Chromium `locales/*.pak`（文件对话框、右键菜单等）——跟随系统区域设置，不可安全修改
- 官方已有的 1349 条译文——经人工维护，本次不改写
- 主进程与 preload bundle——已验证无 UI 文本
- 向 `lmstudio-ai/localization` 提交 PR——上游 issue #222（2025-04 提出）至今 0 回复，
  合并周期不可控；本工具为本地即时方案，两者不冲突

---

## 13. 待定事项

1. 是否为工具目录初始化 git 仓库（词典需要版本管理，但未获明确授权前不自动提交）
2. AppImage 回写流程的具体封装方式（依赖 `squashfs-tools`）
3. 本地模型的具体型号选择与提示词调优（首次实现时实测确定）