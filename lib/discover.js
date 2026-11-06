/**
 * Read-only discovery of candidate secondary roots for one workspace.
 *
 * Everything here is user-initiated from the `/roots discover` command: the
 * plugin never adopts a discovered directory on its own, and no agent tool can
 * reach these functions. Discovery only *proposes*; `validateGrant` (the same
 * admission path a hand-typed path takes) decides.
 *
 * Three sources, in decreasing order of confidence:
 *   worktree       — `git worktree list --porcelain` of the workspace repo
 *   code-workspace — `folders[]` of a `*.code-workspace` file in the workspace
 *   sibling        — immediate siblings of the workspace's parent that are git
 *                    checkouts (the "two repos side by side" layout)
 *
 * @module dsh-multi-root/discover
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { canonicalPath } from './canonical.js'

const GIT_TIMEOUT_MS = 3_000
const MAX_SIBLINGS = 200
const MAX_WORKSPACE_FILES = 5

/**
 * Run one read-only git command.
 * @param args - git arguments (without the leading `git`).
 * @param cwd - repository directory.
 * @returns stdout, or undefined when git is missing / the command failed.
 */
export function runGit(args, cwd) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  if (result.error !== undefined || result.status !== 0) return undefined
  return result.stdout
}

/**
 * Other worktrees of the workspace's repository.
 * @param workspaceRoot - session workspace.
 * @returns candidate records.
 */
export function worktreeCandidates(workspaceRoot) {
  const stdout = runGit(['worktree', 'list', '--porcelain'], workspaceRoot)
  if (stdout === undefined) return []
  const candidates = []
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue
    const path = line.slice('worktree '.length).trim()
    if (!isAbsolute(path)) continue
    candidates.push({ path, source: 'worktree', detail: '同一仓库的另一个 worktree' })
  }
  return candidates
}

/**
 * Strip JSONC comments and trailing commas without touching string literals.
 * @param text - file contents.
 * @returns parseable JSON text.
 */
export function stripJsonc(text) {
  let out = ''
  let index = 0
  let inString = false
  let escape = false
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (inString) {
      out += char
      if (escape) escape = false
      else if (char === '\\') escape = true
      else if (char === '"') inString = false
      index += 1
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    out += char
    index += 1
  }
  return out.replace(/,(\s*[}\]])/gu, '$1')
}

/**
 * Folders declared by the first parseable `*.code-workspace` file in the root.
 * @param workspaceRoot - session workspace.
 * @returns candidate records.
 */
export function codeWorkspaceCandidates(workspaceRoot) {
  let names
  try {
    names = readdirSync(workspaceRoot).filter(name => name.endsWith('.code-workspace')).sort().slice(0, MAX_WORKSPACE_FILES)
  } catch {
    return []
  }
  const candidates = []
  for (const name of names) {
    const file = join(workspaceRoot, name)
    let document
    try {
      document = JSON.parse(stripJsonc(readFileSync(file, 'utf8')))
    } catch {
      continue
    }
    const folders = Array.isArray(document?.folders) ? document.folders : []
    for (const folder of folders) {
      let path
      if (typeof folder?.path === 'string') path = folder.path
      else if (typeof folder?.uri === 'string' && folder.uri.startsWith('file://')) path = decodeURIComponent(folder.uri.slice('file://'.length))
      if (typeof path !== 'string' || path === '') continue
      const absolute = isAbsolute(path) ? path : resolve(workspaceRoot, path)
      candidates.push({ path: absolute, source: 'code-workspace', detail: `${name} 的 folders[]` })
    }
  }
  return candidates
}

/**
 * Immediate siblings of the workspace's parent directory that are git checkouts.
 * @param workspaceRoot - session workspace.
 * @returns candidate records.
 */
export function siblingCandidates(workspaceRoot) {
  const parent = dirname(canonicalPath(workspaceRoot))
  const self = canonicalPath(workspaceRoot)
  let names
  try {
    names = readdirSync(parent).sort().slice(0, MAX_SIBLINGS)
  } catch {
    return []
  }
  const candidates = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const path = join(parent, name)
    if (canonicalPath(path) === self) continue
    try {
      if (!statSync(path).isDirectory()) continue
    } catch {
      continue
    }
    try {
      // `.git` is a directory in a normal checkout and a file inside a linked
      // worktree; either marks a repository.
      statSync(join(path, '.git'))
    } catch {
      continue
    }
    candidates.push({ path, source: 'sibling', detail: '与工作区并列的 git 仓库' })
  }
  return candidates
}

/**
 * Every candidate from every source, deduplicated by physical path. The first
 * mention wins, and sources are ordered most-trusted first.
 * @param workspaceRoot - session workspace.
 * @returns deduplicated candidate records.
 */
export function discoverCandidates(workspaceRoot) {
  const seen = new Set([canonicalPath(workspaceRoot)])
  const out = []
  for (const candidate of [...worktreeCandidates(workspaceRoot), ...codeWorkspaceCandidates(workspaceRoot), ...siblingCandidates(workspaceRoot)]) {
    const key = canonicalPath(candidate.path)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...candidate, canonical: key })
  }
  return out
}
