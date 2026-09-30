import WebSocket from 'ws'
import { findLanguage } from '../shared/languages'
import {
  MUTED_OUTPUT,
  type AppSettings,
  type ChannelStatus,
  type Direction,
  type Region,
  type TranslatorEvent
} from '../shared/types'

// 协议见百炼文档「实时音视频翻译」客户端事件 / 服务端事件（qwen3.5-livetranslate-flash-realtime）

const LEGACY_HOSTS: Record<Region, string> = {
  'cn-beijing': 'dashscope.aliyuncs.com',
  'ap-southeast-1': 'dashscope-intl.aliyuncs.com'
}

const ASR_MODEL = 'qwen3-asr-flash-realtime'
const FINISH_TIMEOUT_MS = 3000
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000]
/** 译文消息项 → 原文消息项的映射只留最近这么多条 */
const MAX_LINKS = 256

interface ServerEvent {
  type: string
  item_id?: string
  previous_item_id?: string
  item?: { id?: string; role?: string }
  text?: string
  stash?: string
  transcript?: string
  delta?: string
  code?: string
  message?: string
  error?: { code?: string; message?: string }
}

/** override 是开发调试用的替换地址（不含 model 参数） */
export function buildEndpoint(settings: AppSettings, override?: string): string {
  const model = `model=${encodeURIComponent(settings.model)}`
  if (override) return `${override}?${model}`
  const workspaceId = settings.workspaceId.trim()
  const host = workspaceId
    ? `${workspaceId}.${settings.region}.maas.aliyuncs.com`
    : LEGACY_HOSTS[settings.region]
  return `wss://${host}/api-ws/v1/realtime?${model}`
}

/** 术语表一行一条「原词 = 译法」，# 开头是注释 */
export function parseGlossary(text: string): Record<string, string> {
  const phrases: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const source = trimmed.slice(0, index).trim()
    const target = trimmed.slice(index + 1).trim()
    if (source && target) phrases[source] = target
  }
  return phrases
}

function buildTranslation(language: string, glossary: string): Record<string, unknown> {
  const phrases = parseGlossary(glossary)
  return {
    language,
    // 源语种和目标语种相同时不重复输出，比如收听时对方说的就是中文；服务端只对 zh、en 生效
    ...(language === 'zh' || language === 'en'
      ? { same_language_skip_options: { skip_text: true, skip_audio: true } }
      : {}),
    ...(Object.keys(phrases).length > 0 ? { corpus: { phrases } } : {})
  }
}

/**
 * 译音音色：
 * fixed 用提前复刻好的音色 ID，第一句就是本人声音；复刻时的模型必须和会话模型一致，否则退回 live。
 * live 由服务端边听边复刻，复刻完成前先用默认音色过渡。
 */
function voiceConfig({ model, speak }: AppSettings): Record<string, unknown> {
  const fixed = speak.voiceMode === 'fixed' && speak.clonedVoice?.model === model
  if (fixed && speak.clonedVoice) {
    return {
      voice: speak.clonedVoice.id,
      enable_voice_clone: true,
      voice_clone_options: { frequency: 'never' }
    }
  }
  if (speak.voiceMode === 'off') return {}
  return { voice: 'default', enable_voice_clone: true, voice_clone_options: { frequency: 'once' } }
}

export function buildSessionConfig(
  direction: Direction,
  settings: AppSettings
): Record<string, unknown> {
  const audioFormat = { input_audio_format: 'pcm', sample_rate: 16000, output_audio_format: 'pcm' }

  if (direction === 'listen') {
    const { myLanguage, listen } = settings
    const speech = listen.readAloud && (findLanguage(myLanguage)?.speech ?? false)
    return {
      modalities: speech ? ['text', 'audio'] : ['text'],
      ...audioFormat,
      // 不指定源语种，由模型自动识别
      input_audio_transcription: { model: ASR_MODEL },
      translation: buildTranslation(myLanguage, listen.glossary)
    }
  }

  const { myLanguage, peerLanguage, speak } = settings
  // 选了「不出声」就只要文字，省掉最贵的音频输出
  const speech =
    (findLanguage(peerLanguage)?.speech ?? false) && speak.outputDeviceId !== MUTED_OUTPUT
  return {
    modalities: speech ? ['text', 'audio'] : ['text'],
    ...(speech ? voiceConfig(settings) : {}),
    ...audioFormat,
    input_audio_transcription: { model: ASR_MODEL, language: myLanguage },
    turn_detection:
      speak.mode === 'hold'
        ? null
        : { type: 'server_vad', threshold: 0.2, silence_duration_ms: speak.silenceMs },
    translation: buildTranslation(peerLanguage, speak.glossary)
  }
}

function describeConnectError(error: Error): string {
  const status = /Unexpected server response: (\d+)/.exec(error.message)?.[1]
  if (status === '401') return 'API Key 无效，或和设置里的地域、业务空间对不上'
  if (status === '403') return '这个 API Key 没有调用同传模型的权限，到百炼控制台确认已开通'
  if (status === '404') return '服务地址不存在，检查业务空间 ID 和地域'
  if (status) return `服务拒绝连接（HTTP ${status}）`
  if (/ENOTFOUND|EAI_AGAIN/.test(error.message)) return '找不到服务地址，检查网络和业务空间 ID'
  return error.message
}

const CHECK_TIMEOUT_MS = 8000

/** 只握手不翻译：连上并收到 session.created 就算 Key、地域、业务空间都对 */
export function checkConnection(
  settings: AppSettings,
  endpointOverride?: string
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(buildEndpoint(settings, endpointOverride), {
      headers: { Authorization: `Bearer ${settings.apiKey}` }
    })
    const finish = (ok: boolean, message: string): void => {
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.on('error', () => undefined)
      socket.terminate()
      resolve({ ok, message })
    }
    const timer = setTimeout(() => finish(false, '连接超时，检查网络'), CHECK_TIMEOUT_MS)
    socket.on('message', (data) => {
      const event = JSON.parse(data.toString()) as ServerEvent
      if (event.type === 'session.created') finish(true, '')
      else if (event.type === 'error') finish(false, event.error?.message ?? '服务返回错误')
    })
    socket.on('error', (error) => finish(false, describeConnectError(error)))
    socket.on('close', (code) => finish(false, `连接被关闭（${code}）`))
  })
}

export class TranslatorChannel {
  private socket: WebSocket | null = null
  private active = false
  private session = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  /**
   * 同一个 VAD 片段，服务端会分别建原文和译文两个消息项；
   * 译文项创建时的 previous_item_id 就是原文项 ID，据此把两者归到同一段落
   */
  private paragraphOf = new Map<string, string>()

  constructor(
    private readonly direction: Direction,
    private readonly getSettings: () => AppSettings,
    private readonly emit: (event: TranslatorEvent) => void,
    /** 开发调试时替换服务地址（不含 model 参数），比如指到本地的模拟服务 */
    private readonly endpointOverride?: string
  ) {}

  /** 失败原因通过 status 事件发给界面，这里只返回是否连上 */
  /**
   * 连上返回这次会话的编号，失败返回 0；失败原因通过 status 事件发出去。
   * 状态事件带着会话编号，引擎据此忽略上一次会话迟到的事件。
   */
  async start(): Promise<number> {
    return this.open(true)
  }

  /** 设置变了要换配置：旧会话的尾巴没用了，直接断开，不等服务端译完 */
  async restart(): Promise<number> {
    return this.open(false)
  }

  private async open(graceful: boolean): Promise<number> {
    // 重新开始前悄悄收掉旧连接，不发 idle：批量推送会让它晚于新会话的事件到达
    await this.shutdown(graceful)
    this.session++
    this.active = true
    this.emitStatus('connecting')
    try {
      await this.connect()
      this.emitStatus('live')
      return this.session
    } catch (error) {
      this.active = false
      this.emitStatus('error', describeConnectError(error as Error))
      return 0
    }
  }

  async stop(): Promise<void> {
    await this.shutdown()
    this.emitStatus('idle')
  }

  private async shutdown(graceful = true): Promise<void> {
    this.active = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const socket = this.socket
    this.socket = null
    if (!socket) return
    if (graceful) {
      await this.finish(socket)
    } else {
      socket.removeAllListeners()
      socket.on('error', () => undefined)
      socket.terminate()
    }
  }

  appendAudio(pcm: ArrayBuffer): void {
    this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') })
  }

  commitAudio(): void {
    this.send({ type: 'input_audio_buffer.commit' })
  }

  clearAudio(): void {
    this.send({ type: 'input_audio_buffer.clear' })
  }

  private connect(): Promise<void> {
    const settings = this.getSettings()
    if (!settings.apiKey) {
      return Promise.reject(new Error('还没填 API Key，打开「设置」填入百炼的 API Key'))
    }

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(buildEndpoint(settings, this.endpointOverride), {
        headers: { Authorization: `Bearer ${settings.apiKey}` }
      })
      let ready = false
      this.paragraphOf.clear()

      const fail = (error: Error): void => {
        if (ready) return
        ready = true
        socket.removeAllListeners()
        socket.terminate()
        reject(error)
      }

      socket.on('message', (data) => {
        const event = JSON.parse(data.toString()) as ServerEvent
        if (!ready) {
          if (event.type === 'session.created') {
            socket.send(
              JSON.stringify({
                type: 'session.update',
                session: buildSessionConfig(this.direction, settings)
              })
            )
          } else if (event.type === 'session.updated') {
            ready = true
            this.socket = socket
            resolve()
          } else if (event.type === 'error' || event.code) {
            fail(new Error(this.errorMessage(event)))
          }
          return
        }
        this.handleServerEvent(event)
      })

      socket.on('error', (error) => {
        if (!ready) fail(error)
        else console.error(`[${this.direction}] socket error`, error)
      })

      socket.on('close', (code, reason) => {
        if (!ready) {
          fail(new Error(`连接被关闭（${code} ${reason.toString()}）`))
          return
        }
        if (this.socket === socket) this.handleUnexpectedClose(code, reason.toString())
      })
    })
  }

  private handleUnexpectedClose(code: number, reason: string, attempt = 0): void {
    this.socket = null
    if (!this.active) return
    const delay = RECONNECT_DELAYS_MS[attempt]
    if (delay === undefined) {
      this.active = false
      this.emitStatus('error', `连接断开（${code} ${reason}），重试多次仍失败`)
      return
    }
    this.emitStatus('reconnecting', `连接断开，${delay / 1000} 秒后重连`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.active) return
      this.connect()
        .then(() => this.emitStatus('live'))
        .catch((error: Error) =>
          this.handleUnexpectedClose(code, describeConnectError(error), attempt + 1)
        )
    }, delay)
  }

  /** 先发 session.finish 让服务端把最后一段译完，收到 session.finished 或超时后再断开 */
  private finish(socket: WebSocket): Promise<void> {
    return new Promise((resolve) => {
      if (socket.readyState !== WebSocket.OPEN) {
        socket.terminate()
        resolve()
        return
      }
      const done = (): void => {
        clearTimeout(timer)
        socket.removeAllListeners()
        socket.close()
        resolve()
      }
      const timer = setTimeout(done, FINISH_TIMEOUT_MS)
      socket.removeAllListeners('message')
      socket.removeAllListeners('close')
      socket.on('close', done)
      socket.on('message', (data) => {
        const event = JSON.parse(data.toString()) as ServerEvent
        if (event.type === 'session.finished') done()
        else this.handleServerEvent(event)
      })
      socket.send(JSON.stringify({ type: 'session.finish' }))
    })
  }

  private handleServerEvent(event: ServerEvent): void {
    const direction = this.direction
    const itemId = event.item_id ?? ''
    switch (event.type) {
      case 'conversation.item.created':
        if (event.item?.role === 'assistant' && event.item.id && event.previous_item_id) {
          this.link(event.item.id, event.previous_item_id)
        }
        break
      case 'conversation.item.input_audio_transcription.text':
        this.emitText('source', itemId, event.text, event.stash, false)
        break
      case 'conversation.item.input_audio_transcription.completed':
        this.emitText('source', itemId, event.transcript, '', true)
        break
      case 'response.text.text':
      case 'response.audio_transcript.text':
        this.emitText('translation', itemId, event.text, event.stash, false)
        break
      case 'response.text.done':
        this.emitText('translation', itemId, event.text, '', true)
        break
      case 'response.audio_transcript.done':
        this.emitText('translation', itemId, event.transcript, '', true)
        break
      case 'response.audio.delta':
        if (event.delta) {
          this.emit({
            direction,
            type: 'audio',
            pcm: new Uint8Array(Buffer.from(event.delta, 'base64'))
          })
        }
        break
      case 'input_audio_buffer.speech_started':
        this.emit({ direction, type: 'speech', speaking: true })
        break
      case 'input_audio_buffer.speech_stopped':
        this.emit({ direction, type: 'speech', speaking: false })
        break
      case 'error':
        this.emitStatus('live', this.errorMessage(event))
        break
    }
  }

  private link(translationId: string, sourceId: string): void {
    this.paragraphOf.set(translationId, sourceId)
    if (this.paragraphOf.size > MAX_LINKS) {
      const oldest = this.paragraphOf.keys().next().value
      if (oldest !== undefined) this.paragraphOf.delete(oldest)
    }
  }

  private emitText(
    type: 'source' | 'translation',
    itemId: string,
    text: string | undefined,
    stash: string | undefined,
    final: boolean
  ): void {
    // 没拿到关联时（比如服务端没发 conversation.item.created）译文自成一段
    const paragraphId = type === 'translation' ? (this.paragraphOf.get(itemId) ?? itemId) : itemId
    this.emit({
      direction: this.direction,
      type,
      paragraphId,
      text: text ?? '',
      stash: stash ?? '',
      final
    })
  }

  private errorMessage(event: ServerEvent): string {
    const code = event.error?.code ?? event.code
    const message = event.error?.message ?? event.message ?? '未知错误'
    return code ? `${message}（${code}）` : message
  }

  private send(event: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event))
  }

  private emitStatus(status: ChannelStatus, message?: string): void {
    this.emit({ direction: this.direction, type: 'status', status, message, session: this.session })
  }
}
