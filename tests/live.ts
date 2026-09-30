// 真实百炼联调：用自己的 Key 逐个模型跑一遍，回答文档里没写清的几件事。百炼限流每分钟 10 次连接，几种模式分开跑。
//   默认（LIVE_MODE=speak）：按实时速度推一段中文语音，看已确认的译文会不会被改写、定稿和最后一版是否一致、
//         出字延迟、热词；Qwen3.8 另外跑按住说话（推完再提交）和边说边复刻（要出译音）
//   LIVE_MODE=listen：「听」的测速。两个人轮流说的英文对话，按看板的显示规则回放，
//         统计每句原文出来后译文多久上屏、稳定优先比显示未确认晚多少、被上一句压住多久
//   LIVE_MODE=probe：只握手不推音频，逐项看 Qwen3.8 收不收文档没写明的参数
// 运行：DASHSCOPE_API_KEY=sk-xxx npm run test:live
// 可选：LIVE_MODEL=模型 ID（只测这一个）、DASHSCOPE_REGION=ap-southeast-1、DASHSCOPE_WORKSPACE_ID=xxx
// 语音：LIVE_WAV=自己的录音.wav（16kHz、16 位、单声道）；不指定时在 macOS 上用 say 现场合成一段
// 调试这个脚本：LIVE_ENDPOINT=ws://127.0.0.1:端口/api-ws/v1/realtime 连本地的模拟服务
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import WebSocket from 'ws'
import { buildEndpoint, buildSessionConfig, TranslatorChannel } from '../src/main/translator'
import { captionOf } from '../src/renderer/src/overlay/caption'
import { guessModel, MODEL_PRESETS, type ModelChoice } from '../src/shared/models'
import { upsertParagraph, type Paragraph } from '../src/shared/paragraphs'
import {
  MUTED_OUTPUT,
  type AppSettings,
  type Region,
  type TranslatorEvent
} from '../src/shared/types'

const apiKey = process.env.DASHSCOPE_API_KEY
const endpointOverride = process.env.LIVE_ENDPOINT
if (!apiKey) {
  console.error('先设置环境变量 DASHSCOPE_API_KEY')
  process.exit(1)
}

/** [[slnc 毫秒]] 是 say 的停顿指令：句间停 1.2 秒，服务端会断成三段 */
const SAMPLE_TEXT =
  '好的，登录页这周四提测。[[slnc 1200]]你能在周五前把修复推上去吗？[[slnc 1200]]我们下周一再对一下排期。'
const GLOSSARY = { 提测: 'hand off to QA' }

function settingsFor(model: ModelChoice, speak: Partial<AppSettings['speak']> = {}): AppSettings {
  const settings: AppSettings = {
    apiKey: apiKey ?? '',
    workspaceId: process.env.DASHSCOPE_WORKSPACE_ID ?? '',
    region: (process.env.DASHSCOPE_REGION as Region) ?? 'cn-beijing',
    myLanguage: 'zh',
    peerLanguage: 'en',
    pauseListenWhileSpeaking: true,
    theme: 'system',
    listen: {
      model,
      source: 'system',
      readAloud: false,
      outputDeviceId: '',
      glossary: '',
      silenceMs: 1000,
      vadThreshold: 0.2,
      speakers: true,
      showPending: false
    },
    speak: {
      model,
      inputDeviceId: '',
      outputDeviceId: 'none',
      monitor: false,
      mode: 'auto',
      silenceMs: 800,
      voiceMode: 'off',
      clonedVoice: null,
      glossary: Object.entries(GLOSSARY)
        .map(([source, target]) => `${source} = ${target}`)
        .join('\n')
    },
    overlay: {
      fontSize: 28,
      textColor: '#ffffff',
      backgroundColor: '#000000',
      textOpacity: 1,
      backgroundOpacity: 0.55,
      showSource: true,
      showTranslation: true,
      lines: 2,
      showSpeak: false,
      bounds: null
    },
    records: { bounds: null, alwaysOnTop: false }
  }
  return { ...settings, speak: { ...settings.speak, ...speak } }
}

/** 推语音的几种跑法 */
interface Variant {
  name: string
  speak: Partial<AppSettings['speak']>
}

const AUTO: Variant = { name: '停顿自动断句，只出文字', speak: {} }
const VARIANTS_38: Variant[] = [
  AUTO,
  { name: '按住说话：推完整段再提交', speak: { mode: 'hold' } },
  { name: '边说边复刻，出译音', speak: { outputDeviceId: '', voiceMode: 'live' } }
]

/**
 * Qwen3.8 文档没写明的参数，逐项单独握手看服务端收不收。
 * session.update 里少了 translation 会报 Invalid translation parameter，所以每项都带上基础配置
 */
const BASE_38 = { output_modalities: ['text'], voice: 'Tina', translation: { language: 'en' } }
const VAD_TUNED = { type: 'server_vad', threshold: 0.3, silence_duration_ms: 1500 }
const PROBES_38: [string, Record<string, unknown>][] = [
  ['只有基础配置', {}],
  [
    'audio.input.turn_detection 调停顿和灵敏度',
    { audio: { input: { turn_detection: VAD_TUNED } } }
  ],
  ['顶层 turn_detection 调停顿和灵敏度', { turn_detection: VAD_TUNED }],
  [
    '按说话人断句时调停顿',
    {
      audio: { input: { turn_detection: { type: 'speaker_detection', silence_duration_ms: 1500 } } }
    }
  ],
  ['手动断句 audio.input.turn_detection = null', { audio: { input: { turn_detection: null } } }],
  ['手动断句 顶层 turn_detection = null', { turn_detection: null }],
  [
    '边说边复刻（音色 Tina）',
    { enable_voice_clone: true, voice_clone_options: { frequency: 'once' } }
  ],
  [
    '边说边复刻（音色 default）',
    { voice: 'default', enable_voice_clone: true, voice_clone_options: { frequency: 'once' } }
  ]
].map(([name, patch]) => [name as string, { ...BASE_38, ...(patch as object) }])

/** 回显里看这几项：服务端收下的值会原样出现，不认的字段会被丢掉或回到默认值 */
const ECHO_KEYS = ['audio', 'turn_detection', 'voice', 'enable_voice_clone', 'voice_clone_options']

function probe(
  model: ModelChoice,
  name: string,
  session: Record<string, unknown>,
  fullEcho = false
): Promise<void> {
  return new Promise((resolve) => {
    const settings = settingsFor(model)
    const socket = new WebSocket(buildEndpoint(settings, model.id, endpointOverride), {
      headers: { Authorization: `Bearer ${settings.apiKey}` }
    })
    const done = (line: string): void => {
      clearTimeout(timer)
      console.log(`  ${name}：${line}`)
      socket.removeAllListeners()
      socket.on('error', () => undefined)
      socket.terminate()
      resolve()
    }
    const timer = setTimeout(() => done('✖ 超时'), 8000)
    socket.on('message', (data) => {
      const event = JSON.parse(data.toString()) as {
        type: string
        session?: Record<string, unknown>
        error?: { code?: string; message?: string }
      }
      if (event.type === 'session.created') {
        socket.send(JSON.stringify({ type: 'session.update', session }))
      } else if (event.type === 'session.updated') {
        if (fullEcho) {
          done(`✔ 收下，完整回显 ${JSON.stringify(event.session)}`)
          return
        }
        const echo = Object.fromEntries(
          ECHO_KEYS.filter((key) => event.session?.[key] !== undefined).map((key) => [
            key,
            event.session?.[key]
          ])
        )
        done(`✔ 收下，回显 ${JSON.stringify(echo)}`)
      } else if (event.type === 'error') {
        done(`✖ 报错 ${event.error?.code ?? ''} ${event.error?.message ?? ''}`)
      }
    })
    socket.on('error', (error) => done(`✖ ${error.message}`))
  })
}

/** 要推的语音文件：LIVE_WAV 指定的，或者 macOS 上用 say 合成的 */
function speechFile(): string {
  if (process.env.LIVE_WAV) return process.env.LIVE_WAV
  if (process.platform !== 'darwin') {
    console.error('先用 LIVE_WAV 指定一段 16kHz、16 位、单声道的中文录音')
    process.exit(1)
  }
  // 脚本打包后在 tests/.output 里运行，合成的语音也放那
  const file = join(__dirname, 'live-zh16k.wav')
  execFileSync('say', [
    '-v',
    'Tingting',
    '-o',
    file,
    '--file-format=WAVE',
    '--data-format=LEI16@16000',
    SAMPLE_TEXT
  ])
  return file
}

function pcmOf(file: string): Buffer {
  const wav = readFileSync(file)
  const format = {
    channels: wav.readUInt16LE(22),
    rate: wav.readUInt32LE(24),
    bits: wav.readUInt16LE(34)
  }
  if (format.channels !== 1 || format.rate !== 16000 || format.bits !== 16) {
    throw new Error(`要 16kHz、16 位、单声道的 WAV，这个文件是 ${JSON.stringify(format)}`)
  }
  let offset = 12
  while (offset < wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') return wav.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size + (size % 2)
  }
  throw new Error('WAV 里没有 data 块')
}

type TextEvent = Extract<TranslatorEvent, { type: 'source' | 'translation' }>

/** 推一段语音，统计文字的变化方式 */
async function run(model: ModelChoice, pcm: Buffer, variant: Variant): Promise<boolean> {
  const paragraphs = new Map<string, { source?: string; translation?: string }>()
  const last = new Map<string, { text: string; stash: string }>()
  const notes: string[] = []
  let rewrites = 0
  let finalChanged = 0
  let firstShownAt = 0
  let firstConfirmedAt = 0
  let audioBytes = 0
  let errors = 0
  const startedAt = Date.now()

  const onText = (event: TextEvent): void => {
    const key = `${event.type}:${event.paragraphId}`
    const previous = last.get(key)
    if (previous && !event.final && !event.text.startsWith(previous.text)) {
      rewrites++
      notes.push(
        `  已确认的${event.type === 'source' ? '原文' : '译文'}被改写：「${previous.text}」→「${event.text}」`
      )
    }
    // 定稿去掉了尾部空格（见 translator.ts），比较时忽略
    if (previous && event.final && event.text !== (previous.text + previous.stash).trimEnd()) {
      finalChanged++
      notes.push(`  定稿和最后一版不同：「${previous.text + previous.stash}」→「${event.text}」`)
    }
    last.set(key, { text: event.text, stash: event.stash })
    if (event.type === 'translation') {
      if (!firstShownAt && (event.text || event.stash)) firstShownAt = Date.now()
      if (!firstConfirmedAt && event.text) firstConfirmedAt = Date.now()
    }
    const paragraph = paragraphs.get(event.paragraphId) ?? {}
    paragraph[event.type] = event.text + event.stash
    paragraphs.set(event.paragraphId, paragraph)
  }

  const channel = new TranslatorChannel(
    'speak',
    () => settingsFor(model, variant.speak),
    (event) => {
      if (event.type === 'status') {
        if (event.message || event.status === 'error') {
          errors++
          console.log(`  [状态] ${event.status}${event.message ? `：${event.message}` : ''}`)
        }
      } else if (event.type === 'audio') {
        audioBytes += event.pcm.byteLength
      } else if (event.type === 'source' || event.type === 'translation') {
        onText(event)
      }
    },
    endpointOverride
  )

  if (!(await channel.start())) return false
  // 16kHz × 16 位 × 100ms = 3200 字节，按实时速度推
  for (let offset = 0; offset < pcm.length; offset += 3200) {
    channel.appendAudio(new Uint8Array(pcm.subarray(offset, offset + 3200)).buffer)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (variant.speak.mode === 'hold') {
    // 和应用一样，松开后再送 0.4 秒才提交（见 engine.ts 的 RELEASE_TAIL_MS）
    for (let i = 0; i < 4; i++) {
      channel.appendAudio(new ArrayBuffer(3200))
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    channel.commitAudio()
  }
  await new Promise((resolve) => setTimeout(resolve, 3000))
  await channel.stop()

  const since = (at: number): string => (at ? `${at - startedAt} ms` : '-')
  console.log(`  首个译文（含未确认部分）：${since(firstShownAt)}`)
  console.log(`  首个已确认的译文：${since(firstConfirmedAt)}`)
  console.log(`  已确认的文字被改写：${rewrites} 次；定稿和最后一版不同：${finalChanged} 次`)
  // 24kHz × 16 位单声道
  if (settingsFor(model, variant.speak).speak.outputDeviceId !== MUTED_OUTPUT) {
    console.log(`  译音：${(audioBytes / 48000).toFixed(1)} 秒`)
  }
  for (const note of notes.slice(0, 8)) console.log(note)
  const translations = [...paragraphs.values()].map((p) => p.translation ?? '').join(' ')
  console.log(
    `  热词「提测 → hand off to QA」：${/hand off to QA/i.test(translations) ? '生效' : '没生效'}`
  )
  for (const [id, paragraph] of paragraphs) {
    console.log(
      `  段落 ${id.slice(-6)}\n    原文：${paragraph.source ?? ''}\n    译文：${paragraph.translation ?? ''}`
    )
  }
  return paragraphs.size > 0 && errors === 0
}

/** 「听」的测速：两个人轮流说，换人时只停一小会儿，像视频和会议 */
const CONVERSATION: [voice: string, text: string][] = [
  [
    'Samantha',
    'Thanks for joining. We finished the login page this week, and the API integration is almost done.'
  ],
  [
    'Daniel',
    'Great. Can you push the fix for the payment bug before Friday? The client is waiting for it.'
  ],
  ['Samantha', 'Sure. I will hand it off to QA on Thursday, so they have a full day to test.'],
  ['Daniel', "Perfect. Let's review the schedule again next Monday and plan the next release."]
]
/** 换人时的停顿，比断句的停顿阈值短 */
const TURN_GAP_MS = 300
/** 和看板一样，只留最近几段（见 Overlay.tsx 的 KEEP_PARAGRAPHS） */
const KEEP_PARAGRAPHS = 6

interface Conversation {
  pcm: Buffer
  /** 每个人开口的时间（毫秒）和他那句的第一个词；自己给的录音没有这些 */
  turns: { start: number; firstWord: string }[]
}

function conversation(): Conversation {
  if (process.env.LIVE_WAV) return { pcm: pcmOf(process.env.LIVE_WAV), turns: [] }
  if (process.platform !== 'darwin') {
    console.error('先用 LIVE_WAV 指定一段 16kHz、16 位、单声道的外语录音')
    process.exit(1)
  }
  const gap = Buffer.alloc((16000 * 2 * TURN_GAP_MS) / 1000)
  const turns: Conversation['turns'] = []
  let offset = 0
  const parts = CONVERSATION.flatMap(([voice, text], index) => {
    const file = join(__dirname, `live-en-${index}.wav`)
    execFileSync('say', [
      '-v',
      voice,
      '-o',
      file,
      '--file-format=WAVE',
      '--data-format=LEI16@16000',
      text
    ])
    const pcm = pcmOf(file)
    turns.push({ start: Math.round(offset / 32), firstWord: text.split(/\W/)[0] })
    offset += pcm.length + gap.length
    return [pcm, gap]
  })
  return { pcm: Buffer.concat(parts), turns }
}

interface Moment {
  /** 从开始推音频算起的毫秒数 */
  t: number
  event: TextEvent
}

/** 按实时速度推一遍，记下每条字幕事件到达的时间 */
async function recordListen(settings: AppSettings, pcm: Buffer): Promise<Moment[]> {
  const timeline: Moment[] = []
  let startedAt = Date.now()
  const channel = new TranslatorChannel(
    'listen',
    () => settings,
    (event) => {
      if (event.type === 'status' && (event.message || event.status === 'error')) {
        console.log(`  [状态] ${event.status}${event.message ? `：${event.message}` : ''}`)
      } else if (event.type === 'source' || event.type === 'translation') {
        timeline.push({ t: Date.now() - startedAt, event })
      }
    },
    endpointOverride
  )
  if (!(await channel.start())) return timeline
  startedAt = Date.now()
  for (let offset = 0; offset < pcm.length; offset += 3200) {
    channel.appendAudio(new Uint8Array(pcm.subarray(offset, offset + 3200)).buffer)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await new Promise((resolve) => setTimeout(resolve, 4000))
  await channel.stop()
  return timeline
}

interface ParagraphTimes {
  source?: number
  sourceFinal?: number
  /** 第一次有已确认的译文 */
  confirmed?: number
  /** 按「显示未确认」规则第一次上屏 */
  pending?: number
  /** 按「稳定优先」规则第一次上屏 */
  stable?: number
  final?: number
  updates: number
}

/** 按看板的规则回放：每来一条事件，算一遍两种显示方式下哪些段落已经上屏 */
/** 原文、确认过的译文，在某一时刻各累计了多少字 */
interface Progress {
  t: number
  source: number
  stable: number
}

/** 第一次达到最终长度的某个比例的时间 */
function reachedAt(series: Progress[], key: 'source' | 'stable', ratio: number): number {
  const target = (series.at(-1)?.[key] ?? 0) * ratio
  return series.find((point) => point[key] >= target && point[key] > 0)?.t ?? NaN
}

function analyzeListen(timeline: Moment[], turns: Conversation['turns']): void {
  let list: Paragraph[] = []
  const times = new Map<string, ParagraphTimes>()
  /** 每段的最新文字，不像看板那样只留最近几段 */
  const texts = new Map<string, { source: string; stable: string }>()
  const series: Progress[] = []
  const heard: number[] = []
  const timesOf = (key: string): ParagraphTimes => {
    const existing = times.get(key)
    if (existing) return existing
    const created: ParagraphTimes = { updates: 0 }
    times.set(key, created)
    return created
  }
  for (const { t, event } of timeline) {
    list = upsertParagraph(list, event, KEEP_PARAGRAPHS)
    const entry = timesOf(`${event.direction}:${event.paragraphId}`)
    if (event.type === 'source') {
      if (event.text || event.stash) entry.source ??= t
      if (event.final) entry.sourceFinal ??= t
    } else {
      entry.updates++
      if (event.text) entry.confirmed ??= t
      if (event.final) entry.final ??= t
    }
    for (const piece of captionOf(list, 'translation', true)) timesOf(piece.key).pending ??= t
    for (const piece of captionOf(list, 'translation', false)) timesOf(piece.key).stable ??= t

    const key = `${event.direction}:${event.paragraphId}`
    const text = texts.get(key) ?? { source: '', stable: '' }
    if (event.type === 'source') text.source = event.text + event.stash
    else text.stable = event.text
    texts.set(key, text)
    const all = [...texts.values()]
    const sum = (field: 'source' | 'stable'): number =>
      all.reduce((total, item) => total + item[field].length, 0)
    series.push({ t, source: sum('source'), stable: sum('stable') })
    const sourceText = all.map((item) => item.source).join(' ')
    turns.forEach((turn, index) => {
      if (
        heard[index] === undefined &&
        new RegExp(`\\b${turn.firstWord}\\b`, 'i').test(sourceText)
      ) {
        heard[index] = t
      }
    })
  }

  const ms = (value: number | undefined, from: number | undefined): string =>
    value === undefined || from === undefined ? '-' : `+${value - from} ms`
  const sums = { pending: 0, stable: 0, count: 0, held: 0, heldTotal: 0 }
  let index = 0
  for (const entry of times.values()) {
    if (entry.pending === undefined) continue
    index++
    const held =
      entry.stable !== undefined && entry.confirmed !== undefined
        ? entry.stable - entry.confirmed
        : 0
    console.log(
      `  第 ${index} 句（原文 ${entry.source === undefined ? '-' : `${(entry.source / 1000).toFixed(1)}s`} 出现）：` +
        `译文上屏 显示未确认 ${ms(entry.pending, entry.source)}、稳定优先 ${ms(entry.stable, entry.source)}` +
        `（被上一句压住 ${held} ms）；原文定稿后 ${ms(entry.final, entry.sourceFinal)} 译文定稿；译文更新 ${entry.updates} 次`
    )
    if (entry.source !== undefined && entry.stable !== undefined) {
      sums.pending += entry.pending - entry.source
      sums.stable += entry.stable - entry.source
      sums.count++
    }
    if (held > 0) {
      sums.held++
      sums.heldTotal += held
    }
  }
  if (sums.count === 0) {
    console.log('  没有拿到译文')
    return
  }

  console.log(
    `  每句第一个字：原文出来后，译文上屏 显示未确认 +${Math.round(sums.pending / sums.count)} ms、` +
      `稳定优先 +${Math.round(sums.stable / sums.count)} ms；` +
      `被上一句压住的 ${sums.held} 句，平均 ${sums.held ? Math.round(sums.heldTotal / sums.held) : 0} ms`
  )

  // 按进度对齐：原文写到 1/4、1/2、3/4、全部时，确认过的译文分别晚多久写到同样的比例。
  // 未确认的尾巴长度忽长忽短，对不齐，不算
  const ratios = [0.25, 0.5, 0.75, 1]
  const lag = Math.round(
    ratios.reduce(
      (total, ratio) =>
        total + reachedAt(series, 'stable', ratio) - reachedAt(series, 'source', ratio),
      0
    ) / ratios.length
  )
  console.log(`  整段：确认过的译文比原文落后 ${lag} ms（按进度对齐）`)

  const sourceLags = turns.map((turn, index) =>
    heard[index] === undefined ? undefined : heard[index] - turn.start
  )
  const seen = sourceLags.filter((value) => value !== undefined)
  if (seen.length === 0) return
  const sourceLag = Math.round(seen.reduce((total, value) => total + value, 0) / seen.length)
  const perTurn = sourceLags
    .map((value) => (value === undefined ? '没认出' : `+${value} ms`))
    .join('、')
  console.log(`  每个人开口后多久看到原文：${perTurn}（平均 ${sourceLag} ms）`)
  console.log(`  估算开口到看到确认过的译文：${sourceLag + lag} ms`)
}

async function benchListen(models: ModelChoice[]): Promise<void> {
  const { pcm, turns } = conversation()
  console.log(
    `「听」的测速：英文对话 ${(pcm.length / 32000).toFixed(1)} 秒，换人停顿 ${TURN_GAP_MS} ms`
  )
  for (const model of models) {
    const variants = model.protocol === 'qwen3.8' ? [true, false] : [false]
    for (const speakers of variants) {
      const base = settingsFor(model)
      const settings = { ...base, listen: { ...base.listen, speakers } }
      const name = model.protocol === 'qwen3.8' ? (speakers ? '，按说话人断句' : '，普通断句') : ''
      console.log(`\n===== ${model.id}${name}（停顿 ${settings.listen.silenceMs} ms 算一句）=====`)
      analyzeListen(await recordListen(settings, pcm), turns)
    }
  }
}

async function main(): Promise<void> {
  const models = process.env.LIVE_MODEL ? [guessModel(process.env.LIVE_MODEL)] : MODEL_PRESETS
  const mode = process.env.LIVE_MODE ?? 'speak'
  if (mode === 'listen') {
    await benchListen(models)
    return
  }
  const probing = mode === 'probe'
  const pcm = probing ? Buffer.alloc(0) : pcmOf(speechFile())
  let ok = true
  for (const model of models) {
    console.log(`\n===== ${model.id}（${model.protocol} 协议）=====`)
    if (probing) {
      console.log('只握手的探测：')
      for (const direction of ['listen', 'speak'] as const) {
        const session = buildSessionConfig(direction, settingsFor(model))
        await probe(
          model,
          `应用实际发的配置（${direction === 'listen' ? '听' : '说'}）`,
          session,
          true
        )
      }
      if (model.protocol === 'qwen3.8') {
        for (const [name, session] of PROBES_38) await probe(model, name, session)
      }
      continue
    }
    for (const variant of model.protocol === 'qwen3.8' ? VARIANTS_38 : [AUTO]) {
      console.log(`推语音（${variant.name}）：`)
      ok = (await run(model, pcm, variant)) && ok
    }
  }
  process.exitCode = ok ? 0 : 1
}

void main()
