// 运行在 AudioWorkletGlobalScope：降混成单声道，重采样到 16kHz，转成 PCM16，每 100ms 发一块

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void
declare const sampleRate: number

const TARGET_RATE = 16000
const CHUNK_SAMPLES = TARGET_RATE / 10

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private readonly ratio = sampleRate / TARGET_RATE
  private phase = 0
  private sum = 0
  private count = 0
  private chunk = new Int16Array(CHUNK_SAMPLES)
  private filled = 0
  private squares = 0

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0]
    if (!channels || channels.length === 0) return true
    const frames = channels[0].length
    const channelCount = channels.length

    for (let i = 0; i < frames; i++) {
      let sample = 0
      for (let c = 0; c < channelCount; c++) sample += channels[c][i]
      // 每个输出样本取对应窗口内输入的平均值，顺带做了一次简单低通
      this.sum += sample / channelCount
      this.count++
      this.phase++
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio
        this.write(this.sum / this.count)
        this.sum = 0
        this.count = 0
      }
    }
    return true
  }

  private write(value: number): void {
    const clamped = Math.max(-1, Math.min(1, value))
    this.chunk[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
    this.squares += clamped * clamped
    if (this.filled < CHUNK_SAMPLES) return

    const level = Math.sqrt(this.squares / CHUNK_SAMPLES)
    const buffer = this.chunk.buffer
    // 所有权转给主线程，这里换一块新缓冲区
    this.port.postMessage({ pcm: buffer, level }, [buffer])
    this.chunk = new Int16Array(CHUNK_SAMPLES)
    this.filled = 0
    this.squares = 0
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)

// 让本文件成为模块，上面的 declare 只在本文件内生效，不污染渲染进程的全局类型
export {}
