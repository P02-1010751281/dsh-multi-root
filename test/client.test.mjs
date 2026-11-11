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
  assert.match(SOURCE, /inject: \['slots'\]/u)
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
  assert.equal(Array.from(plugin.inject).join(','), 'slots')
  assert.equal(typeof plugin.apply, 'function')

  const registered = []
  plugin.apply({
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => registered.push({ options, component }),
    },
  })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'settings.section')
  assert.equal(registered[0].options.id, 'multi-root')
  assert.equal(typeof registered[0].options.label(), 'string')
  assert.equal(typeof registered[0].component, 'function')
})
