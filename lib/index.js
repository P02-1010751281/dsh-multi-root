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

import { defaultStatePath, RootTable } from './state.js'
import { installResolvePatch } from './policy.js'
import { guardHit } from './guard.js'
import { registerRootsCommand } from './commands.js'

export const name = 'dsh-multi-root'

/** The one service this plugin cannot work without. */
export const inject = ['sandboxPolicy']

export { canonicalPath, pathInside } from './canonical.js'
export { discoverCandidates, stripJsonc } from './discover.js'
export { RootTable, dshHome, defaultStatePath, parseState, serializeState, validateGrant } from './state.js'
export { decoratePolicy, installResolvePatch } from './policy.js'
export { guardHit } from './guard.js'
export { renderAudit, renderCheck, renderDiscovery, renderList, selectCandidates, splitArgs } from './commands.js'

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

  registerRootsCommand(ctx, table)

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
