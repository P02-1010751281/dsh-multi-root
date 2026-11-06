# RULES.md — dsh-multi-root 工程行为准则

生效范围：本仓库全部代码、测试、脚本与文档。改动本文件必须单独提交（commit message 前缀 `rules:`），不与实现改动混提。
本文件只写判据，不复制实现细节；事实来源是 `package.json`、`lib/`、`test/`、`scripts/`。

## 1 概览与范围

- 单包 Cordis 插件，运行时零依赖：`package.json` 不写 `dependencies`，唯一 peer 是 `@deepseek-ai/cordis`。
  - why：插件要能在宿主的 profile 里裸装，任何运行时依赖都会变成宿主的解析负担。
  - 判据：`node -e "const p=require('./package.json');process.exit(p.dependencies?1:0)"` 退出码 0。
- 只做一件事：把「按工作区配置的副根」合进宿主 `sandboxPolicy.resolve()` 返回的 `additionalWritableRoots`。
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

- 布局固定：`lib/`（运行时）、`test/`（node:test）、`scripts/`（安装/卸载）、根 `README.md` + `cordis.patch.yml` + `package.json`。
  - why：宿主按 `package.json` 的 `exports`/`dsh.bundle` 约定加载，挪文件等于改安装契约。
- 单文件单一职责，行数上限：
  - `lib/canonical.js` —— 只放路径规范化，当前 35 行，上限 80；
  - `lib/discover.js` —— 只放候选发现，当前 191 行，上限 300；
  - `lib/state.js` —— 状态文件形状、准入校验、RootTable（含 prune），当前 312 行，上限 420；
  - `lib/policy.js` —— 只放 policy 合并与 resolve 包装，当前 84 行，上限 160；
  - `lib/guard.js` —— 只放状态目录守卫，当前 50 行，上限 120；
  - `lib/commands.js` —— `/roots` 参数解析、渲染与注册，当前 333 行，上限 430；
  - `lib/index.js` —— 插件入口与装配，当前 131 行，上限 260；任一文件超上限，该次提交必须先拆模块再改功能。
  - 判据：`wc -l lib/*.js`；任一文件超上限的提交必须同时出现新文件。
- 测试文件名按被测面命名（`store`/`discover`/`command`/`enforce`），一个文件一个面，不按功能点碎切。
  - why：失败时能一眼判断哪条约束被破坏，而不是在一堆碎片文件里找入口。
- 文档与脚本里禁止出现本机绝对路径、具体私项目名、token；示例一律写成 `/srv/work/apps/app-a` 这种占位。
  - 判据：`git grep -nE '(/home|/run)/' -- ':!RULES.md'` 无输出（本文件自身含该字符串，故排除）。

## 4 子包与模块边界

- 只暴露一个入口：`package.json` 的 `exports["."]` 指向 `./lib/index.js`；新增对外 API 要有 README 说明与测试。
- 不得改 `workspaceRoot`、不得重实现宿主工具、不得改宿主工具签名。
  - 判据：`grep -n 'workspaceRoot\s*=' lib/*.js` 无输出（只允许读）。
- 依赖方向单向：`canonical.js` 是叶子；`discover.js` / `state.js` / `guard.js` 只依赖 `canonical.js`；`policy.js` 不 import 任何模块；`commands.js` 依赖 `canonical.js` + `discover.js` + `state.js`；只有 `index.js` 依赖以上全部。反向 import 即设计错误。
  - why：反向依赖会把发现/命令逻辑缠进入口，各模块就无法脱离宿主与彼此单测。
  - 判据：`grep -rn "from './index.js'" lib/` 无输出；`grep -rln "from './commands.js'\|from './policy.js'\|from './guard.js'" lib/` 只输出 `lib/index.js`；`grep -rln "from './state.js'" lib/` 只输出 `lib/commands.js` 与 `lib/index.js`。
- 与「换根」类插件（如 `dsh-multi-folder`）互斥，禁止同时启用：两边都改 policy，行为会打架。

## 5 代码风格与命名

- ESM（`"type": "module"`）、2 空格缩进、单引号、**不写行尾分号**、内置模块用 `node:` 前缀。
  - 判据：`grep -c ';$' lib/*.js` 全为 0；`grep -c 'require(' lib/*.js` 全为 0。
- 命名：变量/函数 `camelCase`，常量 `UPPER_SNAKE`，表/类 `PascalCase`（如 `RootTable`）。
- 每个 `lib/` 模块有 `@module` 头注释，导出函数带 JSDoc（`@param`/`@returns`）。
  - 判据：`grep -c '@module' lib/*.js` 每文件 ≥ 1。
- 注释只解释**为什么**与约束，不复述代码。

## 6 测试与质量门禁

- 合并前提：`node --test test/` exit 0，30 项全绿（`pass 30 / fail 0`）。
- 执行层不许 mock：`test/enforce.test.mjs` 必须 import 真实 `LocalSandboxProvider` 并 spawn 受限进程，覆盖五格矩阵（无副根拒绝 / 有副根放行 / 一条命令双写 / `read-only` 全拒 / 跨工作区不继承）。
- 每个新行为必须带负向用例：只证明「放行」不算测过，必须同时证明「未授权时被拒」。
- 改 policy 合并逻辑，必须同时改 `test/store.test.mjs`（隔离、复验、失效条目丢弃）与 README 验证表。

## 7 安全、性能与日志

- 状态目录 `$DSH_HOME/storages/dsh-multi-root/` 为 0700、`roots.json` 为 0600；只由用户斜杠命令写入，插件不提供 agent 写配置的工具。
  - 判据：`stat -c '%a %n' "$DSH_HOME/storages/dsh-multi-root"{,roots.json}` 输出 `700` 与 `600`。
- guard 是拦路不是墙：只拦「写入形状 + 路径字面量」，运行期拼接路径检测不到。文档与注释不得声称它能防住后者。
  - why：过度承诺会让使用者把安全寄托在字符串扫描上，而它本质只是防手滑。
- 运行期复验失败必须**丢弃并告警**，不得让宿主的 `workspaceWritableRoots` 抛错把整个工作区的工具调用打瘫。
  - 判据：`test/store.test.mjs` 的「RootTable drops invalid entries」用例保持通过。
- 审计只追加：每次变更写一行 JSON 到 `audit.jsonl`，不重写历史、不回填。
  - why：审计要能被第三方复核「谁在何时授权了什么」，回填即失去证据力。

## 8 禁令

- 禁止提交 `node_modules/`、`*.pre-*`、`*.bak`、本机绝对路径。
- 禁止绕过门禁（`git commit --no-verify`、`node --test --test-skip-pattern` 全跳过等）；紧急豁免必须在 commit message 写明原因与回滚点。
- 禁止在未上真桌面实测的情况下宣称某个 dsh 版本兼容；版本契约变化先验收再改文档。
- 禁止把插件做成「多合一」工具（顺手加 UI、加换根、加文件菜单）；超出一个工作区的副根配置即越界。
  - why：职责扩张会让版本契约、测试矩阵与文档同时失控，而宿主并不需要第二个策略层。
