# Spec 格式

一个 spec 文件 = 一张图。`build.mjs` 读它、渲染它、校验它。字段之外的键会被忽略。

## 骨架

```json
{
  "view": "architecture",
  "slug": "platform-architecture",
  "eyebrow": "ARCHITECTURE",
  "title": "订单平台架构",
  "desc": "一句话说明这张图讲什么",
  "variant": "minimal-light",
  "dir": "TB",
  "nodes": [],
  "edges": [],
  "groups": [],
  "messages": [],
  "fragments": [],
  "notes": [],
  "tokens": {}
}
```

| 字段 | 说明 |
|---|---|
| `view` | `architecture` / `flow` / `sequence`,决定用哪套布局 |
| `slug` | 文件名(小写短横线),用于 SVG 的 a11y id 前缀 |
| `eyebrow` | 标题上方的小标签,默认 `ARCHITECTURE` |
| `title` / `desc` | 标题与说明;`desc` 空则不渲染副标题 |
| `variant` | `minimal-light`(默认)/ `minimal-dark` / `full-editorial` |
| `dir` | 架构图/流程图方向:`TB`(默认,自上而下)或 `LR` |
| `font_source` | `system`(默认,零网络请求)或 `google` |
| `tokens` | 覆盖皮肤令牌,如 `{"accent": "#2F6FEB"}` |
| `cards` | 可选,`full-editorial` 的摘要卡片:`[{eyebrow,title,items[]}]` |

## 节点

```json
{ "id": "svc.auth", "label": "Auth Service", "sub": "Python / JWT",
  "kind": "service", "group": "svc", "accent": false }
```

- `id` **必填、稳定**。改显示名改 `label`,别动 `id`——id 变了,增量布局就失效了。
- `label`:人读的节点名(无衬线字体)
- `sub`:技术副标签(等宽字体),如端口、协议、语言
- `kind`:见下表,决定外形和角标
- `group`:分区/层 ID,对应 `groups` 里的一项
- `accent`:`true` = 焦点节点(强调色)。**整图最多 2 个**
- `w` / `h`:可选,覆盖默认尺寸(必须整除 4)

### kind

| kind | 外形 | 角标 | 典型用途 |
|---|---|---|---|
| `service` | 圆角框 | SVC | 后端服务 |
| `client` | 圆角框 | UI | 前端/客户端 |
| `api` | 圆角框 | API | API 层 |
| `worker` | 圆角框 | WRK | 消费者/任务 |
| `db` | 圆角框 | DB | 数据库/存储 |
| `cache` | 圆角框 | CACHE | 缓存 |
| `queue` | 圆角框 | MQ | 消息队列 |
| `external` | 虚线框 | EXT | 外部系统 |
| `actor` | 圆角框 | ACT | 角色/人 |
| `participant` | 圆角框 | — | 时序图参与者 |
| `step` | 圆角框 | — | 流程步骤 |
| `start` / `end` | 圆角框 | START/END | 流程起止 |
| `decision` | 菱形 | — | 判断分支 |

## 边

```json
{ "id": "e1", "from": "gw", "to": "svc.auth", "label": "POST /login", "kind": "http" }
```

| kind | 画法 | 含义 |
|---|---|---|
| `sync` | 实线,muted | 普通调用 |
| `http` | 实线,link 蓝 | HTTP/API 调用 |
| `async` | 虚线 `5,4` | 异步/消息 |
| `optional` | 虚线 `4,3` | 可选/被动 |
| `return` | 虚线 `4,3` | 返回/回写 |
| `write` | 实线,accent | 写路径(主线) |
| `event` | 虚线 `5,4` | 事件 |

`label` 会被转成大写、截断到 14 字符,并自动加不透明遮罩。同一节点多条边会自动分散端口。

## 分区 / 层

```json
"groups": [{ "id": "svc", "label": "服务层" }]
```

`group` 既是**层**也是**分区**:同一个 group 的节点会被放到同一层(架构图/流程图),
外面套一个 zone 矩形 + 层级角标。最多 3 个 group。

## 时序图

```json
{
  "view": "sequence",
  "nodes": [{ "id": "user", "label": "Browser", "kind": "participant" }],
  "messages": [
    { "id": "m1", "from": "user", "to": "gw", "label": "POST /login", "kind": "http" }
  ],
  "fragments": [
    { "id": "f1", "kind": "alt", "label": "found", "from_msg": "m2", "to_msg": "m3" }
  ]
}
```

- 参与者数 ≤ 5,消息数 ≤ 12
- `fragments` 的 `from_msg` / `to_msg` 指向消息 id,画成虚线框区间
- 时序图用 `nodes` 存参与者,`messages` 存消息,不用 `edges`

## 增量行为

`build.mjs` 重跑时:

- **节点集合没变** → 复用上一版坐标,只重算受影响的标签/连线 → HTML diff 极小
- **节点集合变了**(加/删节点) → 整体重排
- 强制重排:`node scripts/layout.mjs --spec <spec.json> --reflow`

`geo` 字段是脚本写回 spec 的几何缓存,不用手写,也不该手改。
