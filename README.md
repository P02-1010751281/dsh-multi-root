# dsh-multi-root

给 DeepSeek Harness 的一个工作区（会话 cwd）挂**多个可写根**：主工作区之外的目录在 `workspace-write` 下同样可写，而会话 cwd、侧栏归属、git 语义都不变。

宿主本来就有这个能力：`SandboxPolicyService.resolve()` 返回的 `additionalWritableRoots` 是一等字段，所有执行层（fs 围栏、bwrap/Landlock/Seatbelt、Windows ACL、`apply_patch`、PTC 子进程）都从同一个 policy 派生允许列表。缺的只是**按工作区配置**这一层，本插件只补这一层。

## 机制

```
ctx.sandboxPolicy.resolve(request)   ← 宿主服务，返回 { mode, workspaceRoot, additionalWritableRoots }
        ↑ 本插件只在实例上加一个 own property 包装它
        │
        ├─ fs 围栏        workspaceWritableRoots(policy)  → write/edit/apply_patch 放行
        ├─ bash/pwsh      workspaceWritableRoots(policy)  → bwrap 里 --bind <root> <root>
        ├─ 运行期上下文   宿主自己的 sandbox:policy 段落会打印 "Additional writable directories: [...]"
        └─ read-only      以上两处都返回空数组 —— 副根不绕过模式
```

- **不重实现任何工具**，不改 `workspaceRoot`（会话 cwd 保持不动）。
- 「根」是**列表**：一条命令可以同时写主根和所有副根，`git -C <副根> commit` 这种跨根操作成立。
- 配置**沙箱外**：`$DSH_HOME/storages/dsh-multi-root/roots.json`（目录 0700、文件 0600），只有用户的斜杠命令写它，插件不提供 agent 工具。
- 宿主版本契约变化时**拒绝加载**（启动即报错），不会静默失效。

## 安装

```bash
# 1. 装进目标 profile（非桌面托管 profile 用 CLI；桌面 profile 见下）
DSH_HOME=~/.dsh dsh plugin --profile web add /path/to/dsh-multi-root

# 2. 确认 bundles 里出现 dsh-multi-root，然后重启宿主
```

桌面端（`~/.dsh/profiles/desktop`）被 Electron 独占，CLI 会拒绝写入；改 `package.json` 的 `dependencies` + `dsh.profile.bundles`，再用 profile 自己的 pnpm 安装，等价于插件管理器的操作。

## 使用

在目标工作区的任意会话里：

```
/roots list                        # 列出当前工作区的副根 + 校验状态
/roots add /srv/work/apps/app-b
/roots remove /srv/work/apps/app-b
/roots set /a /b                   # 整体替换
/roots clear
/roots reload                      # 手改了 JSON 之后重读
/roots discover                    # 只读发现候选（编号列表）
/roots adopt 3 7                   # 按编号采纳；也可用路径片段或 --all
/roots check                       # 复验所有工作区的现有配置
/roots audit 20                    # 最近 20 条授权审计
```

改动**立即生效**，不用重启：每次工具调用都会重新解析 policy。

带 `workdir` 的命令仍应写副根的**绝对路径**——会话 cwd 没变，这是设计而非缺陷。

## 自动发现（C2）

`/roots discover` 只读扫描三个来源，按可信度排序并**编号**：

| 来源 | 判据 | 说明 |
|---|---|---|
| `worktree` | `git worktree list --porcelain` | 同一仓库的其它 worktree |
| `code-workspace` | 工作区根下 `*.code-workspace` 的 `folders[]` | 相对路径按该文件所在目录解析 |
| `sibling` | 工作区父目录里带 `.git` 的兄弟目录 | 「两个仓库并排」的真实布局 |

**发现不等于授权**：编号列表只是候选，`/roots adopt 3 7` 才落盘，`--all` 要显式写。每个被采纳的候选都走与手输路径**完全相同**的准入校验，并且落一条 `audit.jsonl`（动作、工作区、来源、会话 id）。

在真实工作区上的样子（app-a，30 个候选）：

```
 1. ✅ ~/.codex/worktrees/0483/app-a   [worktree] 同一仓库的另一个 worktree
 …
16. ✅ /srv/work/apps/Projects/app-b     [sibling] 与工作区并列的 git 仓库
```

兄弟扫描会把 `app-b-item1…10` 这类克隆一起列出来——所以默认**不做 adopt-all**，只按编号挑。

## 准入规则（与宿主一致，且在 `/roots add` 时就拒绝）

- 必须绝对路径、必须存在、必须是目录；
- 必须是**物理路径**：`realpath` 与拼写不一致（符号链接别名）会被拒，宿主的 `additionalRoot` 同样拒绝；
- 拒绝 `/`、`$HOME`、以及 `$HOME` 的祖先；
- 拒绝当前工作区根本身、工作区的祖先、与已有根互相包含的目录；
- 一个工作区最多 16 个。

运行期每条都会复验：失效条目被**丢弃并告警**，而不是让宿主的 `workspaceWritableRoots` 抛错把整个工作区的工具调用打瘫。

## 边界（明说）

- **guard 是拦路，不是墙**：配置目录在 `$DSH_HOME` 下，正常项目会话够不到；若某个会话的 cwd 覆盖了 `$DSH_HOME`，插件会拒绝对该目录的 `write`/`edit`/`apply_patch` 与含该路径字面量的 `bash`/`pwsh`，但**运行时拼接路径绕过字符串扫描是检测不到的**。
- 无 UI、无 `@` 文件菜单、无侧栏分组：侧栏仍按 cwd 归属一个工作区；`glob`/`grep` 用绝对路径本来就能到副根。
- 与 `dsh-multi-folder` 这类「换根」插件**不能共存**：两边都改 policy，行为会打架。
- 部署级 `additionalWritableRoots`（profile patch 里的 `sandbox-policy.config`）仍然生效，本插件是在其结果上**追加**并去重。

## 验证

```bash
node --test test/          # 25 项：状态/准入/守卫/发现/采纳/命令处理器 测试 + 真实 bwrap 收敛矩阵
```

`test/enforce.test.mjs` 不用模拟：它从已安装的 dsh 载荷里 import `LocalSandboxProvider` 与 `writableRoots`，用本插件产出的 policy 真正 spawn 受限进程，验证

| 用例 | 期望 |
|---|---|
| A `workspace-write`，无副根 | 写副目录失败 |
| B `workspace-write`，有副根 | 写副目录成功 |
| B2 一条命令同时写主根 + 副根 | 都成功 |
| C `read-only`，配置了副根 | 两处都失败 |
| D 另一个工作区 | 不继承 A 的副根 |

`DSH_REPO` 可指定 dsh 载荷路径；缺省自动挑 `~/.local/share/dsh-desktop/*/repo` 里最新的一个。

## 状态文件

```json
{
  "version": 1,
  "workspaces": {
    "/srv/work [
      "/srv/work
    ]
  }
}
```

键是会话 cwd 的**物理路径**。每次 `/roots` 变更都会追加一行 `audit.jsonl`（时间、动作、工作区、受影响根、会话 id）。
