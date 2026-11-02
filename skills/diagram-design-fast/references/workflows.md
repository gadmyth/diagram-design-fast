# 工作流手册

## 目录约定

```
<repo>/docs/arch/
  order-arch.spec.json     # 真相
  order-arch.html          # 产物(可提交,便于评审)
  login-seq.spec.json
  login-seq.html
<repo>/.dd-fast/
  repo-summary.md          # 索引摘要(模型读这个)
  repo-index.json          # 索引全量(机器读)
```

## 首次生成:完整链路

```bash
S=.skills/diagram-design-fast/scripts

# 1. 索引(每个仓库一次)
node $S/index-repo.mjs --root . --out .dd-fast

# 2. 读摘要 → 写 spec(这一步由模型完成)
cat .dd-fast/repo-summary.md
#    重点看三段:Modules / Entry points / Inferred wiring
#    Inferred wiring 是按 HTTP 路径名匹配出来的跨语言调用(Go 网关 → Python 服务这类),
#    没有 import 可以证明,画之前核实一下

# 3. 生成 + 校验
node $S/build.mjs --spec docs/arch/order-arch.spec.json --out docs/arch/order-arch.html
```

写 spec 时的顺序建议:

1. 先只写 `nodes`(id / label / kind / group),确定这张图讲什么
2. 再写 `edges`,一条真实依赖写一条;跨服务的调用用 `http`,内部调用用 `sync`
3. 最后挑 1 个焦点节点加 `accent: true`
4. 节点超 9 个 → 拆成多张图,不要压缩

## 修订:不读源码

```bash
S=.skills/diagram-design-fast/scripts
node $S/patch.mjs --spec docs/arch/order-arch.spec.json --op retitle --node svc.auth --label "Auth Service"
node $S/build.mjs --spec docs/arch/order-arch.spec.json --out docs/arch/order-arch.html
git diff --stat docs/arch/order-arch.html   # 通常只有一两行
```

### 全部算子

| 算子 | 参数 | 用途 |
|---|---|---|
| `set-title` / `set-desc` / `set-eyebrow` | `--text` | 改标题类文案 |
| `set-variant` | `--variant` | 换皮肤(`minimal-dark` 等) |
| `set-token` | `--name --value` | 换单个颜色令牌 |
| `set-view` | `--view` | 换视图类型 |
| `set-dir` | `--dir TB\|LR` | 换方向 |
| `retitle` | `--node --label` | 改节点名 |
| `setsub` | `--node --text` | 改节点副标签 |
| `setkind` | `--node --kind` | 改节点类型 |
| `accent` | `--node --on/--off` | 焦点节点开关 |
| `move` | `--node --group` | 换层/分区(`none` 移出分组) |
| `add-node` | `--id --label [--sub --kind --group --accent]` | 加节点 |
| `remove-node` | `--node` | 删节点(连带删它的边) |
| `add-edge` | `--from --to [--label --kind --id]` | 加连线 |
| `remove-edge` | `--edge` | 删连线 |
| `set-edge-label` | `--edge --label` | 改连线标签 |
| `set-edge-kind` | `--edge --kind` | 改连线类型 |
| `add-group` / `remove-group` | `--id [--label]` | 分区增删 |
| `add-message` / `remove-message` | `--from --to [--label --kind]` / `--id` | 时序图消息 |
| `add-note` | `--id --text --at` | 备注(暂不入图,留作备忘) |

`--dry-run` 只打印改动不写盘。

### 增量行为

- 改 label / sub / 连线 / 颜色 → **坐标完全不动**,HTML diff 只有一行
- 加删节点 → 整体重排(预期行为,会动到坐标)
- 强制重排:`node $S/layout.mjs --spec <spec.json> --reflow`

## 代码变更同步

```bash
S=.skills/diagram-design-fast/scripts
node $S/index-repo.mjs --root . --out .dd-fast --update
node $S/check.mjs --drift docs/arch/order-arch.spec.json .dd-fast/repo-index.json
```

输出形如:

```
info: code dependency not drawn: app.core.auth -> app.core.models
warn: diagram edge not backed by code: gw -> redis
```

- `info` = 代码里新出现的依赖,考虑补一条边
- `warn` = 图上有、代码里找不到的边,可能是过时的图或索引没覆盖到,去核实

补边用 `patch.mjs --op add-edge`,**不要**因为一条新边就重画整张图。

## 和 diagram-design 上游并用

上游(`cathrynlavery/diagram-design`)适合"一次性出刊的漂亮图":
品牌 onboarding、13+ 种图形、纯手绘排版。

本 skill 适合"从源码出发、要反复改的图":坐标由脚本算,改图不重读代码。

建议分工:

- 图要进博客/对外发布 → 用上游跑一遍最终稿(它支持 `/diagram-design:import-mermaid` 之类的转绘)
- 图是内部文档、要跟着代码演进 → 用本 skill

上游的 HTML 也能被 `check.mjs` 检(只查 HTML 里的几何,不查 spec)。

## 故障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `nodes N exceeds the 9-node budget` | 图太大 | 拆成总览 + 细节两张 |
| `label mask overlaps node` | 标签太长或连线太挤 | 缩短 label,或把两端节点分开(换 group / 改 dir) |
| `connectors share edge with only Xpx` | 同一节点引出太多线 | 中间加一个节点当汇聚点 |
| `connector has a diagonal segment` | 手改了 HTML | 改 spec 重跑,别手改 |
| 索引里模块太少 | 项目用相对/深层导入 | spec 手工补节点,不用改索引器 |
| 渲染出来留白很大 | 节点少 | 正常;补节点或缩窄画布 |
