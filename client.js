/**
 * Browser half of the Remote Desktop bundle（远程主机 / Remote Desktop）。
 *
 * Registers the left-sidebar entry (`sidebar.panellist`, id `remote-desktop`) and
 * its page (`main`, key `remote-desktop`). The page talks to the Host half's
 * HTTP API under `/remote-desktop/api`:
 *
 *   GET  /state            — ssh environment + saved hosts + live connections
 *   POST /hosts            — create (no id) or update (existing id) a host
 *   POST /hosts/delete     — disconnect then delete
 *   POST /connect          — start connecting, returns immediately
 *   POST /disconnect       — stop a live connection
 *   POST /test             — run a synchronous SSH test
 *   GET  /discover         — local SSH config / known_hosts discovery (once per mount)
 *
 * The state is polled every 2.5 s while the panel is mounted. Once a host is
 * connected, its `connection.url` opens in the application's right-Sidebar
 * Browser tab (a first-party Desktop webview) because a plain iframe cannot
 * carry the remote dsh SameSite=Strict session cookie across the dsh-app origin.
 */
window.__ModuleLoader__.load({
  id: 'dsh-smartremote',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /* ====================================================================== *
     * 常量
     * ====================================================================== */

    const API_PREFIX = '/remote-desktop/api'
    const POLL_INTERVAL_MS = 2500
    const DEFAULT_SSH_PORT = 22
    const DEFAULT_REMOTE_PORT = 39080
    const DEFAULT_LAUNCH_COMMAND = 'dsh --profile web --port {port} --no-open'
    const DEFAULT_INSTALL_COMMAND = 'npm install -g @deepseek-ai/dsh'
    const MODES = ['launch', 'attach', 'url']
    const MODE_LABEL_KEYS = { launch: 'modeLaunch', attach: 'modeAttach', url: 'modeUrl' }
    const STATUS_LABEL_KEYS = {
      connecting: 'statusConnecting',
      connected: 'statusConnected',
      error: 'statusError',
      disconnected: 'statusDisconnected',
    }
    const STATUS_DOT_CLASSES = {
      connecting: 'rd-dotWarn',
      connected: 'rd-dotOk',
      error: 'rd-dotError',
      disconnected: 'rd-dotIdle',
    }
    const LOG_TAIL_LINES = 10
    const MAX_NAME_CHARS = 80
    const MAX_TOKEN_CHARS = 256

    /* 已经自动接管过窗口的连接（`<hostId>|<startedAt>`），避免面板重挂载时反复切换。 */
    const autoOpenedConnections = new Set()

    /* ====================================================================== *
     * 样式（作为组件内的 React 节点渲染，随面板卸载移除；类名前缀 rd-）
     *
     * 颜色 / 背景 / 边框只使用 --dsw-alias-* 主题 token，跟随宿主的亮暗主题；
     * 字体族沿用宿主字体与代码字体 token。
     * ====================================================================== */

    const CSS = `
      .rd-root { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.55; }
      .rd-root *, .rd-root *::before, .rd-root *::after { box-sizing: border-box; }

      .rd-list { flex: 1 1 auto; min-height: 0; overflow: auto; }
      .rd-header { padding: 24px 28px 14px; display: flex; flex-direction: column; gap: 8px; }
      .rd-titleRow { display: flex; align-items: center; gap: 9px; }
      .rd-titleIcon { flex: none; display: inline-flex; color: var(--dsw-alias-brand-primary); }
      .rd-title { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: 0.2px; }
      .rd-sub { margin: 0; max-width: 720px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
      .rd-sshRow { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .rd-sshPath { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 11.5px; color: var(--dsw-alias-label-tertiary); word-break: break-all; }
      .rd-warn { margin: 2px 0 0; padding: 9px 11px; max-width: 760px; border-radius: 9px; border: 1px solid var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-label); font-size: 12px; }
      .rd-toolbar { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-top: 4px; }
      .rd-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .rd-body { padding: 4px 28px 36px; display: flex; flex-direction: column; gap: 12px; }
      .rd-banner { padding: 9px 12px; border-radius: 9px; border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); font-size: 12.5px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .rd-bannerText { min-width: 0; word-break: break-word; }
      .rd-bannerActions { flex: none; display: flex; gap: 6px; }
      .rd-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 14px 16px; }
      .rd-cardHead { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
      .rd-cardHead h2 { margin: 0; font-size: 13.5px; font-weight: 600; letter-spacing: 0.2px; }
      .rd-form { display: flex; flex-direction: column; gap: 12px; }
      .rd-formGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .rd-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
      .rd-fieldFull { grid-column: 1 / -1; }
      .rd-label { font-size: 11.5px; font-weight: 550; color: var(--dsw-alias-label-secondary); }
      .rd-input { width: 100%; font: inherit; font-size: 12.5px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; }
      .rd-input::placeholder { color: var(--dsw-alias-label-tertiary); }
      .rd-input:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 0; border-color: transparent; }
      .rd-hint { margin: 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
      .rd-formFoot { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
      .rd-formError { margin: 0; font-size: 12px; color: var(--dsw-alias-state-error-primary); }
      .rd-seg { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; align-self: flex-start; padding: 3px; border-radius: 9px; background: var(--dsw-alias-bg-layer-2); }
      .rd-segBtn { font: inherit; font-size: 12.5px; line-height: 1.2; padding: 6px 12px; border-radius: 7px; border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
      .rd-segBtn:hover { color: var(--dsw-alias-label-primary); }
      .rd-segBtn.is-active { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 0 0 1px var(--dsw-alias-border-l1); }
      .rd-segBtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 0; }
      .rd-segBtn:disabled { opacity: 0.55; cursor: default; }

      .rd-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 38px 18px; text-align: center; color: var(--dsw-alias-label-secondary); }
      .rd-emptyIcon { display: inline-flex; color: var(--dsw-alias-state-idle-primary); }
      .rd-empty h2 { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .rd-empty p { margin: 0; max-width: 560px; font-size: 12.5px; }
      .rd-modeGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; width: 100%; max-width: 820px; margin-top: 6px; }
      .rd-modeCard { text-align: left; padding: 11px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
      .rd-modeCard strong { display: block; margin-bottom: 3px; font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .rd-modeCard span { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }

      .rd-discover { display: flex; flex-direction: column; gap: 10px; }
      .rd-discoverHead { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .rd-discoverHead h2 { margin: 0; font-size: 13.5px; font-weight: 600; letter-spacing: 0.2px; }
      .rd-discoverSub { margin: 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary); word-break: break-word; }
      .rd-discoverActions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .rd-discoverError { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); font-size: 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .rd-discoverErrorText { min-width: 0; word-break: break-word; }
      .rd-discoverList { display: flex; flex-direction: column; max-height: 320px; overflow: auto; border-top: 1px solid var(--dsw-alias-border-l1); }
      .rd-discoverRow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 2px; }
      .rd-discoverRow + .rd-discoverRow { border-top: 1px solid var(--dsw-alias-border-l1); }
      .rd-discoverRow > .rd-btn { flex: none; }
      .rd-discoverRowBody { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .rd-discoverRowTitle { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .rd-discoverName { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 360px; }
      .rd-discoverKey { font-size: 11.5px; color: var(--dsw-alias-label-secondary); word-break: break-all; }

      .rd-hostHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
      .rd-hostBody { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
      .rd-hostTitleRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .rd-hostName { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 420px; }
      .rd-tag { font-size: 11px; line-height: 1.4; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .rd-hostMeta { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 11.5px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
      .rd-status { flex: none; display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; line-height: 1.5; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .rd-status-connected { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .rd-status-connecting { color: var(--dsw-alias-state-warn-label); border-color: var(--dsw-alias-state-warn-primary); }
      .rd-status-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .rd-hostActions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
      .rd-confirm { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 3px 4px 3px 8px; border-radius: 8px; border: 1px dashed var(--dsw-alias-state-error-primary); }
      .rd-confirmText { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
      .rd-hostError { margin: 10px 0 0; font-size: 12px; color: var(--dsw-alias-state-error-primary); white-space: pre-wrap; word-break: break-word; }
      .rd-logWrap { margin-top: 10px; display: flex; flex-direction: column; gap: 5px; }
      .rd-logTitle { font-size: 11px; font-weight: 550; color: var(--dsw-alias-label-secondary); }
      .rd-log { margin: 0; padding: 9px 10px; max-height: 168px; overflow: auto; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
      .rd-test { margin-top: 10px; display: flex; flex-direction: column; gap: 5px; }
      .rd-testHead { font-size: 12px; font-weight: 550; }
      .rd-testOk .rd-testHead { color: var(--dsw-alias-state-success-primary); }
      .rd-testError .rd-testHead { color: var(--dsw-alias-state-error-primary); }

      .rd-btn { font: inherit; font-size: 12.5px; line-height: 1.2; padding: 7px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
      .rd-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .rd-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
      .rd-btn:disabled { opacity: 0.55; cursor: default; }
      .rd-btn:disabled:hover { background: transparent; }
      .rd-btnPrimary { background: var(--dsw-alias-button-primary-fill); border-color: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-inverted); }
      .rd-btnPrimary:hover { background: var(--dsw-alias-button-primary-hover); border-color: var(--dsw-alias-button-primary-hover); }
      .rd-btnPrimary:disabled:hover { background: var(--dsw-alias-button-primary-fill); }
      .rd-btnDanger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
      .rd-btnDanger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }
      .rd-btnGhost { border-color: transparent; color: var(--dsw-alias-label-secondary); }
      .rd-btnGhost:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .rd-btnSmall { padding: 5px 10px; font-size: 12px; }
      .rd-btnInner { display: inline-flex; align-items: center; gap: 6px; }
      .rd-spin { width: 12px; height: 12px; flex: none; display: inline-block; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-label-secondary); animation: rd-spin 0.8s linear infinite; }
      .rd-spinLarge { width: 22px; height: 22px; border-width: 3px; }
      @keyframes rd-spin { to { transform: rotate(360deg); } }

      .rd-hostHint { margin: 8px 0 0; }

      .rd-rootRemote { padding: 0; }
      .rd-remote { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
      .rd-remoteBar { flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .rd-remoteTitle { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 380px; }
      .rd-spacer { flex: 1 1 auto; }
      .rd-remoteBody { flex: 1 1 auto; min-height: 0; position: relative; display: flex; background: var(--dsw-alias-bg-base); }
      .rd-remoteHost { flex: 1 1 auto; min-height: 0; display: flex; }
      .rd-webview { flex: 1 1 auto; width: 100%; height: 100%; border: 0; display: flex; }
      .rd-remoteStatus { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 18px; text-align: center; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary); font-size: 12.5px; z-index: 1; }
      .rd-remoteStatusText { max-width: 760px; word-break: break-word; }
      .rd-remoteStatusActions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center; }
      .rd-connectLog { width: 100%; max-width: 760px; max-height: 180px; text-align: left; }
      .rd-remoteDiag { flex: none; display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-1); }
      .rd-remoteDiagText { flex: 1 1 auto; min-width: 0; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 11px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); white-space: pre-wrap; word-break: break-word; }
      .rd-remoteLogin { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
      .rd-remoteLoginText { flex: 1 1 auto; min-width: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
      .rd-remoteInfo { flex: none; display: flex; align-items: flex-start; gap: 8px; padding: 7px 10px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
      .rd-remoteInfoText { flex: 1 1 auto; min-width: 0; font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; word-break: break-word; }
      .rd-check { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--dsw-alias-label-primary); cursor: pointer; }
      .rd-check input { width: 14px; height: 14px; margin: 0; flex: none; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
      .rd-check input:disabled { cursor: default; }
      .rd-statusPage { flex: 1 1 auto; min-height: 0; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; }
      .rd-remoteStatusInline { position: static; inset: auto; background: transparent; flex: none; }

      .rd-settingsPage { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px 22px; color: var(--dsw-alias-label-primary); font-size: 13px; }
      .rd-settingsPage * { box-sizing: border-box; }
      .rd-settingsHeading { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: 0.2px; }
      .rd-settingsBar { display: flex; align-items: center; gap: 8px; }
      .rd-settingsTitle { font-size: 14px; font-weight: 600; }
      .rd-settingsList { display: flex; flex-direction: column; }
      .rd-settingsRow { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 10px 4px; background: transparent; border: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: 6px; }
      .rd-settingsRow:hover { background: var(--dsw-alias-bg-layer-2); }
      .rd-settingsRow:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
      .rd-settingsRowBody { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .rd-settingsRowName { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rd-settingsRowMeta { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 11.5px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rd-settingsChevron { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 16px; }
      .rd-settingsActions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; }

      @media (max-width: 760px) {
        .rd-formGrid { grid-template-columns: minmax(0, 1fr); }
        .rd-modeGrid { grid-template-columns: minmax(0, 1fr); }
        .rd-header, .rd-body { padding-left: 18px; padding-right: 18px; }
      }
      @media (prefers-reduced-motion: reduce) { .rd-spin { animation: none; } }
    `

    /* ====================================================================== *
     * 文案字典（ZH / EN，键集合必须一致）
     * ====================================================================== */

    const ZH = {
      navLabel: '远程主机',
      title: '远程主机',
      subtitle: '通过 SSH 连接服务器上运行的 dsh，把远端 Web 界面嵌进面板直接操作。',
      sshOk: 'SSH 客户端可用',
      sshMissing: '未找到 ssh 客户端',
      sshMissingHint: 'Windows 可在「设置 → 应用 → 可选功能」中安装 OpenSSH 客户端；macOS / Linux 通常已内置。',
      addServer: '添加服务器',
      refresh: '刷新',
      hostCount: '{n} 台服务器',
      loading: '正在读取远程主机状态…',
      loadErrorTitle: '无法读取远程主机状态',
      retry: '重试',
      dismiss: '知道了',
      emptyTitle: '还没有服务器',
      emptyNeedDsh: '目标服务器需要先安装 dsh，并且在非交互 SSH 会话里能找到它。',
      emptyNeedKey: '本机需要能用 SSH 密钥免交互登录（推荐 ssh-agent；带口令的私钥请先 ssh-add）。',
      emptyModesTitle: '选择一种连接方式：',
      modeLaunch: 'SSH 启动远端 dsh',
      modeAttach: 'SSH 连接已运行的 dsh',
      modeUrl: '直接 URL',
      modeLaunchDesc: 'SSH 登录后启动 dsh web，自动解析访问令牌并建立端口转发。',
      modeAttachDesc: '远端已经跑着 dsh web，只建立端口转发，可填访问令牌。',
      modeUrlDesc: '远端有反向代理或公网地址时，直接把完整 URL 嵌进面板。',
      statusConnecting: '连接中',
      statusConnected: '已连接',
      statusError: '出错',
      statusDisconnected: '未连接',
      connect: '连接',
      connecting: '连接中…',
      disconnect: '断开',
      disconnecting: '断开中…',
      openInApp: '在桌面中打开',
      openBrowser: '在浏览器打开',
      browserTabHint: '连接成功后会自动用远端界面接管中央区域，并收起本地左侧栏；点顶部「返回」回到本地界面。',
      remoteOpening: '正在打开远端界面…',
      remoteLoadFailed: '远端界面加载失败：{error}',
      remoteUnavailable: '当前环境不支持内嵌远端界面，请用「在浏览器打开」。',
      loginTitle: '远端登录需要在本机浏览器完成授权',
      loginOpen: '在浏览器打开',
      loginCopy: '复制链接',
      loginOpened: '已在本机浏览器打开授权页；完成授权后回到这里（必要时点「重新加载」）。',
      loginOpenFailed: '自动打开浏览器失败：{error}；可点「复制链接」手动打开。',
      loginCopied: '登录链接已复制，粘贴到浏览器完成授权即可。',
      loginCopyFailed: '复制失败：{error}。',
      settingsSection: '远程主机',
      settingsSubtitle: '添加和管理远程主机；每台主机会在左侧栏出现一个图标，点图标即可连接并接管窗口。',
      settingsAddHost: '添加远程主机',
      settingsDiscover: '从本机 SSH 配置发现',
      settingsEmpty: '还没有远程主机。点「添加远程主机」开始，或从本机 SSH 配置自动发现。',
      discoverNoCandidates: '没有发现可导入的候选主机。',
      discoverViewHint: '导入后主机会出现在左侧栏；也可以继续在列表里添加或编辑。',
      hostConnecting: '正在连接「{name}」…',
      hostMissing: '该主机配置已删除。',
      hostConnectFailed: '连接失败。',
      test: '测试',
      testing: '测试中…',
      testOk: 'SSH 测试通过',
      testFailed: 'SSH 测试失败',
      logTitle: '连接日志',
      edit: '编辑',
      delete: '删除',
      deleting: '删除中…',
      confirmDelete: '确认删除',
      confirmDeleteHint: '删除「{name}」？此操作不可撤销。',
      cancel: '取消',
      save: '保存',
      saving: '保存中…',
      back: '返回',
      reload: '重新加载',
      editTitle: '编辑服务器',
      addTitle: '添加服务器',
      fieldName: '名称',
      namePlaceholder: '例如：生产服务器',
      fieldMode: '连接模式',
      fieldSshHost: 'SSH 主机',
      sshHostPlaceholder: 'server.example.com',
      fieldSshPort: 'SSH 端口',
      fieldUser: '用户名',
      userPlaceholder: 'root（留空使用 SSH 默认用户）',
      fieldIdentityFile: '私钥路径（可选）',
      identityFilePlaceholder: '~/.ssh/id_ed25519',
      fieldRemotePort: '远端端口',
      fieldLaunchCommand: '启动命令',
      launchHint: '命令中的 {port} 会被替换成远端端口。',
      fieldInstallCommand: '自动安装命令',
      installHint: '首次连接时若远端没有 dsh，会自动执行这条命令安装（仅「SSH 启动远端 dsh」模式；需要远端有 npm 和网络）。',
      fieldKeepRunning: '断开后保持远端运行（默认开启）',
      keepRunningHint:
        '开启后远端 dsh 会脱离 SSH 会话在后台常驻：点「返回」「断开」、本机睡眠或关掉应用，远端正在执行的任务都会继续；隧道断开时还会自动重连。关闭后远端 dsh 会随 SSH 会话结束而终止。远端日志 ~/.dsh/remote-desktop-web.log。',
      restartRemote: '重启远端',
      restarting: '重启中…',
      restartHint: '结束远端服务器上的 dsh 进程并重新启动（会中断正在执行的任务）。',
      keepAliveOffHint:
        '当前未开启「断开后保持远端运行」：本机睡眠、断网或断开连接会终止远端正在执行的任务。',
      keepAliveEnable: '开启并重启远端',
      linkReconnecting: '网络或本机睡眠导致连接中断，正在自动重连…（远端任务会继续运行）',
      linkDown: '隧道已断开，等待网络恢复后自动重连；远端任务仍在运行。也可点「重新加载」或「重启远端」。',
      fieldToken: '访问令牌（可选）',
      tokenPlaceholder: '从远端 dsh web: 启动行复制',
      tokenHint: '对应远端「dsh web: …?token=…」启动行里的 token；留空则不带令牌。',
      fieldUrl: '完整 URL',
      urlPlaceholder: 'https://dsh.example.com/?token=...',
      needName: '请填写名称。',
      nameTooLong: '名称最多 80 个字符。',
      needHost: '请填写 SSH 主机。',
      invalidPort: '端口需为 1–65535 的整数。',
      needUrl: '请填写 URL。',
      invalidUrl: 'URL 需为合法的 http(s) 地址。',
      tokenTooLong: '访问令牌最多 256 个字符。',
      discoverCardTitle: '本地 SSH 自动发现',
      discoverTitle: '发现 {n} 个本地 SSH 主机',
      discoverCandidateCount: '{n} 个候选项',
      discoverConfigSummary: 'SSH 配置 {path}（{n} 条）',
      discoverConfigMissing: 'SSH 配置不可读（{path}）',
      discoverKnownSummary: 'known_hosts {path}（{n} 条，{hashed} 条哈希）',
      discoverKnownMissing: 'known_hosts 不可读（{path}）',
      discoverAgentSummary: 'ssh-agent：{n} 个身份',
      discoverAgentUnavailable: 'ssh-agent 不可用',
      discoverDefaultKeys: '默认密钥：{keys}',
      discoverNoDefaultKeys: '未找到默认密钥',
      discoverRefreshing: '刷新中…',
      discoverImportAll: '全部导入',
      discoverImportingAll: '全部导入中…',
      discoverImport: '导入',
      discoverImporting: '导入中…',
      discoverImported: '已导入',
      discoverSourceConfig: 'SSH 配置',
      discoverSourceKnownHosts: 'known_hosts',
      discoverKeyHint: '私钥：{path}',
      discoverKeyHintDefault: '未指定私钥，使用默认密钥或 ssh-agent',
      discoverFailed: '读取本地 SSH 配置失败：{error}',
      discoverImportFailed: '导入「{name}」失败：{error}',
    }

    const EN = {
      navLabel: 'Remote Desktop',
      title: 'Remote Desktop',
      subtitle: 'Connect to dsh running on a remote server over SSH and operate its web UI inside this panel.',
      sshOk: 'SSH client available',
      sshMissing: 'SSH client not found',
      sshMissingHint: 'On Windows, install the OpenSSH Client optional feature; macOS and Linux usually include it.',
      addServer: 'Add server',
      refresh: 'Refresh',
      hostCount: '{n} servers',
      loading: 'Loading remote hosts…',
      loadErrorTitle: 'Cannot read remote host state',
      retry: 'Retry',
      dismiss: 'Dismiss',
      emptyTitle: 'No servers yet',
      emptyNeedDsh: 'The remote server needs dsh installed and available in a non-interactive SSH session.',
      emptyNeedKey: 'This machine must log in with an SSH key non-interactively (ssh-agent recommended; run ssh-add for passphrase-protected keys).',
      emptyModesTitle: 'Pick a connection mode:',
      modeLaunch: 'Launch remote dsh over SSH',
      modeAttach: 'Attach to running dsh over SSH',
      modeUrl: 'Direct URL',
      modeLaunchDesc: 'Start dsh web after logging in over SSH, parse its token, and forward the port automatically.',
      modeAttachDesc: 'dsh web already runs remotely; only forward its port, with an optional access token.',
      modeUrlDesc: 'Embed an existing public or reverse-proxied URL directly when no SSH is involved.',
      statusConnecting: 'Connecting',
      statusConnected: 'Connected',
      statusError: 'Error',
      statusDisconnected: 'Disconnected',
      connect: 'Connect',
      connecting: 'Connecting…',
      disconnect: 'Disconnect',
      disconnecting: 'Disconnecting…',
      openInApp: 'Open in desktop',
      openBrowser: 'Open in browser',
      browserTabHint: 'After connecting, the remote UI takes over the central area and the local left sidebar collapses. Use Back at the top to return to the local UI.',
      remoteOpening: 'Opening the remote UI…',
      remoteLoadFailed: 'The remote UI failed to load: {error}',
      remoteUnavailable: 'This environment cannot embed the remote UI; use "Open in browser" instead.',
      loginTitle: 'Remote sign-in must be authorized in your local browser',
      loginOpen: 'Open in browser',
      loginCopy: 'Copy link',
      loginOpened: 'Opened the authorization page in your local browser. Finish signing in there, then come back (reload if needed).',
      loginOpenFailed: 'Could not open the browser automatically: {error}. Use "Copy link" to open it manually.',
      loginCopied: 'Login link copied. Paste it into your browser to finish signing in.',
      loginCopyFailed: 'Copy failed: {error}.',
      settingsSection: 'Remote Desktop',
      settingsSubtitle: 'Add and manage remote hosts. Each configured host appears as an icon in the left sidebar; click it to connect and take over the window.',
      settingsAddHost: 'Add remote host',
      settingsDiscover: 'Discover from local SSH config',
      settingsEmpty: 'No remote hosts yet. Click "Add remote host", or discover them from your local SSH config.',
      discoverNoCandidates: 'No importable candidates were found.',
      discoverViewHint: 'Imported hosts appear in the left sidebar; you can keep adding or editing here.',
      hostConnecting: 'Connecting to "{name}"…',
      hostMissing: 'This host configuration was removed.',
      hostConnectFailed: 'Connection failed.',
      test: 'Test',
      testing: 'Testing…',
      testOk: 'SSH test passed',
      testFailed: 'SSH test failed',
      logTitle: 'Connection log',
      edit: 'Edit',
      delete: 'Delete',
      deleting: 'Deleting…',
      confirmDelete: 'Confirm delete',
      confirmDeleteHint: 'Delete "{name}"? This cannot be undone.',
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving…',
      back: 'Back',
      reload: 'Reload',
      editTitle: 'Edit server',
      addTitle: 'Add server',
      fieldName: 'Name',
      namePlaceholder: 'e.g. Production server',
      fieldMode: 'Connection mode',
      fieldSshHost: 'SSH host',
      sshHostPlaceholder: 'server.example.com',
      fieldSshPort: 'SSH port',
      fieldUser: 'Username',
      userPlaceholder: 'root (leave empty to use the SSH default user)',
      fieldIdentityFile: 'Private key path (optional)',
      identityFilePlaceholder: '~/.ssh/id_ed25519',
      fieldRemotePort: 'Remote port',
      fieldLaunchCommand: 'Launch command',
      launchHint: '`{port}` in the command is replaced with the remote port.',
      fieldInstallCommand: 'Auto-install command',
      installHint: 'On the first connection, if dsh is missing remotely this command runs to install it (launch mode only; the remote host needs npm and network access).',
      fieldKeepRunning: 'Keep the remote dsh running after disconnect (on by default)',
      keepRunningHint:
        'When enabled the remote dsh detaches from the SSH session and keeps running: Back, Disconnect, host sleep and even quitting this app leave remote tasks running, and a dropped tunnel reconnects automatically. When disabled the remote dsh ends with the SSH session. Remote log ~/.dsh/remote-desktop-web.log.',
      restartRemote: 'Restart remote',
      restarting: 'Restarting…',
      restartHint: 'Stop the remote dsh process and start it again (interrupts running tasks).',
      keepAliveOffHint:
        'Keeping the remote dsh running is off: sleeping, losing the network or disconnecting terminates running remote tasks.',
      keepAliveEnable: 'Enable and restart remote',
      linkReconnecting: 'Network loss or host sleep broke the tunnel; reconnecting automatically (remote tasks keep running).',
      linkDown: 'Tunnel is down; it reconnects automatically when the network returns and remote tasks keep running. You can also use Reload or Restart remote.',
      fieldToken: 'Access token (optional)',
      tokenPlaceholder: 'Copy from the remote "dsh web:" line',
      tokenHint: 'The token from the remote "dsh web: …?token=…" line; leave empty to omit it.',
      fieldUrl: 'Full URL',
      urlPlaceholder: 'https://dsh.example.com/?token=...',
      needName: 'Enter a name.',
      nameTooLong: 'Name must be at most 80 characters.',
      needHost: 'Enter the SSH host.',
      invalidPort: 'Port must be an integer between 1 and 65535.',
      needUrl: 'Enter a URL.',
      invalidUrl: 'URL must be a valid http(s) address.',
      tokenTooLong: 'Access token must be at most 256 characters.',
      discoverCardTitle: 'Local SSH discovery',
      discoverTitle: 'Found {n} local SSH hosts',
      discoverCandidateCount: '{n} candidates',
      discoverConfigSummary: 'SSH config {path} ({n} entries)',
      discoverConfigMissing: 'SSH config unreadable ({path})',
      discoverKnownSummary: 'known_hosts {path} ({n} entries, {hashed} hashed)',
      discoverKnownMissing: 'known_hosts unreadable ({path})',
      discoverAgentSummary: 'ssh-agent: {n} identities',
      discoverAgentUnavailable: 'ssh-agent unavailable',
      discoverDefaultKeys: 'Default keys: {keys}',
      discoverNoDefaultKeys: 'No default keys found',
      discoverRefreshing: 'Refreshing…',
      discoverImportAll: 'Import all',
      discoverImportingAll: 'Importing all…',
      discoverImport: 'Import',
      discoverImporting: 'Importing…',
      discoverImported: 'Imported',
      discoverSourceConfig: 'SSH config',
      discoverSourceKnownHosts: 'known_hosts',
      discoverKeyHint: 'Private key: {path}',
      discoverKeyHintDefault: 'No private key; default keys or ssh-agent will be used',
      discoverFailed: 'Failed to read local SSH config: {error}',
      discoverImportFailed: 'Failed to import "{name}": {error}',
    }

    /* ====================================================================== *
     * 纯函数工具
     * ====================================================================== */

    /** 统一 POST：same-origin + JSON；HTTP 失败或 ok:false 都转成 Error。 */
    async function postJson(path, body) {
      const response = await fetch(API_PREFIX + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body && typeof body === 'object' ? body : {}),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || !payload || payload.ok === false) {
        const message = (payload && (payload.error || payload.message)) || `HTTP ${response.status}`
        throw new Error(String(message))
      }
      return payload
    }

    /** 是否运行在 DSH Desktop 宿主里：此时 Host 与本机同机，可由 Host 打开本机浏览器。 */
    function isDesktopShell() {
      try {
        const carrier = globalThis.dshDesktop
        return Boolean(carrier && carrier.protocolVersion === 1)
      } catch {
        return false
      }
    }

    /** 渲染层兜底：window.open 由桌面主进程转成外部浏览器（离不开用户手势）。 */
    function openWithWindow(url) {
      try {
        const opened = window.open(url, '_blank', 'noopener,noreferrer')
        if (opened) {
          try {
            opened.opener = null
          } catch {
            // 跨域窗口无法写 opener 时忽略。
          }
        }
        return true
      } catch {
        return false
      }
    }

    /**
     * 用系统浏览器打开外部链接。
     * Desktop 下优先交给 Host 进程执行（定时器/后台逻辑里调用同样有效），
     * 其余环境退回 window.open。返回 { ok, channel, error }。
     */
    async function openExternalUrl(rawUrl) {
      const text = String(rawUrl || '').trim()
      if (!/^https?:\/\//i.test(text)) return { ok: false, channel: null, error: 'unsupported-url' }
      if (isDesktopShell()) {
        try {
          await postJson('/open-url', { url: text })
          return { ok: true, channel: 'host' }
        } catch (cause) {
          const fallback = openWithWindow(text)
          return {
            ok: fallback,
            channel: fallback ? 'window' : null,
            error: String((cause && cause.message) || cause || 'unknown'),
          }
        }
      }
      const ok = openWithWindow(text)
      return { ok, channel: ok ? 'window' : null }
    }

    /** 复制文本：优先 Clipboard API，失败退回临时 textarea（渲染层可能没有剪贴板权限）。 */
    async function copyText(rawText) {
      const text = String(rawText || '')
      if (!text) return false
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // 权限被拒绝时走兜底。
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', 'readonly')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
        document.body.removeChild(area)
        return ok !== false
      } catch {
        return false
      }
    }

    function isValidHttpUrl(text) {
      try {
        const parsed = new URL(text)
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      } catch {
        return false
      }
    }

    /** 空串回落默认端口；非法输入返回 null。 */
    function parsePortValue(raw, fallback) {
      const text = String(raw == null ? '' : raw).trim()
      if (text === '') return fallback
      if (!/^\d+$/.test(text)) return null
      const value = Number(text)
      if (!Number.isInteger(value) || value < 1 || value > 65535) return null
      return value
    }

    /** 新增表单的默认草稿（端口类字段用字符串，保存时再转数字）。 */
    function emptyDraft() {
      return {
        id: '',
        name: '',
        mode: 'launch',
        host: '',
        port: String(DEFAULT_SSH_PORT),
        user: '',
        identityFile: '',
        remotePort: String(DEFAULT_REMOTE_PORT),
        launchCommand: DEFAULT_LAUNCH_COMMAND,
        installCommand: DEFAULT_INSTALL_COMMAND,
        keepRemoteRunning: true,
        token: '',
        url: '',
      }
    }

    function draftFromHost(host) {
      return {
        id: host.id || '',
        name: host.name || '',
        mode: MODES.includes(host.mode) ? host.mode : 'launch',
        host: host.host || '',
        port: host.port == null ? String(DEFAULT_SSH_PORT) : String(host.port),
        user: host.user || '',
        identityFile: host.identityFile || '',
        remotePort: host.remotePort == null ? String(DEFAULT_REMOTE_PORT) : String(host.remotePort),
        launchCommand: host.launchCommand || DEFAULT_LAUNCH_COMMAND,
        installCommand: host.installCommand || DEFAULT_INSTALL_COMMAND,
        keepRemoteRunning: host.keepRemoteRunning !== false,
        token: host.token || '',
        url: host.url || '',
      }
    }

    /**
     * 草稿 → HostInput。返回 { ok:true, host } 或 { error: localeKey }。
     * 编辑已有主机时必须把 id 合并进 host 对象（Host API 依此判断更新）。
     */
    function buildHostInput(draft) {
      const name = draft.name.trim()
      if (!name) return { error: 'needName' }
      if (name.length > MAX_NAME_CHARS) return { error: 'nameTooLong' }

      const mode = MODES.includes(draft.mode) ? draft.mode : 'launch'
      const input = {
        name,
        mode,
        host: draft.host.trim(),
        user: draft.user.trim(),
        identityFile: draft.identityFile.trim(),
        launchCommand: draft.launchCommand.trim(),
        installCommand: mode === 'launch' ? draft.installCommand.trim() || DEFAULT_INSTALL_COMMAND : '',
        keepRemoteRunning: mode === 'launch' ? draft.keepRemoteRunning === true : false,
        token: mode === 'attach' ? draft.token.trim() : '',
        url: '',
        port: DEFAULT_SSH_PORT,
        remotePort: DEFAULT_REMOTE_PORT,
      }
      if (input.token.length > MAX_TOKEN_CHARS) return { error: 'tokenTooLong' }

      if (mode === 'url') {
        const url = draft.url.trim()
        if (!url) return { error: 'needUrl' }
        if (!isValidHttpUrl(url)) return { error: 'invalidUrl' }
        input.url = url
      } else {
        if (!input.host) return { error: 'needHost' }
        const port = parsePortValue(draft.port, DEFAULT_SSH_PORT)
        if (port === null) return { error: 'invalidPort' }
        const remotePort = parsePortValue(draft.remotePort, DEFAULT_REMOTE_PORT)
        if (remotePort === null) return { error: 'invalidPort' }
        input.port = port
        input.remotePort = remotePort
      }

      if (draft.id) input.id = draft.id
      return { ok: true, host: input }
    }

    /** 主机卡片第二行：user@host:port，URL 模式直接显示 URL。 */
    function hostEndpoint(host) {
      if (!host) return ''
      if (host.mode === 'url') return String(host.url || '')
      const target = host.user ? `${host.user}@${host.host || ''}` : String(host.host || '')
      return host.port ? `${target}:${host.port}` : target
    }

    /** 连接日志只展示最后几行（等宽、可滚动）。 */
    function tailLog(log) {
      if (!Array.isArray(log) || log.length === 0) return ''
      return log.slice(-LOG_TAIL_LINES).join('\n')
    }

    /** discover 候选 → POST /hosts 的 HostInput（launch 模式，默认远端端口与启动命令）。 */
    function candidateToHost(candidate) {
      const host = String(candidate.host || '').trim()
      const rawName = String(candidate.name || candidate.alias || host).trim()
      const port = Number(candidate.port)
      return {
        name: (rawName || host).slice(0, MAX_NAME_CHARS),
        mode: 'launch',
        host,
        port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_SSH_PORT,
        user: String(candidate.user || '').trim(),
        identityFile: String(candidate.identityFile || '').trim(),
        remotePort: DEFAULT_REMOTE_PORT,
        launchCommand: DEFAULT_LAUNCH_COMMAND,
        installCommand: DEFAULT_INSTALL_COMMAND,
        token: '',
        url: '',
      }
    }

    /** 候选行第二行：user 为空时只显示 host:port。 */
    function candidateEndpoint(candidate) {
      const target = candidate.user ? `${candidate.user}@${candidate.host || ''}` : String(candidate.host || '')
      return candidate.port ? `${target}:${candidate.port}` : target
    }

    /** 侧栏与页头共用的「远程主机」图标（显示器 + 双向箭头）。 */
    function RdIcon(props) {
      const size = Number(props && props.size) || 22
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', { x: 2.5, y: 3.5, width: 19, height: 13, rx: 2.2 }),
        h('path', { d: 'M8.5 20.5h7' }),
        h('path', { d: 'M12 16.5v4' }),
        h('path', { d: 'M7 8.5h4.5' }),
        h('path', { d: 'M9.3 6.4 11.4 8.5 9.3 10.6' }),
        h('path', { d: 'M17 10.5h-4.5' }),
        h('path', { d: 'M14.7 8.4 12.6 10.5l2.1 2.1' }),
      )
    }

    /* ====================================================================== *
     * 插件入口
     * ====================================================================== */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind('remoteDesktop')
        const fmt = (key, vars) => {
          let text = t(key)
          if (vars) {
            for (const name of Object.keys(vars)) {
              text = text.split(`{${name}}`).join(String(vars[name]))
            }
          }
          return text
        }

        ctx.effect(() => ctx.locale.register('remoteDesktop', 'zh', ZH), 'remote-desktop: zh dictionary')
        ctx.effect(() => ctx.locale.register('remoteDesktop', 'en', EN), 'remote-desktop: en dictionary')

        /** 语言切换时重渲染（照抄 ppt-studio 的订阅方式）。 */
        function useLocaleRevision() {
          const [, setRevision] = useState(0)
          useEffect(() => {
            try {
              return ctx.locale.subscribe(() => setRevision((value) => value + 1))
            } catch {
              return undefined
            }
          }, [])
        }

        /* 本地应用外壳的布局服务（用于接管时收起左侧栏）。 */
        let layoutService = null
        ctx.inject(['layout'], (scope) => {
          layoutService = scope.layout
        })

        let sidebarCollapsedByUs = false

        /** 读取桌面外壳左侧栏是否展开；读不到时返回 undefined（非 Windows 或变量未定义）。 */
        function sidebarExpandedState() {
          try {
            const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-sidebar-width').trim()
            const px = Number.parseFloat(raw)
            return Number.isFinite(px) ? px > 64 : undefined
          } catch {
            return undefined
          }
        }

        /** 接管窗口时收起本地左侧栏（确认展开或无法判断时尝试一次）。 */
        function collapseLocalSidebar() {
          if (sidebarCollapsedByUs || !layoutService || typeof layoutService.toggleSidebar !== 'function') return
          if (sidebarExpandedState() === false) return
          try {
            layoutService.toggleSidebar()
            sidebarCollapsedByUs = true
          } catch {
            // 布局服务异常时忽略：接管本身不受影响。
          }
        }

        /** 退出远端视图时恢复本地左侧栏。 */
        function restoreLocalSidebar() {
          if (!sidebarCollapsedByUs) return
          sidebarCollapsedByUs = false
          try {
            if (layoutService && typeof layoutService.toggleSidebar === 'function') layoutService.toggleSidebar()
          } catch {
            // 忽略恢复失败。
          }
        }

        /** Desktop 暴露的浏览器 guest 租约桥（官方 Browser 面板使用同一套）。 */
        function getDesktopBridge() {
          try {
            const carrier = globalThis.dshDesktop
            if (!carrier || carrier.protocolVersion !== 1 || !carrier.browser) return undefined
            const bridge = carrier.browser
            if (typeof bridge.acquire !== 'function' || typeof bridge.release !== 'function') return undefined
            return bridge
          } catch {
            return undefined
          }
        }

        /**
         * 无地址栏的远端界面：在中央面板里用应用自己的 Browser guest 租约渲染一个
         * Electron <webview>。Desktop 下它是独立顶层文档与 cookie 分区（第一方会话），
         * 远端 dsh 的 SameSite=Strict 登录态才能生效；普通 iframe 会被跨站拦截。
         */
        function RemoteView(props) {
          const {
            hostId,
            name,
            url,
            t,
            fmt,
            onBack,
            onDisconnect,
            onRestart,
            restartBusy,
            keepRunning,
            keepBusy,
            onEnableKeepRunning,
            linkStatus,
            onOpenExternal,
            busy,
          } = props
          const hostRef = useRef(null)
          const viewRef = useRef(null)
          const [phase, setPhase] = useState('opening')
          const [error, setError] = useState('')
          const [diagLines, setDiagLines] = useState([])
          const [loginUrl, setLoginUrl] = useState('')
          const [infoNote, setInfoNote] = useState('')

          useEffect(() => {
            const bridge = getDesktopBridge()
            const container = hostRef.current
            let disposed = false
            let lease = null
            let element = null
            let watchdog = null
            let probeTimer = null
            let loginPollTimer = null
            let lastOpenedLogin = ''
            let reloadedOnce = false
            let unsubscribeOpen = null
            /**
             * 远端视图打开期间申请屏幕唤醒锁：本机因空闲进入现代待机会断开网卡，
             * 进而切断 SSH 隧道（表现为频繁断线重连）。只要用户正在看远端界面，
             * 就阻止屏幕休眠；离开视图或页面隐藏时释放，不影响正常待机。
             */
            let wakeLock = null
            const acquireWakeLock = () => {
              try {
                const api = navigator && navigator.wakeLock
                if (!api || typeof api.request !== 'function' || document.visibilityState !== 'visible') return
                api
                  .request('screen')
                  .then((lock) => {
                    if (disposed) {
                      try {
                        lock.release()
                      } catch {
                        // 忽略释放失败。
                      }
                      return
                    }
                    wakeLock = lock
                  })
                  .catch(() => {
                    // 环境不支持或策略拒绝：静默降级。
                  })
              } catch {
                // 忽略：唤醒锁只是体验优化。
              }
            }
            const releaseWakeLock = () => {
              const lock = wakeLock
              wakeLock = null
              if (!lock) return
              try {
                lock.release()
              } catch {
                // 忽略释放失败。
              }
            }
            const onVisibilityChange = () => {
              if (disposed) return
              if (document.visibilityState === 'visible') acquireWakeLock()
              else releaseWakeLock()
            }
            acquireWakeLock()
            try {
              document.addEventListener('visibilitychange', onVisibilityChange)
            } catch {
              // 忽略监听失败。
            }
            const note = (text) => {
              if (disposed) return
              const clean = String(text || '').trim()
              if (!clean) return
              setDiagLines((previous) => {
                const next = clean.slice(0, 300)
                if (previous.includes(next)) return previous
                return [...previous.slice(-2), next]
              })
            }
            /** 中性提示（登录流程等正常事件），与红色诊断条分开显示。 */
            const hint = (text) => {
              if (disposed) return
              const clean = String(text || '').trim()
              if (!clean) return
              setInfoNote(clean.slice(0, 300))
            }
            const clearWatchdog = () => {
              if (watchdog === null) return
              clearTimeout(watchdog)
              watchdog = null
            }
            const releaseLease = () => {
              const current = lease
              lease = null
              if (current === null || !bridge) return
              try {
                const pending = bridge.release(current)
                if (pending && typeof pending.catch === 'function') pending.catch(() => {})
              } catch {
                // 释放失败忽略：主进程会在窗口销毁时统一回收。
              }
            }
            const fail = (message) => {
              if (disposed) return
              clearWatchdog()
              setError(String(message || 'unknown'))
              setPhase('error')
            }
            /** 诊断信息：guest 是否真的被主进程附加（未附加时 webview 方法会抛错）。 */
            const describeGuest = (view) => {
              const parts = []
              try {
                parts.push(`element=${(view && view.constructor && view.constructor.name) || 'unknown'}`)
                parts.push(typeof (view && view.loadURL) === 'function' ? 'loadURL=yes' : 'loadURL=no')
                const id = typeof view.getWebContentsId === 'function' ? view.getWebContentsId() : undefined
                parts.push(id === undefined ? 'webContents=未知' : `webContents=${id}`)
              } catch (cause) {
                parts.push(`guest 未附加（${String((cause && cause.message) || cause)}）`)
              }
              try {
                if (typeof view.getURL === 'function') parts.push(`url=${view.getURL() || '(empty)'}`)
              } catch {
                // 忽略读取失败。
              }
              return parts.join('; ')
            }
            if (!bridge || !container) {
              fail(t('remoteUnavailable'))
              return undefined
            }
            setPhase('opening')
            setError('')
            ;(async () => {
              try {
                const reservation = await bridge.acquire(`remote-desktop:${hostId}`)
                if (disposed) {
                  try {
                    const pending = bridge.release(reservation.lease)
                    if (pending && typeof pending.catch === 'function') pending.catch(() => {})
                  } catch {
                    // 忽略。
                  }
                  return
                }
                lease = reservation.lease
                // 远端页面里的弹窗（典型是 DeepSeek 账号登录授权页）由主进程转成
                // browserOpenRequested；转发到本地系统浏览器，授权回调经本地隧道回到远端。
                try {
                  if (typeof bridge.onOpenRequested === 'function') {
                    unsubscribeOpen = bridge.onOpenRequested(lease, (target) => {
                      if (disposed || typeof target !== 'string') return
                      if (!/^https?:\/\//i.test(target)) return
                      setLoginUrl(target)
                      void openExternalUrl(target).then((result) => {
                        if (disposed) return
                        if (result.ok) hint(t('loginOpened'))
                        else hint(fmt('loginOpenFailed', { error: result.error || 'unknown' }))
                      })
                    })
                  }
                } catch {
                  // 订阅失败不影响远端页面本身。
                }
                const view = document.createElement('webview')
                view.className = 'rd-webview'
                view.setAttribute('name', reservation.lease)
                view.setAttribute('partition', reservation.partition)
                view.setAttribute('allowpopups', '')
                view.setAttribute('src', `about:blank#${reservation.lease}`)
                element = view
                viewRef.current = view
                const consoleErrors = []
                view.addEventListener('console-message', (event) => {
                  if (disposed) return
                  const level = event && typeof event.level === 'number' ? event.level : 0
                  const message = String((event && (event.message || event.detail)) || '').trim()
                  if (level < 2 || !message) return
                  if (consoleErrors.length < 10) consoleErrors.push(message.slice(0, 400))
                  // 页面自身的 console.error（如账号接口失败）通常不影响使用：
                  // 只写入诊断日志，不占用界面；只有探测到白屏时才提示。
                  void postJson('/client-report', {
                    report: { hostId, url, kind: 'console', consoleErrors },
                  }).catch?.(() => {})
                })
                const probeBody = `(async () => {
                  const out = {};
                  out.href = String(location.href);
                  out.title = document.title || "";
                  out.ready = document.readyState;
                  const root = document.getElementById("root");
                  out.rootChildren = root ? root.childElementCount : -1;
                  out.text = document.body ? String(document.body.innerText || "").slice(0, 400) : "";
                  out.boot = typeof window.__DSH_BOOT__;
                  try { out.transport = JSON.stringify(window.__DSH_TRANSPORT__ || null).slice(0, 400); } catch (error) { out.transport = "unreadable"; }
                  try { out.bodyBg = getComputedStyle(document.body).backgroundColor; } catch (error) { out.bodyBg = "unknown"; }
                  try { out.rootHtml = document.getElementById("root") ? String(document.getElementById("root").innerHTML || "").slice(0, 300) : ""; } catch (error) { out.rootHtml = "unreadable"; }
                  try {
                    out.failedResources = performance.getEntriesByType("resource")
                      .map((entry) => ({ name: entry.name, status: entry.responseStatus, size: entry.transferSize }))
                      .filter((item) => !item.status || item.status >= 400)
                      .slice(0, 30);
                  } catch (error) { out.failedResources = "unreadable"; }
                  try { out.scripts = Array.from(document.scripts).map((script) => script.src || "(inline)").slice(0, 15); } catch (error) { out.scripts = "unreadable"; }
                  try { const response = await fetch("/api", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); out.api = response.status; } catch (error) { out.api = "err:" + String((error && error.message) || error); }
                  try { const response = await fetch("/connect", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); out.connect = response.status; } catch (error) { out.connect = "err:" + String((error && error.message) || error); }
                  return JSON.stringify(out);
                })()`
                /** 加载后探测远端页面是否真的渲染了内容（白板时给出证据），并上报到 Host 日志。 */
                const runProbe = async () => {
                  let info = null
                  try {
                    const raw = await view.executeJavaScript(probeBody)
                    if (disposed) return
                    try {
                      info = JSON.parse(String(raw))
                    } catch {
                      info = null
                    }
                  } catch (cause) {
                    note(`页面探测失败：${String((cause && cause.message) || cause)}`)
                  }
                  if (!disposed) {
                    void postJson('/client-report', {
                      report: {
                        hostId,
                        url,
                        info,
                        consoleErrors,
                        diag: [],
                      },
                    }).catch?.(() => {})
                  }
                  if (info === null) return
                  const text = String(info.text || '').trim()
                  const empty = !(info.rootChildren > 0 || text !== '')
                  if (!empty) {
                    setDiagLines((previous) => previous.slice(0, 1))
                    return
                  }
                  note(
                    `页面已加载但未渲染：#root=${info.rootChildren}；title=${info.title || '(空)'}；api=${info.api}；connect=${info.connect}；href=${info.href}`,
                  )
                  if (!reloadedOnce) {
                    reloadedOnce = true
                    try {
                      view.reload()
                    } catch {
                      // 忽略重载失败。
                    }
                  }
                }
                /**
                 * 远端登录链接捕获。
                 *
                 * 远端账号登录 UI（dsh-client-ui-settings-account 的 BrowserLogin）在点击
                 * 「登录」时先 `window.open("about:blank", "_blank")` 预开一个标签页，等 Host
                 * 的登录尝试返回 `authorizeUrl` 后再 `popup.location.replace(授权地址)`。
                 * 在 Electron guest 里任何 window.open 都会被 deny（返回 null），授权地址
                 * 因此永远不会出现在 window.open 的入参里——所以这里返回一个「假弹窗」，
                 * 接管后续 location.replace/href 跳转，并把真正的授权地址交给本地浏览器。
                 * 另外保留外链点击、复制登录链接、RPC 响应扫描三条兜底。
                 */
                const loginHookScript = `(() => {
                  const isHttp = (value) => typeof value === "string" && (value.indexOf("http://") === 0 || value.indexOf("https://") === 0);
                  if (!window.__rdLoginHook) {
                    window.__rdLoginHook = true;
                    window.__rdLoginUrl = "";
                    window.__rdLoginVia = "";
                    const capture = (value, via) => {
                      try {
                        const text = typeof value === "string" ? value : String((value && value.href) || "");
                        if (!isHttp(text)) return;
                        window.__rdLoginUrl = text;
                        window.__rdLoginVia = via;
                      } catch (e) {}
                    };
                    // 假弹窗：只实现登录流程真正会用到的 popup 成员。
                    const fakePopup = () => {
                      const popup = { opener: null, closed: false, name: "", focus() {}, blur() {}, postMessage() {} };
                      const target = {
                        _href: "about:blank",
                        replace(url) { capture(url, "popup.replace"); },
                        assign(url) { capture(url, "popup.assign"); },
                        reload() {},
                        toString() { return this._href; }
                      };
                      try {
                        Object.defineProperty(target, "href", {
                          configurable: true,
                          get() { return target._href; },
                          set(value) { target._href = String(value); capture(value, "popup.href"); }
                        });
                      } catch (e) {}
                      popup.location = target;
                      popup.close = function () { popup.closed = true; };
                      popup.closed = false;
                      return popup;
                    };
                    const originalOpen = window.open;
                    window.open = function (url, name, features) {
                      try {
                        const value = typeof url === "string" ? url : "";
                        if (isHttp(value)) { capture(value, "window.open"); return fakePopup(); }
                        // about:blank / 空 → 登录流程的预开标签页：返回假弹窗等它导航。
                        if (value === "" || value.indexOf("about:") === 0) return fakePopup();
                      } catch (e) {}
                      try {
                        return originalOpen ? originalOpen.call(window, url, name, features) : null;
                      } catch (e) { return null; }
                    };
                    try {
                      const clipboard = navigator.clipboard;
                      if (clipboard && clipboard.writeText) {
                        const write = clipboard.writeText.bind(clipboard);
                        clipboard.writeText = function (text) {
                          capture(String(text), "clipboard");
                          return write(String(text));
                        };
                      }
                    } catch (e) {}
                    document.addEventListener("click", function (event) {
                      try {
                        const node = event.target;
                        const anchor = node && node.closest ? node.closest("a[href]") : null;
                        if (!anchor) return;
                        const href = anchor.href;
                        if (!href || href.indexOf(location.origin) === 0) return;
                        capture(href, "anchor");
                      } catch (e) {}
                    }, true);
                    // 兜底：账号状态的 RPC 响应体里也可能直接带着授权地址。
                    try {
                      const originalFetch = window.fetch;
                      if (typeof originalFetch === "function") {
                        const scan = (body) => {
                          try {
                            const marker = body.indexOf("/dsh/authorize?");
                            if (marker < 0) return;
                            const start = body.lastIndexOf("http", marker);
                            if (start < 0) return;
                            let end = marker;
                            while (end < body.length) {
                              const code = body.charCodeAt(end);
                              // 遇到引号、反斜杠、尖括号、逗号或空白就截断。
                              if (code === 34 || code === 39 || code === 92 || code === 60 || code === 62 || code === 44 || code === 32 || code === 9 || code === 10 || code === 13) break;
                              end += 1;
                            }
                            capture(body.slice(start, end), "fetch");
                          } catch (e) {}
                        };
                        window.fetch = function () {
                          return originalFetch.apply(window, arguments).then(function (response) {
                            try {
                              const headers = response && response.headers;
                              const type = String((headers && headers.get && headers.get("content-type")) || "");
                              if (type.indexOf("json") >= 0 && typeof response.clone === "function") {
                                response.clone().text().then(scan, function () {});
                              }
                            } catch (e) {}
                            return response;
                          });
                        };
                      }
                    } catch (e) {}
                  }
                  const url = window.__rdLoginUrl;
                  const via = window.__rdLoginVia;
                  window.__rdLoginUrl = "";
                  window.__rdLoginVia = "";
                  return JSON.stringify({ url: String(url || ""), via: String(via || "") });
                })()`
                const pollLoginLink = async () => {
                  try {
                    const raw = String((await view.executeJavaScript(loginHookScript)) || '')
                    if (disposed || !raw) return
                    let candidate = raw
                    let via = ''
                    try {
                      const parsed = JSON.parse(raw)
                      candidate = String((parsed && parsed.url) || '')
                      via = String((parsed && parsed.via) || '')
                    } catch {
                      // 兼容旧格式：直接返回 URL 字符串。
                    }
                    if (!/^https?:\/\//i.test(candidate)) return
                    setLoginUrl(candidate)
                    if (candidate === lastOpenedLogin) return
                    lastOpenedLogin = candidate
                    const result = await openExternalUrl(candidate)
                    if (disposed) return
                    if (result.ok) hint(t('loginOpened'))
                    else hint(fmt('loginOpenFailed', { error: result.error || 'unknown' }))
                    void postJson('/client-report', {
                      report: {
                        hostId,
                        url,
                        kind: 'login-link',
                        via,
                        loginUrl: candidate.slice(0, 800),
                        opened: result.ok,
                        channel: result.channel,
                      },
                    }).catch?.(() => {})
                  } catch {
                    // 页面尚未就绪或已销毁时忽略。
                  }
                }
                view.addEventListener('dom-ready', () => {
                  if (disposed) return
                  // guest 已附加：先撤掉遮罩，让远端页面自己渲染（它有自己的启动过程）。
                  clearWatchdog()
                  setPhase('ready')
                  try {
                    const pending = view.loadURL(url)
                    if (pending && typeof pending.catch === 'function') {
                      pending.catch((cause) => fail(String((cause && cause.message) || cause)))
                    }
                  } catch (cause) {
                    fail(String((cause && cause.message) || cause))
                  }
                  probeTimer = setTimeout(() => {
                    probeTimer = null
                    if (!disposed) void runProbe()
                  }, 4500)
                  loginPollTimer = setInterval(() => {
                    void pollLoginLink()
                  }, 1500)
                }, { once: true })
                view.addEventListener('did-fail-load', (event) => {
                  if (disposed || !event || event.isMainFrame === false || event.errorCode === -3) return
                  fail(`${event.errorCode} ${event.errorDescription || ''}`.trim())
                })
                // 每次主文档加载完成立刻补装登录挂钩，缩小「页面已就绪但钩子未装」的窗口。
                view.addEventListener('did-finish-load', () => {
                  if (disposed) return
                  void pollLoginLink()
                })
                container.appendChild(view)
                watchdog = setTimeout(() => {
                  watchdog = null
                  if (disposed || element === null) return
                  fail(
                    `webview 在 12 秒内没有就绪（租约 ${String(reservation.lease).slice(0, 8)}…；${describeGuest(view)}）`,
                  )
                }, 12000)
              } catch (cause) {
                fail(`获取 browser guest 失败：${String((cause && cause.message) || cause)}`)
              }
            })()
            return () => {
              disposed = true
              clearWatchdog()
              if (probeTimer !== null) {
                clearTimeout(probeTimer)
                probeTimer = null
              }
              if (loginPollTimer !== null) {
                clearInterval(loginPollTimer)
                loginPollTimer = null
              }
              viewRef.current = null
              try {
                if (typeof unsubscribeOpen === 'function') unsubscribeOpen()
              } catch {
                // 忽略取消订阅失败。
              }
              unsubscribeOpen = null
              try {
                if (element && element.parentNode) element.parentNode.removeChild(element)
              } catch {
                // 忽略 DOM 清理失败。
              }
              element = null
              releaseWakeLock()
              try {
                document.removeEventListener('visibilitychange', onVisibilityChange)
              } catch {
                // 忽略移除失败。
              }
              releaseLease()
            }
          }, [hostId, url])

          const reloadView = () => {
            setDiagLines([])
            setInfoNote('')
            setLoginUrl('')
            try {
              const view = viewRef.current
              if (view && typeof view.reload === 'function') view.reload()
            } catch {
              // 忽略重载失败。
            }
          }

          const openLoginLink = () => {
            if (!loginUrl) return
            void openExternalUrl(loginUrl).then((result) => {
              if (result.ok) setInfoNote(t('loginOpened'))
              else setInfoNote(fmt('loginOpenFailed', { error: result.error || 'unknown' }))
            })
          }

          const copyLoginLink = () => {
            if (!loginUrl) return
            void copyText(loginUrl).then((ok) => {
              setInfoNote(ok ? t('loginCopied') : fmt('loginCopyFailed', { error: 'clipboard' }))
            })
          }

          const status =
            phase === 'ready'
              ? null
              : phase === 'error'
                ? h(
                    'div',
                    { className: 'rd-remoteStatus' },
                    h('div', { className: 'rd-remoteStatusText' }, fmt('remoteLoadFailed', { error: error || 'unknown' })),
                    diagLines.length > 0
                      ? h('pre', { className: 'rd-log rd-connectLog' }, diagLines.join('\n'))
                      : null,
                    h(
                      'div',
                      { className: 'rd-remoteStatusActions' },
                      h('button', { type: 'button', className: 'rd-btn rd-btnSmall', onClick: onBack }, t('back')),
                      h(
                        'button',
                        { type: 'button', className: 'rd-btn rd-btnSmall rd-btnPrimary', onClick: onOpenExternal },
                        t('openBrowser'),
                      ),
                    ),
                  )
                : h(
                    'div',
                    { className: 'rd-remoteStatus' },
                    h('span', { className: 'rd-spin', 'aria-hidden': true }),
                    h('span', { className: 'rd-remoteStatusText' }, t('remoteOpening')),
                  )

          return h(
            'div',
            { className: 'rd-remote' },
            h(
              'div',
              { className: 'rd-remoteBar' },
              h('button', { type: 'button', className: 'rd-btn rd-btnSmall', onClick: onBack }, t('back')),
              h('span', { className: 'rd-remoteTitle', title: name }, name),
              h('span', { className: 'rd-spacer' }),
              h('button', { type: 'button', className: 'rd-btn rd-btnSmall', onClick: reloadView }, t('reload')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'rd-btn rd-btnSmall',
                  disabled: busy || restartBusy,
                  onClick: onRestart,
                  title: t('restartHint'),
                },
                restartBusy ? t('restarting') : t('restartRemote'),
              ),
              h(
                'button',
                { type: 'button', className: 'rd-btn rd-btnSmall rd-btnDanger', disabled: busy, onClick: onDisconnect },
                t('disconnect'),
              ),
            ),
            h(
              'div',
              { className: 'rd-remoteBody' },
              h('div', { className: 'rd-remoteHost', ref: hostRef }),
              status,
            ),
            phase === 'ready' && linkStatus !== 'connected'
              ? h(
                  'div',
                  { className: 'rd-remoteInfo' },
                  h(
                    'span',
                    { className: 'rd-remoteInfoText' },
                    linkStatus === 'connecting' ? t('linkReconnecting') : t('linkDown'),
                  ),
                )
              : null,
            phase === 'ready' && keepRunning === false
              ? h(
                  'div',
                  { className: 'rd-remoteInfo' },
                  h('span', { className: 'rd-remoteInfoText' }, t('keepAliveOffHint')),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'rd-btn rd-btnSmall rd-btnPrimary',
                      disabled: keepBusy || restartBusy,
                      onClick: onEnableKeepRunning,
                    },
                    keepBusy ? t('restarting') : t('keepAliveEnable'),
                  ),
                )
              : null,
            phase === 'ready' && loginUrl
              ? h(
                  'div',
                  { className: 'rd-remoteLogin' },
                  h('span', { className: 'rd-remoteLoginText', title: loginUrl }, t('loginTitle')),
                  h('button', { type: 'button', className: 'rd-btn rd-btnSmall rd-btnPrimary', onClick: openLoginLink }, t('loginOpen')),
                  h('button', { type: 'button', className: 'rd-btn rd-btnSmall', onClick: copyLoginLink }, t('loginCopy')),
                  h('button', { type: 'button', className: 'rd-btn rd-btnSmall rd-btnGhost', onClick: () => setLoginUrl('') }, t('dismiss')),
                )
              : null,
            infoNote
              ? h(
                  'div',
                  { className: 'rd-remoteInfo' },
                  h('span', { className: 'rd-remoteInfoText' }, infoNote),
                  h('button', { type: 'button', className: 'rd-btn rd-btnSmall rd-btnGhost', onClick: () => setInfoNote('') }, t('dismiss')),
                )
              : null,
            phase === 'ready' && diagLines.length > 0
              ? h(
                  'div',
                  { className: 'rd-remoteDiag' },
                  h('span', { className: 'rd-remoteDiagText' }, diagLines.join('\n')),
                  h('button', { type: 'button', className: 'rd-btn rd-btnSmall', onClick: reloadView }, t('reload')),
                  h('button', { type: 'button', className: 'rd-btn rd-btnSmall rd-btnGhost', onClick: () => setDiagLines([]) }, t('dismiss')),
                )
              : null,
          )
        }

        /** 读取 Host 状态（管理面板与左侧栏入口共用）。 */
        async function getState() {
          const response = await fetch(`${API_PREFIX}/state`, { credentials: 'same-origin' })
          let payload = null
          try {
            payload = await response.json()
          } catch {
            payload = null
          }
          if (!response.ok || !payload || payload.ok === false) {
            throw new Error((payload && payload.error) || `HTTP ${response.status}`)
          }
          return payload
        }

        /* ---------------------- 每台远程主机：左侧栏图标 + 远端视图 ---------------------- */

        /** 已配置主机在左侧栏的入口：点开即自动连接并接管窗口；返回回到本地桌面界面。 */
        function RemoteHostPage(props) {
          const { hostId, fallbackName } = props
          const [hostName, setHostName] = useState(fallbackName)
          const [phase, setPhase] = useState('connecting')
          const [error, setError] = useState('')
          const [target, setTarget] = useState(null)
          const [logTail, setLogTail] = useState([])
          const [generation, setGeneration] = useState(0)
          const [restartBusy, setRestartBusy] = useState(false)
          const [keepRunning, setKeepRunning] = useState(true)
          const [keepBusy, setKeepBusy] = useState(false)
          const [currentHost, setCurrentHost] = useState(null)
          const [linkStatus, setLinkStatus] = useState('connected')
          const connectRequested = useRef(false)

          useEffect(() => {
            let disposed = false
            let timer = null
            let logTimer = null
            let lastReportedLogLine = ''
            let offlineTicks = 0
            connectRequested.current = false
            collapseLocalSidebar()
            /**
             * 连接就绪后的轻量状态同步（每 3 秒）：
             * 1. 把远端 ssh 输出（含远端 dsh 自己的 stderr）变化回传到诊断文件；
             * 2. 跟踪隧道状态，断线自动重连期间给用户明确提示（远端任务不受影响）；
             * 3. 本地端口万一变了，同步新的远端 URL，避免页面停留在旧地址上。
             */
            const syncLiveState = async () => {
              try {
                const payload = await getState()
                if (disposed) return
                const connection = (payload.active || {})[hostId] || null
                // 抖动抑制：连续两次轮询都非 connected 才显示提示条，避免几秒级中断让界面闪。
                if (connection && connection.status === 'connected') {
                  offlineTicks = 0
                  setLinkStatus('connected')
                } else {
                  offlineTicks += 1
                  setLinkStatus(offlineTicks >= 2 && connection ? connection.status : 'connected')
                }
                if (connection && connection.status === 'connected' && connection.url) {
                  setTarget((previous) => {
                    if (previous === null || previous.url === connection.url) return previous
                    const host = (payload.hosts || []).find((item) => item.id === hostId) || previous.host
                    return { host, url: connection.url }
                  })
                }
                const lines = connection && Array.isArray(connection.log) ? connection.log : []
                if (lines.length === 0) return
                const last = lines[lines.length - 1]
                if (last === lastReportedLogLine) return
                lastReportedLogLine = last
                await postJson('/client-report', {
                  report: { hostId, kind: 'remote-log', lines: lines.slice(-40) },
                })
              } catch {
                // 诊断与状态提示用途；失败忽略。
              }
            }
            const poll = async () => {
              try {
                const payload = await getState()
                if (disposed) return
                const host = (payload.hosts || []).find((item) => item.id === hostId) || null
                if (!host) {
                  setPhase('error')
                  setError(t('hostMissing'))
                  return
                }
                setHostName(host.name || host.host || fallbackName)
                setCurrentHost(host)
                setKeepRunning(host.keepRemoteRunning !== false)
                const connection = (payload.active || {})[hostId] || null
                if (connection && Array.isArray(connection.log)) setLogTail(connection.log.slice(-8))
                if (connection && connection.status === 'connected' && connection.url) {
                  autoOpenedConnections.add(`${hostId}|${connection.startedAt || ''}`)
                  setTarget({ host, url: connection.url })
                  setLinkStatus('connected')
                  setPhase('ready')
                  void syncLiveState()
                  if (logTimer === null) {
                    logTimer = setInterval(() => {
                      void syncLiveState()
                    }, 3000)
                  }
                  return
                }
                if (connection && connection.status === 'error') {
                  setPhase('error')
                  setError(connection.error || t('hostConnectFailed'))
                  return
                }
                if (!connectRequested.current) {
                  connectRequested.current = true
                  try {
                    await postJson('/connect', { id: hostId })
                  } catch (cause) {
                    if (!disposed) {
                      setPhase('error')
                      setError(String((cause && cause.message) || cause))
                    }
                    return
                  }
                }
                setPhase('connecting')
                timer = setTimeout(poll, 1200)
              } catch (cause) {
                if (!disposed) {
                  setPhase('error')
                  setError(String((cause && cause.message) || cause))
                }
              }
            }
            void poll()
            return () => {
              disposed = true
              if (timer !== null) clearTimeout(timer)
              if (logTimer !== null) clearInterval(logTimer)
              restoreLocalSidebar()
            }
          }, [hostId, generation])

          /** 返回本地桌面界面（会话），而不是配置页。 */
          const backToLocal = () => {
            try {
              if (layoutService && typeof layoutService.selectPanel === 'function') layoutService.selectPanel(null)
            } catch {
              // 忽略切换失败。
            }
          }

          /** 手动重启远端 dsh：Host 结束远端进程并等端口释放，然后重建连接与隧道。 */
          const restartRemote = () => {
            if (restartBusy) return
            setRestartBusy(true)
            setError('')
            postJson('/restart', { id: hostId })
              .then(() => {
                setTarget(null)
                setLogTail([])
                setPhase('connecting')
                connectRequested.current = false
                setGeneration((value) => value + 1)
              })
              .catch((cause) => {
                setPhase('error')
                setError(String((cause && cause.message) || cause))
              })
              .finally(() => setRestartBusy(false))
          }

          const disconnect = () => {
            postJson('/disconnect', { id: hostId })
              .catch(() => {})
              .finally(() => backToLocal())
          }

          /** 一键开启「保持远端运行」：更新主机配置后重启远端，切到常驻模式。 */
          const enableKeepRunning = () => {
            if (keepBusy || !currentHost) return
            setKeepBusy(true)
            postJson('/hosts', { host: { ...currentHost, keepRemoteRunning: true } })
              .then(() => {
                setKeepRunning(true)
                restartRemote()
              })
              .catch((cause) => {
                setPhase('error')
                setError(String((cause && cause.message) || cause))
              })
              .finally(() => setKeepBusy(false))
          }

          if (phase === 'ready' && target) {
            return h(
              'div',
              { className: 'rd-root rd-rootRemote' },
              h('style', { key: 'rd-style' }, CSS),
              h(RemoteView, {
                hostId,
                name: hostName,
                url: target.url,
                t,
                fmt,
                onBack: backToLocal,
                onDisconnect: disconnect,
                onRestart: restartRemote,
                restartBusy,
                keepRunning,
                keepBusy,
                onEnableKeepRunning: enableKeepRunning,
                linkStatus,
                onOpenExternal: () => {
                  void openExternalUrl(target.url)
                },
              }),
            )
          }

          return h(
            'div',
            { className: 'rd-root rd-rootRemote' },
            h('style', { key: 'rd-style' }, CSS),
            h(
              'div',
              { className: 'rd-statusPage' },
              phase === 'error'
                ? h(
                    'div',
                    { className: 'rd-remoteStatus rd-remoteStatusInline' },
                    h('div', { className: 'rd-remoteStatusText' }, fmt('remoteLoadFailed', { error: error || 'unknown' })),
                    h(
                      'div',
                      { className: 'rd-remoteStatusActions' },
                      h('button', { type: 'button', className: 'rd-btn rd-btnSmall', onClick: backToLocal }, t('back')),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'rd-btn rd-btnSmall',
                          disabled: restartBusy,
                          onClick: restartRemote,
                          title: t('restartHint'),
                        },
                        restartBusy ? t('restarting') : t('restartRemote'),
                      ),
                    ),
                  )
                : h(
                    'div',
                    { className: 'rd-remoteStatus rd-remoteStatusInline' },
                    h('span', { className: 'rd-spin', 'aria-hidden': true }),
                    h('span', { className: 'rd-remoteStatusText' }, fmt('hostConnecting', { name: hostName })),
                    logTail.length > 0
                      ? h('pre', { className: 'rd-log rd-connectLog' }, logTail.join('\n'))
                      : null,
                  ),
            ),
          )
        }

        /* 动态注册：每台已保存主机一个左侧栏图标（label = 主机名）+ 一个 main 面板。 */
        const hostEntries = new Map()
        const hostEntryId = (host) => `rd-host:${host.id}`

        function registerHostEntry(host, order) {
          const id = hostEntryId(host)
          const name = host.name || host.host || 'Remote host'
          const icon = (iconProps) => h(RdIcon, { size: (iconProps && iconProps.size) || 20 })
          const disposeNav = ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id, order, label: () => name }, icon),
          )
          const disposeMain = ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: id }, () =>
              h(RemoteHostPage, { hostId: host.id, fallbackName: name }),
            ),
          )
          return {
            name,
            dispose: () => {
              try {
                disposeNav?.()
              } catch {
                // 忽略注销失败。
              }
              try {
                disposeMain?.()
              } catch {
                // 忽略注销失败。
              }
            },
          }
        }

        let syncingHostEntries = false

        /** 让左侧栏图标与已保存主机保持同步（新增/改名/删除）。 */
        async function syncHostEntries() {
          if (syncingHostEntries) return
          syncingHostEntries = true
          try {
            const payload = await getState()
            const hosts = Array.isArray(payload.hosts) ? payload.hosts : []
            const seen = new Set()
            hosts.forEach((host, index) => {
              if (!host || typeof host.id !== 'string') return
              const id = hostEntryId(host)
              seen.add(id)
              const name = host.name || host.host || 'Remote host'
              const existing = hostEntries.get(id)
              if (existing && existing.name === name) return
              if (existing) {
                existing.dispose()
                hostEntries.delete(id)
              }
              try {
                hostEntries.set(id, registerHostEntry(host, 40 + index * 10))
              } catch {
                // 单台注册失败不影响其它主机。
              }
            })
            for (const [id, entry] of [...hostEntries]) {
              if (seen.has(id)) continue
              entry.dispose()
              hostEntries.delete(id)
            }
          } catch {
            // 状态读取失败保持现状，等下一次同步。
          } finally {
            syncingHostEntries = false
          }
        }

        ctx.effect(
          () => {
            const timer = setInterval(() => {
              void syncHostEntries()
            }, 5000)
            void syncHostEntries()
            return () => {
              clearInterval(timer)
              for (const entry of hostEntries.values()) entry.dispose()
              hostEntries.clear()
            }
          },
          'remote-desktop: sidebar host entries',
        )

        /* ---------------------- 设置：远程主机（列表 + 二级编辑/发现） ---------------------- */

        const SETTINGS_VIEW_LIST = { kind: 'list' }

        function RemoteSettingsPage() {
          useLocaleRevision()

          const [data, setData] = useState(null)
          const [loading, setLoading] = useState(true)
          const [loadError, setLoadError] = useState('')
          const [error, setError] = useState('')
          const [view, setView] = useState(SETTINGS_VIEW_LIST)
          const [draft, setDraft] = useState(null)
          const [draftError, setDraftError] = useState('')
          const [busy, setBusy] = useState('')
          const [testResult, setTestResult] = useState(null)
          const [confirmDelete, setConfirmDelete] = useState(false)
          const [discover, setDiscover] = useState(null)
          const [discoverError, setDiscoverError] = useState('')
          const [discoverBusy, setDiscoverBusy] = useState('')

          const load = useCallback(async (quiet) => {
            if (!quiet) setLoading(true)
            try {
              const payload = await getState()
              setData(payload)
              setLoadError('')
            } catch (cause) {
              setLoadError(String((cause && cause.message) || cause))
            } finally {
              if (!quiet) setLoading(false)
            }
          }, [])

          useEffect(() => {
            void load()
          }, [load])

          const hosts = data && Array.isArray(data.hosts) ? data.hosts : []
          const actionBusy = busy !== ''

          const openAdd = () => {
            setDraft(emptyDraft())
            setDraftError('')
            setTestResult(null)
            setConfirmDelete(false)
            setView({ kind: 'form', adding: true })
          }

          const openEdit = (host) => {
            setDraft(draftFromHost(host))
            setDraftError('')
            setTestResult(null)
            setConfirmDelete(false)
            setView({ kind: 'form', adding: false })
          }

          const openDiscover = async () => {
            setView({ kind: 'discover' })
            setDiscoverBusy('load')
            setDiscoverError('')
            try {
              const response = await fetch(`${API_PREFIX}/discover`, { credentials: 'same-origin' })
              const payload = await response.json().catch(() => null)
              if (!response.ok || !payload || payload.ok === false) {
                throw new Error((payload && payload.error) || `HTTP ${response.status}`)
              }
              setDiscover(payload)
            } catch (cause) {
              setDiscoverError(String((cause && cause.message) || cause))
            } finally {
              setDiscoverBusy('')
            }
          }

          const backToList = () => {
            setView(SETTINGS_VIEW_LIST)
            setDraft(null)
            setDraftError('')
            setTestResult(null)
            setConfirmDelete(false)
            void load(true)
            void syncHostEntries()
          }

          const updateDraft = (patch) => {
            setDraftError('')
            setDraft((previous) => (previous ? { ...previous, ...patch } : previous))
          }

          const saveDraft = async () => {
            if (!draft || busy) return
            const built = buildHostInput(draft)
            if (!built.ok) {
              setDraftError(t(built.error))
              return
            }
            setBusy('save')
            setDraftError('')
            try {
              await postJson('/hosts', { host: built.host })
              await load(true)
              void syncHostEntries()
              backToList()
            } catch (cause) {
              setDraftError(String((cause && cause.message) || cause))
            } finally {
              setBusy('')
            }
          }

          const deleteCurrent = async () => {
            if (!draft || !draft.id || busy) return
            setBusy('delete')
            try {
              await postJson('/hosts/delete', { id: draft.id })
              await load(true)
              void syncHostEntries()
              backToList()
            } catch (cause) {
              setDraftError(String((cause && cause.message) || cause))
            } finally {
              setBusy('')
            }
          }

          const testCurrent = async () => {
            if (!draft || !draft.id || busy) return
            setBusy('test')
            setTestResult(null)
            try {
              const payload = await postJson('/test', { id: draft.id })
              setTestResult({ ok: true, text: typeof payload.output === 'string' ? payload.output : '' })
            } catch (cause) {
              setTestResult({ ok: false, text: String((cause && cause.message) || cause) })
            } finally {
              setBusy('')
            }
          }

          const importCandidate = async (candidate) => {
            if (!candidate || discoverBusy) return
            setDiscoverBusy(`import:${candidate.key}`)
            try {
              await postJson('/hosts', { host: candidateToHost(candidate) })
              await load(true)
              void syncHostEntries()
              await openDiscover()
            } catch (cause) {
              setDiscoverError(String((cause && cause.message) || cause))
            } finally {
              setDiscoverBusy('')
            }
          }

          const importAll = async () => {
            if (!discover || discoverBusy) return
            const pending = (discover.candidates || []).filter((item) => item && item.imported !== true)
            if (pending.length === 0) return
            setDiscoverBusy('all')
            setDiscoverError('')
            try {
              for (const candidate of pending) {
                await postJson('/hosts', { host: candidateToHost(candidate) })
              }
              await load(true)
              void syncHostEntries()
              await openDiscover()
            } catch (cause) {
              setDiscoverError(String((cause && cause.message) || cause))
            } finally {
              setDiscoverBusy('')
            }
          }

          const bannerText = loadError ? `${t('loadErrorTitle')}：${loadError}` : error
          const banner = bannerText
            ? h(
                'div',
                { className: 'rd-banner', role: 'alert' },
                h('span', { className: 'rd-bannerText' }, bannerText),
                h(
                  'div',
                  { className: 'rd-bannerActions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'rd-btn rd-btnSmall rd-btnGhost',
                      onClick: () => {
                        setError('')
                        setLoadError('')
                      },
                    },
                    t('dismiss'),
                  ),
                ),
              )
            : null

          if (view.kind === 'form') {
            const field = (labelText, control, full) =>
              h(
                'label',
                { className: full ? 'rd-field rd-fieldFull' : 'rd-field' },
                h('span', { className: 'rd-label' }, labelText),
                control,
              )
            const textInput = (key, placeholder) =>
              h('input', {
                className: 'rd-input',
                type: 'text',
                value: draft ? String(draft[key] == null ? '' : draft[key]) : '',
                placeholder: placeholder || undefined,
                disabled: actionBusy,
                onChange: (event) => updateDraft({ [key]: event.target.value }),
              })
            const portInput = (key) =>
              h('input', {
                className: 'rd-input',
                type: 'number',
                min: 1,
                max: 65535,
                inputMode: 'numeric',
                value: draft ? String(draft[key] == null ? '' : draft[key]) : '',
                disabled: actionBusy,
                onChange: (event) => updateDraft({ [key]: event.target.value }),
              })
            const modeSwitch = h(
              'div',
              { className: 'rd-field rd-fieldFull' },
              h('span', { className: 'rd-label' }, t('fieldMode')),
              h(
                'div',
                { className: 'rd-seg' },
                MODES.map((mode) =>
                  h(
                    'button',
                    {
                      key: mode,
                      type: 'button',
                      className: draft && draft.mode === mode ? 'rd-segBtn is-active' : 'rd-segBtn',
                      'aria-pressed': draft && draft.mode === mode,
                      disabled: actionBusy,
                      onClick: () => updateDraft({ mode }),
                    },
                    t(MODE_LABEL_KEYS[mode]),
                  ),
                ),
              ),
            )
            const sshFields =
              draft && draft.mode !== 'url'
                ? h(
                    'div',
                    { className: 'rd-formGrid' },
                    field(t('fieldSshHost'), textInput('host', t('sshHostPlaceholder'))),
                    field(t('fieldSshPort'), portInput('port')),
                    field(t('fieldUser'), textInput('user', t('userPlaceholder'))),
                    field(t('fieldIdentityFile'), textInput('identityFile', t('identityFilePlaceholder'))),
                  )
                : null
            const tailFields =
              draft && draft.mode === 'url'
                ? h(
                    'div',
                    { className: 'rd-formGrid' },
                    field(t('fieldUrl'), textInput('url', t('urlPlaceholder')), true),
                  )
                : draft && draft.mode === 'launch'
                  ? h(
                      'div',
                      { className: 'rd-formGrid' },
                      field(t('fieldRemotePort'), portInput('remotePort')),
                      field(t('fieldLaunchCommand'), textInput('launchCommand'), true),
                      h('p', { className: 'rd-hint rd-fieldFull' }, t('launchHint')),
                      field(t('fieldInstallCommand'), textInput('installCommand'), true),
                      h('p', { className: 'rd-hint rd-fieldFull' }, t('installHint')),
                      h(
                        'label',
                        { className: 'rd-check rd-fieldFull' },
                        h('input', {
                          type: 'checkbox',
                          checked: draft.keepRemoteRunning === true,
                          disabled: actionBusy,
                          onChange: (event) => updateDraft({ keepRemoteRunning: event.target.checked }),
                        }),
                        h('span', null, t('fieldKeepRunning')),
                      ),
                      h('p', { className: 'rd-hint rd-fieldFull' }, t('keepRunningHint')),
                    )
                  : h(
                      'div',
                      { className: 'rd-formGrid' },
                      field(t('fieldRemotePort'), portInput('remotePort')),
                      field(t('fieldToken'), textInput('token', t('tokenPlaceholder'))),
                      h('p', { className: 'rd-hint rd-fieldFull' }, t('tokenHint')),
                    )

            return h(
              'div',
              { className: 'rd-settingsPage' },
              h('style', { key: 'rd-style' }, CSS),
              h(
                'div',
                { className: 'rd-settingsBar' },
                h('button', { type: 'button', className: 'rd-btn rd-btnSmall', onClick: backToList }, t('back')),
                h('span', { className: 'rd-settingsTitle' }, view.adding ? t('addTitle') : t('editTitle')),
              ),
              banner,
              h(
                'div',
                { className: 'rd-form' },
                field(t('fieldName'), textInput('name', t('namePlaceholder')), true),
                modeSwitch,
                sshFields,
                tailFields,
                draftError ? h('p', { className: 'rd-formError', role: 'alert' }, draftError) : null,
                testResult
                  ? h(
                      'div',
                      { className: `rd-test ${testResult.ok ? 'rd-testOk' : 'rd-testError'}` },
                      h('div', { className: 'rd-testHead' }, testResult.ok ? t('testOk') : t('testFailed')),
                      testResult.text ? h('pre', { className: 'rd-log' }, testResult.text) : null,
                    )
                  : null,
                h(
                  'div',
                  { className: 'rd-formFoot' },
                  h(
                    'button',
                    { type: 'button', className: 'rd-btn rd-btnPrimary', disabled: actionBusy, onClick: saveDraft },
                    busy === 'save' ? t('saving') : t('save'),
                  ),
                  !view.adding && draft && draft.id
                    ? h(
                        'button',
                        { type: 'button', className: 'rd-btn', disabled: actionBusy, onClick: testCurrent },
                        busy === 'test' ? t('testing') : t('test'),
                      )
                    : null,
                  h('button', { type: 'button', className: 'rd-btn rd-btnGhost', disabled: actionBusy, onClick: backToList }, t('cancel')),
                  !view.adding && draft && draft.id
                    ? confirmDelete
                      ? h(
                          'span',
                          { className: 'rd-confirm' },
                          h('span', { className: 'rd-confirmText' }, fmt('confirmDeleteHint', { name: draft.name || hostEndpoint(draft) })),
                          h(
                            'button',
                            { type: 'button', className: 'rd-btn rd-btnSmall rd-btnDanger', disabled: actionBusy, onClick: deleteCurrent },
                            busy === 'delete' ? t('deleting') : t('confirmDelete'),
                          ),
                          h('button', { type: 'button', className: 'rd-btn rd-btnSmall rd-btnGhost', onClick: () => setConfirmDelete(false) }, t('cancel')),
                        )
                      : h(
                          'button',
                          { type: 'button', className: 'rd-btn rd-btnDanger', disabled: actionBusy, onClick: () => setConfirmDelete(true) },
                          t('delete'),
                        )
                    : null,
                ),
              ),
            )
          }

          if (view.kind === 'discover') {
            const candidates = discover && Array.isArray(discover.candidates) ? discover.candidates : []
            const rows = candidates.map((candidate) =>
              h(
                'div',
                { className: 'rd-discoverRow', key: candidate.key },
                h(
                  'div',
                  { className: 'rd-discoverRowBody' },
                  h(
                    'div',
                    { className: 'rd-discoverRowTitle' },
                    h('span', { className: 'rd-discoverName', title: candidate.name }, candidate.name || candidate.host),
                    h(
                      'span',
                      { className: 'rd-tag' },
                      candidate.source === 'ssh-config' ? t('discoverSourceConfig') : t('discoverSourceKnownHosts'),
                    ),
                  ),
                  h('div', { className: 'rd-discoverKey' }, candidateEndpoint(candidate)),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'rd-btn rd-btnSmall',
                    disabled: candidate.imported === true || discoverBusy !== '',
                    onClick: () => void importCandidate(candidate),
                  },
                  candidate.imported === true
                    ? t('discoverImported')
                    : discoverBusy === `import:${candidate.key}`
                      ? t('discoverImporting')
                      : t('discoverImport'),
                ),
              ),
            )
            return h(
              'div',
              { className: 'rd-settingsPage' },
              h('style', { key: 'rd-style' }, CSS),
              h(
                'div',
                { className: 'rd-settingsBar' },
                h('button', { type: 'button', className: 'rd-btn rd-btnSmall', onClick: backToList }, t('back')),
                h('span', { className: 'rd-settingsTitle' }, t('settingsDiscover')),
                h('span', { className: 'rd-spacer' }),
                h(
                  'button',
                  { type: 'button', className: 'rd-btn rd-btnSmall', disabled: discoverBusy !== '', onClick: () => void importAll() },
                  discoverBusy === 'all' ? t('discoverImportingAll') : t('discoverImportAll'),
                ),
              ),
              discoverError
                ? h('div', { className: 'rd-banner', role: 'alert' }, h('span', { className: 'rd-bannerText' }, discoverError))
                : null,
              h('div', { className: 'rd-card' }, h('div', { className: 'rd-discoverList' }, rows.length > 0 ? rows : h('p', { className: 'rd-hint' }, t('discoverNoCandidates')))),
              h('p', { className: 'rd-hint' }, t('discoverViewHint')),
            )
          }

          const rows = hosts.map((host) =>
            h(
              'button',
              { type: 'button', className: 'rd-settingsRow', key: host.id, onClick: () => openEdit(host) },
              h(
                'span',
                { className: 'rd-settingsRowBody' },
                h('span', { className: 'rd-settingsRowName' }, host.name || host.host || 'Remote host'),
                h('span', { className: 'rd-settingsRowMeta' }, hostEndpoint(host)),
              ),
              h('span', { className: 'rd-settingsChevron', 'aria-hidden': true }, '›'),
            ),
          )

          return h(
            'div',
            { className: 'rd-settingsPage' },
            h('style', { key: 'rd-style' }, CSS),
            h('h1', { className: 'rd-settingsHeading' }, t('settingsSection')),
            h('p', { className: 'rd-sub' }, t('settingsSubtitle')),
            banner,
            loading && !data ? h('p', { className: 'rd-hint' }, t('loading')) : null,
            h(
              'div',
              { className: 'rd-card' },
              hosts.length === 0 ? h('p', { className: 'rd-hint' }, t('settingsEmpty')) : h('div', { className: 'rd-settingsList' }, rows),
              h(
                'div',
                { className: 'rd-settingsActions' },
                h('button', { type: 'button', className: 'rd-btn rd-btnPrimary', onClick: openAdd }, t('settingsAddHost')),
                h('button', { type: 'button', className: 'rd-btn', onClick: () => void openDiscover() }, t('settingsDiscover')),
              ),
            ),
          )
        }

        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'remote-desktop-settings',
                  order: 60,
                  label: () => t('settingsSection'),
                },
                RemoteSettingsPage,
              ),
            ),
          'remote-desktop: settings section',
        )
      },
    }
  },
})
