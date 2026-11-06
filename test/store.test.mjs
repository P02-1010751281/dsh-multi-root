/**
 * Unit coverage for the parts of dsh-multi-root that do not need a running
 * host: state parsing, grant admission, invalid-entry dropping, the state-file
 * guard, and patch disposal.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  RootTable,
  canonicalPath,
  guardHit,
  installResolvePatch,
  parseState,
  pathInside,
  serializeState,
  splitArgs,
  validateGrant,
} from '../lib/index.js'

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-multi-root-unit-'))
  const workspace = join(base, 'workspace')
  const secondary = join(base, 'secondary')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(secondary, { recursive: true })
  return { base, workspace, secondary, statePath: join(base, 'storages', 'roots.json') }
}

test('state round-trips and rejects untrustworthy shapes', () => {
  const state = { version: 1, workspaces: { '/a': ['/b', '/c'] } }
  assert.deepEqual(parseState(serializeState(state)), state)
  assert.throws(() => parseState('{'), /not valid JSON/u)
  assert.throws(() => parseState('[]'), /JSON object/u)
  assert.throws(() => parseState('{"version":99,"workspaces":{}}'), /unsupported roots file version/u)
  assert.throws(() => parseState('{"version":1,"workspaces":{"/a":"/b"}}'), /must map to an array/u)
  assert.throws(() => parseState('{"version":1,"workspaces":{"relative":[]}}'), /not absolute/u)
})

test('validateGrant admits a physical sibling directory', () => {
  const { workspace, secondary } = fixture()
  const verdict = validateGrant(secondary, { workspaceRoot: workspace, existing: [] })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.canonical, canonicalPath(secondary))
})

test('validateGrant rejects a symlink alias, exactly as the host does', () => {
  const { base, workspace, secondary } = fixture()
  const alias = join(base, 'alias')
  symlinkSync(secondary, alias)
  const verdict = validateGrant(alias, { workspaceRoot: workspace, existing: [] })
  assert.equal(verdict.ok, false)
  assert.match(verdict.error, /物理路径/u)
})

test('validateGrant rejects the dangerous spellings', () => {
  const { base, workspace, secondary } = fixture()
  const reject = (path, pattern, options = {}) => {
    const verdict = validateGrant(path, { workspaceRoot: workspace, existing: [], ...options })
    assert.equal(verdict.ok, false, `${path} must be rejected`)
    assert.match(verdict.error, pattern)
  }
  reject('relative/dir', /绝对路径/u)
  reject(join(base, 'missing'), /无法读取目录/u)
  reject('/', /文件系统根/u)
  reject(homedir(), /home 目录/u)
  reject(base, /home 的祖先|包含当前工作区/u)
  reject(workspace, /就是当前工作区根/u)
  reject(secondary, /已经配置过/u, { existing: [secondary] })
  const nested = join(secondary, 'inner')
  mkdirSync(nested)
  reject(nested, /覆盖|包含关系/u, { existing: [secondary] })
})

test('pathInside compares physical paths', () => {
  const { workspace, secondary } = fixture()
  assert.equal(pathInside(join(workspace, 'a', 'b'), workspace), true)
  assert.equal(pathInside(workspace, workspace), true)
  assert.equal(pathInside(secondary, workspace), false)
  assert.equal(pathInside(join(workspace, '..', 'workspace-evil'), workspace), false)
})

test('RootTable drops invalid entries instead of breaking every call', () => {
  const { base, workspace, secondary, statePath } = fixture()
  const alias = join(base, 'alias')
  symlinkSync(secondary, alias)
  mkdirSync(join(statePath, '..'), { recursive: true })
  writeFileSync(statePath, JSON.stringify({ version: 1, workspaces: { [canonicalPath(workspace)]: [secondary, alias] } }))
  const warnings = []
  const table = new RootTable(statePath, { warn: message => warnings.push(message) })
  table.load()
  assert.deepEqual(table.grantsFor(workspace), [canonicalPath(secondary)])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /跳过无效副根/u)
})

test('the patched resolve restores on dispose', () => {
  const { workspace, secondary, statePath } = fixture()
  const table = new RootTable(statePath)
  table.load()
  table.setRoots(workspace, [secondary])
  const service = {
    resolve(request = {}) {
      return { mode: 'workspace-write', workspaceRoot: request.session.header.cwd }
    },
  }
  const before = service.resolve
  const patch = installResolvePatch(service, table)
  const decorated = service.resolve({ session: { header: { cwd: workspace } } })
  assert.deepEqual(decorated.additionalWritableRoots, [canonicalPath(secondary)])
  patch.dispose()
  assert.equal(service.resolve, before)
  assert.equal(Object.prototype.hasOwnProperty.call(service, 'resolve'), true)
})

test('installing twice on the same target never stacks, and dispose is clean', () => {
  const { workspace, secondary, statePath } = fixture()
  const table = new RootTable(statePath)
  table.load()
  table.setRoots(workspace, [secondary])
  const service = {
    resolve(request = {}) {
      return { mode: 'workspace-write', workspaceRoot: request.session.header.cwd }
    },
  }
  const original = service.resolve
  const first = installResolvePatch(service, table)
  const second = installResolvePatch(service, table)
  assert.equal(first.applied, true)
  assert.equal(second.applied, false, 'a second wrapper on the same target must be a no-op')
  // LIFO disposal (as `apply` does) restores the untouched prototype method.
  second.dispose()
  first.dispose()
  assert.equal(service.resolve, original)
  assert.equal(Object.prototype.hasOwnProperty.call(service, 'resolve'), true)
})

test('guardHit refuses tool calls that name the state directory', () => {
  const { statePath } = fixture()
  const table = new RootTable(statePath)
  table.load()
  const dir = canonicalPath(table.dir)
  assert.match(guardHit({ name: 'write', arguments: { file_path: join(dir, 'roots.json') } }, table), /拒绝访问/u)
  assert.match(guardHit({ name: 'bash', arguments: { command: `rm -rf ${dir}` } }, table), /拒绝访问/u)
  assert.match(guardHit({ name: 'bash', arguments: { command: `echo x > ${dir}/roots.json` } }, table), /拒绝访问/u)
  assert.match(guardHit({ name: 'bash', arguments: { command: `python3 -c 'open("${dir}/roots.json","w")'` } }, table), /拒绝访问/u)
  // 只读诊断不能误伤：路径出现但命令没有写入形状时必须放行。
  assert.equal(guardHit({ name: 'bash', arguments: { command: `ls -la ${dir}` } }, table), undefined)
  assert.equal(guardHit({ name: 'bash', arguments: { command: `cat ${dir}/roots.json 2>/dev/null` } }, table), undefined)
  assert.equal(guardHit({ name: 'bash', arguments: { command: `stat ${dir}` } }, table), undefined)
  assert.equal(guardHit({ name: 'write', arguments: { file_path: join(dir, '..', 'other.json') } }, table), undefined)
  assert.equal(guardHit({ name: 'bash', arguments: { command: 'ls /tmp' } }, table), undefined)
})

test('splitArgs keeps absolute paths intact', () => {
  assert.deepEqual(splitArgs('  add /a /b  '), ['add', '/a', '/b'])
  assert.deepEqual(splitArgs(''), [])
})

test('a class-declared resolve is patched on the prototype, not the instance', () => {
  const { workspace, secondary, statePath } = fixture()
  const table = new RootTable(statePath)
  table.load()
  table.setRoots(workspace, [secondary])
  class PolicyService {
    constructor(root) { this.root = root }
    resolve(request = {}) {
      return { mode: 'workspace-write', workspaceRoot: request.session?.header?.cwd ?? this.root }
    }
  }
  const service = new PolicyService(workspace)
  const facade = Object.create(service)      // cordis-style per-context view
  const patch = installResolvePatch(service, table)
  assert.equal(patch.applied, true)
  assert.equal(Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(service), 'resolve'), true, 'patch must live on the prototype')
  assert.equal(Object.prototype.hasOwnProperty.call(service, 'resolve'), false, 'the instance itself must stay clean')
  const viaFacade = facade.resolve({ session: { header: { cwd: workspace } } })
  assert.deepEqual(viaFacade.additionalWritableRoots, [canonicalPath(secondary)], 'a facade must see the decoration')
  patch.dispose()
  assert.deepEqual(facade.resolve({ session: { header: { cwd: workspace } } }).additionalWritableRoots, undefined)
})

test('prune drops inadmissible grants and keeps the rest', () => {
  const { base, workspace, secondary, statePath } = fixture()
  const gone = join(base, 'gone')
  mkdirSync(join(statePath, '..'), { recursive: true })
  writeFileSync(statePath, JSON.stringify({ version: 1, workspaces: { [canonicalPath(workspace)]: [secondary, gone] } }))
  const table = new RootTable(statePath)
  table.load()
  const result = table.prune()
  assert.equal(result.dropped.length, 1)
  assert.match(result.dropped[0].error, /无法读取目录/u)
  assert.deepEqual(table.storedFor(workspace), [canonicalPath(secondary)])
  const written = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.deepEqual(written.workspaces[canonicalPath(workspace)], [canonicalPath(secondary)])
})

test('prune --dry-run reports the drop list without touching the file', () => {
  const { base, workspace, secondary, statePath } = fixture()
  const gone = join(base, 'gone')
  mkdirSync(join(statePath, '..'), { recursive: true })
  writeFileSync(statePath, JSON.stringify({ version: 1, workspaces: { [canonicalPath(workspace)]: [secondary, gone] } }))
  const table = new RootTable(statePath)
  table.load()
  const before = readFileSync(statePath, 'utf8')
  const result = table.prune({ dryRun: true })
  assert.equal(result.dryRun, true)
  assert.equal(result.dropped.length, 1)
  assert.equal(readFileSync(statePath, 'utf8'), before)
  assert.deepEqual(table.storedFor(workspace), [secondary, gone])
})

test('prune never empties a workspace whose own directory is missing', () => {
  const { base, secondary, statePath } = fixture()
  const unmounted = join(base, 'unmounted')
  mkdirSync(join(statePath, '..'), { recursive: true })
  writeFileSync(statePath, JSON.stringify({ version: 1, workspaces: { [unmounted]: [secondary] } }))
  const table = new RootTable(statePath)
  table.load()
  const result = table.prune()
  assert.equal(result.dropped.length, 0)
  assert.equal(result.skipped.length, 1)
  assert.equal(result.changed, false)
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')).workspaces[unmounted], [secondary])
})
