import type { TranslatorEvent } from '../shared/types'

/**
 * 字幕事件带的是累计全文，同一段在一个批次里只需要最后一版。
 * 按固定间隔合并后一次性发给渲染进程，减少 IPC 和 React 渲染次数；音频不合并，直接发。
 */
export class EventBatcher {
  private pending = new Map<string, TranslatorEvent>()
  private timer: NodeJS.Timeout | null = null
  private sequence = 0

  constructor(
    private readonly flush: (events: TranslatorEvent[]) => void,
    private readonly intervalMs = 50
  ) {}

  push(event: TranslatorEvent): void {
    if (event.type === 'audio') {
      this.flush([event])
      return
    }
    this.pending.set(this.keyOf(event), event)
    this.timer ??= setTimeout(() => this.drain(), this.intervalMs)
  }

  drain(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.pending.size === 0) return
    const events = [...this.pending.values()]
    this.pending.clear()
    this.flush(events)
  }

  private keyOf(event: TranslatorEvent): string {
    if (event.type === 'source' || event.type === 'translation') {
      return `${event.direction}:${event.type}:${event.paragraphId}`
    }
    // 状态和说话起止都要保留先后顺序，不合并
    return `${event.direction}:${event.type}:${this.sequence++}`
  }
}
