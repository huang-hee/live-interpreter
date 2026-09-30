// 真实百炼联调：用自己的 Key 逐个模型跑一遍，回答文档里没写清的几件事。
//   默认：按实时速度推一段中文语音，看已确认的译文会不会被改写、定稿和最后一版是否一致、出字延迟、热词；
//         Qwen3.8 另外跑按住说话（推完再提交）和边说边复刻（要出译音）
//   LIVE_PROBE=1：只握手不推音频，逐项看 Qwen3.8 收不收文档没写明的参数。
//         每项一次连接，百炼限流每分钟 10 次，所以和推语音分开跑
// 运行：DASHSCOPE_API_KEY=sk-xxx npm run test:live
// 可选：LIVE_MODEL=模型 ID（只测这一个）、DASHSCOPE_REGION=ap-southeast-1、DASHSCOPE_WORKSPACE_ID=xxx
// 语音：LIVE_WAV=自己的录音.wav（16kHz、16 位、单声道）；不指定时在 macOS 上用 say 现场合成一段
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import WebSocket from 'ws'
import { buildEndpoint, buildSessionConfig, TranslatorChannel } from '../src/main/translator'
import { guessModel, MODEL_PRESETS, type ModelChoice } from '../src/shared/models'
import type { AppSettings, Region, TranslatorEvent } from '../src/shared/types'

const apiKey = process.env.DASHSCOPE_API_KEY
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
    const socket = new WebSocket(buildEndpoint(settings, model.id), {
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
    }
  )

  if (!(await channel.start())) return false
  // 16kHz × 16 位 × 100ms = 3200 字节，按实时速度推
  for (let offset = 0; offset < pcm.length; offset += 3200) {
    channel.appendAudio(new Uint8Array(pcm.subarray(offset, offset + 3200)).buffer)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (variant.speak.mode === 'hold') channel.commitAudio()
  await new Promise((resolve) => setTimeout(resolve, 3000))
  await channel.stop()

  const since = (at: number): string => (at ? `${at - startedAt} ms` : '-')
  console.log(`  首个译文（含未确认部分）：${since(firstShownAt)}`)
  console.log(`  首个已确认的译文：${since(firstConfirmedAt)}`)
  console.log(`  已确认的文字被改写：${rewrites} 次；定稿和最后一版不同：${finalChanged} 次`)
  // 24kHz × 16 位单声道
  if (variant.speak.outputDeviceId !== 'none') {
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

async function main(): Promise<void> {
  const models = process.env.LIVE_MODEL ? [guessModel(process.env.LIVE_MODEL)] : MODEL_PRESETS
  const probing = process.env.LIVE_PROBE === '1'
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
