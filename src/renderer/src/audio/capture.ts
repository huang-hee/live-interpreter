import workletUrl from './pcm-capture.worklet?worker&url'

export type CaptureSource =
  | { kind: 'system' }
  /** voice 为 true 时开回声消除和降噪，适合麦克风；虚拟声卡这类信号源要关掉 */
  | { kind: 'device'; deviceId: string; voice: boolean }

export interface CaptureChunk {
  pcm: ArrayBuffer
  level: number
}

async function openStream(source: CaptureSource): Promise<MediaStream> {
  if (source.kind === 'system') {
    // 主进程的 setDisplayMediaRequestHandler 会把 audio 授权成系统 loopback，视频轨用不上直接停掉
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    for (const track of stream.getVideoTracks()) {
      track.stop()
      stream.removeTrack(track)
    }
    return stream
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: source.deviceId ? { exact: source.deviceId } : undefined,
      echoCancellation: source.voice,
      noiseSuppression: source.voice,
      autoGainControl: source.voice
    }
  })
}

export class AudioCapture {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null

  constructor(
    private readonly onChunk: (chunk: CaptureChunk) => void,
    private readonly onEnded: () => void
  ) {}

  async start(source: CaptureSource): Promise<void> {
    this.stop()
    const stream = await openStream(source)
    this.stream = stream
    const [track] = stream.getAudioTracks()
    // macOS 没有「系统录音」权限时，轨道一创建就是 ended 状态，不会报错
    if (!track || track.readyState === 'ended') {
      this.stop()
      throw new Error(
        source.kind === 'system'
          ? '拿不到系统声音：到系统设置的「隐私与安全性 → 录屏与系统录音」里允许本应用'
          : '这个输入设备没有声音信号'
      )
    }
    track.addEventListener('ended', this.onEnded)

    const context = new AudioContext()
    this.context = context
    await context.audioWorklet.addModule(workletUrl)
    const node = new AudioWorkletNode(context, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0
    })
    node.port.onmessage = (event: MessageEvent<CaptureChunk>) => this.onChunk(event.data)
    context.createMediaStreamSource(stream).connect(node)
    this.node = node
  }

  stop(): void {
    this.node?.port.close()
    this.node?.disconnect()
    this.node = null
    for (const track of this.stream?.getTracks() ?? []) {
      track.removeEventListener('ended', this.onEnded)
      track.stop()
    }
    this.stream = null
    void this.context?.close()
    this.context = null
  }
}
