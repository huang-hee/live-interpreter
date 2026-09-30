import { BrowserWindow, nativeTheme, screen, shell, type Rectangle } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import type { WindowRole } from '../shared/types'
import type { SettingsStore } from './settings'

const PRELOAD = join(__dirname, '../preload/index.js')

type PanelRole = 'overlay' | 'records'

const MIN_SIZE: Record<PanelRole, { width: number; height: number }> = {
  overlay: { width: 420, height: 60 },
  records: { width: 520, height: 320 }
}

function load(window: BrowserWindow): void {
  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function webPreferences(role: WindowRole): Electron.WebPreferences {
  return {
    preload: PRELOAD,
    sandbox: false,
    // preload 按这个参数决定页面渲染哪个窗口
    additionalArguments: [`--role=${role}`]
  }
}

function openLinksExternally(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
}

function defaultBounds(role: PanelRole): Rectangle {
  const { workArea } = screen.getPrimaryDisplay()
  if (role === 'overlay') {
    const width = Math.min(1000, workArea.width - 80)
    const height = 220
    return {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: workArea.y + workArea.height - height - 60,
      width,
      height
    }
  }
  const width = Math.min(760, workArea.width - 80)
  const height = Math.min(480, workArea.height - 320)
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + 80,
    width,
    height
  }
}

/** 保存的位置可能在已经拔掉的副屏上，那就退回默认位置 */
function visibleBounds(saved: Rectangle | null, fallback: Rectangle): Rectangle {
  if (!saved) return fallback
  const centerX = saved.x + saved.width / 2
  const centerY = saved.y + saved.height / 2
  const onScreen = screen
    .getAllDisplays()
    .some(
      ({ workArea }) =>
        centerX >= workArea.x &&
        centerX <= workArea.x + workArea.width &&
        centerY >= workArea.y &&
        centerY <= workArea.y + workArea.height
    )
  return onScreen ? saved : fallback
}

/**
 * 四个窗口：
 * engine  隐藏窗口，负责采集和播放，应用活多久它就活多久；
 * overlay 字幕看板，打开应用看到的就是它；
 * settings 设置；records 翻译记录，和看板一样是无边框透明面板。
 * 透明窗口不能用系统边框缩放（Electron 文档写明 resizable 会让透明失效），
 * 拖动和缩放都由页面算好位置、尺寸后走 move() / resize()。
 */
export class WindowManager {
  engine: BrowserWindow | null = null
  overlay: BrowserWindow | null = null
  settings: BrowserWindow | null = null
  records: BrowserWindow | null = null

  constructor(
    private readonly store: SettingsStore,
    private readonly onOverlayClosed: () => void
  ) {}

  createEngine(): BrowserWindow {
    const window = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        ...webPreferences('engine'),
        // 引擎一直在后台，不能因为窗口不可见就降频
        backgroundThrottling: false
      }
    })
    window.on('closed', () => {
      if (this.engine === window) this.engine = null
    })
    load(window)
    this.engine = window
    return window
  }

  showOverlay(): void {
    if (this.overlay) {
      this.overlay.showInactive()
      return
    }
    const window = this.createPanel('overlay', this.store.get().overlay.bounds)
    // screen-saver 层级才能盖住全屏播放的视频
    window.setAlwaysOnTop(true, 'screen-saver')
    if (process.platform === 'darwin') {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
    window.on('closed', () => {
      this.overlay = null
      this.onOverlayClosed()
    })
    this.overlay = window
  }

  openSettings(): void {
    if (this.settings) {
      this.settings.show()
      this.settings.focus()
      return
    }
    const window = new BrowserWindow({
      width: 820,
      height: 640,
      minWidth: 680,
      minHeight: 520,
      show: false,
      title: '同传设置',
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1d1f21' : '#f8f9f7',
      ...(process.platform === 'linux' ? { icon } : {}),
      webPreferences: webPreferences('settings')
    })
    window.once('ready-to-show', () => window.show())
    window.on('closed', () => {
      this.settings = null
    })
    openLinksExternally(window)
    load(window)
    this.settings = window
  }

  openRecords(): void {
    if (this.records) {
      this.records.show()
      this.records.focus()
      return
    }
    const { bounds, alwaysOnTop } = this.store.get().records
    const window = this.createPanel('records', bounds)
    window.setAlwaysOnTop(alwaysOnTop, 'floating')
    window.on('closed', () => {
      this.records = null
    })
    this.records = window
  }

  setRecordsOnTop(flag: boolean): void {
    this.records?.setAlwaysOnTop(flag, 'floating')
    this.store.update({ records: { alwaysOnTop: flag } })
  }

  /** 只处理看板和记录这两个无边框面板 */
  move(sender: Electron.WebContents, x: number, y: number): void {
    const role = this.panelRoleOf(sender)
    const window = role && this[role]
    if (!role || !window) return
    window.setPosition(Math.round(x), Math.round(y))
    this.saveBounds(role)
  }

  resize(sender: Electron.WebContents, width: number, height: number): void {
    const role = this.panelRoleOf(sender)
    const window = role && this[role]
    if (!role || !window) return
    const bounds = window.getBounds()
    const { workArea } = screen.getDisplayMatching(bounds)
    const min = MIN_SIZE[role]
    window.setBounds({
      ...bounds,
      width: Math.round(Math.min(Math.max(width, min.width), workArea.width)),
      height: Math.round(Math.min(Math.max(height, min.height), workArea.height))
    })
    this.saveBounds(role)
  }

  /** 看板的高度跟着内容走（行数、字号、字幕条），底边不动，字幕始终贴在原来的位置 */
  fitHeight(sender: Electron.WebContents, height: number): void {
    const window = this.overlay
    if (!window || this.roleOf(sender) !== 'overlay') return
    const bounds = window.getBounds()
    const { workArea } = screen.getDisplayMatching(bounds)
    const next = Math.round(Math.min(Math.max(height, MIN_SIZE.overlay.height), workArea.height))
    if (next === bounds.height) return
    // 底边不动往上长；贴着屏幕顶时不再往上顶出去
    const y = Math.max(workArea.y, bounds.y + bounds.height - next)
    window.setBounds({ ...bounds, y, height: next })
    this.saveBounds('overlay')
  }

  roleOf(sender: Electron.WebContents): WindowRole | null {
    const roles: WindowRole[] = ['engine', 'overlay', 'settings', 'records']
    return roles.find((role) => this[role]?.webContents === sender) ?? null
  }

  private panelRoleOf(sender: Electron.WebContents): PanelRole | null {
    const role = this.roleOf(sender)
    return role === 'overlay' || role === 'records' ? role : null
  }

  private createPanel(role: PanelRole, saved: Rectangle | null): BrowserWindow {
    const window = new BrowserWindow({
      ...visibleBounds(saved, defaultBounds(role)),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      hasShadow: false,
      fullscreenable: false,
      maximizable: false,
      minimizable: role === 'records',
      title: role === 'overlay' ? '同传' : '翻译记录',
      backgroundColor: '#00000000',
      ...(process.platform === 'linux' ? { icon } : {}),
      webPreferences: webPreferences(role)
    })
    window.once('ready-to-show', () => (role === 'overlay' ? window.showInactive() : window.show()))
    window.on('close', () => this.saveBounds(role))
    openLinksExternally(window)
    load(window)
    return window
  }

  private saveBounds(role: PanelRole): void {
    const window = this[role]
    if (!window || window.isDestroyed()) return
    const bounds = window.getBounds()
    this.store.update(role === 'overlay' ? { overlay: { bounds } } : { records: { bounds } })
  }
}
