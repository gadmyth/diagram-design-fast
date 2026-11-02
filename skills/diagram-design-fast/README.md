# diagram-design-fast

从源码生成**架构图 / 流程图 / 时序图**,输出自包含的 HTML + 内联 SVG。

核心区别:**坐标由脚本算,不由模型算。** 图的语义存在一份 JSON spec 里,改图 = 改 spec + 重跑一条命令,
不重读代码、不手调坐标。

> 这份 README 是给人看的。模型执行时只需要读 `SKILL.md`,不用读这里。

---

## 它解决什么

用通用方式画源码架构图,改一次图的成本极高:

| 环节 | 通用做法(手写 SVG) | 本 skill |
|---|---|---|
| 读代码 | 每次生成、每次修改都重读一遍 | 索引一次,之后只读摘要 |
| 定坐标 | 模型心算,几十个 x/y | 布局引擎算,4px 网格、正交肘弯 |
| 改一个标签 | 邻接元素几何全部失效,整图重画 | 坐标完全不动,HTML diff 一行 |
| 出错 | 靠肉眼 | 校验器秒级查:斜线、遮罩压节点、端口重叠、a11y |

改标题实测:**HTML diff 1 行,节点坐标零位移,零源码读取。**

---

## 30 秒上手

```bash
S=<skill目录>/scripts

# 1. 索引仓库(每个仓库只做一次)
node $S/index-repo.mjs --root . --out .dd-fast
cat .dd-fast/repo-summary.md        # ← 模型读这个,不读源码

# 2. 写 spec(docs/arch/xxx.spec.json,格式见 references/spec.md)

# 3. 出图 + 校验(一条命令)
node $S/build.mjs --spec docs/arch/xxx.spec.json --out docs/arch/xxx.html
```

改图:

```bash
node $S/patch.mjs --spec docs/arch/xxx.spec.json --op retitle --node svc.auth --label "Auth Service"
node $S/build.mjs --spec docs/arch/xxx.spec.json --out docs/arch/xxx.html
```

代码变了:

```bash
node $S/index-repo.mjs --root . --out .dd-fast --update          # 只重解析变更文件
node $S/check.mjs --drift docs/arch/xxx.spec.json .dd-fast/repo-index.json
```

---

## 和 diagram-design 比

[diagram-design](https://github.com/cathrynlavery/diagram-design)(MIT)是上游的开源 skill,做的是同一件事:
输出自包含 HTML + SVG。两者的关系:

| | diagram-design | diagram-design-fast |
|---|---|---|
| 几何计算 | **模型手算坐标**(靠 6 条连接线规则自律) | **脚本布局引擎** |
| 改图 | 没有修订流程,只能整张重画 | spec 补丁,坐标不动 |
| 理解源码 | 每次现读 | 仓库索引 + 摘要复用 |
| 图形类型 | 40+ 种(象限图、轴测图、Sankey、飞轮…) | 3 种(架构图 / 流程图 / 时序图) |
| 品牌 onboarding | 有(读网站提取色板) | 有(令牌可手改,`set-token`) |
| 导入 draw.io / Mermaid / Excalidraw | 有 | 无 |
| 导出 PNG / SVG | 有(需要 Playwright) | 无 |
| 校验 | 自带 Python 校验器 | 自带零依赖 Node 校验器 |

**视觉规范完全对齐上游现行默认**(jet-black / white-smoke / burnt-tangerine 令牌命名与色板、
4px 网格、发丝边框、零阴影、强调色 ≤2、9 节点 / 12 连线预算、a11y 契约),
所以两个 skill 的产出并排放是同一套视觉语言。

**怎么选**:

- 要反映真实代码、要反复改 → **本 skill**
- 要一次性成品、要品牌 onboarding、要导入类图形、要花型图表 → **diagram-design**

两者可共存。详见 `references/design-system.md`。

---

## 工作原理

```
源码 ──index-repo.mjs──> .dd-fast/repo-summary.md   代码摘要(模型读这个)
                                    │
                             spec.json                 语义真相(节点/边/分组)
                                    │
                      layout.mjs → render.mjs → check.mjs
                                    │
                              xxx.html                 产物(自包含,可直接打开)
```

- **索引器**支持 Python / TypeScript / JavaScript / Java / Go / C,提取模块、职责、入口、
  内部依赖,并按 HTTP 路径名**推断跨语言接线**(Go 网关 → Python 服务这类没有 import 可循的关系)
- **布局引擎**做分层排序、group 分层、端口扇开(L*k/(N+1))、正交肘弯(r=8)、
  标签落位搜索(避让节点/连线/互不重叠),节点集合不变时**复用上一版坐标**
- **校验器**零依赖,秒级检查 4px 网格、连接线无斜线、标签遮罩与线的 6–10px 间隙、
  共享边端口 ≥12px、节点与遮罩不重叠、内容不出 viewBox、a11y 契约、预算上限、单文件安全

---

## 安装

需要 **Node.js ≥ 18**,零 npm 依赖。

### 方式一:直接解压(最简单)

```bash
unzip diagram-design-fast.zip -d ~/.trae-cn/skills/    # Trae CN
unzip diagram-design-fast.zip -d ~/.claude/skills/      # Claude Code
```

Windows:

```powershell
Expand-Archive .\diagram-design-fast.zip -DestinationPath "$env:USERPROFILE\.trae-cn\skills" -Force
```

### 方式二:skills CLI(从 GitHub 装,能一键升级)

```bash
npx skills add <user>/<repo> --skill diagram-design-fast --agent trae-cn -g -y
```

> `--agent trae-cn` 会装到 `~/.trae-cn/skills/`(Trae CN 全局)。
> 注意默认值是 `claude-code`(→ `~/.claude/skills/`),**Trae CN 读不到那个目录**。
> skills CLI 要求 Node ≥ 22.20。

### 方式三:软链(单一真相源,改 GitHub 立刻生效)

```bash
git clone https://github.com/<user>/<repo>.git ~/code/agent-skills
mkdir -p ~/.trae-cn/skills
ln -s ~/code/agent-skills/skills/diagram-design-fast ~/.trae-cn/skills/diagram-design-fast
```

Windows 用目录联接:

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.trae-cn\skills\diagram-design-fast" `
  -Target "$env:USERPROFILE\code\agent-skills\skills\diagram-design-fast"
```

### 各主机的 skill 发现目录

| 主机 | 全局 | 项目级 |
|---|---|---|
| Trae CN | `~/.trae-cn/skills/` | `.trae/skills/` |
| Trae | `~/.trae/skills/` | `.trae/skills/` |
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Codex / Cursor / Cline / Copilot / Kiro / OpenCode | `~/.agents/skills/`、`~/.cursor/skills/`、`~/.cline/skills/`、`~/.copilot/skills/`、`~/.kiro/skills/`、`~/.config/opencode/skills/` | `.agents/skills/`、`.cursor/skills/` 等 |

只建你实际用的那几处。某主机同时扫原生目录和 `.agents/skills/` 时,选一个,别重复安装。

---

## 升级

| 装法 | 升级方式 |
|---|---|
| skills CLI(GitHub 源) | `npx skills update diagram-design-fast` |
| 软链 | `git pull` 即可 |
| 手动解压 | 重新解压覆盖(建议先删旧目录,避免残留文件) |

覆盖脚本(仓库里的 `install-diagram-design-fast.sh` / `.ps1`)会自动:**备份旧版 → 整目录替换 → 版本自检**。

自检输出长这样:

```
✓ 版本: 含最新路由规则
✓ 色板: 已对齐上游现行默认
文件数: 11
```

装完**重启 Trae**(或重开项目),让它重新扫描 skill 描述。

---

## 目录约定

```
<repo>/
├── docs/arch/
│   ├── order-arch.spec.json    # 真相:改它,别改 html
│   └── order-arch.html         # 产物:脚本生成
└── .dd-fast/
    ├── repo-summary.md         # 代码摘要
    └── repo-index.json         # 索引全量
```

`.dd-fast/` 建议加进 `.gitignore`;`docs/arch/*.html` 建议提交(便于评审和 PR diff)。

---

## 命令速查

```bash
node <skill>/scripts/index-repo.mjs --root . --out .dd-fast [--update]
node <skill>/scripts/build.mjs     --spec x.spec.json --out x.html [--reflow]
node <skill>/scripts/patch.mjs     --spec x.spec.json --op <算子> [参数] [--dry-run]
node <skill>/scripts/check.mjs     x.html
node <skill>/scripts/check.mjs     --drift x.spec.json .dd-fast/repo-index.json
node <skill>/scripts/patch.mjs     --list          # 全部算子
```

常用算子:`retitle` / `setsub` / `move`(换层) / `accent` / `add-node` / `remove-node` /
`add-edge` / `remove-edge` / `set-edge-label` / `set-token`(换配色)/ `set-variant` /
`add-message`(时序图)/ `add-group`。

---

## 已知限制

- 只支持 **架构图 / 流程图 / 时序图** 三种视图,不支持象限图、轴测图这类花型(那些交给 diagram-design)
- 索引器是**正则启发式**,不是真前端;非标准目录结构、动态注册、依赖注入会漏
- 跨语言接线按路径名匹配,**会有误报**,摘要里标了 "Inferred wiring",画之前核实
- 没有 PNG / SVG 导出(上游有,需要 Playwright)
- 单图 ≤ 9 节点 / 12 连线,超了要拆"总览 + 细节"多张图

---

## License

MIT。视觉规范(语义令牌、默认色板、4px 网格、连接线规则、复杂度预算、a11y 契约)
沿用上游 [diagram-design](https://github.com/cathrynlavery/diagram-design)(MIT,Cathryn Lavery);
**未包含其任何代码** —— 本仓库的布局引擎、渲染器、校验器、索引器均为独立实现。
