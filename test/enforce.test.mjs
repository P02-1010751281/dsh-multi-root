/**
 * Enforcement proof for dsh-multi-root against the HOST's own sandbox code.
 *
 * This does not simulate the fence: it imports `LocalSandboxProvider` and
 * `writableRoots` from the installed DeepSeek Harness payload, feeds them the
 * policy our `resolve` wrapper produces, spawns the resulting confined argv,
 * and checks whether real writes land.
 *
 * Matrix:
 *   A  workspace-write, no grant      → secondary write must fail
 *   B  workspace-write, one grant     → secondary write must succeed
 *   C  read-only, grant present       → both writes must fail (mode wins)
 *   D  workspace-write, other ws      → workspace B does not inherit A's grant
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RootTable, canonicalPath, installResolvePatch } from '../lib/index.js'

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

const repo = findHostRepo()
const skip = repo === undefined ? 'no installed DeepSeek Harness payload found (set DSH_REPO)' : false

const load = async relative => (await import(join(repo, relative))).default ?? (await import(join(repo, relative)))

let modules
if (!skip) {
  const { Context } = await import(join(repo, 'node_modules/@deepseek-ai/cordis/lib/index.js'))
  const local = await import(join(repo, 'packages/sandbox/sandbox-local/lib/index.js'))
  const sandbox = await import(join(repo, 'packages/sandbox/sandbox/lib/index.js'))
  modules = { Context, LocalSandboxProvider: local.default, writableRoots: sandbox.writableRoots }
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-multi-root-'))
  const workspaceA = join(base, 'project-a')
  const workspaceB = join(base, 'project-b')
  const secondary = join(base, 'sibling-repo')
  for (const dir of [workspaceA, workspaceB, secondary]) mkdirSync(dir, { recursive: true })
  const statePath = join(base, 'storages', 'dsh-multi-root', 'roots.json')
  const table = new RootTable(statePath)
  table.load()
  table.setRoots(workspaceA, [secondary])
  return { base, workspaceA, workspaceB, secondary, statePath, table }
}

/**
 * A stand-in for `SandboxPolicyService` that mirrors its real resolution
 * contract (`workspaceRoot` = session cwd) so the patch is exercised on the
 * shape it actually sees. Deliberately NOT our own code: the assertion is that
 * our wrapper decorates a host-shaped policy.
 */
function stubService() {
  return {
    resolve(request = {}) {
      const cwd = request.session?.header?.cwd
      return {
        mode: request.mode ?? 'workspace-write',
        workspaceRoot: canonicalPath(typeof cwd === 'string' ? cwd : process.cwd()),
        ...request.session === undefined ? {} : { sessionId: request.session.id },
      }
    },
  }
}

function policyFor(service, cwd, mode) {
  return service.resolve({ mode, session: { id: 'session-1', header: { cwd } } })
}

function runConfined(provider, policy, program, args) {
  return provider.confine([program, ...args], policy).then(confined => {
    const result = spawnSync(confined.argv[0], confined.argv.slice(1), { encoding: 'utf8' })
    return { status: result.status, output: ((result.stdout ?? '') + (result.stderr ?? '')).trim(), enforcement: confined.enforcement }
  })
}

test('directory names resolve canonically and symlink aliases are rejected', { skip }, () => {
  const { base, secondary } = fixture()
  const alias = join(base, 'alias')
  symlinkSync(secondary, alias)
  assert.equal(canonicalPath(alias), canonicalPath(secondary))
  assert.notEqual(canonicalPath(alias), alias)
})

test('host writableRoots honors the merged policy only in workspace-write', { skip }, () => {
  const { workspaceA, secondary, table } = fixture()
  const service = stubService()
  installResolvePatch(service, table)

  const writable = policyFor(service, workspaceA)
  assert.deepEqual(writable.additionalWritableRoots, [canonicalPath(secondary)])
  const roots = modules.writableRoots(writable)
  assert.ok(roots.includes(canonicalPath(secondary)), `expected ${secondary} in ${JSON.stringify(roots)}`)

  const readOnly = policyFor(service, workspaceA, 'read-only')
  assert.equal(readOnly.additionalWritableRoots, undefined, 'read-only must not advertise extra roots')
  assert.deepEqual(modules.writableRoots(readOnly), [], 'read-only allows nothing')
})

test('per-workspace isolation: workspace B never inherits A\'s grant', { skip }, () => {
  const { workspaceA, workspaceB, secondary, table } = fixture()
  const service = stubService()
  installResolvePatch(service, table)
  assert.deepEqual(policyFor(service, workspaceB).additionalWritableRoots, undefined)
  assert.deepEqual(policyFor(service, workspaceA).additionalWritableRoots, [canonicalPath(secondary)])
})

test('real confinement matrix A/B/C/D on the host provider', { skip }, async () => {
  const { base, workspaceA, workspaceB, secondary, table } = fixture()
  const service = stubService()
  installResolvePatch(service, table)
  const provider = new modules.LocalSandboxProvider(new modules.Context(), {
    runnerCommand: [],
    runnerFailureSignatures: [],
    probeTimeoutMs: 5_000,
  })

  const writeTo = (policy, dir, name) =>
    runConfined(provider, policy, 'bash', ['-c', `echo payload > ${JSON.stringify(join(dir, name))} && echo WROTE`])

  // A — workspace-write without a grant: the host's own policy object.
  const bare = { mode: 'workspace-write', workspaceRoot: canonicalPath(workspaceA) }
  const denied = await writeTo(bare, secondary, 'a.txt')
  assert.notEqual(denied.status, 0, 'write outside the workspace root must fail')
  assert.ok(!existsSync(join(secondary, 'a.txt')))
  assert.equal(denied.enforcement, 'full')

  // B — the decorated policy from our wrapper.
  const granted = await writeTo(policyFor(service, workspaceA), secondary, 'b.txt')
  assert.equal(granted.status, 0, `granted write must succeed: ${granted.output}`)
  assert.equal(readFileSync(join(secondary, 'b.txt'), 'utf8').trim(), 'payload')

  // B2 — one command writes the primary AND the secondary root (list semantics,
  // the thing a re-rooting plugin cannot do).
  const both = await runConfined(
    provider,
    policyFor(service, workspaceA),
    'bash',
    ['-c', `echo one > ${JSON.stringify(join(workspaceA, 'primary.txt'))}; echo two > ${JSON.stringify(join(secondary, 'both.txt'))} && echo BOTH`],
  )
  assert.equal(both.status, 0, `cross-root write must succeed: ${both.output}`)
  assert.ok(existsSync(join(workspaceA, 'primary.txt')))
  assert.ok(existsSync(join(secondary, 'both.txt')))

  // C — read-only keeps denying even with a grant configured.
  const readOnly = await writeTo(policyFor(service, workspaceA, 'read-only'), secondary, 'c.txt')
  assert.notEqual(readOnly.status, 0, 'read-only must deny the secondary root')
  assert.ok(!existsSync(join(secondary, 'c.txt')))

  // D — workspace B resolves to a policy with no grants.
  const otherWorkspace = await writeTo(policyFor(service, workspaceB), secondary, 'd.txt')
  assert.notEqual(otherWorkspace.status, 0, 'another workspace must not inherit the grant')
  assert.ok(!existsSync(join(secondary, 'd.txt')))

  assert.equal(base.startsWith(tmpdir()), true)
})
