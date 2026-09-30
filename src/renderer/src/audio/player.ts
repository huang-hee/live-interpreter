/** 服务端返回的译音：24kHz、单声道、16 位 PCM */
const OUTPUT_RATE = 24000
/** 空闲后第一块音频延后一点播放，吸收网络抖动 */
const START_DELAY_S = 0.08

// AudioContext.setSinkId 目前只有 Chromium 实现，TS 的 DOM 类型里还没有
type SinkAudioContext = AudioContext & {
  sinkId?: string
  setSinkId?: (sinkId: string) => Promise<void>
}

export class PcmPlayer {
  private context: SinkAudioContext | null = null
  private nextTime = 0

  /** 提前建好播放上下文并切到目标设备，避免第一句从默认设备漏出来。deviceId 为空表示系统默认输出 */
  async prepare(deviceId: string): Promise<void> {
    const context = this.ensureContext()
    if (context.sinkId !== deviceId) await context.setSinkId?.(deviceId)
  }

  play(pcm: Uint8Array): void {
    const context = this.ensureContext()
    // Int16Array 要求偏移按 2 字节对齐，不对齐时复制一份
    const bytes = pcm.byteOffset % 2 === 0 ? pcm : pcm.slice()
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1)
    const buffer = context.createBuffer(1, samples.length, OUTPUT_RATE)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 0x8000

    const node = context.createBufferSource()
    node.buffer = buffer
    node.connect(context.destination)
    const startAt = Math.max(context.currentTime + START_DELAY_S, this.nextTime)
    node.start(startAt)
    this.nextTime = startAt + buffer.duration
  }

  /** 还有排队未播完的音频 */
  isPlaying(tailSeconds = 0): boolean {
    return this.context !== null && this.context.currentTime < this.nextTime + tailSeconds
  }

  stop(): void {
    void this.context?.close()
    this.context = null
    this.nextTime = 0
  }

  private ensureContext(): SinkAudioContext {
    this.context ??= new AudioContext({ sampleRate: OUTPUT_RATE })
    return this.context
  }
}
