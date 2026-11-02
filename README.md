# diagram-design-fast

自用的 Agent Skills 仓库。当前收录:

| skill | 作用 |
|---|---|
| [diagram-design-fast](skills/diagram-design-fast/) | 从源码生成架构图 / 流程图 / 时序图,输出自包含 HTML+SVG。spec 驱动、脚本算坐标,改图不重读代码 |

> 详细说明(用途、与 diagram-design 的对比、安装矩阵、升级方式)见
> [skills/diagram-design-fast/README.md](skills/diagram-design-fast/README.md)。

## 安装

### 解压安装

解压 / clone 后把 `skills/<name>` 软链到主机的 skills 目录。

```bash
git clone https://github.com/gadmyth/diagram-design-fast.git ~/code/diagram-design-fast

# Claude Code
mkdir -p ~/.claude/skills
ln -s ~/code/diagram-design-fast/skills/diagram-design-fast ~/.claude/skills/diagram-design-fast

# 其他 Agent Skills 主机(按需要建目录)
mkdir -p ~/.agents/skills ~/.cursor/skills ~/.codex/skills
ln -s ~/code/diagram-design-fast/skills/diagram-design-fast ~/.agents/skills/diagram-design-fast
ln -s ~/code/diagram-design-fast/skills/diagram-design-fast ~/.cursor/skills/diagram-design-fast
```

Windows 用目录联接代替软链:

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\skills\diagram-design-fast" -Target "$env:USERPROFILE\code\diagram-design-fast\skills\diagram-design-fast"
```

### CLI直接安装

用 skills CLI(它认 `skills/<name>/SKILL.md` 这种布局,和上游 diagram-design 一样):

```bash
npx skills add gadmyth/diagram-design-fast --skill diagram-design-fast --agent claude-code
npx skills add gadmyth/diagram-design-fast --skill diagram-design-fast -g     # 装到全局
```

> skills CLI v1.7.x 要求 Node ≥ 22.20;skill 脚本本身只要 Node ≥ 18。

## 依赖

Node.js ≥ 18,无第三方 npm 依赖。装完自检:

```bash
node skills/diagram-design-fast/scripts/index-repo.mjs --root . --out .dd-fast
```

## diagram-design-fast 用法

```bash
S=skills/diagram-design-fast/scripts

# 1. 索引仓库(一次)
node $S/index-repo.mjs --root . --out .dd-fast

# 2. 写 spec(docs/arch/xxx.spec.json,格式见 skills/diagram-design-fast/references/spec.md)

# 3. 生成 + 校验
node $S/build.mjs --spec docs/arch/xxx.spec.json --out docs/arch/xxx.html

# 4. 改图(不读源码)
node $S/patch.mjs --spec docs/arch/xxx.spec.json --op retitle --node svc.auth --label "Auth Service"
node $S/build.mjs --spec docs/arch/xxx.spec.json --out docs/arch/xxx.html
```

更细的手册在 `skills/diagram-design-fast/references/workflows.md`。
