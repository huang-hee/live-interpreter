import { upsertParagraph } from '../shared/paragraphs'
import type {
  AppState,
  ChannelState,
  Direction,
  EngineReport,
  Records,
  TranslatorEvent
} from '../shared/types'

/** 每个方向最多留这么多段记录，长时间运行不涨内存 */
const MAX_RECORDS = 500

const idle = (): ChannelState => ({ status: 'idle', message: '', error: '', speaking: false })

/**
 * 各窗口共用的运行状态和翻译记录。
 * 引擎、看板、设置、记录都是独立窗口，状态放在主进程，变化时合并成一次广播；
 * 记录窗口随时打开都能拿到完整历史。
 */
export class StateStore {
  private state: AppState = {
    channels: { listen: idle(), speak: idle() },
    holding: false,
    listenPaused: false
  }
  private records: Records = { listen: [], speak: [] }
  private scheduled = false

  constructor(private readonly onChange: (state: AppState) => void) {}

  get(): AppState {
    return this.state
  }

  getRecords(): Records {
    return this.records
  }

  clearRecords(): void {
    this.records = { listen: [], speak: [] }
  }

  applyEvent(event: TranslatorEvent): void {
    const { direction } = event
    switch (event.type) {
      case 'status':
        this.patchChannel(direction, {
          status: event.status,
          message: event.message ?? '',
          // 重新开始时清掉上次采集端的报错
          ...(event.status === 'connecting' ? { error: '' } : {}),
          ...(event.status === 'live' ? {} : { speaking: false })
        })
        break
      case 'speech':
        this.patchChannel(direction, { speaking: event.speaking })
        break
      case 'source':
      case 'translation':
        this.records = {
          ...this.records,
          [direction]: upsertParagraph(this.records[direction], event, MAX_RECORDS)
        }
        break
    }
  }

  applyReport(report: EngineReport): void {
    switch (report.type) {
      case 'error':
        this.patchChannel(report.direction, { error: report.error })
        break
      case 'holding':
        this.patch({ holding: report.holding })
        break
      case 'listen-paused':
        this.patch({ listenPaused: report.paused })
        break
    }
  }

  isRunning(direction: Direction): boolean {
    const { status } = this.state.channels[direction]
    return status !== 'idle' && status !== 'error'
  }

  private patchChannel(direction: Direction, patch: Partial<ChannelState>): void {
    const current = this.state.channels[direction]
    const changed = (Object.keys(patch) as (keyof ChannelState)[]).some(
      (key) => patch[key] !== current[key]
    )
    if (!changed) return
    this.patch({ channels: { ...this.state.channels, [direction]: { ...current, ...patch } } })
  }

  private patch(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch }
    // 同一轮事件里的多次变化合并成一次广播
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.onChange(this.state)
    })
  }
}
