import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { findLanguage } from '@shared/languages'
import { upsertParagraph, type Paragraph } from '@shared/paragraphs'
import type { ChannelState, Direction, Records as RecordLists } from '@shared/types'
import { PartText } from '../components/PartText'
import { useAppState } from '../hooks/useAppState'
import { useSettings } from '../hooks/useSettings'
import { panelVars } from '../panel/color'
import { startWindowMove, startWindowResize } from '../panel/drag'
import '../panel/panel.css'
import './records.css'

/** 和主进程保持一致：每个方向最多留这么多段 */
const MAX_RECORDS = 500
/** 离底部这么近就算「在看最新」，新内容进来时自动滚到底 */
const STICK_THRESHOLD_PX = 48

const RecordItem = memo(function RecordItem({ paragraph }: { paragraph: Paragraph }) {
  const { source, translation } = paragraph
  const live = !(source?.final ?? true) || !(translation?.final ?? true)
  return (
    <div className="record" data-live={live}>
      {source && (
        <p className="record-source">
          <PartText part={source} />
        </p>
      )}
      {translation && (
        <p className="record-translation">
          <PartText part={translation} />
        </p>
      )}
    </div>
  )
})

interface ColumnProps {
  direction: Direction
  title: string
  route: string
  channel: ChannelState
  paragraphs: Paragraph[]
  empty: string
}

function RecordColumn({
  direction,
  title,
  route,
  channel,
  paragraphs,
  empty
}: ColumnProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  useLayoutEffect(() => {
    const element = ref.current
    if (element && stickRef.current) element.scrollTop = element.scrollHeight
  }, [paragraphs])

  const handleScroll = (): void => {
    const element = ref.current
    if (!element) return
    stickRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD_PX
  }

  return (
    <section className="record-column" data-direction={direction} data-status={channel.status}>
      <h2>
        <span className="record-dot" aria-hidden="true" />
        {title}
        <small>{route}</small>
        <span className="record-count">{paragraphs.length} 段</span>
      </h2>
      <div className="record-scroll" ref={ref} onScroll={handleScroll} role="log">
        {paragraphs.length === 0 ? (
          <p className="record-empty">{empty}</p>
        ) : (
          paragraphs.map((paragraph) => <RecordItem key={paragraph.key} paragraph={paragraph} />)
        )}
      </div>
    </section>
  )
}

export function Records(): React.JSX.Element {
  const [settings] = useSettings()
  const state = useAppState()
  const [records, setRecords] = useState<RecordLists>({ listen: [], speak: [] })

  useEffect(() => {
    let active = true
    void window.api.getRecords().then((loaded) => {
      if (active) setRecords(loaded)
    })
    const offEvents = window.api.onTranslatorEvents((events) => {
      setRecords((current) =>
        events.reduce((acc, event) => {
          if (event.type !== 'source' && event.type !== 'translation') return acc
          const list = upsertParagraph(acc[event.direction], event, MAX_RECORDS)
          return list === acc[event.direction] ? acc : { ...acc, [event.direction]: list }
        }, current)
      )
    })
    const offCleared = window.api.onRecordsCleared(() => setRecords({ listen: [], speak: [] }))
    return () => {
      active = false
      offEvents()
      offCleared()
    }
  }, [])

  if (!settings) return <div className="panel records" />

  const myName = findLanguage(settings.myLanguage)?.name ?? settings.myLanguage
  const peerName = findLanguage(settings.peerLanguage)?.name ?? settings.peerLanguage
  const pinned = settings.records.alwaysOnTop

  return (
    <div className="panel records" style={panelVars(settings.overlay)}>
      <header className="records-head" onPointerDown={(event) => startWindowMove(event)}>
        <h1>翻译记录</h1>
        <span className="records-spacer" />
        <button
          type="button"
          className="chip"
          aria-pressed={pinned}
          title="让记录窗口保持在其他窗口上面"
          onClick={() => window.api.setAlwaysOnTop(!pinned)}
        >
          置顶
        </button>
        <button type="button" className="chip" onClick={() => window.api.clearRecords()}>
          清空
        </button>
        <button
          type="button"
          className="chip close"
          aria-label="关闭记录"
          onClick={() => window.api.closeWindow()}
        >
          ×
        </button>
      </header>
      <div className="records-body">
        <RecordColumn
          direction="listen"
          title="听"
          route={`${peerName} → ${myName}`}
          channel={state.channels.listen}
          paragraphs={records.listen}
          empty="开始收听后，对方说的话和译文会按段落记在这里。"
        />
        <RecordColumn
          direction="speak"
          title="说"
          route={`${myName} → ${peerName}`}
          channel={state.channels.speak}
          paragraphs={records.speak}
          empty="开始说话后，你说的话和译文会按段落记在这里。"
        />
      </div>
      <div
        className="panel-resize panel-resize-visible"
        aria-hidden="true"
        onPointerDown={(event) => startWindowResize(event)}
      />
    </div>
  )
}
