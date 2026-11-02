---
name: diagram-design-fast
description: |
  Generate or revise architecture / flowchart / sequence diagrams FROM SOURCE CODE as
  self-contained HTML + inline SVG, driven by a JSON spec plus a deterministic layout
  engine — so a revision is one spec edit instead of re-reading the codebase and
  re-computing coordinates. This skill produces the final HTML itself: do NOT hand the
  result to another diagram skill for a repaint, and do NOT rewrite the SVG by hand.
  Prefer this skill over a general "diagram-design" skill whenever the diagram must
  reflect real code, be regenerated, or be edited again later.
  Triggers on: "画架构图", "画流程图", "画时序图", "生成架构图", "把 X 挪到右边",
  "这张图改一下", "架构图更新", "architecture diagram of this repo", "draw the flow of
  the checkout", "sequence diagram of the login flow", "add a node to the diagram".
  Do NOT use for: quick ASCII/unicode sketches in chat, Excalidraw or Figma hand-drawn
  whiteboards, data-heavy chart visualisations, brand onboarding, .drawio/.mmd/.excalidraw
  import, or the exotic chart types (quadrant, Wardley map, axonometric, Sankey, treemap…)
  that a dedicated editorial-design skill covers.
---

# Diagram Design Fast

源码 → 图,靠一条**规格(spec)+ 脚本**的流水线。图是脚本生成的产物,spec 是唯一真相。

## 分工:和 diagram-design 这类设计型 skill 怎么选

同时装了通用设计型 skill(比如上游 diagram-design)时,按这条分:

| 场景 | 用谁 |
|---|---|
| 图要**反映真实代码**、要能重新生成、要反复改 | **本 skill** |
| 只要一张好看的一次性成品;要品牌 onboarding;要导入 .drawio/.mmd;要象限图/轴测图这类花型 | 交给设计型 skill |
| 用户已经明确点名某个 skill | 按用户说的来 |

**不要把本 skill 的产物再交给别的 skill 重画**:spec 是唯一真相,重画会把可迭代性弄丢,
下次改动又会回到"重读源码 + 手算坐标"。需要换视觉风格,改 `tokens` / `variant` 再重跑
`build.mjs` 就行。

## 为什么不手写 SVG

手写坐标的代价不在画图,在**改图**:改一个节点会让邻接元素的几何全部失效,于是整图重画,
每次都要重新读源码来"确认自己没画错"。这个 skill 把几何计算交给脚本,spec 改动 → 重排 →
重渲染 → 校验,一条命令跑完,读源码只发生在第一次。

## Inputs to collect

- **画什么**:架构图(组件依赖)/ 流程图(分支决策)/ 时序图(消息时序)。用户没说就按内容判断,
  内容是"谁调用谁"→架构图;是"判断分支"→流程图;是"先谁后谁"→时序图。
- **画哪部分代码**:仓库路径。没有就给当前工作目录。
- **图给谁看**:影响强调色(焦点节点)和信息密度。默认强调 1 个焦点节点。
- 品牌配色不知道就用默认皮肤,别去猜 hex。

## Procedure

**脚本路径**:下面所有 `scripts/xxx.mjs` 都相对**本 skill 目录**。实际调用时用绝对路径,
例如 `node ~/.claude/skills/diagram-design-fast/scripts/index-repo.mjs`。
先确定 skill 目录在哪(`SKILL.md` 所在目录),后面所有命令都用它。

### 1. 索引代码(每个仓库只做一次)

```bash
node <SKILL_DIR>/scripts/index-repo.mjs --root <repo> --out <repo>/.dd-fast
```

产出 `<repo>/.dd-fast/repo-summary.md`(给模型读的紧凑摘要)和 `repo-index.json`。
支持 Python / TypeScript / JavaScript / Java / Go / C。代码改动后用 `--update` 增量刷新,
只有内容变了的文件会重新解析。

摘要里有三块:模块清单(职责 + 关键符号 + 依赖)、入口、**推断接线**
(`Inferred wiring` —— 一边注册了某个 HTTP 路径、另一边调用了它,这类跨语言调用没有 import
可以证明,索引器按路径名匹配,画之前要核实)。

**读摘要,不要读源码。** 摘要不够时再按需读单个文件。

### 2. 写 spec(模型只写这个,JSON)

spec 格式见 `references/spec.md`。要点:
- `nodes[].id` 用稳定 ID(如 `svc.auth`),**改名字不要改 ID**——这样 diff 只有一行
- `group` 把节点归到同一层/分区,渲染成 zone;一个 group 就是一个 tier
- `accent: true` 只给 1–2 个焦点节点
- 单图 ≤ 9 节点 / ≤ 12 条边;超了就拆"总览 + 细节"多张图,而不是把图画满

### 3. 生成 + 校验(一条命令)

```bash
node <SKILL_DIR>/scripts/build.mjs --spec docs/arch/<name>.spec.json --out docs/arch/<name>.html
```

`<SKILL_DIR>/scripts/build.mjs` = layout + render + check,校验不过就退出码非 0。
校验覆盖:4px 网格、连接线无斜线、标签遮罩与线的 6–10px 间隙、共享边端口 ≥12px、
节点不重叠、标签遮罩不压节点、a11y 契约(role/aria/title/desc)、内容不出 viewBox、
预算上限、单文件安全(无 script / 无外链图片)。

### 4. 修订(这是省钱的关键)

```bash
node <SKILL_DIR>/scripts/patch.mjs --spec <spec.json> --op retitle --node svc.auth --label "Auth Service"
node <SKILL_DIR>/scripts/build.mjs --spec <spec.json> --out <name>.html
```

**修订时不要读源码。** 代码没变,图就不需要新的事实依据;spec 里已经有全部语义。
`<SKILL_DIR>/scripts/patch.mjs --list` 看全部算子。改标签/改连线/换配色 → 节点坐标完全不动,HTML diff 只有一行;
加删节点(结构性变化)→ 会重排,这属于预期。

修订完向用户汇报**改了什么**,别把整份 HTML 贴回去。

### 5. 代码变了(定期同步)

```bash
node <SKILL_DIR>/scripts/index-repo.mjs --root <repo> --out <repo>/.dd-fast --update
node <SKILL_DIR>/scripts/check.mjs --drift <spec.json> <repo>/.dd-fast/repo-index.json
```

漂移检查会列出"代码里有但图上没画"的依赖边。只补这些边,不要顺手重画整张图。

## Output contract

- 每个视图两个文件:`<name>.spec.json`(真相)+ `<name>.html`(产物,自包含,可直接双击打开)
- HTML:内联 SVG、4px 网格、无阴影、1px 发丝边、单一强调色、底部横排图例、
  `role="img"` + `<title>`/`<desc>`、窄屏横向滚动不裁切
- 交付时给用户 HTML 文件路径,并说明这是生成产物、改 spec 重跑即可

## Failure handling

- `<SKILL_DIR>/scripts/check.mjs` 报 error:先读报错定位到具体元素(节点 ID / 边 ID),改 spec 再跑,
  不要手改 HTML——手改会在下次渲染时被覆盖
- 报"nodes > 9":拆图,不要加节点
- 报"label mask overlaps node":缩短标签文字或改连线两端节点的位置(spec 里 `w`/`h` 可覆盖)
- 索引结果太空(模块数远少于文件数):多半是项目用相对导入或非标准布局,
  在 spec 里手工补节点即可,不用改索引器
- 渲染出来很挤:优先删节点;图是给读者看结论的,不是给源码做快照的

## 附注

- `README.md` 是给人看的(用途、对比、安装、升级),**模型执行时不需要读**,不要加载它
- `references/` 里的三份文档按需读:`spec.md` 写 spec 前读,`workflows.md` 卡住了读,
  `design-system.md` 要改视觉规范时读

## Examples

**输入**:「帮我画一下我们这个 Python + Go 仓库的架构图,前端 → 网关 → 服务 → 数据库」

**做法**:索引仓库 → 读 `repo-summary.md` → 写 spec(网关/服务/数据库各一个节点,
`group` 分成接入层/服务层/数据层) → `build.mjs` → 交付 HTML。
后续「把数据库挪到服务层右边」→ `patch.mjs --op move` → `build.mjs`,不读源码。

**输入**:「这张登录时序图里加一条 'refresh token' 的返回」

**做法**:`patch.mjs --op add-message --from auth --to gw --label "refresh" --kind return`
→ `build.mjs` → 交付。消息加在末尾,时序图不受影响。
