import {
  MUTED_OUTPUT,
  SYSTEM_AUDIO_SOURCE,
  type ChannelStatus,
  type Direction,
  type EngineCommand,
  type PublicSettings,
  type TranslatorEvent
} from '@shared/types'
import { AudioCapture, type CaptureChunk, type CaptureSource } from '../audio/capture'
import { PcmPlayer } from '../audio/player'

/** 译音播完后再多停一会儿收听，盖住设备缓冲 */
const PLAYBACK_TAIL_S = 0.4
/** 按住不到这么久多半是误触，提示一下 */
const MIN_HOLD_MS = 300
/** 松开后再送这么久才提交：人往往最后一个字还没说完就松手，采集也有不满一块的尾巴 */
const RELEASE_TAIL_MS = 400

function captureSourceOf(direction: Direction, settings: PublicSettings): CaptureSource {
  if (direction === 'speak') {
    return { kind: 'device', deviceId: settings.speak.inputDeviceId, voice: true }
  }
  return settings.listen.source === SYSTEM_AUDIO_SOURCE
    ? { kind: 'system' }
    : { kind: 'device', deviceId: settings.listen.source, voice: false }
}

/** 选了具体设备（通常是虚拟声卡）且打开监听时，本机默认输出也放一份 */
function shouldMonitor(settings: PublicSettings): boolean {
  const { outputDeviceId, monitor } = settings.speak
  return monitor && outputDeviceId !== '' && outputDeviceId !== MUTED_OUTPUT
}

function errorText(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return '没有权限采集声音。到系统设置的「隐私与安全性」里允许本应用使用麦克风或录制系统声音。'
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return '找不到选中的音频设备，可能已经拔掉了。换一个设备再开始。'
  }
  return error instanceof Error ? error.message : String(error)
}

const running = (status: ChannelStatus): boolean => status !== 'idle' && status !== 'error'

/**
 * 音频引擎：跑在隐藏窗口里，负责两条通道的采集、译音播放、防回授和按住说话。
 * 界面窗口的操作经主进程转成 handle() 调用；状态变化通过 report 报给主进程再广播。
 */
export class Engine {
  private settings: PublicSettings | null = null
  private readonly statuses: Record<Direction, ChannelStatus> = { listen: 'idle', speak: 'idle' }
  /** 自己发起的最近一次会话编号，更早会话的状态事件一律忽略 */
  private readonly sessions: Record<Direction, number> = { listen: 0, speak: 0 }
  private readonly players = {
    listen: new PcmPlayer(),
    speak: new PcmPlayer(),
    /** 「说」的译音在本机默认输出上的监听副本 */
    monitor: new PcmPlayer()
  }
  private readonly captures: Record<Direction, AudioCapture>
  private holding = false
  private holdStartedAt = 0
  private sentDuringHold = false
  /** 松开后还在送尾巴，到点提交 */
  private releaseTimer: number | undefined
  private listenPaused = false

  constructor() {
    this.captures = { listen: this.createCapture('listen'), speak: this.createCapture('speak') }
    void window.api.getSettings().then((settings) => {
      this.settings = settings
    })
    window.api.onSettingsChanged((settings) => this.applySettings(settings))
    window.api.onTranslatorEvents((events) => this.handleEvents(events))
  }

  handle(command: EngineCommand): void {
    switch (command.type) {
      case 'start':
        void this.start(command.direction)
        break
      case 'stop':
        void this.stop(command.direction)
        break
      case 'stop-all':
        // 通道由主进程直接停，这里只管停采集
        this.captures.listen.stop()
        this.captures.speak.stop()
        this.setHolding(false)
        this.setListenPaused(false)
        break
      case 'hold-begin':
        this.beginHold()
        break
      case 'hold-end':
        this.endHold()
        break
      case 'hold-toggle':
        if (this.holding) this.endHold()
        else this.beginHold()
        break
    }
  }

  /** 通道在跑时换了声音来源、麦克风或输出设备，立刻切过去，不用停下重开 */
  private applySettings(next: PublicSettings): void {
    const previous = this.settings
    this.settings = next
    if (!previous) return
    for (const direction of ['listen', 'speak'] as Direction[]) {
      if (!running(this.statuses[direction])) continue
      const before = JSON.stringify(captureSourceOf(direction, previous))
      if (JSON.stringify(captureSourceOf(direction, next)) !== before) {
        this.captures[direction].start(captureSourceOf(direction, next)).catch((error) => {
          this.reportError(direction, errorText(error))
          void this.stop(direction)
        })
      }
    }
    if (
      running(this.statuses.listen) &&
      next.listen.outputDeviceId !== previous.listen.outputDeviceId
    ) {
      void this.players.listen.prepare(next.listen.outputDeviceId)
    }
    if (running(this.statuses.speak)) {
      const { outputDeviceId } = next.speak
      if (outputDeviceId !== previous.speak.outputDeviceId && outputDeviceId !== MUTED_OUTPUT) {
        void this.players.speak.prepare(outputDeviceId)
      }
      if (shouldMonitor(next) && !shouldMonitor(previous)) void this.players.monitor.prepare('')
    }
  }

  private createCapture(direction: Direction): AudioCapture {
    return new AudioCapture(
      (chunk) => this.handleChunk(direction, chunk),
      () => {
        this.reportError(direction, '音频来源断开了。检查设备后重新开始。')
        void this.stop(direction)
      }
    )
  }

  private async start(direction: Direction): Promise<void> {
    const settings = this.settings
    if (!settings || running(this.statuses[direction])) return
    this.reportError(direction, '')

    const source = captureSourceOf(direction, settings)
    if (source.kind === 'device' && !(await window.api.requestMicrophoneAccess())) {
      this.reportError(
        direction,
        '没有麦克风权限。到系统设置的「隐私与安全性 → 麦克风」里允许本应用。'
      )
      return
    }

    // 连接失败的原因主进程已经通过状态事件广播了
    const session = await window.api.startChannel(direction)
    if (!session) return
    this.sessions[direction] = session
    this.statuses[direction] = 'live'

    try {
      if (direction === 'speak') {
        const { outputDeviceId } = settings.speak
        // 不出声时服务端只回文字，不会有音频要播
        if (outputDeviceId !== MUTED_OUTPUT) await this.players.speak.prepare(outputDeviceId)
        if (shouldMonitor(settings)) await this.players.monitor.prepare('')
      } else {
        await this.players.listen.prepare(settings.listen.outputDeviceId)
      }
      await this.captures[direction].start(source)
    } catch (error) {
      this.captures[direction].stop()
      await window.api.stopChannel(direction)
      this.reportError(direction, errorText(error))
    }
  }

  private async stop(direction: Direction): Promise<void> {
    this.captures[direction].stop()
    if (direction === 'listen') this.setListenPaused(false)
    if (direction === 'speak') this.stopHolding()
    await window.api.stopChannel(direction)
  }

  private handleEvents(events: TranslatorEvent[]): void {
    const settings = this.settings
    for (const event of events) {
      if (event.type === 'audio') {
        this.players[event.direction].play(event.pcm)
        if (event.direction === 'speak' && settings && shouldMonitor(settings)) {
          this.players.monitor.play(event.pcm)
        }
      } else if (event.type === 'status') {
        if (event.session < this.sessions[event.direction]) continue
        this.statuses[event.direction] = event.status
        // 通道被主进程停掉（睡眠、清除账号、重连失败）时，采集也要跟着停
        if (!running(event.status)) {
          this.captures[event.direction].stop()
          if (event.direction === 'speak') this.stopHolding()
          if (event.direction === 'listen') this.setListenPaused(false)
        }
      }
    }
  }

  private handleChunk(direction: Direction, chunk: CaptureChunk): void {
    if (!this.shouldSend(direction)) return
    if (direction === 'speak' && this.holdingOrReleasing()) this.sentDuringHold = true
    window.api.sendAudio(direction, chunk.pcm)
  }

  private shouldSend(direction: Direction): boolean {
    const settings = this.settings
    if (!settings) return false
    if (direction === 'speak') return settings.speak.mode === 'auto' || this.holdingOrReleasing()
    // 自己的译音在外放时，系统声音会把它录回来，这段时间先不送收听通道
    const paused =
      settings.pauseListenWhileSpeaking &&
      (this.holdingOrReleasing() ||
        this.players.speak.isPlaying(PLAYBACK_TAIL_S) ||
        this.players.monitor.isPlaying(PLAYBACK_TAIL_S))
    this.setListenPaused(paused)
    return !paused
  }

  private beginHold(): void {
    const settings = this.settings
    if (this.holding || settings?.speak.mode !== 'hold' || this.statuses.speak !== 'live') return
    // 上一句的尾巴还没送完又按下了：先把上一句提交
    this.commitHold()
    this.holdStartedAt = performance.now()
    this.sentDuringHold = false
    this.setHolding(true)
    this.reportError('speak', '')
    window.api.clearAudio('speak')
  }

  private endHold(): void {
    if (!this.holding) return
    this.setHolding(false)
    if (performance.now() - this.holdStartedAt < MIN_HOLD_MS) {
      window.api.clearAudio('speak')
      this.reportError('speak', '按住久一点再开口，松开后才会翻译。')
      return
    }
    this.releaseTimer = window.setTimeout(() => this.commitHold(), RELEASE_TAIL_MS)
  }

  private holdingOrReleasing(): boolean {
    return this.holding || this.releaseTimer !== undefined
  }

  /** 送完尾巴，提交这一句 */
  private commitHold(): void {
    if (this.releaseTimer === undefined) return
    window.clearTimeout(this.releaseTimer)
    this.releaseTimer = undefined
    // 一块音频都没送就提交，服务端会报缓冲区为空
    if (this.sentDuringHold) window.api.commitAudio('speak')
  }

  /** 通道停了：按住和没送完的尾巴都作废，不再提交 */
  private stopHolding(): void {
    window.clearTimeout(this.releaseTimer)
    this.releaseTimer = undefined
    this.setHolding(false)
  }

  /** 只在状态翻转时上报，不跟着每 100ms 的音频块刷 */
  private setListenPaused(paused: boolean): void {
    if (paused === this.listenPaused) return
    this.listenPaused = paused
    window.api.report({ type: 'listen-paused', paused })
  }

  private setHolding(holding: boolean): void {
    if (holding === this.holding) return
    this.holding = holding
    window.api.report({ type: 'holding', holding })
  }

  private reportError(direction: Direction, error: string): void {
    window.api.report({ type: 'error', direction, error })
  }
}
