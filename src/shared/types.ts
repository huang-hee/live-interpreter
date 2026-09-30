import type { ModelChoice } from './models'
import type { Paragraph } from './paragraphs'

/** listen：对方 → 我；speak：我 → 对方 */
export type Direction = 'listen' | 'speak'

export type Region = 'cn-beijing' | 'ap-southeast-1'

export type SpeakMode = 'auto' | 'hold'

export type Theme = 'system' | 'light' | 'dark'

/**
 * 译音的音色：
 * off：系统预设音色；live：服务端边听边复刻，复刻完成前先用默认音色；
 * fixed：提前录一段复刻好的固定音色，第一句就是自己的声音
 */
export type VoiceMode = 'off' | 'live' | 'fixed'

/** 每个窗口的用途，preload 从启动参数里读 */
export type WindowRole = 'engine' | 'overlay' | 'settings' | 'records'

/** 收听来源：系统声音，或某个音频输入设备的 deviceId */
export const SYSTEM_AUDIO_SOURCE = 'system'

/** 「说」的译音不出声，只出文字 */
export const MUTED_OUTPUT = 'none'

export interface ListenSettings {
  model: ModelChoice
  source: string
  /** 除了字幕，是否把译文念出来 */
  readAloud: boolean
  outputDeviceId: string
  glossary: string
  /** 停顿多久算一句话说完（Qwen3.5 协议） */
  silenceMs: number
  /** 断句灵敏度，-1~1，越低越容易把背景音当成人声（Qwen3.5 协议） */
  vadThreshold: number
  /** 按说话人断句（Qwen3.8 协议） */
  speakers: boolean
  /** 字幕里也显示还没确认、可能被改写的译文：出字更快，但会改字 */
  showPending: boolean
}

export interface ClonedVoice {
  id: string
  /** 复刻时指定的模型，会话用的模型必须和它一致 */
  model: string
  createdAt: number
}

export interface SpeakSettings {
  model: ModelChoice
  inputDeviceId: string
  /** 译音播到哪：空串是系统默认输出，MUTED_OUTPUT 是不出声，其余是设备 deviceId */
  outputDeviceId: string
  /** 译音送到虚拟声卡时，本机默认输出（通常是耳机）也放一份 */
  monitor: boolean
  mode: SpeakMode
  /** 自动断句模式下，停顿多久算一句话说完 */
  silenceMs: number
  voiceMode: VoiceMode
  clonedVoice: ClonedVoice | null
  glossary: string
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 字幕看板的样式；记录窗口也跟着这套颜色和透明度 */
export interface OverlaySettings {
  fontSize: number
  textColor: string
  backgroundColor: string
  textOpacity: number
  backgroundOpacity: number
  /** 在译文上面加一行原文 */
  showSource: boolean
  showTranslation: boolean
  /** 滚动字幕固定显示几行译文 */
  lines: number
  /** 底部单独一条显示自己说的话，默认不显示 */
  showSpeak: boolean
  bounds: WindowBounds | null
}

export interface RecordsSettings {
  bounds: WindowBounds | null
  alwaysOnTop: boolean
}

export interface AppSettings {
  apiKey: string
  workspaceId: string
  region: Region
  myLanguage: string
  peerLanguage: string
  /** 说话或播报译文时暂停收听，避免系统声音把自己的译音再录回去 */
  pauseListenWhileSpeaking: boolean
  theme: Theme
  listen: ListenSettings
  speak: SpeakSettings
  overlay: OverlaySettings
  records: RecordsSettings
}

/** 给渲染进程的设置：不带 API Key 明文 */
export type PublicSettings = Omit<AppSettings, 'apiKey'> & {
  hasApiKey: boolean
  apiKeyHint: string
}

export type SettingsPatch = Partial<
  Omit<AppSettings, 'listen' | 'speak' | 'overlay' | 'records'>
> & {
  listen?: Partial<ListenSettings>
  speak?: Partial<SpeakSettings>
  overlay?: Partial<OverlaySettings>
  records?: Partial<RecordsSettings>
}

export type ChannelStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error'

export interface ChannelState {
  status: ChannelStatus
  /** 服务端给的提示，比如重连中、请求出错 */
  message: string
  /** 采集端出的错，比如没权限、设备断开；下次开始前一直保留 */
  error: string
  /** 服务端检测到有人在说话 */
  speaking: boolean
}

/** 各窗口共用的运行状态，主进程维护，变化时广播 */
export interface AppState {
  channels: Record<Direction, ChannelState>
  /** 正在按住说话 */
  holding: boolean
  /** 防回授生效中：自己的译音在播，收听暂停 */
  listenPaused: boolean
}

/** 引擎窗口报给主进程的状态变化 */
export type EngineReport =
  | { type: 'error'; direction: Direction; error: string }
  | { type: 'holding'; holding: boolean }
  | { type: 'listen-paused'; paused: boolean }

export type TranslatorEvent =
  | {
      direction: Direction
      type: 'status'
      status: ChannelStatus
      message?: string
      /** 第几次会话；上一次会话迟到的状态事件据此识别 */
      session: number
    }
  | {
      direction: Direction
      type: 'source' | 'translation'
      /** 同一段语音的原文和译文共用一个段落 ID（取原文消息项的 ID） */
      paragraphId: string
      text: string
      stash: string
      final: boolean
    }
  | { direction: Direction; type: 'audio'; pcm: Uint8Array }
  | { direction: Direction; type: 'speech'; speaking: boolean }

/** 界面窗口发给引擎的操作；采集和播放都在引擎里 */
export type EngineCommand =
  | { type: 'start' | 'stop'; direction: Direction }
  | { type: 'hold-begin' | 'hold-end' | 'hold-toggle' }
  | { type: 'stop-all' }

export type Records = Record<Direction, Paragraph[]>

/** 检查连接用的草稿：apiKey 为空时用已保存的 Key */
export interface ConnectionDraft {
  apiKey?: string
  region: Region
  workspaceId: string
}

export interface Result {
  ok: boolean
  message: string
}

export interface InterpreterApi {
  platform: string
  role: WindowRole
  getSettings: () => Promise<PublicSettings>
  saveSettings: (patch: SettingsPatch) => Promise<PublicSettings>
  /** 任何窗口改了设置，所有窗口都会收到 */
  onSettingsChanged: (listener: (settings: PublicSettings) => void) => () => void
  /** 用草稿里的 Key、地域、业务空间试连一次，通过后再保存 */
  checkConnection: (draft: ConnectionDraft) => Promise<Result>
  /** 停掉所有通道，删掉复刻音色和保存的 Key */
  clearAccount: () => Promise<boolean>
  /** 用一段 WAV 录音复刻固定音色 */
  createVoice: (wav: ArrayBuffer) => Promise<Result>
  deleteVoice: () => Promise<Result>

  getState: () => Promise<AppState>
  onStateChanged: (listener: (state: AppState) => void) => () => void
  getRecords: () => Promise<Records>
  clearRecords: () => void
  onRecordsCleared: (listener: () => void) => () => void
  /** 主进程按批推送，一批里同一段字幕只保留最新一版 */
  onTranslatorEvents: (listener: (events: TranslatorEvent[]) => void) => () => void

  sendCommand: (command: EngineCommand) => void
  openWindow: (role: 'settings' | 'records') => void
  closeWindow: () => void
  quit: () => void
  /** 无边框窗口没有系统标题栏，拖动和缩放由页面算好位置、尺寸后交给主进程 */
  moveWindow: (x: number, y: number) => void
  resizeWindow: (width: number, height: number) => void
  /** 看板按内容算好高度后调整窗口，底边位置不动 */
  fitWindowHeight: (height: number) => void
  setAlwaysOnTop: (flag: boolean) => void

  // 以下只给引擎窗口用
  /** 连上返回会话编号，失败返回 0；失败原因通过状态事件广播 */
  startChannel: (direction: Direction) => Promise<number>
  stopChannel: (direction: Direction) => Promise<void>
  sendAudio: (direction: Direction, pcm: ArrayBuffer) => void
  commitAudio: (direction: Direction) => void
  clearAudio: (direction: Direction) => void
  requestMicrophoneAccess: () => Promise<boolean>
  report: (report: EngineReport) => void
}

export const HOLD_TO_TALK_SHORTCUT = 'CommandOrControl+Shift+Space'
