/**
 * The browser half is a classic script served verbatim, so nothing else catches
 * a contract break: an ESM `import` would silently fail to parse in the shell's
 * script tag, and a `require` outside the frozen platform table resolves to
 * nothing at runtime. Both are asserted here against the bytes we ship.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/** The installed payload, when there is one — the field the shell actually ships. */
function findHostRepo() {
  if (process.env.DSH_REPO !== undefined && process.env.DSH_REPO !== '') return process.env.DSH_REPO
  const root = join(process.env.HOME ?? '/root', '.local', 'share', 'dsh-desktop')
  const versions = existsSync(root)
    ? readdirSync(root).filter(name => existsSync(join(root, name, 'repo', 'packages', 'client', 'ui-primitives', 'lib', 'index.js')))
    : []
  if (versions.length === 0) return undefined
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return join(root, versions[versions.length - 1], 'repo')
}

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

/** Stand-ins for the shell primitives the bundle renders; only identity matters here. */
const PRIMITIVES = Object.fromEntries([
  'Button', 'PathLabel', 'StateDot',
  'IconFolderOpenOutlineRegular', 'IconPlusOutlineRegular', 'IconRefreshOutlineRegular',
  'IconTrashOutlineRegular', 'IconWarningOutlineRegular',
  'PermissionIconReadOnlyRegular', 'PermissionIconWorkspaceWriteMedium', 'PermissionIconWorkspaceWriteRegular',
].map(name => [name, () => null]))

/** The frozen platform table as the sandbox sees it, with the two modules asserted above. */
function platformModules(React) {
  return name => (name === 'react'
    ? React
    : name === '@deepseek-ai/dsh-client-ui-primitives'
      ? PRIMITIVES
      : name === 'react/jsx-runtime' ? {} : undefined)
}

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
  const sectionSlots = [...SOURCE.matchAll(/ctx\.slots\.inject\('settings\.section'/gu)]
  assert.equal(sectionSlots.length, 1, '设置卡片仍然只注册一次')
  // The nav glyph is a separate slot keyed by the section id: without it the
  // shell paints its default glyph, which is what "缺少图标" looked like.
  assert.match(SOURCE, /ctx\.slots\.inject\('settings\.section\.icon'/u)
  assert.match(SOURCE, /name: 'settings\.section\.icon',\s*\n\s*id: 'multi-root'/u)
  // Menu glyphs are addressed by action id, so every action needs a key here.
  assert.match(SOURCE, /ctx\.slots\.inject\('contextMenu\.icon'/u)
  for (const key of ['multi-root.menu', 'multi-root.root', 'multi-root.none', 'multi-root.add', 'multi-root.remove', 'multi-root.unreachable']) {
    assert.ok(SOURCE.includes(`'${key}'`), `菜单图标键缺失：${key}`)
  }
})

/** Every primitive this bundle destructures, read straight from the bytes. */
function primitivesUsed() {
  const block = SOURCE.match(/const \{([\s\S]*?)\} = require\('@deepseek-ai\/dsh-client-ui-primitives'\)/u)
  assert.ok(block !== null, '必须从 primitives 里解构组件')
  return block[1].split(',').map(name => name.trim()).filter(name => name !== '')
}

test('every primitives symbol the bundle destructures is exported by the shell', () => {
  const repo = findHostRepo()
  if (repo === undefined) return // 没有载荷就没有可对照的导出表
  const bundle = readFileSync(`${repo}/packages/client/ui-primitives/lib/index.js`, 'utf8')
  const exported = new Set(
    [...bundle.matchAll(/export \{([\s\S]*?)\};/gu)]
      .flatMap(match => match[1].split(','))
      .map(name => name.trim().split(/\s+as\s+/u).pop()),
  )
  assert.ok(exported.size > 0, '载荷的导出表必须解析出来')
  for (const name of primitivesUsed()) {
    assert.ok(exported.has(name), `primitives 里没有导出 ${name}`)
  }
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
  const plugin = captured.factory(platformModules(React))
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
  const bySlot = name => registered.filter(entry => entry.options.name === name)
  assert.equal(bySlot('settings.section').length, 1, '卡片只注册一次')
  assert.equal(bySlot('settings.section').at(0).options.id, 'multi-root')
  assert.equal(typeof bySlot('settings.section').at(0).options.label(), 'string')
  assert.equal(typeof bySlot('settings.section').at(0).component, 'function')

  const icons = bySlot('settings.section.icon')
  assert.equal(icons.length, 1, '设置导航图标必须注册')
  assert.equal(icons[0].options.id, 'multi-root', '图标 id 必须等于 section id，否则壳不渲染')
  assert.equal(typeof icons[0].component, 'function')

  const menuIcons = bySlot('contextMenu.icon')
  assert.equal(menuIcons.length, 6, '每个菜单动作一个键')
  assert.deepEqual(
    Array.from(menuIcons.map(entry => entry.options.key)).sort(),
    ['multi-root.add', 'multi-root.menu', 'multi-root.none', 'multi-root.remove', 'multi-root.root', 'multi-root.unreachable'],
  )
  for (const entry of menuIcons) assert.equal(typeof entry.component, 'function')

  assert.equal(menus.length, 1)
  assert.equal(menus[0].id, 'multi-root.workspace')
  assert.equal(menus[0].target, 'workspace')
  assert.equal(typeof menus[0].resolve, 'function')
})

/** A React stand-in that actually builds a tree, with the hook values supplied per call. */
function treeReact(values) {
  const queue = [...values]
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: () => [queue.shift(), () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
  }
}

function flatten(node, sink = []) {
  if (node === null || node === undefined || node === false || node === true) return sink
  if (Array.isArray(node)) { for (const child of node) flatten(child, sink); return sink }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node.props)) {
      if (typeof value === 'string' && (key === 'path' || key === 'placeholder' || key === 'aria-label' || key === 'title')) sink.push(value)
    }
    flatten(node.children, sink)
    return sink
  }
  sink.push(String(node))
  return sink
}

test('the card renders one group per project and the add row, not an empty shell', async () => {
  const vm = await import('node:vm')
  let captured
  const sandbox = { window: { __ModuleLoader__: { load: options => { captured = options } } }, console }
  vm.runInNewContext(SOURCE, sandbox)
  // Hook order in Section: state, editing, anchor, path, busy.
  const React = treeReact([
    {
      loading: false,
      error: undefined,
      data: {
        statePath: '/state/roots.json',
        anchors: [
          { key: '/repo-a', roots: [{ path: '/repo-a/extra', ok: true }, { path: '/repo-a/bad', ok: false, error: '不是目录' }] },
          { key: '/repo-b', roots: [] },
        ],
      },
    },
    false, '', '', false,
  ])
  const plugin = captured.factory(platformModules(React))
  let card
  plugin.apply({
    slots: { inject: (name, callback) => callback(), register: (options, component) => { if (options.name === 'settings.section') card = component } },
    contextMenus: { register: () => () => {}, notify: () => {} },
  })
  assert.equal(typeof card, 'function')

  const text = flatten(card()).join('\n')
  // 这一条是本轮真实缺陷的门禁：渲染树里必须出现每条根，而不只是外壳和添加行。
  for (const expected of ['/repo-a', '/repo-a/extra', '/state/roots.json', '添加可写根', '（无，仅主根）', '不是目录']) {
    assert.ok(text.includes(expected), `渲染结果里缺少：${expected}`)
  }
  assert.ok(text.includes('移除 /repo-a/extra'), '每行要有可访问名称的移除按钮')
})

test('the card renders the empty state when no project is configured', async () => {
  const vm = await import('node:vm')
  let captured
  const sandbox = { window: { __ModuleLoader__: { load: options => { captured = options } } }, console }
  vm.runInNewContext(SOURCE, sandbox)
  const React = treeReact([{ loading: false, error: undefined, data: { statePath: '/state/roots.json', anchors: [] } }, false, '', '', false])
  const plugin = captured.factory(platformModules(React))
  let card
  plugin.apply({
    slots: { inject: (name, callback) => callback(), register: (options, component) => { if (options.name === 'settings.section') card = component } },
    contextMenus: { register: () => () => {}, notify: () => {} },
  })
  const text = flatten(card()).join('\n')
  assert.ok(text.includes('还没有项目配置副根。'), '空态文案必须在')
  assert.ok(text.includes('添加可写根'), '空态也要能给第一条授权')
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
  const plugin = captured.factory(platformModules(React))
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
  // 跨 realm 的对象原型不同，deepEqual 会误报：按序列化结果比较。
  assert.equal(JSON.stringify(actions[0].icon), JSON.stringify({ key: 'multi-root.menu' }), '顶层菜单项带图标')
  const labels = Array.from(actions[0].children).map(child => child.label)
  // 状态由行首图标承载，标签里不再塞 ✓/✗ 字符。
  assert.deepEqual(labels, ['/extra', '添加 /sib（sibling）', '移除 /extra'])
  assert.deepEqual(
    Array.from(actions[0].children).map(child => child.icon?.key),
    ['multi-root.root', 'multi-root.add', 'multi-root.remove'],
  )
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
  const plugin = captured.factory(platformModules(React))
  let menu
  plugin.apply({
    slots: { inject: () => {}, register: () => {} },
    contextMenus: { register: options => { menu = options; return () => {} }, notify: (text, success) => notices.push({ text, success }) },
  })
  const actions = await menu.resolve({ workspaceId: 'w', path: '/repo', displayTitle: 'repo' })
  assert.equal(actions[0].disabled, true)
  assert.match(actions[0].label, /该目录包含当前工作区/u)
})
