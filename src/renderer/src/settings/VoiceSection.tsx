import { useEffect, useRef, useState } from 'react'
import { featuresOf, findPreset } from '@shared/models'
import type { PublicSettings, Result, SettingsPatch, VoiceMode } from '@shared/types'
import { VoiceRecorder } from '../audio/recorder'
import { Segmented } from '../components/fields'

const MODES: { value: VoiceMode; label: string }[] = [
  { value: 'off', label: '预设音色' },
  { value: 'live', label: '边说边复刻' },
  { value: 'fixed', label: '固定音色' }
]

const MODE_HINT: Record<VoiceMode, string> = {
  off: '用服务端的预设音色念译文。',
  live: '开始说话后，服务端根据你的声音边说边复刻。复刻完成前，开头几句会先用默认音色。',
  fixed: '提前录一段朗读复刻好音色，每次开始说话，第一句就是你的声音。'
}

/** 复刻要求 10~20 秒、至少 3 秒连续清晰朗读 */
const MIN_SECONDS = 10
const MAX_SECONDS = 20

const SCRIPT =
  '你好，我是这个项目的前端开发。这周我会把登录页和个人中心做完，周四提测。' +
  '如果需求有调整，我们随时在群里沟通，我会尽快给出排期和评估。'

type Phase = 'idle' | 'recording' | 'uploading'

interface Props {
  settings: PublicSettings
  save: (patch: SettingsPatch) => Promise<void>
}

export function VoiceSection({ settings, save }: Props): React.JSX.Element {
  const { speak } = settings
  const [phase, setPhase] = useState<Phase>('idle')
  const [seconds, setSeconds] = useState(0)
  const [result, setResult] = useState<Result | null>(null)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const levelRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      window.clearInterval(timerRef.current)
      recorderRef.current?.stop()
    },
    []
  )

  const finish = async (): Promise<void> => {
    const recorder = recorderRef.current
    if (!recorder) return
    window.clearInterval(timerRef.current)
    recorderRef.current = null
    const recording = recorder.finish()
    if (recording.seconds < MIN_SECONDS) {
      setPhase('idle')
      setResult({
        ok: false,
        message: `录得太短（${recording.seconds.toFixed(0)} 秒），至少要 ${MIN_SECONDS} 秒。`
      })
      return
    }
    setPhase('uploading')
    const created = await window.api.createVoice(recording.wav)
    setPhase('idle')
    setResult(created)
  }

  const record = async (): Promise<void> => {
    setResult(null)
    const recorder = new VoiceRecorder()
    try {
      await recorder.start(speak.inputDeviceId, (level) => {
        levelRef.current?.style.setProperty('--level', Math.min(1, level * 4).toFixed(3))
      })
    } catch {
      setResult({ ok: false, message: '打不开麦克风。到系统设置里允许本应用使用麦克风后再试。' })
      return
    }
    recorderRef.current = recorder
    setSeconds(0)
    setPhase('recording')
    timerRef.current = window.setInterval(() => {
      const elapsed = recorder.seconds
      setSeconds(elapsed)
      if (elapsed >= MAX_SECONDS) void finish()
    }, 200)
  }

  const cancel = (): void => {
    window.clearInterval(timerRef.current)
    recorderRef.current?.stop()
    recorderRef.current = null
    setPhase('idle')
  }

  const remove = async (): Promise<void> => {
    setResult(await window.api.deleteVoice())
  }

  const voice = speak.clonedVoice
  const modelMismatch = voice !== null && voice.model !== speak.model.id
  const features = featuresOf(speak.model)
  const modelName = findPreset(speak.model.id)?.name ?? speak.model.id
  const options = MODES.map((mode) => ({
    ...mode,
    disabled:
      (mode.value === 'fixed' && !features.fixedVoice) ||
      (mode.value === 'live' && !features.liveClone)
  }))
  // 模型不支持的模式按会话里实际的退路显示：固定音色 → 边说边复刻 → 预设音色
  const fallback: VoiceMode = features.liveClone ? 'live' : 'off'
  const mode = options.find((option) => option.value === speak.voiceMode)?.disabled
    ? fallback
    : speak.voiceMode

  return (
    <>
      <header className="section-head">
        <h2>音色</h2>
        <p>「说」的译音用谁的声音念。</p>
      </header>

      <div className="section-body">
        {!features.fixedVoice && (
          <p className="notice">
            「说」现在用的 {modelName}{' '}
            不支持固定音色。要让第一句就是你的声音，到「翻译」里把「说」的模型换成 Qwen3.5。
          </p>
        )}
        <Segmented
          label="译音音色"
          value={mode}
          options={options}
          onChange={(voiceMode) => void save({ speak: { voiceMode } })}
        />
        <p className="section-text">{MODE_HINT[mode]}</p>

        {mode === 'fixed' && (
          <div className="voice-card">
            {voice ? (
              <p className="voice-status">
                已复刻音色，{new Date(voice.createdAt).toLocaleString()} 创建。
                {modelMismatch && ' 当前模型和复刻时不一致，开始说话时会改用边说边复刻。'}
              </p>
            ) : (
              <p className="voice-status">还没有固定音色。录好之前，开始说话时会先用边说边复刻。</p>
            )}

            {phase === 'recording' ? (
              <div className="recorder" data-ready={seconds >= MIN_SECONDS}>
                <p className="recorder-script">{SCRIPT}</p>
                <div className="recorder-meter" ref={levelRef} aria-hidden="true">
                  <div />
                </div>
                <div className="recorder-actions">
                  <span className="recorder-time">
                    {seconds.toFixed(0)} / {MAX_SECONDS} 秒
                    {seconds < MIN_SECONDS ? `，再读 ${Math.ceil(MIN_SECONDS - seconds)} 秒` : ''}
                  </span>
                  <button type="button" className="button-secondary" onClick={cancel}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="button-primary"
                    disabled={seconds < MIN_SECONDS}
                    onClick={() => void finish()}
                  >
                    录好了
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="section-text">
                  找个安静的地方，用平常说话的语气把一段话读 10~20 秒，不要有背景音乐或别人的声音。
                </p>
                <div className="form-actions">
                  <button
                    type="button"
                    className="button-primary"
                    disabled={!settings.hasApiKey || phase === 'uploading'}
                    title={settings.hasApiKey ? undefined : '先在「账号」里填好 API Key'}
                    onClick={() => void record()}
                  >
                    {phase === 'uploading' ? '正在复刻…' : voice ? '重新录制' : '开始录音'}
                  </button>
                  {voice && phase === 'idle' && (
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => void remove()}
                    >
                      删除音色
                    </button>
                  )}
                </div>
              </>
            )}
            {result && (
              <p className="form-result" data-ok={result.ok} role="status">
                {result.message}
              </p>
            )}
          </div>
        )}
      </div>
    </>
  )
}
