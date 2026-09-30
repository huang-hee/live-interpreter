import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { InterpreterApi, WindowRole } from '../shared/types'

/** 订阅主进程推送，返回取消订阅函数 */
function subscribe<T extends unknown[]>(
  channel: string,
  listener: (...args: T) => void
): () => void {
  const handler = (_: IpcRendererEvent, ...args: unknown[]): void => listener(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const ROLES: WindowRole[] = ['engine', 'overlay', 'settings', 'records']

// 主进程创建窗口时带上 --role=xxx
const roleArg = process.argv.find((arg) => arg.startsWith('--role='))?.slice('--role='.length)
const role = ROLES.find((item) => item === roleArg) ?? 'overlay'

const api: InterpreterApi = {
  platform: process.platform,
  role,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  onSettingsChanged: (listener) => subscribe('settings:changed', listener),
  checkConnection: (draft) => ipcRenderer.invoke('settings:check', draft),
  clearAccount: () => ipcRenderer.invoke('account:clear'),
  createVoice: (wav) => ipcRenderer.invoke('voice:create', wav),
  deleteVoice: () => ipcRenderer.invoke('voice:delete'),

  getState: () => ipcRenderer.invoke('state:get'),
  onStateChanged: (listener) => subscribe('state:changed', listener),
  getRecords: () => ipcRenderer.invoke('records:get'),
  clearRecords: () => ipcRenderer.send('records:clear'),
  onRecordsCleared: (listener) => subscribe('records:cleared', listener),
  onTranslatorEvents: (listener) => subscribe('translator:events', listener),

  sendCommand: (command) => ipcRenderer.send('command', command),
  openWindow: (target) => ipcRenderer.send('window:open', target),
  closeWindow: () => ipcRenderer.send('window:close'),
  quit: () => ipcRenderer.send('app:quit'),
  moveWindow: (x, y) => ipcRenderer.send('window:move', x, y),
  resizeWindow: (width, height) => ipcRenderer.send('window:resize', width, height),
  fitWindowHeight: (height) => ipcRenderer.send('window:fit-height', height),
  setAlwaysOnTop: (flag) => ipcRenderer.send('window:always-on-top', flag),

  startChannel: (direction) => ipcRenderer.invoke('channel:start', direction),
  stopChannel: (direction) => ipcRenderer.invoke('channel:stop', direction),
  sendAudio: (direction, pcm) => ipcRenderer.send('audio:append', direction, pcm),
  commitAudio: (direction) => ipcRenderer.send('audio:commit', direction),
  clearAudio: (direction) => ipcRenderer.send('audio:clear', direction),
  requestMicrophoneAccess: () => ipcRenderer.invoke('media:microphone'),
  report: (report) => ipcRenderer.send('engine:report', report)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
