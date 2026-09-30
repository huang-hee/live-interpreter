import { writeFileSync } from 'fs'

/**
 * 每个字符 100ms：# 有声，. 停顿。四句话，句间停顿都超过 1 秒，
 * 模拟服务按音量断句（RMS > 0.01 算有声），会切出四段。
 */
const RHYTHM =
  '####...###############.###........................####.##########...####################.....'

const FRAME_MS = 100
const FADE_MS = 8

/**
 * 生成一段「像说话」的测试音频：有声段是带谐波的嗡声，按音节速度起伏，中间夹着停顿。
 * 模拟服务不做识别，只看有没有声音，用不着真人语音，仓库里也就不放录音文件。
 * Chromium 的 --use-file-for-fake-audio-capture 只认干净的 WAV（fmt + data 两块）。
 */
export function writeTestSpeech(path: string, sampleRate: number): void {
  const frame = (sampleRate * FRAME_MS) / 1000
  const fade = (sampleRate * FADE_MS) / 1000
  const samples = new Int16Array(RHYTHM.length * frame)

  for (let i = 0; i < samples.length; i++) {
    const index = Math.floor(i / frame)
    if (RHYTHM[index] !== '#') continue
    // 到前后停顿的距离，用来做淡入淡出，避免咔哒声
    const voicedBefore = RHYTHM[index - 1] === '#'
    const voicedAfter = RHYTHM[index + 1] === '#'
    const offset = i % frame
    const edge = Math.min(voicedBefore ? fade : offset, voicedAfter ? fade : frame - offset)
    const ramp = Math.min(1, edge / fade)

    const t = i / sampleRate
    const pitch = 160 + 25 * Math.sin(2 * Math.PI * 0.7 * t)
    const phase = 2 * Math.PI * pitch * t
    const voice = Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase)
    const syllable = 0.65 + 0.35 * Math.sin(2 * Math.PI * 4 * t)
    samples[i] = Math.round(voice * syllable * ramp * 0.18 * 32767)
  }

  const data = Buffer.from(samples.buffer)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // 单声道
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([header, data]))
}
