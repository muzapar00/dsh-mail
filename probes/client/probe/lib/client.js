/**
 * client-ui 调研探针（手写单文件客户端 bundle）。
 *
 * 目的：在真实 DSH Web GUI 里验证下列注册 API，最小化、可独立安装：
 *  1. window.__ModuleLoader__.load({ id, factory }) 手写 bundle 能否被加载；
 *  2. require('react') / require('@deepseek-ai/dsh-client-ui-primitives') 基线模块是否可用；
 *  3. ctx.locale.register(ns, {zh,en}) + 注册项 locale 选项注入的 t；
 *  4. 左侧主导航页面：ctx.slots.inject('main') + register({name:'main', key})；
 *  5. 左侧导航行：ctx.slots.inject('sidebar.panellist') + register({name,id,order,label})；
 *  6. 命令面板：ctx.commandUi.register({name,label,description,available,ui:{kind:'action',run}})；
 *  7. 设置页：ctx.slots.inject('settings.section') + register({name,id,order,label})；
 *  8. 会话头部常驻入口：ctx.slots.inject('conversation.session.header.utilities')；
 *  9. 侧栏折叠态徽标：ctx.slots.inject('sidebar.toggle.badge')；
 * 10. 未读徽标渲染（数字）在入口图标上的可行性与视觉效果。
 *
 * 结果写进 window.__MAILBOX_PROBE__，供 CDP 读取；页面里也有可截图的可见标记。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mailbox-probe',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var P = require('@deepseek-ai/dsh-client-ui-primitives')
    var h = React.createElement

    var NS = 'mailbox.probe'
    var PANEL_ID = 'mailbox-probe'

    var probe = (window.__MAILBOX_PROBE__ = {
      bundleExecuted: true,
      primitives: Object.keys(P).length,
      registered: {},
      errors: [],
      events: [],
    })
    function record(key, detail) {
      probe.registered[key] = detail === undefined ? true : detail
    }
    function recordError(key, error) {
      probe.errors.push({ key: key, message: String((error && error.message) || error) })
    }
    function safe(key, fn) {
      return function () {
        try {
          return fn()
        } catch (error) {
          recordError(key, error)
          return undefined
        }
      }
    }

    var DICT = {
      zh: {
        panel: '邮箱探针',
        title: '邮箱探针 · 注册验证',
        intro: '这个页面验证 DSH 客户端插件的左侧入口、设置页、命令与未读徽标。',
        command: '打开邮箱探针',
        commandDesc: '验证客户端命令能打开左侧导航页面',
        settings: '邮箱探针设置',
        settingsBody: '设置页注册验证：settings.section',
        button: '主要按钮',
        switch: '总开关（验证 Switch）',
        input: '搜索邮件（验证 Input）',
        tag: '未读',
        open: '打开弹层',
        modalTitle: '二次确认',
        modalDesc: '危险操作必须二次确认。',
        confirm: '确认',
        cancel: '取消',
        toast: '已经送信',
        header: '邮箱入口',
      },
      en: {
        panel: 'Mailbox Probe',
        title: 'Mailbox probe · registration check',
        intro: 'Verifies the left-nav page, settings page, command and unread badge of a DSH client plugin.',
        command: 'Open mailbox probe',
        commandDesc: 'Verifies a client command can open a the left-nav page',
        settings: 'Mailbox probe settings',
        settingsBody: 'Settings page registration check: settings.section',
        button: 'Primary action',
        switch: 'Master switch (Switch)',
        input: 'Search mail (Input)',
        tag: 'Unread',
        open: 'Open dialog',
        modalTitle: 'Confirm',
        modalDesc: 'Destructive actions need confirmation.',
        confirm: 'Confirm',
        cancel: 'Cancel',
        toast: 'Mail sent',
        header: 'Mailbox',
      },
    }

    /** 入口图标 + 未读数字徽标；props = {size, active}。 */
    function MailboxIcon(props) {
      var size = (props && props.size) || 16
      return h(
        'span',
        { className: 'dsh-mailbox-probe-icon', style: { position: 'relative', display: 'inline-flex' } },
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
          h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 3 }),
          h('path', { d: 'M3.6 7.2 12 13l8.4-5.8' }),
        ),
        h(
          'span',
          {
            'data-unread-badge': '3',
            style: {
              position: 'absolute',
              top: '-5px',
              right: '-7px',
              minWidth: '14px',
              height: '14px',
              padding: '0 3px',
              borderRadius: '7px',
              background: '#e5484d',
              color: '#fff',
              fontSize: '9px',
              lineHeight: '14px',
              textAlign: 'center',
              fontWeight: 600,
            },
          },
          '3',
        ),
      )
    }

    function ProbePage(props) {
      var t = props.t
      var [on, setOn] = React.useState(true)
      var [text, setText] = React.useState('')
      var [open, setOpen] = React.useState(false)
      var [toast, setToast] = React.useState(null)
      var [variant] = React.useState('primary')
      React.useEffect(function () {
        probe.events.push('probe-page-mounted')
      }, [])
      return h(
        'section',
        {
          'data-testid': 'mailbox-probe-page',
          className: 'dsh-mailbox-probe-page',
          style: {
            boxSizing: 'border-box',
            height: '100%',
            overflow: 'auto',
            padding: '48px clamp(24px, 4vw, 48px)',
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-base)',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
          },
        },
        h('h1', { style: { margin: 0, fontSize: '20px', fontWeight: 500, lineHeight: '28px' } }, t('title')),
        h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', lineHeight: '20px' } }, t('intro')),
        h(
          'div',
          { style: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
          h(P.Button, { variant: variant, onClick: function () { setToast({ text: t('toast'), tone: 'success' }) } }, t('button')),
          h(P.Button, { variant: 'outline', onClick: function () { setOpen(true) } }, t('open')),
          h(P.Tag, { tone: 'info' }, t('tag')),
          h(P.StateDot, { state: 'ongoing' }),
          h(P.StateDot, { state: 'error' }),
          h(
            P.Tooltip,
            { label: 'DSH primitives Tooltip', side: 'bottom', portal: true },
            h('span', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' } }, 'Tooltip'),
          ),
        ),
        h(
          'label',
          { style: { display: 'flex', gap: '12px', alignItems: 'center', fontSize: '13px' } },
          t('switch'),
          h(P.Switch, { checked: on, label: t('switch'), onChange: function (value) { setOn(value) } }),
        ),
        h(P.Input, {
          type: 'search',
          placeholder: t('input'),
          value: text,
          onChange: function (event) { setText(event.target.value) },
          'aria-label': t('input'),
        }),
        h(P.Modal, {
          open: open,
          title: t('modalTitle'),
          description: t('modalDesc'),
          closeLabel: t('cancel'),
          onClose: function () { setOpen(false) },
          footer: h(
            'div',
            { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
            h(P.Button, { variant: 'outline', onClick: function () { setOpen(false) } }, t('cancel')),
            h(P.Button, { variant: 'primary', onClick: function () { setOpen(false) } }, t('confirm')),
          ),
        }),
        toast ? h(P.Toast, { text: toast.text, tone: toast.tone, onDone: function () { setToast(null) } }) : null,
        h(
          'pre',
          {
            'data-testid': 'mailbox-probe-registry',
            style: {
              margin: 0,
              padding: '12px',
              borderRadius: '8px',
              background: 'var(--dsw-alias-bg-layer-1)',
              border: '0.5px solid var(--dsw-alias-border-l3)',
              fontSize: '11px',
              lineHeight: '16px',
              whiteSpace: 'pre-wrap',
            },
          },
          JSON.stringify({ registered: probe.registered, errors: probe.errors, primitives: probe.primitives }, null, 2),
        ),
      )
    }

    function ProbeSettingsPage(props) {
      return h(
        'section',
        { 'data-testid': 'mailbox-probe-settings', style: { padding: '8px 0', fontSize: '13px' } },
        h('h3', { style: { margin: '0 0 8px', fontSize: '14px', fontWeight: 500 } }, props.t('settings')),
        h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-secondary)' } }, props.t('settingsBody')),
      )
    }

    function ProbeHeaderAction(props) {
      var [hover, setHover] = React.useState(false)
      return h(
        'button',
        {
          type: 'button',
          'data-testid': 'mailbox-probe-header-action',
          'aria-label': props.t('header'),
          title: props.t('header'),
          onPointerEnter: function () { setHover(true) },
          onPointerLeave: function () { setHover(false) },
          onClick: function () { props.openMailbox() },
          style: {
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '28px',
            height: '28px',
            padding: 0,
            borderRadius: '8px',
            border: 0,
            background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
            color: 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
          },
        },
        h(MailboxIcon, { size: 16 }),
      )
    }

    function apply(ctx) {
      probe.events.push('apply-started')
      ctx.effect(
        function () {
          return ctx.locale.register(NS, DICT)
        },
        'mailbox-probe: dictionaries',
      )
      var t = ctx.locale.bind(NS)
      probe.t = typeof t === 'function'

      // 1) 左侧主导航页面（keyed main slot）
      ctx.effect(function () {
        return ctx.slots.inject('main', function () {
          return safe('main', function () {
            var result = ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                locale: NS,
                inject: function () {
                  return { openMailbox: function () { ctx.layout.selectPanel(PANEL_ID) } }
                },
              },
              ProbePage,
            )
            record('main')
            return result
          })()
        })
      }, 'mailbox-probe: main panel')

      // 2) 左侧导航行（图标 + 未读数字徽标）
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.panellist', function () {
          return safe('sidebar.panellist', function () {
            var result = ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: function () { return t('panel') }, locale: NS },
              MailboxIcon,
            )
            record('sidebar.panellist')
            return result
          })()
        })
      }, 'mailbox-probe: sidebar row')

      // 3) 设置页
      ctx.effect(function () {
        return ctx.slots.inject('settings.section', function () {
          return safe('settings.section', function () {
            var result = ctx.slots.register(
              { name: 'settings.section', id: 'mailbox-probe', order: 5, label: function () { return t('settings') }, locale: NS },
              ProbeSettingsPage,
            )
            record('settings.section')
            return result
          })()
        })
      }, 'mailbox-probe: settings section')

      // 4) 会话头部常驻入口
      ctx.effect(function () {
        return ctx.slots.inject('conversation.session.header.utilities', function () {
          return safe('header.utilities', function () {
            var result = ctx.slots.register(
              {
                name: 'conversation.session.header.utilities',
                id: 'mailbox-probe',
                order: 10,
                locale: NS,
                inject: function () {
                  return { openMailbox: function () { ctx.layout.selectPanel(PANEL_ID) } }
                },
              },
              ProbeHeaderAction,
            )
            record('header.utilities')
            return result
          })()
        })
      }, 'mailbox-probe: header action')

      // 5) 折叠态侧栏徽标：sidebar.toggle.badge 是 single 槽，官方组合已占用，
      //    再注册会抛 "already has a registration at priority 0"（实测，见调研报告）。
      //    所以入口徽标只做在 sidebar.panellist 的图标里，不占用该槽。
      probe.registered['sidebar.toggle.badge'] = 'skipped: single slot occupied by shipped composition'

      // 6) 命令面板动作
      ctx.inject(['commandUi'], function (scope) {
        scope.effect(
          function () {
            return scope.commandUi.register({
              name: 'mailbox-probe',
              label: function () { return t('command') },
              description: function () { return t('commandDesc') },
              available: function () { return true },
              ui: {
                kind: 'action',
                run: function () {
                  ctx.layout.selectPanel(PANEL_ID)
                },
              },
            })
          },
          'mailbox-probe: command',
        )
        record('commandUi.register')
      })

      probe.events.push('apply-finished')
    }

    exports.name = 'mailbox-probe'
    exports.inject = ['slots', 'locale', 'layout']
    exports.apply = apply
    return module.exports
  },
})
