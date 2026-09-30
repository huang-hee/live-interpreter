// 运行在 AudioWorkletGlobalScope：降混成单声道，保持原采样率转成 PCM16，每 100ms 发一块。
// 声音复刻要求采样率不低于 24kHz，所以这里不重采样。

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void
declare const sampleRate: number

class PcmRecordProcessor extends AudioWorkletProcessor {
  private readonly size = Math.round(sampleRate / 10)
  private chunk = new Int16Array(this.size)
  private filled = 0
  private squares = 0

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0]
    if (!channels || channels.length === 0) return true
    const count = channels.length
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0
      for (let c = 0; c < count; c++) sample += channels[c][i]
      const value = Math.max(-1, Math.min(1, sample / count))
      this.chunk[this.filled++] = value < 0 ? value * 0x8000 : value * 0x7fff
      this.squares += value * value
      if (this.filled === this.size) this.flush()
    }
    return true
  }

  private flush(): void {
    const level = Math.sqrt(this.squares / this.size)
    const buffer = this.chunk.buffer
    this.port.postMessage({ pcm: buffer, level }, [buffer])
    this.chunk = new Int16Array(this.size)
    this.filled = 0
    this.squares = 0
  }
}

registerProcessor('pcm-record', PcmRecordProcessor)

// 让本文件成为模块，上面的 declare 只在本文件内生效，不污染渲染进程的全局类型
export {}
