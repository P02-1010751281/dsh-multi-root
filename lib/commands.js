/**
 * The `/roots` command surface: argument parsing, the human-readable renders,
 * and one registration function. Rendering lives here so the entry module stays
 * wiring-only and the command text can be unit-tested without a host.
 *
 * @module dsh-multi-root/commands
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'

import { canonicalPath } from './canonical.js'
import { discoverCandidates } from './discover.js'
import { validateGrant } from './state.js'

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
  const anchor = table.keyFor(workspaceRoot)
  const stored = table.storedFor(workspaceRoot)
  const lines = [`工作区 ${canonical}`]
  if (anchor !== canonical) lines.push(`授权键 ${anchor}（仓库根，本目录的会话继承它）`)
  lines.push(`可写根：${stored.length === 0 ? '（无，仅主根）' : ''}`)
  for (const entry of stored) {
    const verdict = validateGrant(entry, { workspaceRoot: canonical, existing: [] })
    lines.push(`  ${verdict.ok ? '✓' : '✗'} ${entry}${verdict.ok ? '' : `  — ${verdict.error}`}`)
  }
  if (table.loadError !== undefined) lines.push(`配置读取问题：${table.loadError}`)
  lines.push(`状态文件：${table.statePath}`)
  const others = table.workspaces().filter(key => key !== anchor && key !== canonical)
  if (others.length > 0) lines.push(`其他工作区的副根：${others.map(key => `${key}（${table.state.workspaces[key].length}）`).join('，')}`)
  return lines.filter(line => line !== '').join('\n')
}

/**
 * Format the discovery report for one workspace. Candidates are classified
 * with the SAME admission path a hand-typed path takes, so what `/roots adopt`
 * will do is exactly what this prints.
 * @param table - the root table.
 * @param workspaceRoot - the invoking session's workspace.
 * @returns the human-readable report.
 */
export function renderDiscovery(table, workspaceRoot, precomputed) {
  const workspace = canonicalPath(workspaceRoot)
  const candidates = precomputed ?? discoverCandidates(workspace)
  if (candidates.length === 0) return `没有发现候选目录（工作区 ${workspace}）`
  const existing = table.storedFor(workspaceRoot)
  const lines = [`发现 ${candidates.length} 个候选（工作区 ${workspace}）：`]
  let admittable = 0
  candidates.forEach((candidate, index) => {
    const verdict = validateGrant(candidate.canonical, { workspaceRoot: workspace, existing })
    const label = String(index + 1).padStart(2, ' ')
    if (verdict.ok) {
      admittable += 1
      lines.push(`  ${label}. ✅ ${candidate.canonical}   [${candidate.source}] ${candidate.detail}`)
    } else if (verdict.error.startsWith('已经配置过')) {
      lines.push(`  ${label}. ✔ ${candidate.canonical}   [${candidate.source}] 已配置`)
    } else {
      lines.push(`  ${label}. ⛔ ${candidate.canonical}   [${candidate.source}] ${verdict.error}`)
    }
  })
  if (admittable > 0) lines.push(`采纳其中几个：/roots adopt <编号…>   全部采纳：/roots adopt --all`)
  return lines.join('\n')
}

/**
 * Pick discovery results by index, by path substring, or wholesale. Indices
 * refer to the numbered `/roots discover` output, so the user always selects
 * from a list they have just seen; there is no implicit "add everything".
 * @param candidates - the numbered candidate list.
 * @param args - command arguments.
 * @returns `{ selected }` or `{ error }`.
 */
export function selectCandidates(candidates, args) {
  if (args.length === 0) return { error: '用法：/roots adopt <编号…> | --all | <路径片段>' }
  if (args.length === 1 && args[0] === '--all') return { selected: [...candidates] }
  const selected = []
  for (const arg of args) {
    if (/^\d+$/u.test(arg)) {
      const index = Number.parseInt(arg, 10)
      if (index < 1 || index > candidates.length) return { error: `编号 ${arg} 超出范围（1–${candidates.length}）` }
      selected.push(candidates[index - 1])
      continue
    }
    const hits = candidates.filter(candidate => candidate.canonical.includes(arg))
    if (hits.length === 0) return { error: `没有匹配 "${arg}" 的候选` }
    selected.push(...hits)
  }
  const seen = new Set()
  const deduped = []
  for (const candidate of selected) {
    if (seen.has(candidate.canonical)) continue
    seen.add(candidate.canonical)
    deduped.push(candidate)
  }
  return { selected: deduped }
}

/**
 * Format the tail of the audit log.
 * @param table - the root table.
 * @param limit - how many trailing records to show.
 * @returns the human-readable log tail.
 */
export function renderAudit(table, limit = 10) {
  let text
  try {
    text = readFileSync(table.auditPath, 'utf8')
  } catch {
    return '还没有审计记录（改动根时才会写）'
  }
  const lines = text.split('\n').filter(line => line.trim() !== '').slice(-limit)
  if (lines.length === 0) return '还没有审计记录（改动根时才会写）'
  return lines.map(line => {
    try {
      const record = JSON.parse(line)
      const detail = record.added !== undefined
        ? ` +${record.added.length}${Array.isArray(record.sources) ? ` (${[...new Set(record.sources)].join(',')})` : ''}`
        : record.roots !== undefined
          ? ` set ${record.roots.length}`
          : record.removed !== undefined ? ` -${record.removed.length}` : record.dropped !== undefined ? ` -${record.dropped.length}` : ''
      return `${record.at}  ${String(record.action).padEnd(7)} ${record.workspace}${detail}`
    } catch {
      return line
    }
  }).join('\n')
}

/**
 * Re-validate every configured workspace without changing anything.
 * @param table - the root table.
 * @returns the report.
 */
export function renderCheck(table) {
  const workspaces = table.workspaces()
  if (workspaces.length === 0) return '还没有任何工作区配置副根'
  const lines = []
  for (const workspace of workspaces) {
    lines.push(workspace)
    const accepted = []
    for (const entry of table.state.workspaces[workspace] ?? []) {
      const verdict = validateGrant(entry, { workspaceRoot: workspace, existing: accepted })
      if (verdict.ok) {
        accepted.push(verdict.canonical)
        lines.push(`  ✓ ${entry}`)
      } else {
        lines.push(`  ✗ ${entry} — ${verdict.error}`)
      }
    }
  }
  return lines.join('\n')
}

/**
 * Format the `/roots prune` report.
 * @param result - the `RootTable.prune()` result.
 * @returns the human-readable report.
 */
export function renderPrune(result) {
  if (result.dropped.length === 0 && result.skipped.length === 0) return '没有失效副根'
  const lines = []
  if (result.dropped.length > 0) {
    lines.push(`${result.dryRun ? '将移除' : '已移除'} ${result.dropped.length} 条失效副根：`)
    for (const item of result.dropped) lines.push(`  - ${item.workspace}  ${item.entry}  — ${item.error}`)
  }
  for (const item of result.skipped) lines.push(`跳过 ${item.workspace}：${item.reason}`)
  if (result.dryRun && result.dropped.length > 0) lines.push('（dry-run：未写入；去掉 --dry-run 才会移除）')
  return lines.join('\n')
}

/**
 * Register the `/roots` command on the plugin context.
 *
 * The last discovery list is kept per workspace in this closure, so
 * `/roots adopt <n>` always refers to the numbering the user just saw.
 *
 * @param ctx - the plugin context (`commands` is injected here).
 * @param table - the root table the handlers mutate.
 */
export function registerRootsCommand(ctx, table) {
  // Last `/roots discover` list per workspace, so `/roots adopt <n>` refers to
  // the numbering the user just saw.
  const discovery = new Map()

  ctx.inject(['commands'], scope => {
    scope.commands.register({
      name: 'roots',
      description: '管理当前工作区的副可写根（多根插件）',
      input: { hint: '[list|add <abs-dir>|remove <abs-dir>|set <abs-dir>…|clear|reload|discover|adopt|check|prune|audit]' },
      handler: ({ agent, rawInput }) => {
        const cwd = agent?.session?.header?.cwd
        if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
          return { kind: 'error', text: '这个会话没有绝对 cwd，无法确定工作区' }
        }
        const [subcommand = 'list', ...rest] = splitArgs(rawInput)
        const existing = table.storedFor(cwd)
        const workspace = canonicalPath(cwd)
        const anchoringKey = table.keyFor(cwd)
        const anchor = anchoringKey === workspace ? undefined : anchoringKey
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
              '/roots discover — 只读发现候选（worktree / .code-workspace / 并列仓库）',
              '/roots adopt <编号…> | --all | <片段> — 采纳选中的候选（写审计）',
              '/roots check — 复验所有工作区的现有配置',
              '/roots prune [--dry-run] — 移除所有工作区里已失效的副根（写审计）',
              '/roots audit [n] — 看最近 n 条审计（默认 10）',
              '改动立即生效，无需重启。',
            ].join('\n'),
          }
        }
        if (subcommand === 'clear') {
          table.setRoots(cwd, [])
          table.audit({ at: new Date().toISOString(), action: 'clear', workspace, key: anchor, session: agent?.session?.header?.id })
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
          table.audit({ at: new Date().toISOString(), action: 'add', workspace, key: anchor, added, session: agent?.session?.header?.id })
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
          table.audit({ at: new Date().toISOString(), action: 'set', workspace, key: anchor, roots: next, session: agent?.session?.header?.id })
          return { kind: 'success', text: `已替换\n${renderList(table, cwd)}` }
        }
        if (subcommand === 'remove') {
          if (rest.length === 0) return fail('用法：/roots remove <绝对目录>')
          const targets = rest.map(entry => canonicalPath(resolvePath(entry)))
          const kept = existing.filter(entry => !targets.includes(canonicalPath(entry)))
          if (kept.length === existing.length) return fail(`没有匹配的副根：${rest.join(' ')}`)
          table.setRoots(cwd, kept)
          table.audit({ at: new Date().toISOString(), action: 'remove', workspace, key: anchor, removed: targets, session: agent?.session?.header?.id })
          return { kind: 'success', text: `已移除\n${renderList(table, cwd)}` }
        }
        if (subcommand === 'discover') {
          const candidates = discoverCandidates(table.keyFor(cwd))
          discovery.set(workspace, candidates)
          return { kind: 'success', text: renderDiscovery(table, cwd, candidates) }
        }
        if (subcommand === 'adopt') {
          const candidates = discovery.get(workspace) ?? discoverCandidates(table.keyFor(cwd))
          const picked = selectCandidates(candidates, rest)
          if (picked.error !== undefined) return fail(picked.error)
          let current = [...existing]
          const added = []
          const skipped = []
          for (const candidate of picked.selected) {
            const verdict = validateGrant(candidate.canonical, { workspaceRoot: workspace, existing: current })
            if (verdict.ok) {
              current.push(verdict.canonical)
              added.push({ path: verdict.canonical, source: candidate.source })
            } else if (!verdict.error.startsWith('已经配置过')) {
              skipped.push(`${candidate.canonical} — ${verdict.error}`)
            }
          }
          if (added.length === 0) {
            const tail = skipped.length === 0 ? '' : `\n被跳过：\n${skipped.map(item => '  ⛔ ' + item).join('\n')}`
            return { kind: 'success', text: `没有可采纳的候选${tail}` }
          }
          table.setRoots(cwd, current)
          table.audit({
            at: new Date().toISOString(),
            action: 'adopt',
            workspace,
            key: anchor,
            added: added.map(item => item.path),
            sources: added.map(item => item.source),
            session: agent?.session?.header?.id,
          })
          return {
            kind: 'success',
            text: `已采纳 ${added.length} 个\n${added.map(item => `  + ${item.path}  [${item.source}]`).join('\n')}\n${renderList(table, cwd)}`,
          }
        }
        if (subcommand === 'check') {
          return { kind: 'success', text: renderCheck(table) }
        }
        if (subcommand === 'prune') {
          const result = table.prune({ dryRun: rest.includes('--dry-run') })
          const text = renderPrune(result)
          if (!result.changed || result.dryRun) return { kind: 'success', text }
          table.audit({
            at: new Date().toISOString(),
            action: 'prune',
            workspace,
            dropped: result.dropped.map(item => `${item.workspace} ${item.entry}`),
            session: agent?.session?.header?.id,
          })
          return { kind: 'success', text: `${text}\n${renderList(table, cwd)}` }
        }
        if (subcommand === 'audit') {
          const wanted = Number.parseInt(rest[0] ?? '10', 10)
          const limit = Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, 200) : 10
          return { kind: 'success', text: renderAudit(table, limit) }
        }
        return fail(`未知子命令 "${subcommand}"，可用：list add remove set clear reload discover adopt check prune audit help`)
      },
    })
  })
}
