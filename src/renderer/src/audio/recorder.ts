import workletUrl from './pcm-record.worklet?worker&url'

/** 单声道 16 位 PCM 加 44 字节 WAV 头 */
function encodeWav(chunks: Int16Array[], sampleRate: number): ArrayBuffer {
  const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const text = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples * 2, true)
  let offset = 44
  for (const chunk of chunks) {
    new Int16Array(buffer, offset, chunk.length).set(chunk)
    offset += chunk.length * 2
  }
  return buffer
}

export interface Recording {
  wav: ArrayBuffer
  seconds: number
}

/** 录一段复刻用的朗读，按麦克风原采样率保存成 WAV */
export class VoiceRecorder {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private chunks: Int16Array[] = []
  private sampleRate = 48000

  async start(deviceId: string, onLevel: (level: number) => void): Promise<void> {
    this.stop()
    this.chunks = []
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, noiseSuppression: true }
    })
    const context = new AudioContext()
    this.context = context
    this.sampleRate = context.sampleRate
    await context.audioWorklet.addModule(workletUrl)
    const node = new AudioWorkletNode(context, 'pcm-record', {
      numberOfInputs: 1,
      numberOfOutputs: 0
    })
    node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      this.chunks.push(new Int16Array(event.data.pcm))
      onLevel(event.data.level)
    }
    context.createMediaStreamSource(this.stream).connect(node)
  }

  get seconds(): number {
    return (this.chunks.length * Math.round(this.sampleRate / 10)) / this.sampleRate
  }

  finish(): Recording {
    const recording = { wav: encodeWav(this.chunks, this.sampleRate), seconds: this.seconds }
    this.stop()
    return recording
  }

  stop(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    void this.context?.close()
    this.context = null
  }
}
