import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeTheme,
  powerMonitor,
  session,
  systemPreferences
} from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import {
  HOLD_TO_TALK_SHORTCUT,
  type ConnectionDraft,
  type Direction,
  type EngineCommand,
  type EngineReport,
  type Result,
  type SettingsPatch,
  type TranslatorEvent
} from '../shared/types'
import { EventBatcher } from './event-batcher'
import { SettingsStore } from './settings'
import { StateStore } from './state'
import { buildSessionConfig, checkConnection, TranslatorChannel } from './translator'
import { createVoice, deleteVoice } from './voice'
import { WindowManager } from './windows'

// 未打包运行时可以指定独立的数据目录和服务地址，开发调试、自动化测试不碰日常设置和真实服务
const userDataOverride = app.isPackaged ? undefined : process.env['LIVE_INTERPRETER_USER_DATA']
const endpointOverride = app.isPackaged ? undefined : process.env['LIVE_INTERPRETER_ENDPOINT']
if (userDataOverride) app.setPath('userData', userDataOverride)

/** 退出前等通道把最后一段译完再断开，最多等这么久 */
const QUIT_TIMEOUT_MS = 2000

const DIRECTIONS: Direction[] = ['listen', 'speak']

function broadcast(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, ...args)
  }
}

function isDirection(value: unknown): value is Direction {
  return value === 'listen' || value === 'speak'
}

const COMMAND_TYPES = new Set([
  'start',
  'stop',
  'hold-begin',
  'hold-end',
  'hold-toggle',
  'stop-all'
])

function isCommand(value: unknown): value is EngineCommand {
  const command = value as { type?: string; direction?: unknown } | null
  if (!command || !COMMAND_TYPES.has(command.type ?? '')) return false
  return command.type === 'start' || command.type === 'stop' ? isDirection(command.direction) : true
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 渲染进程用 getDisplayMedia 请求系统声音。
 * Windows 走 WASAPI loopback；macOS 14.2+ 走 CoreAudio Tap，需要「系统录音」权限。
 * 视频轨只是 getDisplayMedia 的必需品，优先给引擎窗口自己的画面，避免触发屏幕录制授权。
 */
function handleSystemAudioRequests(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (request.frame) {
      callback({ video: request.frame, audio: 'loopback' })
      return
    }
    const [screen] = await desktopCapturer.getSources({ types: ['screen'] })
    callback(screen ? { video: screen, audio: 'loopback' } : {})
  })
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.liveinterpreter.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const settings = new SettingsStore()
  nativeTheme.themeSource = settings.get().theme

  const state = new StateStore((snapshot) => broadcast('state:changed', snapshot))
  const batcher = new EventBatcher((events) => broadcast('translator:events', events))
  const emit = (event: TranslatorEvent): void => {
    state.applyEvent(event)
    batcher.push(event)
  }
  const channels: Record<Direction, TranslatorChannel> = {
    listen: new TranslatorChannel('listen', () => settings.get(), emit, endpointOverride),
    speak: new TranslatorChannel('speak', () => settings.get(), emit, endpointOverride)
  }
  let quitting = false
  const windows = new WindowManager(settings, () => {
    // 看板就是主界面，关掉它等于退出
    if (!quitting) app.quit()
  })

  /**
   * 引擎在隐藏窗口里，没有用户点击。getDisplayMedia 要求用户手势，
   * 用 executeJavaScript 的 userGesture 参数把这次调用标记成用户触发。
   */
  const sendToEngine = (command: EngineCommand): void => {
    const engine = windows.engine
    if (!engine || engine.isDestroyed()) return
    void engine.webContents
      .executeJavaScript(`window.__engine?.handle(${JSON.stringify(command)})`, true)
      .catch((error) => console.error('引擎执行指令失败', command, error))
  }

  const stopAll = async (): Promise<void> => {
    sendToEngine({ type: 'stop-all' })
    await Promise.all(DIRECTIONS.map((direction) => channels[direction].stop()))
  }

  const createEngine = (): void => {
    const engine = windows.createEngine()
    engine.webContents.on('render-process-gone', (_, details) => {
      if (quitting) return
      console.error('音频引擎退出', details)
      void stopAll()
      for (const direction of DIRECTIONS) {
        state.applyReport({
          type: 'error',
          direction,
          error: '音频引擎异常退出，已停止。重新开始即可。'
        })
      }
      engine.destroy()
      createEngine()
    })
  }

  /**
   * 保存设置并广播。正在跑的通道如果会话配置变了（语言、术语表、音色、断句方式等），
   * 断开当前连接用新配置重连；采集不停，重连期间的几百毫秒音频会丢掉。
   */
  const saveAndBroadcast = (patch: SettingsPatch): ReturnType<SettingsStore['getPublic']> => {
    const configOf = (direction: Direction): string =>
      JSON.stringify(buildSessionConfig(direction, settings.get()))
    const before = { listen: configOf('listen'), speak: configOf('speak') }
    const result = settings.update(patch)
    if (patch.theme) nativeTheme.themeSource = result.theme
    broadcast('settings:changed', result)
    for (const direction of DIRECTIONS) {
      if (state.isRunning(direction) && configOf(direction) !== before[direction]) {
        void channels[direction].restart()
      }
    }
    return result
  }

  // ---------- 设置和账号 ----------

  ipcMain.handle('settings:get', () => settings.getPublic())
  ipcMain.handle('settings:save', (_, patch: SettingsPatch) => saveAndBroadcast(patch))

  ipcMain.handle('settings:check', (_, draft: ConnectionDraft) => {
    const current = settings.get()
    const candidate = {
      ...current,
      region: draft.region,
      workspaceId: draft.workspaceId,
      apiKey: draft.apiKey?.trim() || current.apiKey
    }
    if (!candidate.apiKey) return { ok: false, message: '先填 API Key' }
    return checkConnection(candidate, endpointOverride)
  })

  ipcMain.handle('account:clear', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['清除', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: '清除账号？',
      detail: '会停止所有通道，删掉这台电脑上保存的 API Key，并删除复刻的音色。'
    }
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
    if (response !== 0) return false
    await stopAll()
    const current = settings.get()
    if (current.speak.clonedVoice && current.apiKey) {
      // 尽量把服务端的音色也删掉，释放额度；失败不影响本地清除
      await deleteVoice(current, current.speak.clonedVoice.id, endpointOverride).catch((error) =>
        console.error('删除复刻音色失败', error)
      )
    }
    broadcast('settings:changed', settings.resetAccount())
    return true
  })

  ipcMain.handle('voice:create', async (_, wav: ArrayBuffer): Promise<Result> => {
    const current = settings.get()
    if (!current.apiKey) return { ok: false, message: '先填 API Key' }
    try {
      const voice = await createVoice(current, Buffer.from(wav), endpointOverride)
      const previous = current.speak.clonedVoice
      if (previous) {
        await deleteVoice(current, previous.id, endpointOverride).catch((error) =>
          console.error('删除旧的复刻音色失败', error)
        )
      }
      saveAndBroadcast({ speak: { clonedVoice: voice, voiceMode: 'fixed' } })
      return { ok: true, message: '音色复刻好了，下次开始说话时生效' }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })

  ipcMain.handle('voice:delete', async (): Promise<Result> => {
    const current = settings.get()
    const voice = current.speak.clonedVoice
    if (!voice) return { ok: true, message: '' }
    const remote = await deleteVoice(current, voice.id, endpointOverride).then(
      () => '',
      (error) => `服务端没删掉（${errorMessage(error)}），本地已移除`
    )
    saveAndBroadcast({
      speak: {
        clonedVoice: null,
        voiceMode: current.speak.voiceMode === 'fixed' ? 'live' : current.speak.voiceMode
      }
    })
    return { ok: remote === '', message: remote || '已删除复刻音色' }
  })

  // ---------- 运行状态和记录 ----------

  ipcMain.handle('state:get', () => state.get())
  ipcMain.handle('records:get', () => state.getRecords())
  ipcMain.on('records:clear', () => {
    state.clearRecords()
    broadcast('records:cleared')
  })

  ipcMain.on('engine:report', (event, report: EngineReport) => {
    if (windows.roleOf(event.sender) === 'engine') state.applyReport(report)
  })

  // ---------- 引擎用：通道和音频 ----------

  ipcMain.handle('channel:start', (_, direction: unknown) => {
    if (isDirection(direction)) return channels[direction].start()
    return 0
  })

  ipcMain.handle('channel:stop', (_, direction: unknown) => {
    if (isDirection(direction)) return channels[direction].stop()
    return undefined
  })

  ipcMain.on('audio:append', (_, direction: unknown, pcm: ArrayBuffer) => {
    if (isDirection(direction)) channels[direction].appendAudio(pcm)
  })

  ipcMain.on('audio:commit', (_, direction: unknown) => {
    if (isDirection(direction)) channels[direction].commitAudio()
  })

  ipcMain.on('audio:clear', (_, direction: unknown) => {
    if (isDirection(direction)) channels[direction].clearAudio()
  })

  ipcMain.handle('media:microphone', () => {
    // 用 Chromium 假音频设备跑自动化测试时不经过真实麦克风，也就不需要系统授权
    if (app.commandLine.hasSwitch('use-fake-device-for-media-stream')) return true
    return process.platform === 'darwin' ? systemPreferences.askForMediaAccess('microphone') : true
  })

  // ---------- 界面窗口用 ----------

  ipcMain.on('command', (_, command: unknown) => {
    if (isCommand(command)) sendToEngine(command)
  })

  ipcMain.on('window:open', (_, role: unknown) => {
    if (role === 'settings') windows.openSettings()
    if (role === 'records') windows.openRecords()
  })

  ipcMain.on('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())

  ipcMain.on('window:move', (event, x: unknown, y: unknown) => {
    if (typeof x === 'number' && typeof y === 'number') windows.move(event.sender, x, y)
  })

  ipcMain.on('window:resize', (event, width: unknown, height: unknown) => {
    if (typeof width === 'number' && typeof height === 'number') {
      windows.resize(event.sender, width, height)
    }
  })

  ipcMain.on('window:fit-height', (event, height: unknown) => {
    if (typeof height === 'number') windows.fitHeight(event.sender, height)
  })

  ipcMain.on('window:always-on-top', (event, flag: unknown) => {
    if (windows.roleOf(event.sender) === 'records' && typeof flag === 'boolean') {
      windows.setRecordsOnTop(flag)
      broadcast('settings:changed', settings.getPublic())
    }
  })

  ipcMain.on('app:quit', () => app.quit())

  // ---------- 启动 ----------

  handleSystemAudioRequests()
  createEngine()
  windows.showOverlay()
  if (!settings.get().apiKey) windows.openSettings()

  globalShortcut.register(HOLD_TO_TALK_SHORTCUT, () => sendToEngine({ type: 'hold-toggle' }))

  // 合盖或睡眠后连接迟早会断，干脆先停掉，醒来由用户重新开始
  powerMonitor.on('suspend', () => void stopAll())

  app.on('activate', () => windows.showOverlay())

  /**
   * 正常退出（包括 ⌘Q）先让两条通道发 session.finish、关掉连接再退，最多等 QUIT_TIMEOUT_MS。
   * 异常退出时进程没了，系统会关掉它的网络连接，服务端也就断开了。
   */
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    settings.flush()
    const timeout = new Promise((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS))
    void Promise.race([stopAll(), timeout]).finally(() => {
      settings.flush()
      app.quit()
    })
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  app.quit()
})
