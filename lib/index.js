/**
 * dsh-multi-root — per-workspace secondary writable roots for DeepSeek Harness.
 *
 * ## What it does (and does not do)
 *
 * The host already owns the mechanism: `SandboxPolicyService.resolve()` returns
 * `{ mode, workspaceRoot, additionalWritableRoots }`, and every enforcing
 * consumer derives its allow-list from that one policy — the fs fence
 * (`workspaceWritableRoots`), the bwrap/Landlock/Seatbelt profiles
 * (`workspaceWritableRoots`), the Windows ACL grants, and the runtime-context
 * paragraph that tells the model which directories are writable. Under
 * `read-only` those derivations return nothing, so extra roots grant nothing.
 *
 * So this plugin adds NO tool implementation. It wraps one method: for a
 * profile whose workspace has configured roots, `resolve()` returns the same
 * policy with those roots merged into `additionalWritableRoots`. Everything
 * downstream — `write`/`edit`/`apply_patch`, `bash`/`pwsh`, background jobs,
 * PTC subprocesses, the prompt text — inherits it without knowing this plugin
 * exists.
 *
 * Consequence worth stating plainly: one command may write the primary
 * workspace AND every configured secondary root at once. This is the host's
 * list semantics, not a re-rooting trick, so `git -C <secondary> commit` works
 * inside a single shell call.
 *
 * ## Ownership boundary
 *
 * The roots are per *workspace* (the session cwd), stored OUTSIDE the sandbox
 * below `$DSH_HOME/storages/dsh-multi-root/roots.json`. Only the user writes it,
 * through the `/roots` slash command. There is deliberately no agent tool: the
 * agent must not be able to widen its own write access. A project session
 * cannot reach that file at all (it lives outside its workspace); a session
 * whose cwd contains `$DSH_HOME` could, so a best-effort guard rejects
 * `write`/`edit`/`apply_patch`/`bash`/`pwsh` calls whose arguments name the
 * state directory. Best effort is stated, not implied: a command that computes
 * the path at runtime is not detectable by string scan.
 *
 * @module dsh-multi-root
 */

import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath, sep } from 'node:path'

export const name = 'dsh-multi-root'

/** The one service this plugin cannot work without. */
export const inject = ['sandboxPolicy']

const STATE_VERSION = 1
const STATE_DIR_NAME = 'dsh-multi-root'
const MAX_ROOTS = 16
const CACHE_TTL_MS = 5_000
/** Marks a resolve wrapper this plugin installed, so two candidate objects never stack. */
const PATCH_MARK = Symbol.for('dsh-multi-root.resolve.patched')

/**
 * Resolve the harness home the same way the host does: explicit `DSH_HOME`,
 * then `~/.dsh`.
 * @returns the absolute harness home.
 */
export function dshHome() {
  const env = process.env.DSH_HOME
  return env !== undefined && env !== '' ? env : join(homedir(), '.dsh')
}

/** @returns the default state file path for this installation. */
export function defaultStatePath() {
  return join(dshHome(), 'storages', STATE_DIR_NAME, 'roots.json')
}

/**
 * Canonicalize a path the way the host does (native realpath, spelled path as
 * the fallback when it does not resolve).
 * @param path - any path.
 * @returns the physical path when resolvable, else the input.
 */
export function canonicalPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Whether `child` is `parent` itself or lies below it, comparing physical
 * paths. Both sides are canonicalized first so a symlinked ancestor cannot
 * disguise containment.
 * @param child - candidate descendant.
 * @param parent - candidate ancestor.
 * @returns whether child is inside parent.
 */
export function pathInside(child, parent) {
  const a = canonicalPath(child)
  const b = canonicalPath(parent)
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/** Empty workspace table. */
function emptyState() {
  return { version: STATE_VERSION, workspaces: {} }
}

/**
 * Parse a state document, rejecting shapes this plugin cannot trust.
 * @param text - raw JSON.
 * @returns the normalized state.
 * @throws {Error} on malformed JSON or an unsupported shape.
 */
export function parseState(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`dsh-multi-root: roots file is not valid JSON (${String(error)})`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-multi-root: roots file must be a JSON object')
  }
  if (raw.version !== STATE_VERSION) {
    throw new Error(`dsh-multi-root: unsupported roots file version ${JSON.stringify(raw.version)} (expected ${STATE_VERSION})`)
  }
  const workspaces = raw.workspaces
  if (workspaces === null || typeof workspaces !== 'object' || Array.isArray(workspaces)) {
    throw new Error('dsh-multi-root: roots file needs a "workspaces" object')
  }
  const state = emptyState()
  for (const [key, list] of Object.entries(workspaces)) {
    if (!isAbsolute(key)) throw new Error(`dsh-multi-root: workspace key ${JSON.stringify(key)} is not absolute`)
    if (!Array.isArray(list)) throw new Error(`dsh-multi-root: workspace ${JSON.stringify(key)} must map to an array`)
    state.workspaces[key] = list.map(entry => {
      if (typeof entry !== 'string' || !isAbsolute(entry)) {
        throw new Error(`dsh-multi-root: workspace ${JSON.stringify(key)} has a non-absolute entry ${JSON.stringify(entry)}`)
      }
      return entry
    })
  }
  return state
}

/** @returns the serialized state document (stable key order). */
export function serializeState(state) {
  const workspaces = {}
  for (const key of Object.keys(state.workspaces).sort()) {
    if (state.workspaces[key].length > 0) workspaces[key] = state.workspaces[key]
  }
  return JSON.stringify({ version: STATE_VERSION, workspaces }, null, 2) + '\n'
}

/**
 * Validate one proposed grant against the host's own admission rules
 * (`@deepseek-ai/dsh-sandbox`'s `additionalRoot`) plus the containment rules a
 * write-list needs: the grant must be a physical directory, must not be the
 * filesystem root or home, must not be the workspace or contain it, and must
 * not overlap an existing grant.
 * @param spelled - the path as typed.
 * @param options - workspace root, existing grants, and this installation's home.
 * @returns `{ ok: true, canonical }` or `{ ok: false, error }`.
 */
export function validateGrant(spelled, options) {
  const { workspaceRoot, existing = [], home = homedir() } = options
  if (typeof spelled !== 'string' || spelled.trim() === '') return { ok: false, error: '路径为空' }
  const path = spelled.trim()
  if (path.includes('\0')) return { ok: false, error: '路径含 NUL 字节' }
  if (!isAbsolute(path)) return { ok: false, error: `必须是绝对路径：${path}` }
  const spelledAbs = resolvePath(path)
  if (spelledAbs === sep) return { ok: false, error: '拒绝把文件系统根 / 设为可写根' }
  let physical
  let info
  try {
    physical = realpathSync.native(spelledAbs)
    info = statSync(physical)
  } catch (error) {
    return { ok: false, error: `无法读取目录：${String(error)}` }
  }
  if (!info.isDirectory()) return { ok: false, error: `不是目录：${physical}` }
  if (physical !== spelledAbs) {
    return { ok: false, error: `请使用物理路径 ${JSON.stringify(physical)}（不接受符号链接别名）` }
  }
  const homePhysical = canonicalPath(home)
  if (physical === homePhysical) return { ok: false, error: '拒绝把 home 目录设为可写根' }
  if (pathInside(homePhysical, physical)) return { ok: false, error: '该目录是 home 的祖先，等于放开整个 home' }
  const workspacePhysical = canonicalPath(workspaceRoot)
  if (physical === workspacePhysical) return { ok: false, error: '这个目录就是当前工作区根，无需添加' }
  if (pathInside(workspacePhysical, physical)) {
    return { ok: false, error: `该目录包含当前工作区 ${JSON.stringify(workspacePhysical)}，会向上放开写权限` }
  }
  for (const grant of existing) {
    const grantPhysical = canonicalPath(grant)
    if (physical === grantPhysical) return { ok: false, error: `已经配置过：${grantPhysical}` }
    if (pathInside(physical, grantPhysical)) return { ok: false, error: `已被现有根 ${JSON.stringify(grantPhysical)} 覆盖` }
    if (pathInside(grantPhysical, physical)) return { ok: false, error: `与现有根 ${JSON.stringify(grantPhysical)} 是包含关系，请只保留一个` }
  }
  if (existing.length >= MAX_ROOTS) return { ok: false, error: `一个工作区最多 ${MAX_ROOTS} 个副根` }
  return { ok: true, canonical: physical }
}

/**
 * The per-process root table: load once, mutate through the command, and hand
 * validated absolute roots to the policy wrapper.
 */
export class RootTable {
  /**
   * @param statePath - absolute path of the roots file.
   * @param logger - the plugin's cordis logger (optional).
   */
  constructor(statePath, logger) {
    this.statePath = statePath
    this.dir = join(statePath, '..')
    this.logger = logger
    this.state = emptyState()
    this.loadError = undefined
    this.cache = new Map()
    this.reported = new Set()
  }

  /** Read the file; a missing file is an empty table, a malformed one is recorded and treated as empty. */
  load() {
    this.cache.clear()
    this.loadError = undefined
    let text
    try {
      text = readFileSync(this.statePath, 'utf8')
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        this.state = emptyState()
        return this.state
      }
      this.loadError = `读取 ${this.statePath} 失败：${String(error)}`
      this.logger?.warn?.(`[dsh-multi-root] ${this.loadError}`)
      this.state = emptyState()
      return this.state
    }
    try {
      this.state = parseState(text)
    } catch (error) {
      this.loadError = String(error !== null && typeof error === 'object' && error.message ? error.message : error)
      this.logger?.warn?.(`[dsh-multi-root] ${this.loadError}（本进程内按空表处理）`)
      this.state = emptyState()
    }
    return this.state
  }

  /** Persist the current table atomically (dir 0700, file 0600). */
  save() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const temp = `${this.statePath}.tmp-${process.pid}`
    writeFileSync(temp, serializeState(this.state), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.statePath)
    this.cache.clear()
  }

  /**
   * The roots recorded for one workspace, keyed by physical path. Lookup tries
   * the canonical spelling first, then the spelled one (a workspace reached
   * through a symlinked ancestor may be configured by either).
   * @param workspaceRoot - the session workspace as the policy spells it.
   * @returns the stored entries (unvalidated).
   */
  storedFor(workspaceRoot) {
    const canonical = canonicalPath(workspaceRoot)
    return this.state.workspaces[canonical] ?? this.state.workspaces[workspaceRoot] ?? []
  }

  /**
   * The validated grants for one workspace. Entries are re-checked (physical
   * directory, no symlink alias) and invalid ones are dropped with one log
   * line each, because an invalid entry makes the host's own
   * `workspaceWritableRoots` throw and would break every call in the
   * workspace rather than just the bad grant.
   * @param workspaceRoot - the session workspace as the policy spells it.
   * @returns physical, deduplicated absolute roots.
   */
  grantsFor(workspaceRoot) {
    const stored = this.storedFor(workspaceRoot)
    if (stored.length === 0) return []
    const key = canonicalPath(workspaceRoot)
    const now = Date.now()
    const cached = this.cache.get(key)
    if (cached !== undefined && cached.source === stored && now - cached.at < CACHE_TTL_MS) return cached.roots
    const roots = []
    for (const entry of stored) {
      const verdict = validateGrant(entry, { workspaceRoot: key, existing: roots })
      if (verdict.ok) {
        roots.push(verdict.canonical)
        continue
      }
      const signature = `${key}|${entry}|${verdict.error}`
      if (!this.reported.has(signature)) {
        this.reported.add(signature)
        this.logger?.warn?.(`[dsh-multi-root] 跳过无效副根 ${entry}（${verdict.error}）`)
      }
    }
    this.cache.set(key, { at: now, source: stored, roots })
    return roots
  }

  /** @returns every configured workspace path. */
  workspaces() {
    return Object.keys(this.state.workspaces).sort()
  }

  /**
   * Replace one workspace's roots.
   * @param workspaceRoot - session workspace, stored canonically.
   * @param roots - physical absolute paths.
   */
  setRoots(workspaceRoot, roots) {
    const key = canonicalPath(workspaceRoot)
    if (roots.length === 0) delete this.state.workspaces[key]
    else this.state.workspaces[key] = [...new Set(roots)]
    this.save()
  }

  /**
   * Append one audit line describing a mutation.
   * @param record - JSON-serializable audit record.
   */
  audit(record) {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      appendFileSync(join(this.dir, 'audit.jsonl'), JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      this.logger?.warn?.(`[dsh-multi-root] 审计写入失败：${String(error)}`)
    }
  }
}

/**
 * Merge the table's grants into one resolved policy. Exported for tests; the
 * single production caller is the `resolve` wrapper below.
 * @param policy - the host's resolved policy.
 * @param table - the root table.
 * @returns the policy to hand downstream.
 */
export function decoratePolicy(policy, table) {
  if (policy === null || typeof policy !== 'object') return policy
  // Extra roots grant nothing outside workspace-write; do not pretend otherwise.
  if (policy.mode !== 'workspace-write') return policy
  if (typeof policy.workspaceRoot !== 'string') return policy
  let extra
  try {
    extra = table.grantsFor(policy.workspaceRoot)
  } catch (error) {
    table.logger?.warn?.(`[dsh-multi-root] 解析副根失败：${String(error)}`)
    return policy
  }
  if (extra.length === 0) return policy
  const merged = [...new Set([...(policy.additionalWritableRoots ?? []), ...extra])]
  return { ...policy, additionalWritableRoots: merged }
}

/**
 * Wrap one policy service's `resolve` so it decorates the host's own result.
 * The instance is patched rather than the prototype: every consumer captured
 * this exact object (`ctx.sandboxPolicy` / `ctx.get('sandboxPolicy')`), so an
 * own property is what they will actually call.
 * @param service - the sandbox-policy service instance.
 * @param table - the root table.
 * @returns a disposer restoring the previous state.
 */
export function installResolvePatch(service, table) {
  // A second candidate may be a proxy over the same target: never stack two
  // wrappers on one service, or disposing them in order would leave the first
  // wrapper installed and still rewriting policies.
  if (typeof service.resolve === 'function' && service.resolve[PATCH_MARK] === true) {
    return { applied: false, dispose() {} }
  }
  const original = service.resolve.bind(service)
  const hadOwn = Object.prototype.hasOwnProperty.call(service, 'resolve')
  const previous = hadOwn ? service.resolve : undefined
  const patched = function (request = {}) {
    return decoratePolicy(original(request), table)
  }
  Object.defineProperty(patched, PATCH_MARK, { value: true })
  Object.defineProperty(service, 'resolve', {
    configurable: true,
    writable: true,
    enumerable: false,
    value: patched,
  })
  return {
    applied: true,
    /** Restore the pre-patch resolution path. */
    dispose() {
      if (hadOwn) {
        Object.defineProperty(service, 'resolve', { configurable: true, writable: true, enumerable: false, value: previous })
      } else {
        delete service.resolve
      }
    },
  }
}

/** @returns the lexical arguments of a slash command's rawInput (no shell quoting). */
export function splitArgs(rawInput) {
  return String(rawInput ?? '').trim().split(/\s+/u).filter(part => part !== '')
}

/**
 * Format the `/roots` listing for one workspace.
 * @param table - the root table.
 * @param workspaceRoot - the invoking session's workspace.
 * @returns the human-readable listing.
 */
export function renderList(table, workspaceRoot) {
  const canonical = canonicalPath(workspaceRoot)
  const stored = table.storedFor(workspaceRoot)
  const lines = [`工作区 ${canonical}`, `可写根：${stored.length === 0 ? '（无，仅主根）' : ''}`]
  for (const entry of stored) {
    const verdict = validateGrant(entry, { workspaceRoot: canonical, existing: [] })
    lines.push(`  ${verdict.ok ? '✓' : '✗'} ${entry}${verdict.ok ? '' : `  — ${verdict.error}`}`)
  }
  if (table.loadError !== undefined) lines.push(`配置读取问题：${table.loadError}`)
  lines.push(`状态文件：${table.statePath}`)
  const others = table.workspaces().filter(key => key !== canonical)
  if (others.length > 0) lines.push(`其他工作区的副根：${others.map(key => `${key}（${table.state.workspaces[key].length}）`).join('，')}`)
  return lines.filter(line => line !== '').join('\n')
}

/**
 * The agent-facing guard: reject a tool call that names the state directory.
 * The state file is outside every normal workspace, so this only matters for a
 * session rooted above `$DSH_HOME`; it is a speed bump, not a wall, and the
 * README says so.
 * @param exec - the dispatch execution.
 * @param table - the root table.
 * @returns a model-facing error text when the call must be refused.
 */
export function guardHit(exec, table) {
  const dir = canonicalPath(table.dir)
  const args = exec.arguments
  if (args === null || typeof args !== 'object') return undefined
  const candidates = []
  for (const key of ['file_path', 'path', 'input']) {
    const value = args[key]
    if (typeof value === 'string') candidates.push(value)
  }
  for (const value of candidates) {
    if (!isAbsolute(value)) continue
    if (pathInside(value, dir)) return `拒绝访问 ${dir}：多根配置属于用户，agent 不能修改。`
  }
  if (exec.name === 'bash' || exec.name === 'pwsh') {
    const command = typeof args.command === 'string' ? args.command : ''
    if (command.includes(dir) || command.includes(table.statePath)) {
      return `拒绝访问 ${dir}：多根配置属于用户，agent 不能通过 shell 修改。`
    }
  }
  return undefined
}

/**
 * Mount the plugin.
 * @param ctx - the plugin's cordis context.
 * @param config - optional `{ statePath }` override (tests, unusual layouts).
 */
export function apply(ctx, config = {}) {
  // `ctx.sandboxPolicy` may be an interception proxy while `ctx.get()` returns
  // the raw instance; both spellings are the same object in 0.2.x, but which
  // one a consumer captured is not ours to assume, so patch every distinct one.
  const candidates = []
  const fromGet = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined
  for (const candidate of [fromGet, ctx.sandboxPolicy]) {
    if (candidate !== undefined && candidate !== null && typeof candidate.resolve === 'function' && !candidates.includes(candidate)) {
      candidates.push(candidate)
    }
  }
  if (candidates.length === 0) {
    throw new Error('dsh-multi-root: ctx.sandboxPolicy 缺失或没有 resolve()，这个宿主版本不兼容（需要 0.2.x 的 sandbox-policy 服务）')
  }
  // `ctx.logger` is the logger SERVICE: a name is required to get a facade.
  const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-multi-root') : undefined
  const table = new RootTable(config.statePath ?? defaultStatePath(), logger)
  table.load()
  // Fail closed on a host whose policy shape changed: a silent no-op would look
  // exactly like a working install.
  const probe = candidates[0].resolve({})
  if (probe === null || typeof probe !== 'object' || typeof probe.mode !== 'string' || typeof probe.workspaceRoot !== 'string') {
    throw new Error('dsh-multi-root: sandboxPolicy.resolve() 返回的对象不含 mode/workspaceRoot，宿主契约已变化')
  }
  const patches = candidates.map(service => installResolvePatch(service, table))
  ctx.effect(() => () => {
    // LIFO: a proxy patch restored before the raw-instance patch would otherwise
    // reinstall the wrapper it captured as its "previous".
    for (const patch of [...patches].reverse()) patch.dispose()
  })
  const applied = patches.filter(patch => patch.applied).length
  const mounted = `已挂载：状态文件 ${table.statePath}，已配置工作区 ${table.workspaces().length} 个，包装 ${applied} 个 policy 实例（候选 ${candidates.length}）`
  logger?.info?.(mounted)
  if (process.env.DSH_MULTI_ROOT_DEBUG === '1') console.log(`[dsh-multi-root] ${mounted}`)

  // The host renders `additionalWritableRoots` into the runtime context itself
  // (its own `sandbox:policy` layer calls this same, now-patched resolve), so
  // only the rule the host does not state is added here.
  ctx.inject(['systemPrompt'], scope => {
    scope.systemPrompt.context({
      name: 'dsh-multi-root',
      order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
      text: context => {
        const cwd = context.agent?.session?.header?.cwd
        if (typeof cwd !== 'string' || cwd === '') return ''
        const roots = table.grantsFor(cwd)
        if (roots.length === 0) return ''
        return `Secondary writable roots of this workspace: ${JSON.stringify(roots)}. `
          + 'They are writable in workspace-write mode as well, but the session cwd stays the primary workspace: '
          + 'pass an absolute `workdir` when a command must run inside one of them, and do not treat them as cwd.'
      },
    })
  })

  ctx.inject(['commands'], scope => {
    scope.commands.register({
      name: 'roots',
      description: '管理当前工作区的副可写根（多根插件）',
      input: { hint: '[list|add <abs-dir>|remove <abs-dir>|set <abs-dir>…|clear|reload]' },
      handler: ({ agent, rawInput }) => {
        const cwd = agent?.session?.header?.cwd
        if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
          return { kind: 'error', text: '这个会话没有绝对 cwd，无法确定工作区' }
        }
        const [subcommand = 'list', ...rest] = splitArgs(rawInput)
        const existing = table.storedFor(cwd)
        const workspace = canonicalPath(cwd)
        const fail = error => ({ kind: 'error', text: error })
        if (subcommand === 'list') return { kind: 'success', text: renderList(table, cwd) }
        if (subcommand === 'reload') {
          table.load()
          return { kind: 'success', text: `已重新读取\n${renderList(table, cwd)}` }
        }
        if (subcommand === 'help') {
          return {
            kind: 'success',
            text: [
              '/roots list — 列出当前工作区的副根',
              '/roots add <绝对目录> — 添加一个副根（必须是物理目录，不接受符号链接）',
              '/roots remove <绝对目录> — 移除',
              '/roots set <目录…> — 整体替换',
              '/roots clear — 清空当前工作区',
              '/roots reload — 从磁盘重新读取',
              '改动立即生效，无需重启。',
            ].join('\n'),
          }
        }
        if (subcommand === 'clear') {
          table.setRoots(cwd, [])
          table.audit({ at: new Date().toISOString(), action: 'clear', workspace, session: agent?.session?.header?.id })
          return { kind: 'success', text: `已清空 ${workspace} 的副根` }
        }
        if (subcommand === 'add') {
          if (rest.length === 0) return fail('用法：/roots add <绝对目录>')
          const added = []
          let current = [...existing]
          for (const entry of rest) {
            const verdict = validateGrant(entry, { workspaceRoot: workspace, existing: current })
            if (!verdict.ok) return fail(`未添加 ${entry}：${verdict.error}`)
            current.push(verdict.canonical)
            added.push(verdict.canonical)
          }
          table.setRoots(cwd, current)
          table.audit({ at: new Date().toISOString(), action: 'add', workspace, added, session: agent?.session?.header?.id })
          return { kind: 'success', text: `已添加\n${added.map(item => '  + ' + item).join('\n')}\n${renderList(table, cwd)}` }
        }
        if (subcommand === 'set') {
          const next = []
          for (const entry of rest) {
            const verdict = validateGrant(entry, { workspaceRoot: workspace, existing: next })
            if (!verdict.ok) return fail(`未替换 ${entry}：${verdict.error}`)
            next.push(verdict.canonical)
          }
          table.setRoots(cwd, next)
          table.audit({ at: new Date().toISOString(), action: 'set', workspace, roots: next, session: agent?.session?.header?.id })
          return { kind: 'success', text: `已替换\n${renderList(table, cwd)}` }
        }
        if (subcommand === 'remove') {
          if (rest.length === 0) return fail('用法：/roots remove <绝对目录>')
          const targets = rest.map(entry => canonicalPath(resolvePath(entry)))
          const kept = existing.filter(entry => !targets.includes(canonicalPath(entry)))
          if (kept.length === existing.length) return fail(`没有匹配的副根：${rest.join(' ')}`)
          table.setRoots(cwd, kept)
          table.audit({ at: new Date().toISOString(), action: 'remove', workspace, removed: targets, session: agent?.session?.header?.id })
          return { kind: 'success', text: `已移除\n${renderList(table, cwd)}` }
        }
        return fail(`未知子命令 "${subcommand}"，可用：list add remove set clear reload help`)
      },
    })
  })

  // Best-effort self-authorization guard (see the module header).
  ctx.on('tools/execute', async (exec, next) => {
    const reason = guardHit(exec, table)
    if (reason === undefined) return next()
    return {
      isError: true,
      error: { message: reason, info: { code: 'MULTI_ROOT_STATE_PROTECTED' } },
      content: [{ type: 'text', text: 'Error: ' + reason }],
    }
  })
}

export default { name, inject, apply }
