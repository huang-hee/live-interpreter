import type { Direction, TranslatorEvent } from './types'

export interface TextPart {
  /** 已确认的累计文本 */
  text: string
  /** 还可能被改写的尾巴 */
  stash: string
  final: boolean
}

/** 一段语音对应一个段落：上面原文，下面译文 */
export interface Paragraph {
  key: string
  direction: Direction
  source: TextPart | null
  translation: TextPart | null
}

type TextEvent = Extract<TranslatorEvent, { type: 'source' | 'translation' }>

/** 流式更新几乎都落在最后几段，只往回找这么远 */
const LOOKBACK = 24

function samePart(a: TextPart | null, b: TextPart): boolean {
  return a !== null && a.text === b.text && a.stash === b.stash && a.final === b.final
}

/**
 * 把一条字幕事件合进段落列表。
 * 内容没变时返回原数组；变了只替换那一段，其余段落保持原引用，memo 过的行不会重渲染。
 */
export function upsertParagraph(list: Paragraph[], event: TextEvent, max: number): Paragraph[] {
  const key = `${event.direction}:${event.paragraphId}`
  const part: TextPart = { text: event.text, stash: event.stash, final: event.final }
  const field = event.type

  const stop = Math.max(0, list.length - LOOKBACK)
  for (let i = list.length - 1; i >= stop; i--) {
    if (list[i].key !== key) continue
    if (samePart(list[i][field], part)) return list
    const copy = list.slice()
    copy[i] = { ...list[i], [field]: part }
    return copy
  }

  if (!part.text && !part.stash) return list
  const paragraph: Paragraph = {
    key,
    direction: event.direction,
    source: null,
    translation: null,
    [field]: part
  }
  const appended = [...list, paragraph]
  return appended.length > max ? appended.slice(-max) : appended
}
