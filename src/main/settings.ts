import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { DEFAULT_LISTEN_MODEL, DEFAULT_SPEAK_MODEL, guessModel } from '../shared/models'
import {
  SYSTEM_AUDIO_SOURCE,
  type AppSettings,
  type OverlaySettings,
  type PublicSettings,
  type SettingsPatch,
  type SpeakSettings
} from '../shared/types'

const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  workspaceId: '',
  region: 'cn-beijing',
  myLanguage: 'zh',
  peerLanguage: 'en',
  pauseListenWhileSpeaking: true,
  theme: 'system',
  listen: {
    model: DEFAULT_LISTEN_MODEL,
    source: SYSTEM_AUDIO_SOURCE,
    readAloud: false,
    outputDeviceId: '',
    glossary: ['# 一行一条：对方语言的词 = 想看到的中文', '# PR = PR', '# deploy = 上线'].join(
      '\n'
    ),
    // 和服务端默认值一致
    silenceMs: 1000,
    vadThreshold: 0.2,
    speakers: true,
    showPending: false
  },
  speak: {
    model: DEFAULT_SPEAK_MODEL,
    inputDeviceId: '',
    outputDeviceId: '',
    monitor: false,
    mode: 'auto',
    silenceMs: 800,
    voiceMode: 'off',
    clonedVoice: null,
    glossary: [
      '# 一行一条：中文词 = 对方语言里的说法',
      '# 提测 = hand off to QA',
      '# 联调 = integration testing'
    ].join('\n')
  },
  overlay: {
    fontSize: 28,
    textColor: '#ffffff',
    backgroundColor: '#000000',
    textOpacity: 1,
    backgroundOpacity: 0.55,
    showSource: false,
    showTranslation: true,
    lines: 2,
    showSpeak: false,
    bounds: null
  },
  records: {
    bounds: null,
    alwaysOnTop: false
  }
}

/** 拖滑块、挪窗口时设置会连续变化，合并成一次写盘 */
const SAVE_DELAY_MS = 400

/** 落盘时 Key 的写法：safeStorage 加密后的 base64；系统不支持加密时退回明文 */
type StoredKey = { encryptedApiKey: string } | { apiKey: string }

type StoredSettings = Omit<AppSettings, 'apiKey'> &
  Partial<{ encryptedApiKey: string; apiKey: string }> & {
    /** 旧版本听和说共用一个模型 */
    model?: string
  }

/** 旧版本用布尔值 voiceClone 表示「边听边复刻」 */
type LegacySpeak = Partial<SpeakSettings> & { voiceClone?: boolean }

/** 旧版本共用的模型留给「说」：复刻音色绑定在这个模型上；「听」用新的默认模型 */
function migrateSpeak(stored: LegacySpeak | undefined, legacyModel?: string): SpeakSettings {
  const { voiceClone, ...rest } = stored ?? {}
  return {
    ...DEFAULT_SETTINGS.speak,
    ...(legacyModel ? { model: guessModel(legacyModel) } : {}),
    ...(voiceClone ? { voiceMode: 'live' as const } : {}),
    ...rest
  }
}

/** 旧版看板默认显示原文；改成滚动字幕（出现 lines 字段）之前的配置，迁移成只显示译文 */
function migrateOverlay(stored: Partial<OverlaySettings> | undefined): OverlaySettings {
  const legacy = stored !== undefined && stored.lines === undefined
  return {
    ...DEFAULT_SETTINGS.overlay,
    ...stored,
    ...(legacy ? { showSource: false } : {})
  }
}

function withoutKey(settings: AppSettings): Omit<AppSettings, 'apiKey'> {
  const copy: Partial<AppSettings> = { ...settings }
  delete copy.apiKey
  return copy as Omit<AppSettings, 'apiKey'>
}

export class SettingsStore {
  private readonly file = join(app.getPath('userData'), 'settings.json')
  private settings: AppSettings
  /** 加密结果缓存起来，只有 Key 变了才重新加密，平时保存设置不碰系统钥匙串 */
  private storedKey: StoredKey = { apiKey: '' }
  private saveTimer: NodeJS.Timeout | null = null

  constructor() {
    this.settings = this.load()
  }

  get(): AppSettings {
    return this.settings
  }

  getPublic(): PublicSettings {
    const { apiKey, ...rest } = this.settings
    return { ...rest, hasApiKey: apiKey.length > 0, apiKeyHint: apiKey.slice(-4) }
  }

  update(patch: SettingsPatch): PublicSettings {
    if (patch.apiKey !== undefined && patch.apiKey !== this.settings.apiKey) {
      this.storedKey = this.encrypt(patch.apiKey)
    }
    this.settings = {
      ...this.settings,
      ...patch,
      listen: { ...this.settings.listen, ...patch.listen },
      speak: { ...this.settings.speak, ...patch.speak },
      overlay: { ...this.settings.overlay, ...patch.overlay },
      records: { ...this.settings.records, ...patch.records }
    }
    this.saveTimer ??= setTimeout(() => this.flush(), SAVE_DELAY_MS)
    return this.getPublic()
  }

  /** 清除账号：Key、业务空间、地域、复刻音色都回到默认，其余偏好保留 */
  resetAccount(): PublicSettings {
    return this.update({
      apiKey: '',
      workspaceId: DEFAULT_SETTINGS.workspaceId,
      region: DEFAULT_SETTINGS.region,
      speak: { clonedVoice: null, voiceMode: 'off' }
    })
  }

  /** 立即写盘；退出前调用，避免丢掉还没写的改动 */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.save()
  }

  private load(): AppSettings {
    if (!existsSync(this.file)) return structuredClone(DEFAULT_SETTINGS)
    try {
      const stored = JSON.parse(readFileSync(this.file, 'utf-8')) as StoredSettings
      const { encryptedApiKey, apiKey, model, ...rest } = stored
      this.storedKey = encryptedApiKey ? { encryptedApiKey } : { apiKey: apiKey ?? '' }
      return {
        ...DEFAULT_SETTINGS,
        ...rest,
        listen: { ...DEFAULT_SETTINGS.listen, ...rest.listen },
        speak: migrateSpeak(rest.speak, model),
        overlay: migrateOverlay(rest.overlay),
        records: { ...DEFAULT_SETTINGS.records, ...rest.records },
        apiKey: encryptedApiKey ? this.decrypt(encryptedApiKey) : (apiKey ?? '')
      }
    } catch (error) {
      console.error('读取设置失败，使用默认设置', error)
      return structuredClone(DEFAULT_SETTINGS)
    }
  }

  private save(): void {
    const stored: StoredSettings = { ...withoutKey(this.settings), ...this.storedKey }
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(stored, null, 2))
  }

  private encrypt(apiKey: string): StoredKey {
    if (!apiKey || !safeStorage.isEncryptionAvailable()) return { apiKey }
    return { encryptedApiKey: safeStorage.encryptString(apiKey).toString('base64') }
  }

  private decrypt(encrypted: string): string {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch (error) {
      console.error('API Key 解密失败，需要重新填写', error)
      return ''
    }
  }
}
