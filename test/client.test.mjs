/**
 * The browser half is a classic script served verbatim, so nothing else catches
 * a contract break: an ESM `import` would silently fail to parse in the shell's
 * script tag, and a `require` outside the frozen platform table resolves to
 * nothing at runtime. Both are asserted here against the bytes we ship.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** The shell's frozen module table (`packages/client/web/src/platform.ts`). */
const PLATFORM_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

test('the bundle registers itself through the module loader, not as an ES module', () => {
  assert.match(SOURCE, /window\.__ModuleLoader__\.load\(\{/u)
  assert.match(SOURCE, /id: 'dsh-multi-root'/u)
  assert.match(SOURCE, /factory\(require\)/u)
  assert.doesNotMatch(SOURCE, /^\s*import\s/mu, '经典脚本里不能有 import')
  assert.doesNotMatch(SOURCE, /^\s*export\s/mu, '经典脚本里不能有 export')
})

test('every require() names a module the shell actually shares', () => {
  const requested = [...SOURCE.matchAll(/require\(['"]([^'"]+)['"]\)/gu)].map(match => match[1])
  assert.ok(requested.length > 0, '至少 require 一次')
  for (const name of requested) {
    assert.ok(PLATFORM_MODULES.has(name), `不在平台模块表里：${name}`)
  }
})

test('the card is registered in the settings slot it declares', () => {
  assert.match(SOURCE, /ctx\.slots\.inject\('settings\.section'/u)
  assert.match(SOURCE, /name: 'settings\.section'/u)
  assert.match(SOURCE, /inject: \['slots', 'contextMenus'\]/u)
})

test('the project-row menu is one contribution for workspace targets, not a slot', () => {
  assert.match(SOURCE, /ctx\.contextMenus\.register\(\{/u)
  assert.match(SOURCE, /target: 'workspace'/u)
  assert.equal([...SOURCE.matchAll(/ctx\.slots\.inject\('/gu)].length, 1, '仍然只有一个 slot 注册')
})

test('the bundle loads in a classic-script sandbox and registers the card', async () => {
  const vm = await import('node:vm')
  let captured
  const sandbox = {
    window: { __ModuleLoader__: { load: options => { captured = options } } },
    console,
  }
  vm.runInNewContext(SOURCE, sandbox)
  assert.ok(captured !== undefined, '必须调用 __ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-multi-root')
  assert.equal(typeof captured.factory, 'function')

  // 只用平台模块表里的 react，这里给出最小替身，验证 factory 返回的是 cordis 插件形状。
  const React = {
    createElement: () => null,
    useState: value => [value, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
  }
  const plugin = captured.factory(name => (name === 'react' ? React : undefined))
  // 跨 realm 数组的原型不同，deepEqual 会误报；按内容比较。
  assert.equal(Array.from(plugin.inject).join(','), 'slots,contextMenus')
  assert.equal(typeof plugin.apply, 'function')

  const registered = []
  const menus = []
  const notices = []
  plugin.apply({
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => registered.push({ options, component }),
    },
    contextMenus: {
      register: options => { menus.push(options); return () => {} },
      notify: (text, success) => notices.push({ text, success }),
    },
  })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'settings.section')
  assert.equal(registered[0].options.id, 'multi-root')
  assert.equal(typeof registered[0].options.label(), 'string')
  assert.equal(typeof registered[0].component, 'function')

  assert.equal(menus.length, 1)
  assert.equal(menus[0].id, 'multi-root.workspace')
  assert.equal(menus[0].target, 'workspace')
  assert.equal(typeof menus[0].resolve, 'function')
})

test('the menu resolves to in-place add/remove actions over the one route', async () => {
  const vm = await import('node:vm')
  let captured
  const requests = []
  const replies = []
  const notices = []
  const sandbox = {
    window: { __ModuleLoader__: { load: options => { captured = options } } },
    console,
    fetch: async (route, init) => {
      requests.push({ route, init })
      const body = replies.shift() ?? {}
      return { ok: true, status: 200, json: async () => body }
    },
  }
  vm.runInNewContext(SOURCE, sandbox)
  const React = {
    createElement: () => null,
    useState: value => [value, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
  }
  const plugin = captured.factory(name => (name === 'react' ? React : undefined))
  let menu
  plugin.apply({
    slots: { inject: () => {}, register: () => {} },
    contextMenus: { register: options => { menu = options; return () => {} }, notify: (text, success) => notices.push({ text, success }) },
  })

  replies.push({
    anchors: [{ key: '/repo', roots: [{ path: '/extra', ok: true }] }],
    candidates: [
      { path: '/sib', source: 'sibling', ok: true, granted: false, detail: '并列仓库' },
      { path: '/taken', source: 'worktree', ok: true, granted: true },
    ],
  })
  const actions = await menu.resolve({ workspaceId: 'w1', path: '/repo', displayTitle: 'repo' })
  assert.equal(actions.length, 1)
  assert.equal(actions[0].label, '多可写根')
  const labels = Array.from(actions[0].children).map(child => child.label)
  assert.deepEqual(labels, ['✓ /extra', '添加 /sib（sibling）', '移除 /extra'])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].route, 'api/multi-root/roots')
  assert.deepEqual(JSON.parse(requests[0].init.body), { action: 'discover', anchor: '/repo' })

  const add = actions[0].children.find(child => String(child.label).startsWith('添加'))
  replies.push({ anchors: [], candidates: [] })
  await add.run()
  assert.deepEqual(JSON.parse(requests[1].init.body), { action: 'add', anchor: '/repo', path: '/sib' })
  assert.equal(notices.at(-1).success, true)
  assert.match(notices.at(-1).text, /已添加 \/sib/u)
})

test('the menu says so when the route refuses, instead of failing silently', async () => {
  const vm = await import('node:vm')
  let captured
  const notices = []
  const sandbox = {
    window: { __ModuleLoader__: { load: options => { captured = options } } },
    console,
    fetch: async () => ({ ok: false, status: 400, json: async () => ({ error: '该目录包含当前工作区' }) }),
  }
  vm.runInNewContext(SOURCE, sandbox)
  const React = { createElement: () => null, useState: v => [v, () => {}], useEffect: () => {}, useCallback: fn => fn }
  const plugin = captured.factory(name => (name === 'react' ? React : undefined))
  let menu
  plugin.apply({
    slots: { inject: () => {}, register: () => {} },
    contextMenus: { register: options => { menu = options; return () => {} }, notify: (text, success) => notices.push({ text, success }) },
  })
  const actions = await menu.resolve({ workspaceId: 'w', path: '/repo', displayTitle: 'repo' })
  assert.equal(actions[0].disabled, true)
  assert.match(actions[0].label, /该目录包含当前工作区/u)
})
