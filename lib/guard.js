/**
 * Best-effort guard: refuse agent tool calls that name the state directory.
 * A speed bump against a session rooted above `$DSH_HOME`, never a wall — a
 * command that computes the path at runtime is not detectable here.
 *
 * @module dsh-multi-root/guard
 */

import { isAbsolute } from 'node:path'

import { canonicalPath, pathInside } from './canonical.js'

/**
 * Command shapes that can write. Used only to keep the state-file guard from
 * refusing read-only diagnostics (`ls`, `cat`, `stat`, `grep`) that merely
 * mention the path — a blunt path match blocked the plugin's own author from
 * inspecting its state during the first live run.
 */
const WRITE_SHAPED = /(^|[^0-9>])>{1,2}(?!>)|\btee\b|\brm\b|\bmv\b|\bcp\b|\bchmod\b|\bchown\b|\bln\b|\bsed\s+-i|\btruncate\b|\bdd\b|\bpython[0-9.]*\b|\bnode\b|\bperl\b|\binstall\b|\bunlink\b|\bmkdir\b|\btouch\b/u

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
    if ((command.includes(dir) || command.includes(table.statePath)) && WRITE_SHAPED.test(command)) {
      return `拒绝访问 ${dir}：多根配置属于用户，agent 不能通过 shell 修改。`
    }
  }
  return undefined
}
