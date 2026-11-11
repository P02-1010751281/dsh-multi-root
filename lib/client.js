/**
 * Browser half: a "多可写根" card in Settings, plus one project-row context-menu
 * entry that manages the same grants in place.
 *
 * Both surfaces read and write the single route below; neither touches the
 * state file. The menu exists because the shell exposes no way for a plugin to
 * open the Settings panel, so "manage this project's roots" has to happen where
 * the project is right-clicked.
 *
 * This file is served as a classic script and is NOT an ES module: it must call
 * `window.__ModuleLoader__.load({ id, factory })` and resolve every dependency
 * through the injected `require` (only the frozen platform table is available:
 * react, react/jsx-runtime, react-dom, @deepseek-ai/cordis, zod,
 * @tanstack/react-virtual, @deepseek-ai/dsh-client-store, -ui-slots,
 * -ui-primitives, -ui-dockkit). No build step produces it — the repository
 * ships these bytes.
 *
 * All reads and writes go through `api/multi-root/roots` (document-relative:
 * the served page carries `<base href="./">`), which the host half registers on
 * the authenticated connection bridge. The card never touches the state file.
 */
window.__ModuleLoader__.load({
  id: 'dsh-multi-root',
  factory(require) {
    const React = require('react')

    const ROUTE = 'api/multi-root/roots'

    // The card and the project-row menu are two views of one state: a write from
    // either has to repaint the other without a reload, so both announce through
    // this one set of listeners.
    const listeners = new Set()
    function changed() {
      for (const listener of [...listeners]) {
        try { listener() } catch { /* one failed repaint must not stop the rest */ }
      }
    }

    /**
     * Find the stored anchor that owns a clicked workspace path: an exact key
     * first, then the nearest enclosing key (a session inside `/repo/sub` is
     * governed by `/repo`).
     */
    function anchorOf(state, path) {
      const anchors = state?.anchors ?? []
      const exact = anchors.find(item => item.key === path)
      if (exact !== undefined) return exact
      let best
      for (const item of anchors) {
        if (path !== item.key && !path.startsWith(item.key.endsWith('/') ? item.key : `${item.key}/`)) continue
        if (best === undefined || item.key.length > best.key.length) best = item
      }
      return best
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '13px' },
      hint: { opacity: 0.75, lineHeight: 1.6, margin: 0 },
      anchor: {
        border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
        borderRadius: '8px',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      },
      key: { fontFamily: 'ui-monospace, monospace', fontSize: '12px', wordBreak: 'break-all' },
      row: { display: 'flex', alignItems: 'center', gap: '8px' },
      path: { fontFamily: 'ui-monospace, monospace', fontSize: '12px', flex: 1, wordBreak: 'break-all' },
      error: { color: 'rgb(200 60 60)', fontSize: '12px' },
      ok: { color: 'rgb(60 160 90)' },
      form: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
      input: {
        flex: '1 1 260px',
        minWidth: '200px',
        padding: '6px 8px',
        borderRadius: '6px',
        border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
        background: 'transparent',
        color: 'inherit',
        fontFamily: 'ui-monospace, monospace',
        fontSize: '12px',
      },
      button: {
        padding: '5px 10px',
        borderRadius: '6px',
        border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
      },
      empty: { opacity: 0.6, margin: 0 },
    }

    async function call(body) {
      const response = await fetch(ROUTE, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload
    }

    function Section() {
      const [state, setState] = React.useState({ loading: true, data: undefined, error: undefined })
      const [anchor, setAnchor] = React.useState('')
      const [path, setPath] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const run = React.useCallback(async (body) => {
        setBusy(true)
        try {
          const data = await call(body)
          setState({ loading: false, data, error: undefined })
          return true
        } catch (error) {
          setState(previous => ({ ...previous, loading: false, error: String(error.message ?? error) }))
          return false
        } finally {
          setBusy(false)
        }
      }, [])

      React.useEffect(() => {
        void run()
        const listener = () => { void run() }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [run])

      const submit = async () => {
        if (await run({ action: 'add', anchor, path })) setPath('')
      }

      const data = state.data
      const anchors = data?.anchors ?? []
      const h = React.createElement

      return h('div', { style: styles.root },
        h('p', { style: styles.hint },
          '授权按仓库根记账：仓库里任意深度的会话都继承同一份配置。只沿仓库根继承——兄弟仓库互不可见，'
          + '记在非仓库祖先目录上的授权不会向下泄漏。改动立即生效，无需重启。'),
        state.error !== undefined ? h('div', { style: styles.error }, state.error) : null,
        state.loading ? h('p', { style: styles.empty }, '读取中…') : null,
        anchors.length === 0 && !state.loading
          ? h('p', { style: styles.empty }, '还没有任何项目配置副根。')
          : anchors.map(item => h('div', { key: item.key, style: styles.anchor },
            h('div', { style: styles.key }, item.key),
            item.roots.length === 0
              ? h('p', { style: styles.empty }, '（无，仅主根）')
              : item.roots.map(root => h('div', { key: root.path, style: styles.row },
                h('span', { style: root.ok ? styles.ok : styles.error }, root.ok ? '✓' : '✗'),
                h('span', { style: styles.path }, root.path),
                root.ok ? null : h('span', { style: styles.error }, root.error ?? ''),
                h('button', {
                  type: 'button',
                  style: styles.button,
                  disabled: busy,
                  onClick: () => void run({ action: 'remove', anchor: item.key, path: root.path }),
                }, '移除'),
              )),
          )),
        h('div', { style: styles.form },
          h('input', {
            style: styles.input,
            placeholder: '项目目录（仓库根或其中任意子目录）',
            value: anchor,
            spellCheck: false,
            onChange: event => setAnchor(event.target.value),
          }),
          h('input', {
            style: styles.input,
            placeholder: '要添加的可写根（绝对路径）',
            value: path,
            spellCheck: false,
            onChange: event => setPath(event.target.value),
          }),
          h('button', {
            type: 'button',
            style: styles.button,
            disabled: busy || anchor.trim() === '' || path.trim() === '',
            onClick: () => void submit(),
          }, '添加'),
          h('button', {
            type: 'button',
            style: styles.button,
            disabled: busy,
            onClick: () => void run(),
          }, '刷新'),
        ),
        data?.statePath !== undefined
          ? h('p', { style: styles.empty }, `状态文件：${data.statePath}`)
          : null,
      )
    }

    return {
      name: 'dsh-multi-root-ui',
      inject: ['slots', 'contextMenus'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'multi-root',
          order: 70,
          label: () => '多可写根',
        }, Section))

        // A menu action writes through the same route the card uses, then tells
        // every open surface. Rejections become a toast instead of a silent
        // no-op, because a context menu has nowhere to render an error.
        const act = async (body, success) => {
          try {
            await call(body)
            changed()
            ctx.contextMenus.notify(success, true)
          } catch (error) {
            ctx.contextMenus.notify(`多可写根：${String(error?.message ?? error)}`)
          }
        }

        ctx.contextMenus.register({
          id: 'multi-root.workspace',
          target: 'workspace',
          order: 300,
          async resolve(target) {
            const anchor = typeof target?.path === 'string' ? target.path : ''
            if (anchor === '') return []
            let state
            try {
              // One round trip: the snapshot the menu needs plus the candidates
              // `/roots discover` would print, already carrying their verdicts.
              state = await call({ action: 'discover', anchor })
            } catch (error) {
              return [{
                id: 'multi-root.unreachable',
                label: `多可写根：${String(error?.message ?? error)}`,
                disabled: true,
              }]
            }
            const owner = anchorOf(state, anchor)
            const key = owner === undefined ? anchor : owner.key
            const roots = owner === undefined ? [] : owner.roots
            const children = []
            for (const root of roots) {
              children.push({
                id: `multi-root.own:${root.path}`,
                label: `${root.ok ? '✓' : '✗'} ${root.path}${root.ok ? '' : `（${root.error ?? '无效'}）`}`,
                disabled: true,
              })
            }
            if (roots.length === 0) {
              children.push({ id: 'multi-root.none', label: '（无，仅主根）', disabled: true })
            }
            const addable = (state.candidates ?? []).filter(candidate => candidate.ok && !candidate.granted)
            const addFrom = children.length
            for (const candidate of addable) {
              children.push({
                id: `multi-root.add:${candidate.path}`,
                label: `添加 ${candidate.path}（${candidate.source}）`,
                run: () => act({ action: 'add', anchor: key, path: candidate.path }, `已添加 ${candidate.path}`),
              })
            }
            if (addable.length > 0) children[addFrom].separatorBefore = true
            const removeFrom = children.length
            for (const root of roots) {
              children.push({
                id: `multi-root.remove:${root.path}`,
                label: `移除 ${root.path}`,
                danger: true,
                run: () => act({ action: 'remove', anchor: key, path: root.path }, `已移除 ${root.path}`),
              })
            }
            if (roots.length > 0) children[removeFrom].separatorBefore = true
            return [{ id: 'multi-root.menu', label: '多可写根', children }]
          },
        })
      },
    }
  },
})
