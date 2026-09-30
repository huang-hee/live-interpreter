import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEndpoint,
  buildSessionConfig,
  parseGlossary,
  TranslatorChannel
} from '../src/main/translator'
import { EventBatcher } from '../src/main/event-batcher'
import { upsertParagraph, type Paragraph } from '../src/shared/paragraphs'
import type { AppSettings, Direction, TranslatorEvent } from '../src/shared/types'

/** 测试里关心的 session.update 字段 */
interface ConfigView {
  modalities?: string[]
  voice?: string
  enable_voice_clone?: boolean
  voice_clone_options?: { frequency: string }
  turn_detection?: { type: string; threshold: number; silence_duration_ms: number } | null
  input_audio_transcription?: { model: string; language?: string }
  translation?: {
    language: string
    same_language_skip_options?: { skip_text: boolean; skip_audio: boolean }
    corpus?: { phrases: Record<string, string> }
  }
}

const config = (direction: Direction, settings: AppSettings): ConfigView =>
  buildSessionConfig(direction, settings) as ConfigView

type TextEvent = Extract<TranslatorEvent, { type: 'source' | 'translation' }>
type AudioEvent = Extract<TranslatorEvent, { type: 'audio' }>

const base: AppSettings = {
  apiKey: 'k',
  workspaceId: '',
  region: 'cn-beijing',
  model: 'qwen3.5-livetranslate-flash-realtime',
  myLanguage: 'zh',
  peerLanguage: 'en',
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
    glossary: ''
  },
  overlay: {
    fontSize: 28,
    textColor: '#fff',
    backgroundColor: '#000',
    textOpacity: 1,
    backgroundOpacity: 0.5,
    showSource: true,
    showTranslation: true,
    lines: 2,
    showSpeak: false,
    bounds: null
  },
  records: { bounds: null, alwaysOnTop: false }
}
const withSpeak = (
  patch: Partial<AppSettings['speak']>,
  top: Partial<AppSettings> = {}
): AppSettings => ({ ...base, ...top, speak: { ...base.speak, ...patch } })

test('parseGlossary 跳过注释和无效行，值里可以带等号', () => {
  assert.deepEqual(
    parseGlossary(
      '# c\n提测 = hand off to QA\n\n  联调=integration testing  \n= bad\nno-eq\na = b = c'
    ),
    {
      提测: 'hand off to QA',
      联调: 'integration testing',
      a: 'b = c'
    }
  )
})

test('buildEndpoint：有业务空间走专属域名，没有走通用域名', () => {
  assert.equal(
    buildEndpoint(base),
    'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-livetranslate-flash-realtime'
  )
  assert.equal(
    buildEndpoint({ ...base, workspaceId: ' ws1 ', region: 'ap-southeast-1' }),
    'wss://ws1.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-livetranslate-flash-realtime'
  )
})

test('收听：默认只要文字，目标中文带同语种跳过，术语表进 corpus', () => {
  const c = config('listen', {
    ...base,
    listen: { ...base.listen, glossary: 'deploy = 上线' }
  })
  assert.deepEqual(c.modalities, ['text'])
  assert.equal(c.input_audio_transcription?.language, undefined)
  assert.deepEqual(c.translation, {
    language: 'zh',
    same_language_skip_options: { skip_text: true, skip_audio: true },
    corpus: { phrases: { deploy: '上线' } }
  })
  const aloud = config('listen', {
    ...base,
    listen: { ...base.listen, readAloud: true }
  })
  assert.deepEqual(aloud.modalities, ['text', 'audio'])
  const yue = config('listen', {
    ...base,
    myLanguage: 'yue',
    listen: { ...base.listen, readAloud: true }
  })
  assert.deepEqual(yue.modalities, ['text'], '粤语只能出文字')
  assert.equal(yue.translation?.same_language_skip_options, undefined)
})

test('说：自动断句、按住说话、静音、三种音色、只出文字的语种', () => {
  const auto = config('speak', base)
  assert.deepEqual(auto.turn_detection, {
    type: 'server_vad',
    threshold: 0.2,
    silence_duration_ms: 800
  })
  assert.deepEqual(auto.modalities, ['text', 'audio'])
  assert.equal(auto.input_audio_transcription?.language, 'zh')
  assert.equal(auto.voice, undefined)
  assert.equal(config('speak', withSpeak({ mode: 'hold' })).turn_detection, null)
  const muted = config('speak', withSpeak({ outputDeviceId: 'none', voiceMode: 'live' }))
  assert.deepEqual(muted.modalities, ['text'])
  assert.equal(muted.enable_voice_clone, undefined, '不出声时不复刻')
  const live = config('speak', withSpeak({ voiceMode: 'live' }))
  assert.equal(live.voice, 'default')
  assert.deepEqual(live.voice_clone_options, { frequency: 'once' })
  const cloned = { id: 'qwen-translate-vc-me', model: base.model, createdAt: 0 }
  const fixed = config('speak', withSpeak({ voiceMode: 'fixed', clonedVoice: cloned }))
  assert.equal(fixed.voice, 'qwen-translate-vc-me')
  assert.deepEqual(fixed.voice_clone_options, { frequency: 'never' }, '固定音色不在服务端复刻')
  const otherModel = { ...cloned, model: 'qwen3-livetranslate-flash-realtime' }
  const mismatch = config('speak', withSpeak({ voiceMode: 'fixed', clonedVoice: otherModel }))
  assert.equal(mismatch.voice, 'default', '复刻时的模型对不上就退回边说边复刻')
  const noVoice = config('speak', withSpeak({ voiceMode: 'fixed' }))
  assert.deepEqual(
    noVoice.voice_clone_options,
    { frequency: 'once' },
    '还没录固定音色也退回边说边复刻'
  )
  const greek = config('speak', withSpeak({ voiceMode: 'live' }, { peerLanguage: 'el' }))
  assert.deepEqual(greek.modalities, ['text'])
  assert.equal(greek.enable_voice_clone, undefined)
  assert.deepEqual(config('speak', withSpeak({}, { peerLanguage: 'ja' })).translation, {
    language: 'ja'
  })
})

test('EventBatcher：同一段只留最新一版，音频直发，状态不合并', async () => {
  const batches: TranslatorEvent[][] = []
  const b = new EventBatcher((e) => batches.push(e), 20)
  const t = (text: string, final = false): TranslatorEvent => ({
    direction: 'listen',
    type: 'translation',
    paragraphId: 'p1',
    text,
    stash: '',
    final
  })
  b.push({ direction: 'listen', type: 'status', status: 'connecting', session: 1 })
  b.push(t('Hel'))
  b.push({ direction: 'listen', type: 'audio', pcm: new Uint8Array(4) })
  b.push(t('Hello'))
  b.push({ direction: 'listen', type: 'status', status: 'live', session: 1 })
  b.push(t('Hello!', true))
  assert.equal(batches.length, 1, '音频立即发出')
  assert.equal(batches[0][0].type, 'audio')
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(batches.length, 2)
  const batch = batches[1]
  assert.equal(batch.length, 3)
  assert.deepEqual(
    batch.map((e) => (e.type === 'status' ? e.status : e.type === 'translation' ? e.text : '')),
    ['connecting', 'Hello!', 'live']
  )
})

test('upsertParagraph：同段更新只替换那一段，没变返回原数组，超量裁掉最旧的', () => {
  const ev = (
    type: 'source' | 'translation',
    id: string,
    text: string,
    final = false
  ): TextEvent => ({
    direction: 'speak',
    type,
    paragraphId: id,
    text,
    stash: '',
    final
  })
  let list: Paragraph[] = []
  list = upsertParagraph(list, ev('source', 'a', '你好'), 3)
  const first = list[0]
  list = upsertParagraph(list, ev('source', 'b', '今天'), 3)
  const same = upsertParagraph(list, ev('source', 'b', '今天'), 3)
  assert.equal(same, list, '内容没变返回原数组')
  list = upsertParagraph(list, ev('translation', 'a', 'Hello'), 3)
  assert.notEqual(list[0], first)
  assert.equal(list[0].source?.text, '你好')
  assert.equal(list[0].translation?.text, 'Hello')
  assert.equal(list[1].key, 'speak:b')
  assert.equal(upsertParagraph(list, ev('source', 'c', ''), 3), list, '空内容不建段')
  list = upsertParagraph(list, ev('translation', 'c', 'x'), 3)
  list = upsertParagraph(list, ev('translation', 'd', 'y'), 3)
  assert.deepEqual(
    list.map((p) => p.key),
    ['speak:b', 'speak:c', 'speak:d']
  )
})

test('TranslatorChannel：译文通过 previous_item_id 归到原文段落，没关联时自成一段', () => {
  const events: TranslatorEvent[] = []
  // handleServerEvent 是私有方法，测试里直接喂服务端事件
  const ch = new TranslatorChannel(
    'listen',
    () => base,
    (e) => events.push(e)
  ) as unknown as { handleServerEvent: (event: Record<string, unknown>) => void }
  ch.handleServerEvent({
    type: 'conversation.item.input_audio_transcription.text',
    item_id: 'asr1',
    text: '',
    stash: 'Hi there'
  })
  ch.handleServerEvent({
    type: 'conversation.item.created',
    previous_item_id: 'asr1',
    item: { id: 'tr1', role: 'assistant' }
  })
  ch.handleServerEvent({
    type: 'conversation.item.created',
    previous_item_id: 'x',
    item: { id: 'u1', role: 'user' }
  })
  ch.handleServerEvent({ type: 'response.text.text', item_id: 'tr1', text: '你好', stash: '啊' })
  ch.handleServerEvent({ type: 'response.text.done', item_id: 'tr1', text: '你好。' })
  ch.handleServerEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'asr1',
    transcript: 'Hi there.'
  })
  ch.handleServerEvent({
    type: 'response.audio_transcript.done',
    item_id: 'orphan',
    transcript: 'x'
  })
  ch.handleServerEvent({
    type: 'response.audio.delta',
    item_id: 'tr1',
    delta: Buffer.from([1, 2, 3, 4]).toString('base64')
  })
  const text = events.filter((e): e is TextEvent => e.type === 'source' || e.type === 'translation')
  assert.deepEqual(
    text.map((e) => [e.type, e.paragraphId, e.text, e.stash, e.final]),
    [
      ['source', 'asr1', '', 'Hi there', false],
      ['translation', 'asr1', '你好', '啊', false],
      ['translation', 'asr1', '你好。', '', true],
      ['source', 'asr1', 'Hi there.', '', true],
      ['translation', 'orphan', 'x', '', true]
    ]
  )
  const audio = events.find((e): e is AudioEvent => e.type === 'audio')
  assert.deepEqual([...(audio?.pcm ?? [])], [1, 2, 3, 4])
})
