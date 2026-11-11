/**
 * The read-only hardening half (v0.5.0): the merge submits protected paths, and
 * the HOST must consume them.
 *
 * Two kinds of test live here, and the split is the point:
 *   - what this plugin owns (which paths it submits, and that it never widens
 *     a policy behind the host's back) runs always;
 *   - what only the host can prove (bwrap re-binds and the fs fence refusal)
 *     runs against the installed payload and skips when that payload has no
 *     `protectedPaths` contract. A silent skip here is a host capability
 *     report, not a passing guarantee.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RootTable, canonicalPath, decoratePolicy, guardedPathsOf, installResolvePatch } from '../lib/index.js'
import { GUARDED_NAMES } from '../lib/policy.js'

function findHostRepo() {
  if (process.env.DSH_REPO !== undefined && process.env.DSH_REPO !== '') return process.env.DSH_REPO
  const root = join(process.env.HOME ?? '/root', '.local', 'share', 'dsh-desktop')
  const versions = existsSync(root)
    ? readdirSync(root).filter(name => existsSync(join(root, name, 'repo', 'packages', 'sandbox', 'sandbox-local', 'lib', 'index.js')))
    : []
  if (versions.length === 0) return undefined
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return join(root, versions[versions.length - 1], 'repo')
}

const hostRepo = findHostRepo()
const noHost = hostRepo === undefined ? 'no installed DeepSeek Harness payload found (set DSH_REPO)' : false

let modules
if (!noHost) {
  const { Context } = await import(join(hostRepo, 'node_modules/@deepseek-ai/cordis/lib/index.js'))
  const local = await import(join(hostRepo, 'packages/sandbox/sandbox-local/lib/index.js'))
  const policyPackage = await import(join(hostRepo, 'packages/sandbox/sandbox-policy/lib/index.js'))
  const sandbox = await import(join(hostRepo, 'packages/sandbox/sandbox/lib/index.js'))
  modules = {
    Context,
    LocalSandboxProvider: local.default,
    SandboxPolicyService: policyPackage.SandboxPolicyService,
    guardedPaths: sandbox.protectedPaths,
    isPathProtected: sandbox.isPathProtected,
  }
}

/** A workspace plus one granted sibling repo that carries all four guarded dirs. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-multi-root-hardening-'))
  const workspace = join(base, 'project-a')
  const granted = join(base, 'sibling-repo')
  const ungranted = join(base, 'not-granted')
  mkdirSync(join(workspace, '.git'), { recursive: true })
  mkdirSync(join(granted, 'src'), { recursive: true })
  // The host drops declared paths that do not exist (a bind of a missing source
  // aborts the whole confined command), so a real grant carries real dirs.
  for (const name of GUARDED_NAMES) mkdirSync(join(granted, name), { recursive: true })
  mkdirSync(ungranted, { recursive: true })
  const statePath = join(base, 'storages', 'roots.json')
  const table = new RootTable(statePath)
  table.load()
  table.setRoots(workspace, [granted])
  return { base, workspace, granted, ungranted, statePath, table }
}

function policyFor(table, workspace, mode = 'workspace-write') {
  return decoratePolicy({ mode, workspaceRoot: canonicalPath(workspace) }, table)
}

/** The payload advertises the contract by exporting the helpers the backends use. */
const contract = noHost ? false : typeof modules.guardedPaths === 'function'
const noContract = contract ? false : 'installed payload has no protectedPaths contract (apply the host patch)'

test('the guarded directory names are exactly the four housekeeping trees', () => {
  assert.deepEqual(GUARDED_NAMES, ['.git', '.agents', '.codex', '.aws'])
  assert.deepEqual(
    guardedPathsOf(['/srv/a']).map(path => path.replace('/srv/a/', '')),
    ['.git', '.agents', '.codex', '.aws'],
  )
})

test('the merge submits one guarded path per granted root and guarded name', () => {
  const { workspace, granted, table } = fixture()
  const policy = policyFor(table, workspace)
  const expected = GUARDED_NAMES.map(name => join(canonicalPath(granted), name))
  assert.deepEqual(policy.protectedPaths, expected)
  assert.deepEqual(policy.additionalWritableRoots, [canonicalPath(granted)])
})

test('host-declared protected paths are kept, not replaced, and never duplicated', () => {
  const { workspace, granted, table } = fixture()
  const deployment = '/srv/deployment-secrets'
  const mine = join(canonicalPath(granted), '.git')
  const decorated = decoratePolicy({
    mode: 'workspace-write',
    workspaceRoot: canonicalPath(workspace),
    additionalWritableRoots: [],
    protectedPaths: [deployment, mine],
  }, table)
  assert.equal(decorated.protectedPaths[0], deployment)
  assert.equal(decorated.protectedPaths.filter(path => path === mine).length, 1)
  assert.equal(decorated.protectedPaths.length, 1 + GUARDED_NAMES.length)
})

test('read-only and ungranted policies stay untouched', () => {
  const { workspace, table } = fixture()
  const readOnly = policyFor(table, workspace, 'read-only')
  assert.equal(readOnly.protectedPaths, undefined, 'read-only grants nothing, so it protects nothing')
  assert.equal(readOnly.additionalWritableRoots, undefined)
})

test('the real resolve wrapper carries both fields downstream', { skip: noHost }, () => {
  const { workspace, granted, table } = fixture()
  const service = {
    resolve() {
      return { mode: 'workspace-write', workspaceRoot: canonicalPath(workspace) }
    },
  }
  installResolvePatch(service, table).dispose
  const resolved = service.resolve()
  assert.deepEqual(resolved.additionalWritableRoots, [canonicalPath(granted)])
  assert.deepEqual(resolved.protectedPaths, GUARDED_NAMES.map(name => join(canonicalPath(granted), name)))
})

test('the host advertises the contract through protectedPathsSupported', { skip: noContract }, () => {
  const { workspace } = fixture()
  const service = new modules.SandboxPolicyService(new modules.Context(), {})
  const resolved = service.resolve({})
  assert.equal(resolved.protectedPathsSupported, true, 'payload carries the protected-subtrees patch')
})

test('real bwrap: guarded subtrees are read-only, the rest of the grant still writes', { skip: noContract }, async () => {
  const { base, workspace, granted, ungranted, table } = fixture()
  const policy = policyFor(table, workspace)
  assert.ok(modules.guardedPaths(policy).length > 0, 'the patched payload recognizes the declared paths')

  const provider = new modules.LocalSandboxProvider(new modules.Context(), {
    runnerCommand: [],
    runnerFailureSignatures: [],
    probeTimeoutMs: 5_000,
  })
  const confined = await provider.confine(['bash', '-c', 'true'], policy)
  const cut = confined.argv.indexOf('--')
  const prefix = confined.argv.slice(0, cut + 1)
  const write = target => {
    const result = spawnSync(prefix[0], [...prefix.slice(1), 'bash', '-c', `echo payload > ${JSON.stringify(target)} && echo WROTE`], { encoding: 'utf8' })
    return { status: result.status, output: ((result.stdout ?? '') + (result.stderr ?? '')).trim() }
  }

  // Positive: the grant still means what it says.
  const plain = write(join(granted, 'ok.txt'))
  assert.equal(plain.status, 0, `plain write must succeed: ${plain.output}`)
  assert.equal(readFileSync(join(granted, 'ok.txt'), 'utf8').trim(), 'payload')
  const nested = write(join(granted, 'src', 'x.txt'))
  assert.equal(nested.status, 0, `nested write must succeed: ${nested.output}`)

  // Negative: each guarded tree inside the grant is read-only.
  for (const name of GUARDED_NAMES) {
    const target = join(granted, name, 'probe.txt')
    const result = write(target)
    assert.notEqual(result.status, 0, `${name} must be read-only inside a grant`)
    assert.equal(existsSync(target), false, `${name}/probe.txt must not land`)
    assert.match(result.output, /只读文件系统|read-only file system/u)
  }

  // Control: an ungranted sibling stays denied for an unrelated reason.
  const control = write(join(ungranted, 'nope.txt'))
  assert.notEqual(control.status, 0, 'an ungranted sibling stays denied')
  assert.equal(existsSync(join(ungranted, 'nope.txt')), false)

  assert.equal(base.startsWith(tmpdir()), true)
})

test('the fs fence refuses a guarded target and still allows the rest', { skip: noContract }, async () => {
  const { workspace, granted, table } = fixture()
  const policy = policyFor(table, workspace)
  const fence = await import(join(hostRepo, 'packages/fs/fs-sandbox/lib/index.js'))
  const fake = {
    ctx: { sandboxPolicy: { resolve: () => policy } },
    async resolve(displayPath) { return { displayPath, targetKey: displayPath } },
  }
  const check = target => fence.default.prototype.checkedTarget.call(fake, { displayPath: target, targetKey: target }, policy)
  await check(join(granted, 'ok.txt'))
  for (const name of GUARDED_NAMES) {
    await assert.rejects(() => check(join(granted, name, 'probe.txt')), error => {
      assert.equal(error.code, 'FS_SANDBOX_DENIED')
      assert.match(error.message, /protected path/u)
      return true
    })
  }
})
