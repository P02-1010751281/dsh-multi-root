/**
 * The policy merge: the workspace's configured roots become
 * `additionalWritableRoots` on the host's resolved policy, and that merge is
 * installed as a wrapper on the service the enforcing consumers actually call.
 *
 * The merge also submits `protectedPaths`: the repository-internal directories
 * an agent must not rewrite even though its root is writable (git hooks are
 * executable, `.agents`/`.codex`/`.aws` hold instructions and credentials). A
 * policy can only ADD whole directories, so this half needs a host that
 * consumes the field; `protectedPathsSupported` on the resolved policy is how
 * the host advertises it, and the plugin stays honest when it is absent.
 *
 * @module dsh-multi-root/policy
 */

import { join } from 'node:path'

/** Marks a resolve wrapper this plugin installed, so two candidate objects never stack. */
const PATCH_MARK = Symbol.for('dsh-multi-root.resolve.patched')

/**
 * Directory names kept read-only inside every granted root. `.git` because
 * hooks and config are executable content; the other three because they carry
 * agent instructions and credentials that must not be rewritten by a session
 * that merely happens to hold a writable root.
 */
export const GUARDED_NAMES = ['.git', '.agents', '.codex', '.aws']

/**
 * The guarded paths of a set of granted roots.
 * @param roots - canonical granted roots.
 * @returns one path per root and guarded name, order preserved.
 */
export function guardedPathsOf(roots) {
  return roots.flatMap(root => GUARDED_NAMES.map(name => join(root, name)))
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
  // A deployment may already protect its own paths; ours are additive, never
  // a replacement, and duplicates are collapsed.
  const guarded = [...new Set([...(policy.protectedPaths ?? []), ...guardedPathsOf(extra)])]
  return { ...policy, additionalWritableRoots: merged, protectedPaths: guarded }
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
  // Patch the PROTOTYPE when the service declares `resolve` there. The first
  // live run proved why: `ctx.sandboxPolicy` and `ctx.get('sandboxPolicy')`
  // return different objects (proxies around the same service), and writing an
  // own property through that proxy never reached the instance the host's own
  // prompt renderer and the enforcing tools call. A prototype patch is visible
  // from every facade, proxy and instance of the class.
  const proto = Object.getPrototypeOf(service)
  const onPrototype = proto !== null && proto !== Object.prototype && Object.prototype.hasOwnProperty.call(proto, 'resolve')
  const target = onPrototype ? proto : service
  if (typeof target.resolve === 'function' && target.resolve[PATCH_MARK] === true) {
    return { applied: false, dispose() {} }
  }
  const original = target.resolve
  const hadOwn = Object.prototype.hasOwnProperty.call(target, 'resolve')
  const previous = hadOwn ? target.resolve : undefined
  const patched = function (request = {}) {
    // `call(this)` keeps per-instance state (session overrides, deployment root)
    // working when the method is invoked on an instance while defined on the proto.
    return decoratePolicy(original.call(this, request), table)
  }
  Object.defineProperty(patched, PATCH_MARK, { value: true })
  Object.defineProperty(target, 'resolve', {
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
        Object.defineProperty(target, 'resolve', { configurable: true, writable: true, enumerable: false, value: previous })
      } else {
        delete target.resolve
      }
    },
  }
}
