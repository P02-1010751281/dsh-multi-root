/**
 * C2 coverage: read-only discovery (worktree / .code-workspace / siblings) and
 * the report renderers it feeds. Discovery never writes; every assertion here
 * is about what the user would be offered.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  RootTable,
  canonicalPath,
  discoverCandidates,
  renderAudit,
  renderCheck,
  renderDiscovery,
  selectCandidates,
  stripJsonc,
} from '../lib/index.js'

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

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-multi-root-discover-'))
  const project = join(base, 'project')
  makeRepo(project)
  return { base, project }
}

test('stripJsonc removes comments and trailing commas but not URL strings', () => {
  const source = `{
    // line comment
    "url": "https://example.com//not-a-comment",
    /* block */
    "list": [1, 2, 3,],
  }`
  const parsed = JSON.parse(stripJsonc(source))
  assert.equal(parsed.url, 'https://example.com//not-a-comment')
  assert.deepEqual(parsed.list, [1, 2, 3])
})

test('worktree discovery finds the sibling worktree and not the workspace itself', () => {
  const { base, project } = fixture()
  const worktree = join(base, 'project-wt')
  git(['worktree', 'add', '-q', worktree], project)
  const candidates = discoverCandidates(project)
  assert.ok(candidates.some(item => item.canonical === canonicalPath(worktree) && item.source === 'worktree'))
  assert.ok(!candidates.some(item => item.canonical === canonicalPath(project)))
})

test('.code-workspace folders are resolved relative to the file', () => {
  const { base, project } = fixture()
  const extra = join(base, 'extra-repo')
  mkdirSync(extra)
  writeFileSync(join(project, 'proj.code-workspace'), JSON.stringify({
    folders: [{ path: '.' }, { path: '../extra-repo' }, { path: '/absolute/nowhere' }],
  }, null, 2))
  const candidates = discoverCandidates(project)
  const found = candidates.find(item => item.source === 'code-workspace' && item.canonical === canonicalPath(extra))
  assert.ok(found, 'relative folder must resolve against the workspace file directory')
  assert.ok(!candidates.some(item => item.canonical === canonicalPath(project)), 'the workspace itself is never a candidate')
})

test('sibling discovery reports git checkouts only', () => {
  const { base, project } = fixture()
  const siblingRepo = makeRepo(join(base, 'sibling-repo'))
  mkdirSync(join(base, 'plain-dir'))
  writeFileSync(join(base, 'a-file.txt'), 'x\n')
  const candidates = discoverCandidates(project).filter(item => item.source === 'sibling')
  assert.deepEqual(candidates.map(item => item.canonical), [canonicalPath(siblingRepo)])
})

test('renderDiscovery classifies admittable / configured / rejected candidates', () => {
  const { base, project } = fixture()
  const siblingRepo = makeRepo(join(base, 'sibling-repo'))
  const statePath = join(base, 'storages', 'roots.json')
  const table = new RootTable(statePath)
  table.load()

  const first = renderDiscovery(table, project)
  assert.match(first, /✅ .*sibling-repo/u)
  assert.match(first, /\/roots adopt/u)

  table.setRoots(project, [siblingRepo])
  const second = renderDiscovery(table, project)
  assert.match(second, /✔ .*sibling-repo.*已配置/u)
  assert.doesNotMatch(second, /✅/u)
})

test('renderAudit and renderCheck report stored state and audit lines', () => {
  const { base, project } = fixture()
  const siblingRepo = makeRepo(join(base, 'sibling-repo'))
  const table = new RootTable(join(base, 'storages', 'roots.json'))
  table.load()
  table.setRoots(project, [siblingRepo])
  table.audit({ at: '2026-11-06T00:00:00.000Z', action: 'adopt', workspace: project, added: [siblingRepo], sources: ['sibling'] })

  const audit = renderAudit(table, 5)
  assert.match(audit, /adopt/u)
  assert.match(audit, /\+1 \(sibling\)/u)

  const check = renderCheck(table)
  assert.match(check, /✓ /u)
  // A live directory passes; deleting it must be reported, not thrown.
  const removed = join(base, 'gone-repo')
  mkdirSync(removed)
  table.setRoots(project, [siblingRepo, removed])
  spawnSync('rmdir', [removed])
  const after = renderCheck(table)
  assert.match(after, new RegExp(`✗ ${removed}`, 'u'))
  assert.ok(existsSync(siblingRepo))
})

test('selectCandidates indexes the numbered output and never implies --all', () => {
  const candidates = [
    { canonical: '/x/a', source: 'worktree' },
    { canonical: '/x/b', source: 'sibling' },
    { canonical: '/x/c', source: 'sibling' },
  ]
  assert.deepEqual(selectCandidates(candidates, []).error !== undefined, true)
  assert.deepEqual(selectCandidates(candidates, ['2']).selected.map(c => c.canonical), ['/x/b'])
  assert.deepEqual(selectCandidates(candidates, ['1', '3']).selected.map(c => c.canonical), ['/x/a', '/x/c'])
  assert.deepEqual(selectCandidates(candidates, ['--all']).selected.length, 3)
  assert.deepEqual(selectCandidates(candidates, ['/x/c']).selected.map(c => c.canonical), ['/x/c'])
  assert.deepEqual(selectCandidates(candidates, ['2', '/x/b']).selected.map(c => c.canonical), ['/x/b'])
  assert.match(selectCandidates(candidates, ['9']).error, /超出范围/u)
  assert.match(selectCandidates(candidates, ['nope']).error, /没有匹配/u)
})
