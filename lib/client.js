/**
 * Browser half: a "多可写根" card in Settings, plus one project-row context-menu
 * entry that manages the same grants in place.
 *
 * Both surfaces read and write the single route below; neither touches the
 * state file. The menu exists because the shell exposes no way for a plugin to
 * open the Settings panel, so "manage this project's roots" has to happen where
 * the project is right-clicked.
 *
 * Presentation follows the list-group idiom of a modern assistant settings page
 * (the ChatGPT settings screen the user pointed at): a small muted section label,
 * one rounded container per group, hairline dividers between rows, a leading
 * icon on every row, the action trailing as a quiet icon button, and the "add"
 * affordance as a final row that reveals its form in place instead of a form
 * permanently parked under the list.
 *
 * The nav glyph is the shell's own permission artwork, because that is the
 * vocabulary this app already uses for sandbox rules.
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
    const {
      Button,
      PathLabel,
      StateDot,
      IconFolderOpenOutlineRegular,
      IconPlusOutlineRegular,
      IconRefreshOutlineRegular,
      IconTrashOutlineRegular,
      IconWarningOutlineRegular,
      PermissionIconReadOnlyRegular,
      PermissionIconWorkspaceWriteMedium,
      PermissionIconWorkspaceWriteRegular,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const ROUTE = 'api/multi-root/roots'
    const h = React.createElement

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

    // Voice: sentence case, no exclamation marks, one line of muted explanation.
    const COPY = {
      hint: '按仓库根记账：仓库内任意深度的会话共用同一份授权。兄弟仓库互不可见，改动立即生效。',
      empty: '还没有项目配置副根。',
      none: '（无，仅主根）',
      unreadable: '读取失败',
      add: '添加',
      cancel: '取消',
      addRow: '添加可写根',
      refresh: '刷新',
      remove: '移除',
      anchorLabel: '项目目录',
      anchorPlaceholder: '仓库根或其中任意子目录',
      pathLabel: '可写根',
      pathPlaceholder: '绝对路径',
      stateFile: '状态文件',
      configured: '已配置的项目',
    }

    const HAIRLINE = '1px solid color-mix(in srgb, currentColor 12%, transparent)'

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '18px', fontSize: '13px' },
      hint: { opacity: 0.7, lineHeight: 1.6, margin: 0, maxWidth: '62ch' },
      sectionLabel: { fontSize: '12px', fontWeight: 600, opacity: 0.6, margin: '0 0 6px 2px' },
      summary: { fontSize: '12px', opacity: 0.55, margin: '0 0 6px 2px' },
      group: {
        borderRadius: '12px',
        border: HAIRLINE,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      },
      groupCaption: { fontSize: '11px', opacity: 0.55, margin: '0', padding: '8px 12px', borderTop: HAIRLINE },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 12px',
        minHeight: '44px',
        boxSizing: 'border-box',
        borderTop: HAIRLINE,
      },
      firstRow: { borderTop: 'none' },
      rowIcon: { display: 'inline-flex', width: '20px', height: '20px', alignItems: 'center', justifyContent: 'center', opacity: 0.75, flex: 'none' },
      path: { flex: 1, minWidth: 0 },
      pathText: { fontFamily: 'ui-monospace, monospace', fontSize: '12px', wordBreak: 'break-all' },
      error: { color: 'rgb(200 60 60)', fontSize: '12px' },
      actionRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 12px',
        minHeight: '44px',
        boxSizing: 'border-box',
        borderTop: HAIRLINE,
        background: 'transparent',
        border: 'none',
        borderTopWidth: '1px',
        color: 'inherit',
        textAlign: 'left',
        width: '100%',
        cursor: 'pointer',
        font: 'inherit',
      },
      form: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', borderTop: HAIRLINE },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      fieldLabel: { fontSize: '11px', opacity: 0.55 },
      input: {
        padding: '7px 10px',
        borderRadius: '8px',
        border: HAIRLINE,
        background: 'transparent',
        color: 'inherit',
        fontFamily: 'ui-monospace, monospace',
        fontSize: '12px',
        width: '100%',
        boxSizing: 'border-box',
      },
      formActions: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
      footer: { display: 'flex', alignItems: 'center', gap: '6px', opacity: 0.45, fontSize: '11px', margin: 0 },
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

    /** The settings navigation glyph: the shell's own workspace-write artwork. */
    function SectionIcon({ size = 16, active }) {
      const Icon = active === true ? PermissionIconWorkspaceWriteMedium : PermissionIconWorkspaceWriteRegular
      return h(Icon, { size })
    }

    function Section() {
      const [state, setState] = React.useState({ loading: true, data: undefined, error: undefined })
      const [editing, setEditing] = React.useState(false)
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
        if (await run({ action: 'add', anchor, path })) {
          setPath('')
          setEditing(false)
        }
      }

      const data = state.data
      const anchors = data?.anchors ?? []
      const total = anchors.reduce((sum, item) => sum + item.roots.length, 0)

      function rootRow(root, index, anchorKey) {
        return h('div', { key: root.path, style: index === 0 ? { ...styles.row, ...styles.firstRow } : styles.row },
          h('span', { style: styles.rowIcon }, h(StateDot, { state: root.ok ? 'done' : 'error' })),
          h('span', { style: styles.path },
            h('span', { style: styles.pathText }, root.path),
            root.ok ? null : h('div', { style: styles.error }, root.error ?? '无效')),
          h(Button, {
            variant: 'ghost',
            size: 'sm',
            icon: h(IconTrashOutlineRegular, { size: 16 }),
            'aria-label': `${COPY.remove} ${root.path}`,
            title: COPY.remove,
            disabled: busy,
            onClick: () => void run({ action: 'remove', anchor: anchorKey, path: root.path }),
          }),
        )
      }

      function addRow() {
        if (!editing) {
          return h('button', {
            type: 'button',
            style: styles.actionRow,
            disabled: busy,
            onClick: () => setEditing(true),
          },
            h('span', { style: styles.rowIcon }, h(IconPlusOutlineRegular, { size: 16 })),
            h('span', null, COPY.addRow),
          )
        }
        return h('div', { style: styles.form },
          h('label', { style: styles.field },
            h('span', { style: styles.fieldLabel }, COPY.anchorLabel),
            h('input', {
              style: styles.input,
              placeholder: COPY.anchorPlaceholder,
              value: anchor,
              spellCheck: false,
              onChange: event => setAnchor(event.target.value),
            })),
          h('label', { style: styles.field },
            h('span', { style: styles.fieldLabel }, COPY.pathLabel),
            h('input', {
              style: styles.input,
              placeholder: COPY.pathPlaceholder,
              value: path,
              spellCheck: false,
              onChange: event => setPath(event.target.value),
            })),
          h('div', { style: styles.formActions },
            h(Button, {
              variant: 'ghost',
              size: 'sm',
              disabled: busy,
              onClick: () => { setEditing(false); setPath('') },
            }, COPY.cancel),
            h(Button, {
              variant: 'primary',
              size: 'sm',
              disabled: busy || anchor.trim() === '' || path.trim() === '',
              onClick: () => void submit(),
            }, COPY.add),
          ),
        )
      }

      // One group per project, ChatGPT-settings style: a small muted label above a
      // rounded container whose rows are separated by hairlines. The add
      // affordance is a row of the last group, not a form parked under the list.
      const projectGroups = anchors.map(item => h('div', { key: item.key, style: { display: 'flex', flexDirection: 'column' } },
        h('div', { style: styles.sectionLabel, title: item.key }, item.key),
        h('div', { style: styles.group },
          item.roots.length === 0
            ? h('div', { style: { ...styles.row, ...styles.firstRow } },
              h('span', { style: styles.rowIcon }, h(StateDot, { state: 'idle' })),
              h('span', { style: { opacity: 0.6 } }, COPY.none))
            : item.roots.map((root, index) => rootRow(root, index, item.key)),
        ),
      ))

      return h('div', { style: styles.root },
        h('p', { style: styles.hint }, COPY.hint),
        state.error !== undefined
          ? h('div', { style: { ...styles.group, borderColor: 'color-mix(in srgb, rgb(200 60 60) 45%, transparent)' } },
            h('div', { style: { ...styles.row, ...styles.firstRow } },
              h('span', { style: styles.rowIcon }, h(IconWarningOutlineRegular, { size: 16 })),
              h('span', { style: styles.error }, `${COPY.unreadable}：${state.error}`)))
          : null,
        state.loading ? h('p', { style: { ...styles.summary, margin: 0 } }, '读取中…') : null,
        anchors.length === 0 && !state.loading
          ? h('div', null,
            h('div', { style: styles.sectionLabel }, COPY.configured),
            h('div', { style: styles.group },
              h('div', { style: { ...styles.row, ...styles.firstRow, opacity: 0.6 } },
                h('span', { style: styles.rowIcon }, h(StateDot, { state: 'idle' })),
                h('span', null, COPY.empty))))
          : null,
        projectGroups.length === 0
          ? null
          : h('div', null,
            h('div', { style: styles.sectionLabel }, COPY.configured),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, projectGroups)),
        h('div', null,
          h('div', { style: styles.group }, addRow())),
        h('p', { style: styles.footer },
          COPY.stateFile,
          h(PathLabel, { path: data?.statePath ?? '' })),
      )
    }

    /**
     * Menu glyphs, addressed by action id. The menu renders a slot per key, so an
     * action carries `icon: { key }` and the surface stays the shell's.
     */
    const menuIcons = {
      'multi-root.menu': PermissionIconWorkspaceWriteRegular,
      'multi-root.root': IconFolderOpenOutlineRegular,
      'multi-root.none': PermissionIconReadOnlyRegular,
      'multi-root.add': IconPlusOutlineRegular,
      'multi-root.remove': IconTrashOutlineRegular,
      'multi-root.unreachable': IconWarningOutlineRegular,
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

        // Without this the shell draws its default glyph for every section; the
        // id has to equal the section id or nothing renders.
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'multi-root',
        }, SectionIcon))

        for (const [key, Icon] of Object.entries(menuIcons)) {
          ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({ name: 'contextMenu.icon', key }, Icon))
        }

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
                icon: { key: 'multi-root.unreachable' },
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
                // State is carried by the row glyph, so the label stays a path.
                label: root.ok ? root.path : `${root.path}（不可用：${root.error ?? '无效'}）`,
                icon: { key: 'multi-root.root' },
                disabled: true,
              })
            }
            if (roots.length === 0) {
              children.push({ id: 'multi-root.none', label: COPY.none, icon: { key: 'multi-root.none' }, disabled: true })
            }
            const addable = (state.candidates ?? []).filter(candidate => candidate.ok && !candidate.granted)
            const addFrom = children.length
            for (const candidate of addable) {
              children.push({
                id: `multi-root.add:${candidate.path}`,
                label: `添加 ${candidate.path}（${candidate.source}）`,
                icon: { key: 'multi-root.add' },
                run: () => act({ action: 'add', anchor: key, path: candidate.path }, `已添加 ${candidate.path}`),
              })
            }
            if (addable.length > 0) children[addFrom].separatorBefore = true
            const removeFrom = children.length
            for (const root of roots) {
              children.push({
                id: `multi-root.remove:${root.path}`,
                label: `移除 ${root.path}`,
                icon: { key: 'multi-root.remove' },
                danger: true,
                run: () => act({ action: 'remove', anchor: key, path: root.path }, `已移除 ${root.path}`),
              })
            }
            if (roots.length > 0) children[removeFrom].separatorBefore = true
            return [{ id: 'multi-root.menu', label: '多可写根', icon: { key: 'multi-root.menu' }, children }]
          },
        })
      },
    }
  },
})
