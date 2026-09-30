import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
import { MY_LANGUAGES, PEER_LANGUAGE_GROUPS } from '@shared/languages'
import { upsertParagraph, type Paragraph } from '@shared/paragraphs'
import type {
  AppState,
  ChannelStatus,
  Direction,
  PublicSettings,
  SettingsPatch,
  TranslatorEvent
} from '@shared/types'
import { StyleControls, type ColorTarget } from '../components/StyleControls'
import { useAppState } from '../hooks/useAppState'
import { useOverlayStyle } from '../hooks/useOverlayStyle'
import { useSettings } from '../hooks/useSettings'
import { panelVars } from '../panel/color'
import { isInteractive, startWindowMove, startWindowResize } from '../panel/drag'
import '../panel/panel.css'
import { captionOf, type Caption } from './caption'
import './overlay.css'

/** 滚动字幕只需要最近几段拼起来的尾巴 */
const KEEP_PARAGRAPHS = 6
const MIN_LINES = 1
const MAX_LINES = 4
/** 鼠标划过时不急着弹工具栏，避免看视频时误触 */
const TOOLBAR_SHOW_DELAY_MS = 80
/** 鼠标离开后工具栏再停留一会儿，从字幕移到按钮时不会闪 */
const TOOLBAR_HIDE_DELAY_MS = 600
/** 这些语言词与词之间不加空格 */
const NO_SPACE_LANGUAGES = new Set(['zh', 'yue', 'ja'])

const running = (status: ChannelStatus): boolean => status !== 'idle' && status !== 'error'

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

type TextEvent = Extract<TranslatorEvent, { type: 'source' | 'translation' }>

/** 固定高度的字幕行：没字时也占着位置，窗口高度不会跟着文字跳 */
function CaptionLines({
  caption,
  language,
  lines,
  kind,
  placeholder
}: {
  caption: Caption
  language: string
  lines: number
  kind: 'source' | 'translation' | 'speak-source' | 'speak-translation'
  placeholder?: ReactNode
}): React.JSX.Element {
  const joiner = NO_SPACE_LANGUAGES.has(language) ? '' : ' '
  return (
    <div className="caption" data-kind={kind} style={{ '--lines': lines } as CSSProperties}>
      {caption.length === 0 ? (
        placeholder && <p className="caption-hint">{placeholder}</p>
      ) : (
        <p className="caption-text">
          {caption.map((piece, index) => (
            <Fragment key={piece.key}>
              {index > 0 && joiner}
              {piece.text}
              {piece.stash && <span className="stash">{piece.stash}</span>}
            </Fragment>
          ))}
        </p>
      )}
    </div>
  )
}

interface ViewProps {
  settings: PublicSettings
  save: (patch: SettingsPatch) => Promise<void>
  state: AppState
}

function hintOf(state: AppState): string {
  const failed = (['listen', 'speak'] as Direction[])
    .map((direction) => state.channels[direction])
    .find((channel) => channel.error || channel.status === 'error')
  if (failed) return failed.error || failed.message
  if (running(state.channels.listen.status)) return '正在收听，等对方开口…'
  return '鼠标移到这里，点「收听」开始'
}

function OverlayView({ settings, save, state }: ViewProps): React.JSX.Element {
  const ids = { mine: useId(), peer: useId() }
  const [style, updateStyle] = useOverlayStyle(settings, save)
  const [heard, setHeard] = useState<Paragraph[]>([])
  const [spoken, setSpoken] = useState<Paragraph[]>([])
  const [toolbar, setToolbar] = useState(false)
  const [picking, setPicking] = useState<ColorTarget | null>(null)
  const toolbarTimer = useRef<number | undefined>(undefined)
  /** 拖动中或焦点在工具栏里时，鼠标离开也不收起 */
  const pinnedRef = useRef(false)
  const hoverRef = useRef(false)
  const contentRef = useRef<HTMLDivElement>(null)

  const { listen, speak } = state.channels
  const hasKey = settings.hasApiKey
  const holdMode = settings.speak.mode === 'hold'
  const speakLive = speak.status === 'live'
  const onAir = state.holding || (speakLive && speak.speaking)

  useEffect(
    () =>
      window.api.onTranslatorEvents((events) => {
        const text = events.filter(
          (event): event is TextEvent => event.type === 'source' || event.type === 'translation'
        )
        if (text.length === 0) return
        const merge =
          (direction: Direction) =>
          (list: Paragraph[]): Paragraph[] =>
            text.reduce(
              (acc, event) =>
                event.direction === direction ? upsertParagraph(acc, event, KEEP_PARAGRAPHS) : acc,
              list
            )
        setHeard(merge('listen'))
        setSpoken(merge('speak'))
      }),
    []
  )

  useEffect(() => () => window.clearTimeout(toolbarTimer.current), [])

  // 窗口高度跟着内容走：改行数、字号、开关字幕条时自动变高变矮
  useEffect(() => {
    const element = contentRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      window.api.fitWindowHeight(Math.ceil(element.getBoundingClientRect().height))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // 焦点在看板上时，按住空格说话
  useEffect(() => {
    if (!holdMode || !speakLive) return
    const down = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat || isTypingTarget(event.target)) return
      event.preventDefault()
      window.api.sendCommand({ type: 'hold-begin' })
    }
    const up = (event: KeyboardEvent): void => {
      if (event.code !== 'Space') return
      event.preventDefault()
      window.api.sendCommand({ type: 'hold-end' })
    }
    const blur = (): void => window.api.sendCommand({ type: 'hold-end' })
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [holdMode, speakLive])

  const scheduleToolbar = (visible: boolean): void => {
    window.clearTimeout(toolbarTimer.current)
    if (!visible && pinnedRef.current) return
    toolbarTimer.current = window.setTimeout(
      () => {
        setToolbar(visible)
        // 取色器跟着工具栏收起，窗口高度随之缩回去
        if (!visible) setPicking(null)
      },
      visible ? TOOLBAR_SHOW_DELAY_MS : TOOLBAR_HIDE_DELAY_MS
    )
  }

  const pinToolbar = (pinned: boolean): void => {
    pinnedRef.current = pinned
    if (pinned) {
      window.clearTimeout(toolbarTimer.current)
      setToolbar(true)
    } else if (!hoverRef.current) {
      // 松开时鼠标已经不在看板上（比如切到了别的应用），照常收起
      scheduleToolbar(false)
    }
  }

  const toggleChannel = (direction: Direction): void => {
    const status = state.channels[direction].status
    window.api.sendCommand({ type: running(status) ? 'stop' : 'start', direction })
  }

  const blocked = hasKey ? undefined : '先在设置里填好 API Key'
  const pending = settings.listen.showPending
  const heardSource = hasKey ? captionOf(heard, 'source', pending) : []
  const heardTranslation = hasKey ? captionOf(heard, 'translation', pending) : []
  // 自己说的一句一换：只看最新一句，不往前拼；尾巴照常显示，说完马上能看到
  const lastSpoken = spoken.slice(-1)
  const languageTitle = '切换后，正在进行的通道会自动重连'

  return (
    <div
      className="panel overlay"
      style={panelVars(style)}
      data-toolbar={toolbar}
      data-thin-bg={style.backgroundOpacity < 0.4}
      onPointerEnter={() => {
        hoverRef.current = true
        scheduleToolbar(true)
      }}
      onPointerLeave={() => {
        hoverRef.current = false
        scheduleToolbar(false)
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || isInteractive(event.target)) return
        pinToolbar(true)
        startWindowMove(event, () => pinToolbar(false))
      }}
    >
      <div className="overlay-content" ref={contentRef}>
        <div
          className="overlay-toolbar"
          aria-hidden={!toolbar}
          onFocus={() => pinToolbar(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) pinToolbar(false)
          }}
          onPointerUp={() => {
            // 点完按钮、拖完滑块就把焦点还回去，否则焦点留在工具栏里，鼠标移开也不会收起
            const active = document.activeElement
            if (
              active instanceof HTMLButtonElement ||
              (active instanceof HTMLInputElement && active.type === 'range')
            ) {
              active.blur()
            }
          }}
        >
          <div className="toolbar-row">
            <button
              type="button"
              className="chip"
              data-channel="listen"
              data-status={listen.status}
              data-paused={state.listenPaused}
              disabled={!hasKey}
              title={
                blocked ??
                (state.listenPaused
                  ? '你的译音正在外放，先暂停收听，免得录回去再翻一遍'
                  : undefined)
              }
              onClick={() => toggleChannel('listen')}
            >
              {running(listen.status) ? '停止收听' : '收听'}
              {state.listenPaused && <small>暂停中</small>}
            </button>
            <button
              type="button"
              className="chip"
              data-channel="speak"
              data-status={speak.status}
              data-onair={onAir}
              disabled={!hasKey}
              title={blocked}
              onClick={() => toggleChannel('speak')}
            >
              {running(speak.status) ? '停止说话' : '说话'}
            </button>
            {holdMode && speakLive && (
              <button
                type="button"
                className="chip chip-hold"
                data-holding={state.holding}
                onPointerDown={() => window.api.sendCommand({ type: 'hold-begin' })}
                onPointerUp={() => window.api.sendCommand({ type: 'hold-end' })}
                onPointerLeave={() => state.holding && window.api.sendCommand({ type: 'hold-end' })}
              >
                {state.holding ? '松开发送' : '按住说话'}
              </button>
            )}
            <span className="toolbar-divider" />
            <label className="lang" htmlFor={ids.mine}>
              我
            </label>
            <select
              id={ids.mine}
              className="lang-select"
              value={settings.myLanguage}
              title={languageTitle}
              onChange={(event) => void save({ myLanguage: event.target.value })}
            >
              {MY_LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.name}
                </option>
              ))}
            </select>
            <span className="lang-link" aria-hidden="true">
              ⇄
            </span>
            <label className="lang" htmlFor={ids.peer}>
              对方
            </label>
            <select
              id={ids.peer}
              className="lang-select"
              value={settings.peerLanguage}
              title={languageTitle}
              onChange={(event) => void save({ peerLanguage: event.target.value })}
            >
              {PEER_LANGUAGE_GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.languages.map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.speech ? language.name : `${language.name}（仅文字）`}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <span className="toolbar-spacer" />
            <button type="button" className="chip" onClick={() => window.api.openWindow('records')}>
              记录
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => window.api.openWindow('settings')}
            >
              设置
            </button>
            <button
              type="button"
              className="chip close"
              aria-label="退出同传"
              title="退出同传，所有通道都会停止"
              onClick={() => window.api.quit()}
            >
              ×
            </button>
          </div>
          <div className="toolbar-row">
            <button
              type="button"
              className="chip"
              aria-pressed={style.showSource}
              onClick={() => updateStyle({ showSource: !style.showSource })}
            >
              原文
            </button>
            <button
              type="button"
              className="chip"
              aria-pressed={style.showSpeak}
              title="底部单独一条显示你说的话和译文"
              onClick={() => updateStyle({ showSpeak: !style.showSpeak })}
            >
              说的字幕
            </button>
            <div className="stepper" role="group" aria-label="字幕行数">
              <button
                type="button"
                aria-label="少显示一行"
                disabled={style.lines <= MIN_LINES}
                onClick={() => updateStyle({ lines: style.lines - 1 })}
              >
                −
              </button>
              <span>{style.lines} 行</span>
              <button
                type="button"
                aria-label="多显示一行"
                disabled={style.lines >= MAX_LINES}
                onClick={() => updateStyle({ lines: style.lines + 1 })}
              >
                +
              </button>
            </div>
            <button
              type="button"
              className="chip"
              onClick={() => {
                setHeard([])
                setSpoken([])
              }}
            >
              清屏
            </button>
            <span className="toolbar-divider" />
            <StyleControls
              style={style}
              onChange={updateStyle}
              picking={picking}
              onPickingChange={setPicking}
            />
          </div>
        </div>

        <div className="caption-area" data-onair={onAir} aria-live="polite">
          <span className="onair-dot" aria-label={onAir ? '正在把你的译音送出去' : undefined} />
          {style.showSource && (
            <CaptionLines
              caption={heardSource}
              language={settings.peerLanguage}
              lines={1}
              kind="source"
            />
          )}
          <CaptionLines
            caption={heardTranslation}
            language={settings.myLanguage}
            lines={style.lines}
            kind="translation"
            placeholder={
              hasKey ? (
                hintOf(state)
              ) : (
                <>
                  还没填百炼 API Key，填好才能用。
                  <button
                    type="button"
                    className="caption-link"
                    onClick={() => window.api.openWindow('settings')}
                  >
                    打开设置
                  </button>
                </>
              )
            }
          />
        </div>

        {style.showSpeak && (
          <div className="speak-strip">
            <span className="speak-tag">我</span>
            <div className="speak-captions">
              <CaptionLines
                caption={captionOf(lastSpoken, 'source', true)}
                language={settings.myLanguage}
                lines={1}
                kind="speak-source"
                placeholder={speakLive ? '开口后这里显示你说的话和译文' : '点「说话」开始'}
              />
              <CaptionLines
                caption={captionOf(lastSpoken, 'translation', true)}
                language={settings.peerLanguage}
                lines={1}
                kind="speak-translation"
              />
            </div>
          </div>
        )}
      </div>

      <div
        className="panel-resize"
        aria-hidden="true"
        onPointerDown={(event) => {
          pinToolbar(true)
          // 高度跟着内容自动算，手柄只调宽度
          startWindowResize(event, () => pinToolbar(false), { widthOnly: true })
        }}
      />
    </div>
  )
}

export function Overlay(): React.JSX.Element {
  const [settings, save] = useSettings()
  const state = useAppState()
  if (!settings) return <div className="panel overlay" />
  return <OverlayView settings={settings} save={save} state={state} />
}
