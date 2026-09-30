import type { TextPart } from '@shared/paragraphs'

/** 已确认的文字正常显示，还可能被改写的尾巴（stash）淡一些 */
export function PartText({ part }: { part: TextPart }): React.JSX.Element {
  return (
    <>
      {part.text}
      {part.stash && <span className="stash">{part.stash}</span>}
    </>
  )
}
