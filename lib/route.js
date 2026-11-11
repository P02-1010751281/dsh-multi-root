/**
 * The settings-UI bridge: one authenticated HTTP endpoint that the browser half
 * calls to read and change this plugin's roots.
 *
 * It exists because the browser cannot touch the state file, and it must not be
 * a way around the admission rules: every write goes through the same
 * `validateGrant` path `/roots add` uses, and every change lands in the audit
 * log with `surface: "settings"` so a UI edit is distinguishable from a typed
 * command.
 *
 * The route is registered on `ctx.connection.fetch`, not on the raw web server:
 * that bridge admits only the owner peer (it answers 403 for every other
 * principal). A raw web-server route would sit in front of `/api` unauthenticated.
 *
 * @module dsh-multi-root/route
 */

import { canonicalPath } from './canonical.js'
import { discoverCandidates } from './discover.js'
import { projectRootOf } from './project.js'
import { validateGrant } from './state.js'

/** Path below `/api`; the browser half calls it document-relatively. */
export const ROUTE_PATH = '/api/multi-root/roots'

/**
 * @param entry - one stored grant.
 * @param anchor - the workspace the grant is validated against.
 * @returns the grant with its current verdict.
 */
function describe(entry, anchor) {
  const verdict = validateGrant(entry, { workspaceRoot: anchor, existing: [] })
  return verdict.ok
    ? { path: verdict.canonical, ok: true }
    : { path: entry, ok: false, error: verdict.error }
}

/**
 * @param table - the root table.
 * @returns the full state as the UI needs it.
 */
export function describeState(table) {
  const anchors = table.workspaces().map(key => ({
    key,
    roots: table.storedFor(key).map(entry => describe(entry, key)),
  }))
  return {
    version: 1,
    statePath: table.statePath,
    loadError: table.loadError ?? null,
    anchors,
  }
}

/** @returns a JSON response with no caching. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Build the fetch handler registered on the connection bridge.
 * @param options - the root table used for reads and writes.
 * @returns an async `fetch(request)` handler.
 */
export function createRootsRoute({ table }) {
  return async function fetchRoots(request) {
    if (request.method === 'GET' || request.method === 'HEAD') {
      return json(describeState(table))
    }
    if (request.method !== 'POST') return json({ error: '只支持 GET/HEAD/POST' }, 405)
    let body
    try {
      body = await request.json()
    } catch {
      return json({ error: '请求体不是合法 JSON' }, 400)
    }
    if (body === null || typeof body !== 'object') return json({ error: '请求体必须是对象' }, 400)
    const action = body.action
    // Grants live under the repository root, so a clicked sub-directory anchors
    // on the same key `/roots add` would use instead of creating a dead entry.
    const anchor = typeof body.anchor === 'string' ? projectRootOf(canonicalPath(body.anchor)) : undefined
    if (typeof anchor !== 'string' || !anchor.startsWith('/')) return json({ error: '缺少绝对的 anchor' }, 400)
    // The action is checked before the anchor lookup: a malformed request is a
    // 400 whatever the anchor happens to be.
    if (action !== 'add' && action !== 'remove' && action !== 'clear' && action !== 'discover') {
      return json({ error: `未知 action：${String(action)}` }, 400)
    }
    if (action !== 'add' && action !== 'discover' && !table.workspaces().includes(anchor)) {
      return json({ error: `没有配置过的项目：${anchor}` }, 404)
    }
    const at = new Date().toISOString()
    const existing = [...table.storedFor(anchor)]

    // Read-only: it proposes, it never writes and never audits. The client uses
    // it to fill the project-row menu with the same candidates `/roots discover`
    // prints, each carrying the verdict `validateGrant` already gave it.
    if (action === 'discover') {
      const taken = new Set(existing.map(entry => canonicalPath(entry)))
      const candidates = discoverCandidates(anchor).map(candidate => {
        const path = canonicalPath(candidate.path)
        const verdict = validateGrant(path, { workspaceRoot: anchor, existing })
        return {
          path,
          source: candidate.source,
          detail: candidate.detail,
          granted: taken.has(path),
          ok: verdict.ok,
          ...verdict.ok ? {} : { error: verdict.error },
        }
      })
      return json({ ...describeState(table), anchor, candidates })
    }

    if (action === 'add') {
      const spelled = typeof body.path === 'string' ? body.path.trim() : ''
      if (spelled === '') return json({ error: '缺少 path' }, 400)
      const verdict = validateGrant(spelled, { workspaceRoot: anchor, existing })
      if (!verdict.ok) return json({ error: verdict.error }, 400)
      table.setRoots(anchor, [...existing, verdict.canonical])
      table.audit({ at, action: 'add', workspace: anchor, added: [verdict.canonical], surface: 'settings' })
      return json(describeState(table))
    }
    if (action === 'remove') {
      const target = canonicalPath(typeof body.path === 'string' ? body.path.trim() : '')
      const kept = existing.filter(entry => canonicalPath(entry) !== target)
      if (kept.length === existing.length) return json({ error: `没有匹配的副根：${target}` }, 404)
      table.setRoots(anchor, kept)
      table.audit({ at, action: 'remove', workspace: anchor, removed: [target], surface: 'settings' })
      return json(describeState(table))
    }
    if (action === 'clear') {
      table.setRoots(anchor, [])
      table.audit({ at, action: 'clear', workspace: anchor, surface: 'settings' })
      return json(describeState(table))
    }
    return json({ error: `未知 action：${String(action)}` }, 400)
  }
}
