/**
 * 同传模型和对接协议。百炼的 livetranslate 实时模型有两套协议：
 * - qwen3.5：session.update 用 modalities / turn_detection；文本事件推「已确认全文 text + 待确认尾巴 stash」，尾巴会被改写
 * - qwen3.8：session.update 用 output_modalities / audio.input.turn_detection；文本事件推增量 delta，只追加不改写
 * 见百炼文档「实时音视频翻译」客户端事件 / 服务端事件
 */
export type ModelProtocol = 'qwen3.5' | 'qwen3.8'

export interface ModelChoice {
  /** 模型 ID，拼在 WebSocket 地址的 model 参数里 */
  id: string
  /** 按哪套协议对接：预设模型固定，自定义模型由用户选 */
  protocol: ModelProtocol
}

export interface ModelFeatures {
  /** 热词 translation.corpus.phrases */
  glossary: boolean
  /** 源语种和目标语种相同时跳过输出 */
  sameLanguageSkip: boolean
  /** 边说边复刻 */
  liveClone: boolean
  /** 提前录好的固定音色：复刻接口的 target_model 要认这个模型 */
  fixedVoice: boolean
  /** turn_detection 设为 null，由客户端提交断句；按住说话要用 */
  manualTurn: boolean
  /** 断句停顿时长、灵敏度可调 */
  vadTuning: boolean
  /** 按说话人断句（speaker_detection） */
  speakers: boolean
}

/**
 * 3.8 的能力文档写得不全，以 npm run test:live 对真实服务的探测为准；
 * 没探测过的（固定音色）先按不支持处理
 */
const FEATURES: Record<ModelProtocol, ModelFeatures> = {
  'qwen3.5': {
    glossary: true,
    sameLanguageSkip: true,
    liveClone: true,
    fixedVoice: true,
    manualTurn: true,
    vadTuning: true,
    speakers: false
  },
  'qwen3.8': {
    glossary: true,
    sameLanguageSkip: false,
    liveClone: true,
    fixedVoice: false,
    manualTurn: true,
    vadTuning: true,
    speakers: true
  }
}

export function featuresOf(model: ModelChoice): ModelFeatures {
  return FEATURES[model.protocol]
}

export interface ModelPreset extends ModelChoice {
  name: string
  note: string
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'qwen3.8-livetranslate-flash-realtime',
    protocol: 'qwen3.8',
    name: 'Qwen3.8 同传',
    note: '百炼同传首推，出字快。译文只往后追加，出现了就不改；可以按说话人断句。不支持固定音色'
  },
  {
    id: 'qwen3.5-livetranslate-flash-realtime',
    protocol: 'qwen3.5',
    name: 'Qwen3.5 同传',
    note: '支持固定音色，第一句就是你的声音。未确认的译文会被改写'
  }
]

export const PROTOCOL_NAMES: Record<ModelProtocol, string> = {
  'qwen3.5': '按 Qwen3.5 的协议',
  'qwen3.8': '按 Qwen3.8 的协议'
}

export const DEFAULT_LISTEN_MODEL: ModelChoice = { id: MODEL_PRESETS[0].id, protocol: 'qwen3.8' }
export const DEFAULT_SPEAK_MODEL: ModelChoice = { id: MODEL_PRESETS[1].id, protocol: 'qwen3.5' }

export function findPreset(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((preset) => preset.id === id)
}

/** 旧配置只存了模型 ID：认得的用预设协议，不认得的按 3.5 */
export function guessModel(id: string): ModelChoice {
  return { id, protocol: findPreset(id)?.protocol ?? 'qwen3.5' }
}
