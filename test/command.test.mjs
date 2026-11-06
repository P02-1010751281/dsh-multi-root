/**
 * End-to-end coverage of the `/roots` command handler through `apply()`.
 *
 * The ctx here is a fake, but it is a *behavioural* fake: it exercises the same
 * registration call the host makes and then invokes the handler the host would
 * invoke, so the discovery cache, the numbered adopt selection, the state
 * write and the audit line are all real code paths.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, canonicalPath } from '../lib/index.js'

function git(args, cwd) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' },
  })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true })
  git(['init', '-q'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '.'], dir)
  git(['commit', '-qm', 'init'], dir)
  return dir
}

function fakeCtx() {
  const commands = []
  const prompts = []
  const sandboxPolicy = {
    resolve(request = {}) {
      const cwd = request.session?.header?.cwd
      return { mode: request.mode ?? 'workspace-write', workspaceRoot: typeof cwd === 'string' ? canonicalPath(cwd) : '/tmp' }
    },
  }
  const scope = {
    commands: { register: definition => commands.push(definition) },
    systemPrompt: {
      getContextOrder: () => 110,
      context: contribution => prompts.push(contribution),
    },
  }
  const ctx = {
    sandboxPolicy,
    get: name => (name === 'sandboxPolicy' ? sandboxPolicy : undefined),
    logger: () => ({ info() {}, warn() {} }),
    effect: fn => fn(),
    inject: (deps, callback) => callback(scope),
    on: () => {},
  }
  return { ctx, commands, prompts }
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-multi-root-command-'))
  const project = makeRepo(join(base, 'project'))
  const worktree = join(base, 'project-wt')
  git(['worktree', 'add', '-q', worktree], project)
  const sibling = makeRepo(join(base, 'sibling-repo'))
  return { base, project, worktree, sibling, statePath: join(base, 'storages', 'dsh-multi-root', 'roots.json') }
}

function invoke(def, cwd, rawInput) {
  return def.handler({ agent: { session: { header: { cwd, id: 'session-fixture' } } }, rawInput })
}

test('the plugin registers /roots and one prompt contribution', () => {
  const { ctx, commands, prompts } = fakeCtx()
  apply(ctx, { statePath: join(tmpdir(), 'dsh-multi-root-noop', 'roots.json') })
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'roots')
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].name, 'dsh-multi-root')
})

test('discover numbers candidates and adopt takes only the chosen index', async () => {
  const { project, worktree, sibling, statePath } = fixture()
  const { ctx, commands } = fakeCtx()
  apply(ctx, { statePath })
  const roots = commands[0]

  const discovered = await invoke(roots, project, ' discover')
  assert.equal(discovered.kind, 'success')
  assert.match(discovered.text, /1\. ✅ .*worktree/u)
  assert.match(discovered.text, /✅/u)
  const lines = discovered.text.split('\n').filter(line => line.includes('✅'))
  assert.ok(lines.length >= 2, `expected worktree + sibling candidates, got:\n${discovered.text}`)

  // Adopt the sibling by its index from the listing above.
  const siblingIndex = lines.findIndex(line => line.includes(canonicalPath(sibling))) + 1
  assert.ok(siblingIndex >= 1)
  const adopted = await invoke(roots, project, ` adopt ${siblingIndex}`)
  assert.equal(adopted.kind, 'success', adopted.text)

  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.deepEqual(state.workspaces[canonicalPath(project)], [canonicalPath(sibling)])
  assert.ok(!existsSync(join(statePath, '..', '..', '..', 'nope')))

  const listed = await invoke(roots, project, ' list')
  assert.match(listed.text, new RegExp(canonicalPath(sibling).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))

  const audit = await invoke(roots, project, ' audit 5')
  assert.match(audit.text, /adopt/u)

  // The worktree is still unadopted: discovery never implies consent.
  assert.ok(!readFileSync(statePath, 'utf8').includes(canonicalPath(worktree)))
})

test('adopt rejects an out-of-range index and a missing argument', async () => {
  const { project, statePath } = fixture()
  const { ctx, commands } = fakeCtx()
  apply(ctx, { statePath })
  const roots = commands[0]
  await invoke(roots, project, ' discover')
  const missing = await invoke(roots, project, ' adopt')
  assert.equal(missing.kind, 'error')
  const tooBig = await invoke(roots, project, ' adopt 99')
  assert.equal(tooBig.kind, 'error')
  assert.match(tooBig.text, /超出范围/u)
})

test('the prompt contribution lists configured roots and stays empty otherwise', async () => {
  const { project, sibling, statePath } = fixture()
  const { ctx, commands, prompts } = fakeCtx()
  apply(ctx, { statePath })
  const roots = commands[0]
  const contribution = prompts[0]
  const session = { agent: { session: { header: { cwd: project } } } }
  assert.equal(contribution.text(session), '')
  await invoke(roots, project, ' add ' + sibling)
  assert.match(contribution.text(session), /Secondary writable roots/u)
  assert.match(contribution.text(session), new RegExp(canonicalPath(sibling).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
})
