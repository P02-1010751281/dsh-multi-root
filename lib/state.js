/**
 * The roots file: its persisted shape, the admission rules a grant must pass,
 * and the per-process table the policy wrapper reads.
 *
 * Everything persisted lives here. Nothing in this module touches a host
 * service, so it is unit-testable without a running harness.
 *
 * @module dsh-multi-root/state
 */

import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath, sep } from 'node:path'

import { canonicalPath, pathInside } from './canonical.js'
import { projectRootOf } from './project.js'

const STATE_VERSION = 1
const STATE_DIR_NAME = 'dsh-multi-root'
const MAX_ROOTS = 16
const CACHE_TTL_MS = 5_000

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

/** Empty workspace table. */
function emptyState() {
  return { version: STATE_VERSION, workspaces: {} }
}

/** @returns whether the path is a directory right now (never throws). */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
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
   * The storage key for a session workspace: its repository root when it sits
   * inside one, else the workspace itself.
   * @param workspaceRoot - the session workspace as the policy spells it.
   * @returns the physical anchoring directory.
   */
  keyFor(workspaceRoot) {
    return projectRootOf(canonicalPath(workspaceRoot))
  }

  /**
   * The roots recorded for one workspace, keyed by physical path. Lookup tries
   * the exact spelling first (also the spelled one: a workspace reached through
   * a symlinked ancestor may be configured by either), then falls back to the
   * repository the workspace belongs to. Only a repository anchor is inherited:
   * an arbitrary ancestor directory is not, or a grant recorded in a home
   * directory would apply to everything beneath it.
   * @param workspaceRoot - the session workspace as the policy spells it.
   * @returns the stored entries (unvalidated).
   */
  storedFor(workspaceRoot) {
    const canonical = canonicalPath(workspaceRoot)
    const exact = this.state.workspaces[canonical] ?? this.state.workspaces[workspaceRoot]
    if (exact !== undefined) return exact
    const anchor = projectRootOf(canonical)
    return anchor === canonical ? [] : this.state.workspaces[anchor] ?? []
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
   * Replace the roots of the project a workspace belongs to, stored under that
   * anchor. A legacy entry keyed on the exact cwd is migrated rather than left
   * behind, so one project never keeps two copies of the same roots.
   * @param workspaceRoot - session workspace; stored at its repository root.
   * @param roots - physical absolute paths.
   */
  setRoots(workspaceRoot, roots) {
    const canonical = canonicalPath(workspaceRoot)
    const key = projectRootOf(canonical)
    if (key !== canonical) delete this.state.workspaces[canonical]
    if (roots.length === 0) delete this.state.workspaces[key]
    else this.state.workspaces[key] = [...new Set(roots)]
    this.save()
  }

  /**
   * Drop stored grants that no longer pass admission. A workspace whose own
   * directory is missing is skipped, never emptied: an unmounted volume must
   * not silently delete its configuration.
   * @param options - `dryRun` reports the drop list without writing.
   * @returns the dropped grants, the skipped workspaces, and whether the file changed.
   */
  prune({ dryRun = false } = {}) {
    const dropped = []
    const skipped = []
    const next = {}
    for (const [workspace, entries] of Object.entries(this.state.workspaces)) {
      if (!isDirectory(workspace)) {
        skipped.push({ workspace, reason: '工作区目录不存在（可能未挂载）' })
        next[workspace] = entries
        continue
      }
      const kept = []
      for (const entry of entries) {
        const verdict = validateGrant(entry, { workspaceRoot: workspace, existing: kept })
        if (verdict.ok) kept.push(verdict.canonical)
        else dropped.push({ workspace, entry, error: verdict.error })
      }
      if (kept.length > 0) next[workspace] = kept
    }
    const changed = dropped.length > 0
    if (changed && !dryRun) {
      this.state = { version: STATE_VERSION, workspaces: next }
      this.save()
    }
    return { dropped, skipped, changed, dryRun }
  }

  /** @returns the audit log path that sits next to the state file. */
  get auditPath() {
    return join(this.dir, 'audit.jsonl')
  }

  /**
   * Append one audit line describing a mutation.
   * @param record - JSON-serializable audit record.
   */
  audit(record) {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      appendFileSync(this.auditPath, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      this.logger?.warn?.(`[dsh-multi-root] 审计写入失败：${String(error)}`)
    }
  }
}
