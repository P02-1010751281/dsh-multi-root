# RULES.md — dsh-multi-root 工程行为准则

生效范围：本仓库全部代码、测试、脚本与文档。改动本文件必须单独提交（commit message 前缀 `rules:`），不与实现改动混提。
本文件只写判据，不复制实现细节；事实来源是 `package.json`、`lib/`、`test/`、`scripts/`。

## 1 概览与范围

- 单包 Cordis 插件，运行时零依赖：`package.json` 不写 `dependencies`，唯一 peer 是 `@deepseek-ai/cordis`。
  - why：插件要能在宿主的 profile 里裸装，任何运行时依赖都会变成宿主的解析负担。
  - 判据：`node -e "const p=require('./package.json');process.exit(p.dependencies?1:0)"` 退出码 0。
- 只做一件事：把「按项目（仓库根）配置的副根」合进宿主 `sandboxPolicy.resolve()` 返回的 `additionalWritableRoots`。
  - why：一旦开始改宿主工具或换根，插件就从「补一层配置」变成「替换策略层」，宿主升级必崩。
  - 判据：`grep -c 'policy.additionalWritableRoots' lib/policy.js` 等于 1，且 `grep -rn additionalWritableRoots lib/state.js lib/commands.js lib/guard.js lib/discover.js lib/canonical.js` 无输出（只有 policy 层读这个字段）；`grep -rn 'registerTool\|defineTool\|addTool' lib/` 无输出（不实现任何工具）。
- 宿主版本下限 dsh `0.2.2-rc.1`；更老的宿主没有这个 policy 字段，插件会「装上但静默无效」。
  - why：服务形状在旧宿主上完全兼容，加载期分辨不出来，只能靠硬性版本要求兜底（真机踩过）。
  - 判据：README 顶部的版本块存在，且 `node --test test/enforce.test.mjs` 能从 `DSH_REPO` 指向的载荷 import 真实 `LocalSandboxProvider` 后跑通。

## 2 元规则

- 破例先改规则：任何「这次特殊」都先在本文件增改一条，写明退出条件，再改代码。
  - why：规则若能靠口头破例绕过，就退化成摆设，下一个改动的人无从判断边界。
- 每条准则必须可核验：给出命令、`path:line` 或阈值；禁止出现「尽量」「合理」「必要时」。
- 文档里的每个数字（测试条数、命中数、行数）必须与同一提交里的实跑结果一致。
  - 判据：改了 `test/` 的提交，同一 commit 内 README「验证」段的条数同步更新。

## 3 文件与目录约定

- 布局固定：`lib/`（运行时）、`test/`（node:test）、`scripts/`（安装/卸载/推送）、根 `README.md` + `cordis.patch.yml` + `package.json`。
  - why：宿主按 `package.json` 的 `exports`/`dsh.bundle` 约定加载，挪文件等于改安装契约。
- 单文件单一职责，行数上限：
  - `lib/canonical.js` —— 只放路径规范化，当前 35 行，上限 80；
  - `lib/project.js` —— 只放项目根锚定（向上找 `.git`），当前 40 行，上限 80；
  - `lib/route.js` —— 只放设置页的数据路由（鉴权由宿主的 connection 桥提供），当前 117 行，上限 180；
  - `lib/client.js` —— 只放浏览器半（经典脚本，见 §4），当前 176 行，上限 260；
  - `lib/discover.js` —— 只放候选发现，当前 191 行，上限 300；
  - `lib/state.js` —— 状态文件形状、准入校验、RootTable（含 prune），当前 333 行，上限 420；
  - `lib/policy.js` —— 只放 policy 合并与 resolve 包装，当前 84 行，上限 160；
  - `lib/guard.js` —— 只放状态目录守卫，当前 50 行，上限 120；
  - `lib/commands.js` —— `/roots` 参数解析、渲染与注册，当前 339 行，上限 430；
  - `lib/index.js` —— 插件入口与装配，当前 145 行，上限 260；任一文件超上限，该次提交必须先拆模块再改功能。
  - 判据：`wc -l lib/*.js`；任一文件超上限的提交必须同时出现新文件。
- 测试文件名按被测面命名（`store`/`discover`/`command`/`enforce`），一个文件一个面，不按功能点碎切。
  - why：失败时能一眼判断哪条约束被破坏，而不是在一堆碎片文件里找入口。
- 文档与脚本里禁止出现本机绝对路径、具体私项目名、token；示例一律写成 `/srv/work/apps/app-a` 这种占位。
  - 判据：`git grep -nE '(/home|/run)/' -- ':!RULES.md'` 无输出（本文件自身含该字符串，故排除）。

## 4 子包与模块边界

- 对外入口两个：`exports["."]` → `./lib/index.js`（宿主半），`exports["./client"]` → `./lib/client.js`（浏览器半）。新增对外 API 要有 README 说明与测试。
  - 判据：`node -e 'console.log(Object.keys(require("./package.json").exports).join(","))'` 含 `.` 与 `./client`。
- 不得改 `workspaceRoot`、不得重实现宿主工具、不得改宿主工具签名。
  - 判据：`grep -n 'workspaceRoot\s*=' lib/*.js` 无输出（只允许读）。
- 依赖方向单向：`canonical.js` 是叶子；`project.js` 只依赖 `canonical.js`；`discover.js` / `guard.js` 只依赖 `canonical.js`；`state.js` 依赖 `canonical.js` + `project.js`；`policy.js` 不 import 任何模块；`route.js` 依赖 `canonical.js` + `state.js`；`commands.js` 依赖 `canonical.js` + `discover.js` + `state.js`；只有 `index.js` 依赖以上全部。反向 import 即设计错误。
  - `client.js` 是唯一例外：不 import 任何 `lib/` 文件，只能 `require` 宿主平台模块表里的名字，因为浏览器半由宿主原样下发。
  - 判据：`test/client.test.mjs` 拒绝 `import`/`export` 语句与表外的 `require`。
  - why：反向依赖会把发现/命令逻辑缠进入口，各模块就无法脱离宿主与彼此单测。
  - 判据：`grep -rn "from './index.js'" lib/` 无输出；`grep -rln "from './project.js'" lib/` 只输出 `lib/state.js` 与 `lib/index.js`；`grep -rln "from './commands.js'\|from './policy.js'\|from './guard.js'" lib/` 只输出 `lib/index.js`；`grep -rln "from './state.js'" lib/` 只输出 `lib/commands.js` 与 `lib/index.js`。
- 与「换根」类插件（如 `dsh-multi-folder`）互斥，禁止同时启用：两边都改 policy，行为会打架。

## 5 代码风格与命名

- ESM（`"type": "module"`）、2 空格缩进、单引号、**不写行尾分号**、内置模块用 `node:` 前缀。
  - 判据：`grep -c ';$' lib/*.js` 全为 0；`grep -c 'require(' lib/*.js` 全为 0。
- 命名：变量/函数 `camelCase`，常量 `UPPER_SNAKE`，表/类 `PascalCase`（如 `RootTable`）。
- 每个 `lib/` 模块有 `@module` 头注释，导出函数带 JSDoc（`@param`/`@returns`）。
  - 判据：`grep -c '@module' lib/*.js` 每文件 ≥ 1。
- 注释只解释**为什么**与约束，不复述代码。

## 6 测试与质量门禁

- 合并前提：`node --test test/` exit 0，52 项全绿（`pass 52 / fail 0`）。
- 执行层不许 mock：`test/enforce.test.mjs` 必须 import 真实 `LocalSandboxProvider` 并 spawn 受限进程，覆盖五格矩阵（无副根拒绝 / 有副根放行 / 一条命令双写 / `read-only` 全拒 / 跨工作区不继承）。
- 每个新行为必须带负向用例：只证明「放行」不算测过，必须同时证明「未授权时被拒」。
- 改 policy 合并逻辑，必须同时改 `test/store.test.mjs`（隔离、复验、失效条目丢弃）与 README 验证表。
- 发版：`package.json` 版本号、`release:` 提交、annotated tag 属同一次发布，且 tag 必须双远端可见。
  - why：profile 的安装 spec 可以钉到 tag（`…#v0.1.3`），tag 只在本地或只在一条腿上，钉版本就不可复现。
  - 判据：Forgejo 与 GitHub 各自 `git ls-remote refs/tags/vX.Y.Z` 返回**同一个** tag 对象；`git clone --branch vX.Y.Z` 检出的 `package.json` 版本与之相符。推 tag 由 `scripts/push-both.sh` 负责，不单靠人手。

## 7 安全、性能与日志

- 状态目录 `$DSH_HOME/storages/dsh-multi-root/` 为 0700、`roots.json` 为 0600；只由用户斜杠命令写入，插件不提供 agent 写配置的工具。
  - 判据：`stat -c '%a %n' "$DSH_HOME/storages/dsh-multi-root"{,roots.json}` 输出 `700` 与 `600`。
- guard 是拦路不是墙：只拦「写入形状 + 路径字面量」，运行期拼接路径检测不到。文档与注释不得声称它能防住后者。
  - why：过度承诺会让使用者把安全寄托在字符串扫描上，而它本质只是防手滑。
- 运行期复验失败必须**丢弃并告警**，不得让宿主的 `workspaceWritableRoots` 抛错把整个工作区的工具调用打瘫。
  - 判据：`test/store.test.mjs` 的「RootTable drops invalid entries」用例保持通过。
- 设置页的数据路由必须注册在 `ctx.connection.fetch`（只对 owner peer 放行，其它主体 403），不得用 `ctx.webServer` 裸路由；每次写入都要过 `validateGrant` 并落审计（`surface: "settings"`）。
  - why：裸路由不经过 `/api` 的鉴权链，等于把「改可写根」暴露给任何能访问该端口的进程。
  - 判据：`grep -c "connection.fetch.register" lib/index.js` 为 1；`grep -n "webServer" lib/` 无输出。
- 只读硬化只在宿主真的消费时才可宣称：`resolve()` 返回 `protectedPathsSupported: true` 才算生效，缺省时只警告、不假装。
  - why：`protectedPaths` 是插件与载荷之间的**新契约**，老宿主会静默忽略未知字段；把「提交了字段」当成「已经挡住」正是本项目最不能犯的错。
  - 判据：`grep -c "protectedPathsSupported" lib/index.js` 为 1；`node --test test/hardening.test.mjs` 在已打补丁的载荷上 8 通过 0 跳过、在未打补丁的载荷上 5 通过 3 跳过（跳过是能力报告，不是通过）。

- 审计只追加：每次变更写一行 JSON 到 `audit.jsonl`，不重写历史、不回填。
  - why：审计要能被第三方复核「谁在何时授权了什么」，回填即失去证据力。

## 8 禁令

- 禁止提交 `node_modules/`、`*.pre-*`、`*.bak`、本机绝对路径。
- 禁止绕过门禁（`git commit --no-verify`、`node --test --test-skip-pattern` 全跳过等）；紧急豁免必须在 commit message 写明原因与回滚点。
- 禁止在未上真桌面实测的情况下宣称某个 dsh 版本兼容；版本契约变化先验收再改文档。
- UI 只允许两个形态，且共用同一个 `/api/multi-root/roots`：设置页里的「多可写根」卡片，和项目行右键菜单里的**一个**「多可写根」子项。禁止加换根、`@` 文件菜单、侧栏面板、工具栏按钮、自绘对话框或第二个数据路由。图标只允许挂在这两个形态自己的键上：`settings.section.icon`（id 必须等于 section id）与 `contextMenu.icon`（只给本贡献的 action 用 `icon: { key }`）。
  - why：右键菜单是唯一既能拿到项目路径、又不新增组件的入口。宿主**没有**给插件「打开设置页」的公开 API（`settings.launcher`、`settings.trigger` 都是 `single` slot，已被宿主自己的实现占满），所以「跳转设置页并预填」做不到；在菜单里直接列出现有根与可发现的候选、就地增删，是等价且不新增 surface 的做法。
  - 判据：`grep -o "ctx\.slots\.inject('[^']*'" lib/client.js | sort -u` 只有 `settings.section`、`settings.section.icon`、`contextMenu.icon` 三种，且 `settings.section.icon` 的 `id` 与卡片同为 `multi-root`；`grep -c "contextMenus.register(" lib/client.js` 为 1 且该贡献里 `target: 'workspace'`；`grep -c "connection.fetch.register" lib/index.js` 仍为 1。
