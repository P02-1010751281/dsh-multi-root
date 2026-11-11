/**
 * The settings-UI bridge: it must expose the same admission rules as the typed
 * command, refuse what `/roots add` refuses, and record a UI edit as such. These
 * tests drive the handler with real `Request` objects and a real `RootTable`, so
 * a bypass introduced in the route shows up here.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RootTable, canonicalPath } from '../lib/index.js'
import { ROUTE_PATH, createRootsRoute } from '../lib/route.js'

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-multi-root-route-'))
  const repo = join(base, 'repo')
  const sub = join(repo, 'deep', 'sub')
  const shared = join(base, 'shared')
  for (const dir of [sub, shared]) mkdirSync(dir, { recursive: true })
  mkdirSync(join(repo, '.git'))
  const statePath = join(base, 'storages', 'roots.json')
  const table = new RootTable(statePath)
  table.load()
  return {
    base,
    repo: canonicalPath(repo),
    shared: canonicalPath(shared),
    statePath,
    table,
    fetch: createRootsRoute({ table }),
  }
}

function get(fetch) {
  return fetch(new Request(`http://localhost${ROUTE_PATH}`, { method: 'GET' }))
}

function post(fetch, body) {
  return fetch(new Request(`http://localhost${ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

test('the route is below /api so the authenticated bridge owns it', () => {
  assert.match(ROUTE_PATH, /^\/api\//u)
})

test('GET reports an empty state before anything is configured', async () => {
  const { fetch } = fixture()
  const response = await get(fetch)
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).anchors, [])
})

test('POST add writes the grant, records the audit surface, and the card sees it', async () => {
  const { fetch, repo, shared, table } = fixture()
  const response = await post(fetch, { action: 'add', anchor: repo, path: shared })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.anchors, [{ key: repo, roots: [{ path: shared, ok: true }] }])
  assert.deepEqual(table.storedFor(repo), [shared])

  const audit = readFileSync(table.auditPath, 'utf8').trim().split('\n')
  assert.equal(audit.length, 1)
  const record = JSON.parse(audit[0])
  assert.equal(record.action, 'add')
  assert.equal(record.surface, 'settings')
  assert.deepEqual(record.added, [shared])
})

test('POST add refuses what the typed command refuses', async () => {
  const { fetch, repo } = fixture()
  const inside = await post(fetch, { action: 'add', anchor: repo, path: repo })
  assert.equal(inside.status, 400)
  assert.match((await inside.json()).error, /就是当前工作区根/u)

  const relative = await post(fetch, { action: 'add', anchor: repo, path: 'relative/dir' })
  assert.equal(relative.status, 400)
  assert.match((await relative.json()).error, /绝对路径/u)
})

test('POST add refuses a non-object or malformed body', async () => {
  const { fetch } = fixture()
  const bad = await fetch(new Request(`http://localhost${ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  }))
  assert.equal(bad.status, 400)
})

test('POST remove drops the grant and the anchor disappears', async () => {
  const { fetch, repo, shared } = fixture()
  await post(fetch, { action: 'add', anchor: repo, path: shared })
  const response = await post(fetch, { action: 'remove', anchor: repo, path: shared })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).anchors, [])
})

test('POST remove of an unknown grant or unconfigured anchor is refused', async () => {
  const { fetch, repo, shared } = fixture()
  await post(fetch, { action: 'add', anchor: repo, path: shared })
  const missing = await post(fetch, { action: 'remove', anchor: repo, path: shared })
  assert.equal(missing.status, 200)
  const again = await post(fetch, { action: 'remove', anchor: repo, path: shared })
  assert.equal(again.status, 404)
  const unknownAnchor = await post(fetch, { action: 'remove', anchor: '/nope/nope', path: shared })
  assert.equal(unknownAnchor.status, 404)
})

test('POST rejects an unknown action', async () => {
  const { fetch, repo } = fixture()
  const response = await post(fetch, { action: 'nuke', anchor: repo })
  assert.equal(response.status, 400)
})

test('GET surfaces a stored grant that no longer validates', async () => {
  const { fetch, repo, table } = fixture()
  table.state.workspaces[repo] = ['/definitely/not/here']
  table.save()
  const body = await (await get(fetch)).json()
  assert.equal(body.anchors[0].roots[0].ok, false)
  assert.equal(typeof body.anchors[0].roots[0].error, 'string')
})
