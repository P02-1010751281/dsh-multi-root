/**
 * Project anchoring: a session opened below a repository root must see the
 * grants recorded for that repository, a session in a sibling repository must
 * not, and a grant recorded for a plain ancestor directory must not leak
 * downwards. These are the properties the 0.2.0 key change exists for, so each
 * one is asserted with its own negative case.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RootTable, canonicalPath, projectRootOf } from '../lib/index.js'

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-multi-root-project-'))
  const repo = join(base, 'repo')
  const sub = join(repo, 'lib', 'deep')
  const sibling = join(base, 'sibling')
  const plain = join(base, 'plain')
  const plainChild = join(plain, 'child')
  const shared = join(base, 'shared')
  for (const dir of [sub, sibling, plainChild, shared]) mkdirSync(dir, { recursive: true })
  mkdirSync(join(repo, '.git'))
  mkdirSync(join(sibling, '.git'))
  return {
    base,
    repo: canonicalPath(repo),
    sub: canonicalPath(sub),
    sibling: canonicalPath(sibling),
    plain: canonicalPath(plain),
    plainChild: canonicalPath(plainChild),
    shared: canonicalPath(shared),
    statePath: join(base, 'storages', 'roots.json'),
  }
}

test('projectRootOf walks up to the repository root and stops there', () => {
  const { base, repo, sub, sibling, plain, plainChild } = fixture()
  assert.equal(projectRootOf(sub), repo)
  assert.equal(projectRootOf(repo), repo)
  assert.equal(projectRootOf(sibling), sibling, '每个仓库是自己的根')
  assert.equal(projectRootOf(plainChild), plainChild, '不在仓库里时就是自己')
  assert.equal(projectRootOf(plain), plain)
  assert.equal(projectRootOf(base), base)
})

test('projectRootOf accepts a .git file (worktree or submodule)', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-multi-root-worktree-'))
  const worktree = join(base, 'worktree')
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/one\n')
  assert.equal(projectRootOf(join(worktree, 'src')), canonicalPath(worktree))
})

test('a session below the repository root inherits the repository grants', () => {
  const { repo, sub, shared, statePath } = fixture()
  const table = new RootTable(statePath)
  table.load()
  table.setRoots(repo, [shared])

  assert.deepEqual(table.storedFor(repo), [shared])
  assert.deepEqual(table.storedFor(sub), [shared], '子目录会话必须继承仓库根的授权')
  assert.deepEqual(table.grantsFor(sub), [shared])
})

test('a sibling repository inherits nothing', () => {
  const { repo, sibling, shared, statePath } = fixture()
  const table = new RootTable(statePath)
  table.load()
  table.setRoots(repo, [shared])

  assert.deepEqual(table.storedFor(sibling), [], '兄弟仓库不得继承')
  assert.deepEqual(table.grantsFor(sibling), [])
})

test('a grant recorded for a plain ancestor directory does not leak downwards', () => {
  const { plain, plainChild, shared, statePath } = fixture()
  const table = new RootTable(statePath)
  table.load()
  table.setRoots(plain, [shared])

  assert.deepEqual(table.storedFor(plain), [shared])
  assert.deepEqual(table.storedFor(plainChild), [], '只沿仓库根继承，不沿任意祖先继承')
})

test('an exact entry still wins over the repository entry', () => {
  const { repo, sub, shared, sibling, statePath } = fixture()
  const table = new RootTable(statePath)
  table.load()
  table.setRoots(repo, [shared])
  // 旧版本按精确 cwd 存的条目：手工补一条，验证它优先于仓库根的
  table.state.workspaces[sub] = [sibling]

  assert.deepEqual(table.storedFor(sub), [sibling])
})

test('setRoots from a subdirectory stores at the repository root and migrates the old key', () => {
  const { repo, sub, shared, sibling, statePath } = fixture()
  const table = new RootTable(statePath)
  table.load()
  table.state.workspaces[sub] = [shared] // 0.1.x 留下的精确键
  table.save()

  table.setRoots(sub, [sibling])

  assert.deepEqual(table.workspaces(), [repo], '旧键被迁走，不留下重复的一批根')
  assert.deepEqual(table.storedFor(repo), [sibling])
  assert.deepEqual(table.storedFor(sub), [sibling])
})

test('keyFor reports the anchoring key used for storage', () => {
  const { repo, sub, plain, statePath } = fixture()
  const table = new RootTable(statePath)
  table.load()
  assert.equal(table.keyFor(sub), repo)
  assert.equal(table.keyFor(plain), plain)
})

test('grants are validated against the session cwd, not the storage key', () => {
  const { repo, sub, statePath } = fixture()
  const table = new RootTable(statePath)
  table.load()
  // 手工把「会话自己的 cwd」写成仓库根的授权：子目录会话必须丢掉它（自身无需授权），
  // 若校验用的是存储键(仓库根)，这条会被当成合法授权放行。
  table.state.workspaces[repo] = [sub]

  assert.deepEqual(table.grantsFor(sub), [], '自身目录不是可授予的副根')
})
