// 按百炼实时同传文档的事件格式模拟服务端，用于自动化测试。
// 地址里的模型是 qwen3.8 开头时按 3.8 协议推增量（delta），否则按 3.5 协议推「全文 + 待确认尾巴」
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { WebSocketServer } from 'ws'

export const MOCK_KEY = 'sk-mock-test'

interface TurnDetection {
  type?: string
  silence_duration_ms?: number
}

interface SessionConfig {
  modalities?: string[]
  output_modalities?: string[]
  audio?: { input?: { turn_detection?: TurnDetection | null } }
  turn_detection?: TurnDetection | null
  translation?: { language?: string; corpus?: { phrases?: Record<string, string> } }
  [key: string]: unknown
}

/** 一次连接里模拟服务端看到的东西，测试用它校验客户端发了什么 */
export interface MockConnection {
  maxRms: number
  rmsHist: number[]
  url: string | undefined
  config: SessionConfig | null
  audioBytes: number
  chunkSizes: Set<number>
  appends: number
  commits: number
  clears: number
  finished: boolean
  segments: number
  events: string[]
  firstAppendAt?: number
  lastAppendAt?: number
  /** 客户端断开的时间，没断开是 undefined */
  closedAt?: number
}

/** 声音复刻接口收到的请求 */
export interface EnrollmentRequest {
  action: string
  targetModel?: string
  audioBytes?: number
  sampleRate?: number
  seconds?: number
  voice?: string
}

export interface MockServer {
  port: number
  stats: {
    connections: MockConnection[]
    enrollments: EnrollmentRequest[]
    closeNext: boolean
    errorNext: boolean
    /** 下一块音频到来时报错并断开，模拟参数被拒 */
    rejectNext: boolean
  }
  close: () => Promise<void>
}

/** 声音复刻：POST /api/v1/services/audio/tts/customization，按文档的请求格式校验 */
function handleEnrollment(
  req: IncomingMessage,
  res: ServerResponse,
  enrollments: EnrollmentRequest[]
): void {
  const reply = (status: number, body: object): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.url !== '/api/v1/services/audio/tts/customization' || req.method !== 'POST') {
    reply(404, { code: 'NotFound', message: 'not found' })
    return
  }
  if (req.headers.authorization !== `Bearer ${MOCK_KEY}`) {
    reply(401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' })
    return
  }
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      model?: string
      input?: { action?: string; target_model?: string; voice?: string; audio?: { data?: string } }
    }
    const input = body.input ?? {}
    if (body.model !== 'qwen-voice-enrollment') {
      reply(400, { code: 'InvalidParameter', message: 'model must be qwen-voice-enrollment' })
      return
    }
    if (input.action === 'delete') {
      enrollments.push({ action: 'delete', voice: input.voice })
      reply(200, { output: {}, usage: { count: 0 } })
      return
    }
    const data = input.audio?.data ?? ''
    const wav = Buffer.from(data.replace(/^data:audio\/wav;base64,/, ''), 'base64')
    const sampleRate = wav.readUInt32LE(24)
    const audioBytes = wav.readUInt32LE(40)
    enrollments.push({
      action: input.action ?? '',
      targetModel: input.target_model,
      audioBytes,
      sampleRate,
      seconds: audioBytes / 2 / sampleRate
    })
    reply(200, {
      output: {
        target_model: input.target_model,
        voice: `qwen-translate-vc-mock-${enrollments.length}`
      },
      usage: { count: 1 }
    })
  })
}

interface Segment {
  n: number
  asr: string
  tr: string
  ms: number
  created: boolean
}

export function startMock(port = 0): Promise<MockServer> {
  const stats: MockServer['stats'] = {
    connections: [],
    enrollments: [],
    closeNext: false,
    errorNext: false,
    rejectNext: false
  }
  const server = createServer((req, res) => handleEnrollment(req, res, stats.enrollments))
  const wss = new WebSocketServer({
    server,
    verifyClient: (info, done) => {
      const ok = info.req.headers.authorization === `Bearer ${MOCK_KEY}`
      done(ok, ok ? undefined : 401, ok ? undefined : 'Unauthorized')
    }
  })
  let seq = 0
  const id = (prefix: string): string => `${prefix}_${++seq}`

  wss.on('connection', (ws, req) => {
    const conn: MockConnection = {
      maxRms: 0,
      rmsHist: [],
      url: req.url,
      config: null,
      audioBytes: 0,
      chunkSizes: new Set(),
      appends: 0,
      commits: 0,
      clears: 0,
      finished: false,
      segments: 0,
      events: []
    }
    stats.connections.push(conn)
    const send = (e: Record<string, unknown>): void => {
      ws.readyState === 1 && ws.send(JSON.stringify({ event_id: id('event'), ...e }))
    }
    let seg: Segment | null = null // 当前语音片段
    let silentMs = 0
    let timer: NodeJS.Timeout | undefined

    const delta = new URL(req.url ?? '', 'ws://mock').searchParams
      .get('model')
      ?.startsWith('qwen3.8')
    const phrases = (): Record<string, string> => conn.config?.translation?.corpus?.phrases ?? {}
    const audioOut = (): boolean =>
      (conn.config?.[delta ? 'output_modalities' : 'modalities'] ?? ['text', 'audio']).includes(
        'audio'
      )
    const target = (): string => conn.config?.translation?.language ?? 'en'
    /** 断句配置：3.8 放在 audio.input 下；null 是手动断句 */
    const turnDetection = (): TurnDetection | null | undefined =>
      delta ? conn.config?.audio?.input?.turn_detection : conn.config?.turn_detection

    const startSegment = (): Segment => {
      conn.segments++
      const next = {
        n: conn.segments,
        asr: id('item_asr'),
        tr: id('item_tr'),
        ms: 0,
        created: false
      }
      if (turnDetection() !== null)
        send({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0, item_id: next.asr })
      return next
    }
    const sourceText = (s: Segment): string =>
      `原文${s.n}` + '字'.repeat(Math.min(12, Math.floor(s.ms / 400)))
    // 文字只往后长，3.8 协议按差量推增量
    const translationText = (s: Segment): string =>
      `[${target()}] segment ${s.n}` +
      (Object.values(phrases()).length ? ` {${Object.values(phrases()).join('|')}}` : '') +
      ' word'.repeat(Math.min(6, Math.floor(s.ms / 800)))
    const sent = new Map<string, string>()
    const sendText = (
      kind: 'source' | 'translation',
      itemId: string,
      text: string,
      stash: string
    ): void => {
      const fields = { item_id: itemId, content_index: 0 }
      const translation = kind === 'translation'
      const extra = translation ? { response_id: 'resp', output_index: 0 } : {}
      if (!delta) {
        const type = translation
          ? audioOut()
            ? 'response.audio_transcript.text'
            : 'response.text.text'
          : 'conversation.item.input_audio_transcription.text'
        send({ type, ...fields, ...extra, text, stash })
        return
      }
      const before = sent.get(itemId) ?? ''
      if (text.length <= before.length) return
      sent.set(itemId, text)
      const type = translation
        ? audioOut()
          ? 'response.audio_transcript.delta'
          : 'response.text.delta'
        : 'conversation.item.input_audio_transcription.delta'
      send({ type, ...fields, ...extra, delta: text.slice(before.length) })
    }
    const progress = (): void => {
      if (!seg) return
      sendText('source', seg.asr, sourceText(seg), '…')
      if (seg.ms >= 400) {
        if (!seg.created) {
          seg.created = true
          send({
            type: 'conversation.item.created',
            previous_item_id: seg.asr,
            item: {
              id: seg.tr,
              object: 'realtime.item',
              type: 'message',
              status: 'in_progress',
              role: 'assistant',
              content: []
            }
          })
        }
        sendText('translation', seg.tr, translationText(seg), ' …')
        if (audioOut())
          send({
            type: 'response.audio.delta',
            item_id: seg.tr,
            response_id: 'resp',
            output_index: 0,
            content_index: 0,
            delta: Buffer.alloc(4800).toString('base64')
          })
      }
    }
    const endSegment = (): void => {
      if (!seg) return
      const s = seg
      seg = null
      if (turnDetection() !== null)
        send({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 0, item_id: s.asr })
      if (!s.created)
        send({
          type: 'conversation.item.created',
          previous_item_id: s.asr,
          item: { id: s.tr, role: 'assistant', content: [] }
        })
      send({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: s.asr,
        content_index: 0,
        transcript: sourceText(s) + '。',
        language: 'zh',
        emotion: ''
      })
      if (audioOut()) {
        send({
          type: 'response.audio_transcript.done',
          item_id: s.tr,
          response_id: 'resp',
          output_index: 0,
          content_index: 0,
          transcript: translationText(s) + '.'
        })
        send({
          type: 'response.audio.done',
          item_id: s.tr,
          response_id: 'resp',
          output_index: 0,
          content_index: 0
        })
      } else {
        send({
          type: 'response.text.done',
          item_id: s.tr,
          response_id: 'resp',
          output_index: 0,
          content_index: 0,
          text: translationText(s) + '.'
        })
      }
      send({ type: 'response.done', response: { id: 'resp', status: 'completed' } })
    }

    send({
      type: 'session.created',
      session: { id: id('sess'), object: 'realtime.session', model: 'mock' }
    })
    ws.on('message', (data) => {
      const e = JSON.parse(data.toString())
      conn.events.push(e.type)
      switch (e.type) {
        case 'session.update':
          conn.config = e.session
          send({ type: 'session.updated', session: e.session })
          break
        case 'input_audio_buffer.append': {
          const pcm = Buffer.from(e.audio, 'base64')
          conn.audioBytes += pcm.length
          conn.firstAppendAt ??= Date.now()
          conn.lastAppendAt = Date.now()
          conn.appends++
          conn.chunkSizes.add(pcm.length)
          const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1)
          let sum = 0
          for (const v of samples) sum += v * v
          const rms = Math.sqrt(sum / Math.max(1, samples.length)) / 32768
          const ms = (samples.length / 16000) * 1000
          conn.maxRms = Math.max(conn.maxRms, rms)
          if (conn.rmsHist.length < 60) conn.rmsHist.push(Math.round(rms * 1000) / 1000)
          if (stats.errorNext) {
            stats.errorNext = false
            send({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                code: 'mock_error',
                message: '模拟的服务端错误'
              }
            })
          }
          if (stats.closeNext) {
            stats.closeNext = false
            ws.close(1011, 'mock drop')
            return
          }
          if (stats.rejectNext) {
            stats.rejectNext = false
            send({
              type: 'error',
              error: { type: 'invalid_request_error', code: 'mock_reject', message: '模拟的拒绝' }
            })
            ws.close(1011, 'mock reject')
            return
          }
          const manual = turnDetection() === null
          if (rms > 0.01) {
            seg ??= startSegment()
            seg.ms += ms
            silentMs = 0
          } else if (seg) {
            silentMs += ms
            if (!manual && silentMs >= (turnDetection()?.silence_duration_ms ?? 1000)) endSegment()
          }
          timer ??= setInterval(progress, 250)
          break
        }
        case 'input_audio_buffer.commit':
          conn.commits++
          send({ type: 'input_audio_buffer.committed' })
          endSegment()
          break
        case 'input_audio_buffer.clear':
          conn.clears++
          seg = null
          send({ type: 'input_audio_buffer.cleared' })
          break
        case 'session.finish':
          conn.finished = true
          endSegment()
          setTimeout(() => {
            send({ type: 'session.finished' })
          }, 100)
          break
      }
    })
    ws.on('close', () => {
      clearInterval(timer)
      conn.closedAt = Date.now()
    })
  })

  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        stats,
        close: (): Promise<void> =>
          new Promise((done) => {
            for (const client of wss.clients) client.terminate()
            wss.close(() => server.close(() => done()))
          })
      })
    )
  )
}
