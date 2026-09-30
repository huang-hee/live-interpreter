import type { Paragraph } from '@shared/paragraphs'

/** 稳定优先时，前一段没定稿会先压住后面的段落；压了这么多段还没定稿，就当它卡住了，不再等 */
const MAX_HELD = 2

/** 一段字幕：已确认的文字，加上还可能被改写的尾巴 */
export interface CaptionPiece {
  key: string
  text: string
  stash: string
}

export type Caption = CaptionPiece[]

/**
 * 滚动字幕：把最近几段接成一条连续的文字，界面上只露出最后几行。
 * 直播节目的实时字幕就是这样滚动的，新字从下面补上，旧行从上面滚走。
 *
 * pending 为 false 是稳定优先：只显示已确认的文字；前一段还在译时，后面的段落先不显示，
 * 这样字只会往后追加，不会被改写，也不会插到已经显示的文字中间。
 * pending 为 true 时每段都带上自己的尾巴，出字更快，但尾巴会变。
 */
export function captionOf(
  paragraphs: Paragraph[],
  field: 'source' | 'translation',
  pending: boolean
): Caption {
  const parts = paragraphs.flatMap((paragraph) => {
    const part = paragraph[field]
    return part ? [{ key: paragraph.key, part }] : []
  })
  const caption: Caption = []
  for (const [index, { key, part }] of parts.entries()) {
    caption.push({ key, text: part.text, stash: pending && !part.final ? part.stash : '' })
    if (!pending && !part.final && parts.length - 1 - index <= MAX_HELD) break
  }
  return caption.filter((piece) => piece.text || piece.stash)
}
