// 真实百炼联调：用自己的 Key 把一段中文语音按实时速度推过去，打印段落化的原文和译文。
// 运行：DASHSCOPE_API_KEY=sk-xxx npm run test:live
// 可选：DASHSCOPE_REGION=ap-southeast-1、DASHSCOPE_WORKSPACE_ID=xxx、PEER_LANGUAGE=ja
// 语音：LIVE_WAV=自己的录音.wav（16kHz、16 位、单声道）；不指定时在 macOS 上用 say 现场合成一段
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { TranslatorChannel } from '../src/main/translator'
import type { AppSettings, Region, TranslatorEvent } from '../src/shared/types'

const apiKey = process.env.DASHSCOPE_API_KEY
if (!apiKey) {
  console.error('先设置环境变量 DASHSCOPE_API_KEY')
  process.exit(1)
}

const SAMPLE_TEXT = '好的，登录页这周四提测。你能在周五前把修复推上去吗？我们下周一再对一下排期。'

const settings: AppSettings = {
  apiKey,
  workspaceId: process.env.DASHSCOPE_WORKSPACE_ID ?? '',
  region: (process.env.DASHSCOPE_REGION as Region) ?? 'cn-beijing',
  model: 'qwen3.5-livetranslate-flash-realtime',
  myLanguage: 'zh',
  peerLanguage: process.env.PEER_LANGUAGE ?? 'en',
  pauseListenWhileSpeaking: true,
  theme: 'system',
  listen: { source: 'system', readAloud: false, outputDeviceId: '', glossary: '' },
  speak: {
    inputDeviceId: '',
    outputDeviceId: '',
    monitor: false,
    mode: 'auto',
    silenceMs: 800,
    voiceMode: 'off',
    clonedVoice: null,
    glossary: '提测 = hand off to QA'
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

async function main(): Promise<void> {
  const paragraphs = new Map<string, { source?: string; translation?: string }>()
  let audioBytes = 0
  const startedAt = Date.now()
  let firstTranslationAt = 0

  const channel = new TranslatorChannel(
    'speak',
    () => settings,
    (event: TranslatorEvent) => {
      if (event.type === 'status') {
        console.log(`[状态] ${event.status}${event.message ? `：${event.message}` : ''}`)
      } else if (event.type === 'audio') {
        audioBytes += event.pcm.byteLength
      } else if (event.type === 'source' || event.type === 'translation') {
        if (event.type === 'translation' && !firstTranslationAt) firstTranslationAt = Date.now()
        const paragraph = paragraphs.get(event.paragraphId) ?? {}
        paragraph[event.type] = event.text + event.stash
        paragraphs.set(event.paragraphId, paragraph)
      }
    }
  )

  if (!(await channel.start())) process.exit(1)
  const pcm = pcmOf(speechFile())
  // 16kHz × 16 位 × 100ms = 3200 字节，按实时速度推
  for (let offset = 0; offset < pcm.length; offset += 3200) {
    const chunk = pcm.subarray(offset, offset + 3200)
    channel.appendAudio(new Uint8Array(chunk).buffer)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await new Promise((resolve) => setTimeout(resolve, 3000))
  await channel.stop()

  console.log(
    `\n首个译文延迟 ${firstTranslationAt ? firstTranslationAt - startedAt : '-'} ms（从开始推音频算）`
  )
  console.log(`译音 ${(audioBytes / 48000).toFixed(1)} 秒`)
  for (const [id, paragraph] of paragraphs) {
    console.log(
      `\n段落 ${id.slice(-6)}\n  原文：${paragraph.source ?? ''}\n  译文：${paragraph.translation ?? ''}`
    )
  }
  process.exitCode = [...paragraphs.values()].some((p) => p.translation) ? 0 : 1
}

void main()
