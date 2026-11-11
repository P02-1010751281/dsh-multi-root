# dsh-multi-root

给 DeepSeek Harness 的一个**项目**挂多个可写根：主工作区之外的目录在 `workspace-write` 下同样可写，而会话 cwd、侧栏归属、git 语义都不变。授权按**仓库根**记账，所以仓库里任意深度的会话都继承同一份配置。

宿主本来就有这个能力：`SandboxPolicyService.resolve()` 返回的 `additionalWritableRoots` 是一等字段，所有执行层（fs 围栏、bwrap/Landlock/Seatbelt、Windows ACL、`apply_patch`、PTC 子进程）都从同一个 policy 派生允许列表。缺的只是**按项目配置**这一层，本插件只补这一层。

> **宿主版本要求：dsh `0.2.2-rc.1` 及以上。** `additionalWritableRoots` 是 0.2.2-rc.1 才进 policy 契约的字段；0.2.1-rc.5 整棵代码树没有这个字段，插件能加载、`/roots` 命令能用，但执行层不会消费它——表现为「装了、配置了、还是写不进去」。这个差异在挂载时**无法从服务形状分辨**（旧宿主的 `mode`/`workspaceRoot` 形状完全兼容），所以它是硬性版本要求，不是可降级项。2026-11-06 在 0.2.1-rc.5 桌面上实测踩过：`additionalWritableRoots` 在 0.2.1-rc.5 全仓 0 命中、在 0.2.2-rc.1 有 55 个文件命中。

## 机制

```
ctx.sandboxPolicy.resolve(request)   ← 宿主服务，返回 { mode, workspaceRoot, additionalWritableRoots, protectedPaths }
        ↑ 本插件只在实例上加一个 own property 包装它
        │
        ├─ fs 围栏        workspaceWritableRoots(policy)  → write/edit/apply_patch 放行
        ├─ bash/pwsh      workspaceWritableRoots(policy)  → bwrap 里 --bind <root> <root>
        ├─ 运行期上下文   宿主自己的 sandbox:policy 段落会打印 "Additional writable directories: [...]"
        ├─ 只读硬化       副根内的 .git/.agents/.codex/.aws → bwrap 追加 --ro-bind，fs 围栏直接拒
        └─ read-only      以上两处都返回空数组 —— 副根不绕过模式
```

- **不重实现任何工具**，不改 `workspaceRoot`（会话 cwd 保持不动）。
- 「根」是**列表**：一条命令可以同时写主根和所有副根，`git -C <副根> commit` 这种跨根操作成立。
- 配置**沙箱外**：`$DSH_HOME/storages/dsh-multi-root/roots.json`（目录 0700、文件 0600），只有用户的斜杠命令写它，插件不提供 agent 工具。
- 宿主**服务形状**变化时**拒绝加载**（启动即报错）；但「宿主更老、只是没有 `additionalWritableRoots` 字段」不在形状检查能覆盖的范围内，靠上面的版本要求兜底。

## 安装

公开仓库：<https://github.com/P02-1010751281/dsh-multi-root>（`git clone https://github.com/P02-1010751281/dsh-multi-root.git`；同一份历史也推送到自建 Forgejo）。

```bash
# 1. 装进目标 profile（非桌面托管 profile 用 CLI；桌面 profile 见下）
DSH_HOME=~/.dsh dsh plugin --profile web add /path/to/dsh-multi-root

# 2. 确认 bundles 里出现 dsh-multi-root，然后重启宿主
```

桌面端（`~/.dsh/profiles/desktop`）被 Electron 独占，CLI 会拒绝写入；改 `package.json` 的 `dependencies` + `dsh.profile.bundles`，再用 profile 自己的 pnpm 安装，等价于插件管理器的操作。

桌面 profile 有两条装法，按用途选：

| 装法 | `dependencies` 里的写法 | 适合 |
|---|---|---|
| **仓库快照** | `"dsh-multi-root": "git+ssh://forgejo@<instance>/<owner>/dsh-multi-root.git"` | 日常使用：插件装在 profile 内，**不依赖源码目录或数据盘是否挂载** |
| **本地链接** | `"dsh-multi-root": "link:/path/to/dsh-multi-root"`（`scripts/install-desktop.sh` 走这条） | 开发：改完代码重启宿主即可生效 |

> **钉版本**：裸 `git+…` 规格在**安装那一刻**解析到分支头，同一行 spec 今天和明天装到的可能不是同一份代码。把 tag 接在后面才是不可变锚：`"dsh-multi-root": "git+ssh://forgejo@<instance>/<owner>/dsh-multi-root.git#v0.1.3"`。仓库每次发版打 annotated tag，`scripts/push-both.sh` 会连同分支一起把 tag 推到每条 push URL（否则远端只有分支头、没有可复现的锚）。

仓库快照模式下，改完代码要重新装一次再重启宿主：

```bash
bash /path/to/dsh-multi-root/scripts/push-both.sh   # 分支 + tag，双远端逐条校验
cd ~/.dsh/profiles/desktop && pnpm update dsh-multi-root
```

> 沙箱内的 `ssh` 坑：DSH 的 bash 沙箱把宿主机的 root 属主显示成 `nobody`，OpenSSH 因此对 `/etc/ssh/ssh_config.d/*` 报 `Bad owner or permissions`（宿主机上没有这个问题）。在沙箱里跑 `git clone`/`pnpm add` 拉 SSH 依赖时加 `GIT_SSH_COMMAND='ssh -F ~/.ssh/config'`。
>
> GitHub 的 22 端口在透明代理下会被拦（`Connection closed by <fake-ip> port 22`，时通时不通）。改用它的 443 端点：`ssh://git@ssh.github.com:443/<owner>/<repo>.git`，并 `git remote set-url --add --push` 让一次 push 同时到 Forgejo 与 GitHub。
>
> 双 pushurl 的代价：两条腿里任一条被掐，`git push` 整条命令都报失败，另一条其实可能已经成功。用 `bash scripts/push-both.sh` 逐条推 + `ls-remote` 校验（每条腿独立重试，失败退出码非 0），比生 `git push` 更适合这种网络。

## 使用

在目标项目的任意会话里（仓库里任意深度都行，授权记在仓库根）：

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
/roots prune                         # 移除所有工作区里已失效的副根（写审计）
/roots prune --dry-run               # 只报告，不写盘
/roots audit 20                    # 最近 20 条授权审计
```

`/roots prune` 只删**已经失效**的条目（目录不存在、不再是物理目录、与其它根包含冲突）；工作区目录本身不存在时整条跳过，避免数据盘未挂载时把配置清空。

改动**立即生效**，不用重启：每次工具调用都会重新解析 policy。

带 `workdir` 的命令仍应写副根的**绝对路径**——会话 cwd 没变，这是设计而非缺陷。

## 设置页（桌面端与 Web 是同一个界面）

**位置**：设置 → **多可写根**。

卡片列出每个项目的**仓库根**及其下的可写根，逐条给出 ✓ / ✗（✗ 带原因）；可以就地填「项目目录 + 可写根」添加、逐条移除、手动刷新。改完立即生效，不需要重启宿主。

| 环节 | 实现 |
|---|---|
| 浏览器半 | `lib/client.js`，手写的 lazy-CJS 经典脚本（`window.__ModuleLoader__.load({ id, factory })`），**无构建步骤**，只 `require` 宿主平台模块表里的 `react` |
| 挂载点 | `settings.section`（宿主声明的 root-scope list slot），`id: multi-root` |
| 数据路由 | `api/multi-root/roots`（文档相对路径），宿主半注册在 `ctx.connection.fetch`——**只对 owner peer 放行，其它主体 403** |
| 写入校验 | 与 `/roots add` 同一条 `validateGrant`：拒绝相对路径、符号链接别名、home、当前工作区本身、包含关系 |
| 审计 | 带 `surface: "settings"`，与斜杠命令的改动**可区分** |

没有 `connection` 服务的宿主（headless）不会注册这个路由，卡片也就不出现，但**策略照常生效**——UI 是可选的一层，不是功能本身。

`test/client.test.mjs` 守住浏览器半的契约：不许出现 `import`/`export`（经典脚本会静默不解析），`require` 只许是平台模块表里的名字。

## 项目右键菜单（同一份配置）

右键侧栏里的**项目** → **多可写根**，就地看和改这个项目的副根：

| 菜单项 | 行为 |
|---|---|
| `✓ /path` / `✗ /path（原因）` | 只读展示现有副根与当前判定 |
| `添加 /path（sibling｜worktree｜code-workspace）` | 候选来自 `/roots discover` 的那三个来源，行内直接落盘 |
| `移除 /path` | 删除该条授权 |

每次打开菜单都会向 `api/multi-root/roots` 发一次 `{action: "discover"}`：**只读**，不写盘、不写审计，返回当前快照 + 候选，每个候选都带 `validateGrant` 的判定。点「添加」与手输路径走**同一条**准入校验，落盘键仍是仓库根，审计同样记 `surface: "settings"`。失败不静默——菜单用宿主 toast 报出拒绝原因。

为什么不是「跳转到设置页并预填」：宿主没有向插件暴露打开设置面板的 API（`settings.launcher`、`settings.trigger` 都是 `single` slot，已被宿主自己的实现占满），所以改成在菜单里直接完成增删——同样的结果，不新增组件、不新增路由。

顺带修掉一个旧缺陷：路由现在先把 anchor 归一化到**仓库根**（与 `/roots add` 一致），所以从仓库子目录右键/填表不会再留下一条永远命不中的键。

## 自动发现（C2）

`/roots discover` 只读扫描三个来源，按可信度排序并**编号**：

| 来源 | 判据 | 说明 |
|---|---|---|
| `worktree` | `git worktree list --porcelain` | 同一仓库的其它 worktree |
| `code-workspace` | 工作区根下 `*.code-workspace` 的 `folders[]` | 相对路径按该文件所在目录解析 |
| `sibling` | 工作区父目录里带 `.git` 的兄弟目录 | 「两个仓库并排」的真实布局 |

**发现不等于授权**：编号列表只是候选，`/roots adopt 3 7` 才落盘，`--all` 要显式写。每个被采纳的候选都走与手输路径**完全相同**的准入校验，并且落一条 `audit.jsonl`（动作、工作区、来源、会话 id）。

在真实工作区上的样子（30 个候选）：

```
 1. ✅ ~/.codex/worktrees/0483/app-a                [worktree] 同一仓库的另一个 worktree
 …
16. ✅ /srv/work/apps/app-b                         [sibling] 与工作区并列的 git 仓库
```

兄弟扫描会把 `app-b-item1…10` 这类克隆一起列出来——所以默认**不做 adopt-all**，只按编号挑。

## 准入规则（与宿主一致，且在 `/roots add` 时就拒绝）

- 必须绝对路径、必须存在、必须是目录；
- 必须是**物理路径**：`realpath` 与拼写不一致（符号链接别名）会被拒，宿主的 `additionalRoot` 同样拒绝；
- 拒绝 `/`、`$HOME`、以及 `$HOME` 的祖先；
- 拒绝当前工作区根本身、工作区的祖先、与已有根互相包含的目录；
- 一个工作区最多 16 个。

运行期每条都会复验：失效条目被**丢弃并告警**，而不是让宿主的 `workspaceWritableRoots` 抛错把整个工作区的工具调用打瘫。

## 只读硬化（v0.5.0）

授权一个副根 = 授权**整棵目录树**，包括 `.git`（钩子是可执行内容）、`.agents` / `.codex`（agent 指令）和 `.aws`（凭据）。Codex 的沙箱把这些当只读，DSH 0.2.2-rc.1 的 policy 没有这个表达：契约里只有 `additionalWritableRoots`，三个执行层（bwrap / Landlock / Seatbelt）与 fs 围栏都从 `workspaceWritableRoots()` 派生，bwrap 直接 `--bind <root> <root>`。

所以硬化分两半，缺一不可：

| 半 | 内容 |
|---|---|
| 插件半（本仓库） | `resolve()` 里补 `protectedPaths`：每个副根 × `['.git', '.agents', '.codex', '.aws']`，只做减法，且与部署级已有条目合并去重 |
| 宿主半（载荷补丁） | 三个消费点读这个字段：bwrap 在 `--bind` **之后**追加 `--ro-bind`（后挂载赢）；fs 围栏对落在保护路径内的 target 抛 `FS_SANDBOX_DENIED`；Landlock 无法对子路径减权，改为整根不授权（fail closed）；Seatbelt 追加 `(deny file-write* (subpath …))`；policy 服务在 `resolve()` 结果里声明 `protectedPathsSupported: true` |

打补丁：

```bash
bash scripts/patch-host.sh            # 打（先备份，锚点不中即失败，不半打）
DRY=1 bash scripts/patch-host.sh      # 只校验锚点与语法
bash scripts/patch-host.sh --revert   # 从备份还原
```

补丁对现有行为**没有影响**：没有 `protectedPaths` 的 policy 走的还是原来那些分支，不带副根的会话逐字节一致。**载荷升级会覆盖这几个文件**，升级后要重跑；`node --test test/hardening.test.mjs` 在未打补丁的载荷上是 5 通过 3 跳过，打了之后 8/8——跳过会翻成通过，这是唯一该信的判据。

**插件不假设宿主打了补丁。** 挂载时读 `probe.protectedPathsSupported`；缺失就 `logger.warn` 明说「副根内的 .git/.agents/.codex/.aws 仍可被写入」，不假装硬化生效。

边界再强调一次：硬化只覆盖**副根**。主工作区在宿主默认配置里就是整棵可写（连 `.git`），本插件不改那个默认值。

## 边界（明说）

- **guard 是拦路，不是墙**：配置目录在 `$DSH_HOME` 下，正常项目会话够不到；若某个会话的 cwd 覆盖了 `$DSH_HOME`，插件会拒绝对该目录的 `write`/`edit`/`apply_patch` 与含该路径字面量的 `bash`/`pwsh`，但**运行时拼接路径绕过字符串扫描是检测不到的**。
- UI 只有两处（见上）：设置页卡片 + 项目右键菜单里的一个子项，共用一条路由；无 `@` 文件菜单、无侧栏面板、无工具栏按钮、无自绘对话框。侧栏仍按 cwd 归属一个工作区，`glob`/`grep` 用绝对路径本来就能到副根。
- 与 `dsh-multi-folder` 这类「换根」插件**不能共存**：两边都改 policy，行为会打架。
- 部署级 `additionalWritableRoots`（profile patch 里的 `sandbox-policy.config`）仍然生效，本插件是在其结果上**追加**并去重。
- 只读硬化**只覆盖副根**，不覆盖主工作区：宿主本来就把整个 workspace 设为可写（连 `.git` 一起），插件不改这个默认值。副根比主根严，是因为副根本来就是本插件新增的授权。

## 验证

```bash
node --test test/          # 66 项：状态/准入/守卫/发现/采纳/清理/命令处理器/项目锚定/数据路由（含 discover 只读）/浏览器半契约（含右键菜单形状与失败提示）/只读硬化（8 项）+ 真实 bwrap 收敛矩阵
```

未打宿主补丁时，`test/hardening.test.mjs` 的 3 项执行层用例**跳过**（不是通过）：那是一份能力报告，不是保证。打了补丁后同一套测试 8/8 全过——这正是判据「跳过会翻成通过」：

```bash
PAYLOAD=$HOME/dsh-host-spike node --test test/hardening.test.mjs   # 已打补丁：8 通过 0 跳过
node --test test/hardening.test.mjs                                 # 实机未补丁：5 通过 3 跳过
```

`test/project.test.mjs` 覆盖 0.2.0 的键变更：仓库根继承、兄弟仓库不继承、非仓库祖先不向下泄漏、`.git` 是文件（worktree）也算根、旧「精确 cwd」键被迁移且不留两份、运行期复验用会话 cwd 而不是落盘键。

`test/enforce.test.mjs` 不用模拟：它从已安装的 dsh 载荷里 import `LocalSandboxProvider` 与 `writableRoots`，用本插件产出的 policy 真正 spawn 受限进程，验证

| 用例 | 期望 |
|---|---|
| A `workspace-write`，无副根 | 写副目录失败 |
| B `workspace-write`，有副根 | 写副目录成功 |
| B2 一条命令同时写主根 + 副根 | 都成功 |
| C `read-only`，配置了副根 | 两处都失败 |
| D 另一个工作区 | 不继承 A 的副根 |

`DSH_REPO` 可指定 dsh 载荷路径；缺省自动挑 `~/.local/share/dsh-desktop/*/repo` 里最新的一个。

2026-11-06 在真桌面（dsh 0.2.2-rc.1）上验收：宿主自己的运行期上下文打印了 `Additional writable directories: [...]`；`bash` 带 `workdir` 与绝对路径写入均成功；`write` 工具写入并读回成功；对照的未授权兄弟仓库在 bwrap 与 fs 围栏两层都被拒；配置目录的只读命令放行，目标仓库无探针残留。

同日晚模块拆分 + `prune` 之后的 0.1.3 重跑了一遍（桌面重启后、越过了运行期上下文这一层）：

| 检查 | 结果 |
|---|---|
| 版本判据 | `/roots prune --dry-run` 返回 `没有失效副根`——`prune` 只有 0.1.3 有，且该文案是 `renderPrune()` 的唯一返回，能确认应答的是新代码 |
| 宿主渲染 | 采纳副根后运行期上下文出现 `Additional writable directories: [...]` 与 `Secondary writable roots of this workspace: [...]` 两段（宿主读的是被包装的 `resolve()`） |
| `bash`（bwrap） | 副根写入成功；未授权兄弟仓库 `只读文件系统` 被拒 |
| `write` 工具（fs 围栏） | 副根写入并读回成功；未授权兄弟仓库 `[sandbox: file access denied under workspace-write mode]` |
| 一条命令跨两处 | 同一会话同时写主根与副根，均成功 |
| 审计与权限 | `audit.jsonl` 落了对应 `add` 记录；状态目录 0700、`roots.json`/`audit.jsonl` 0600 |
| 残留 | 探针文件全部清除，主仓库与副根仓库 `git status` 均干净 |

## 状态文件

```json
{
  "version": 1,
  "workspaces": {
    "/srv/work/apps/app-a": [
      "/srv/work/apps/app-b"
    ]
  }
}
```

键是**仓库根**的物理路径（向上找最近含 `.git` 的目录；不在仓库里时就是会话 cwd 本身）。

继承只沿这一条走：`/repo/sub` 的会话读 `/repo` 的授权；`/repo` 的会话**不**读 `/repo/sub` 的；兄弟仓库互不可见；记在 `/home/user` 这种非仓库祖先上的授权**不会**向下泄漏。这套规则的每条都有对应的失败用例（`test/project.test.mjs`）。

写入时按仓库根落盘：在子目录里执行 `/roots add`，条目记在仓库根，旧的「精确 cwd」条目会被迁走，不会留下两份。

每次 `/roots` 变更都会追加一行 `audit.jsonl`（时间、动作、工作区、落盘键、受影响根、会话 id）。
