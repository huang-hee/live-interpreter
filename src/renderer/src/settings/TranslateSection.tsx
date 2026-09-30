import { useId } from 'react'
import { findLanguage, MY_LANGUAGES, PEER_LANGUAGE_GROUPS } from '@shared/languages'
import { featuresOf, type ModelChoice } from '@shared/models'
import {
  MUTED_OUTPUT,
  SYSTEM_AUDIO_SOURCE,
  type PublicSettings,
  type SettingsPatch,
  type SpeakMode
} from '@shared/types'
import { Segmented, SelectField, Switch } from '../components/fields'
import type { AudioDevices } from '../hooks/useAudioDevices'
import { deviceOptions, hasVirtualDevice, shortcutLabel } from '../lib/devices'
import { ModelField } from './ModelField'

const MODES: { value: SpeakMode; label: string }[] = [
  { value: 'auto', label: '停顿自动断句' },
  { value: 'hold', label: '按住说话' }
]

/** 断句灵敏度（server_vad 的 threshold，-1~1）：越低越容易把背景音当成人声 */
const THRESHOLDS = [
  { value: '0', label: '灵敏' },
  { value: '0.2', label: '标准' },
  { value: '0.5', label: '抗噪' }
]

interface Props {
  settings: PublicSettings
  devices: AudioDevices & { refresh: () => void }
  save: (patch: SettingsPatch) => Promise<void>
}

/** 设备名要拿到麦克风权限后才有；这里申请一下就关掉 */
async function unlockDeviceNames(refresh: () => void): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  for (const track of stream.getTracks()) track.stop()
  refresh()
}

export function TranslateSection({ settings, devices, save }: Props): React.JSX.Element {
  const ids = { mine: useId(), peer: useId(), silence: useId(), listenSilence: useId() }
  const { listen, speak } = settings
  const listenFeatures = featuresOf(listen.model)
  // 按说话人断句时灵敏度由服务端固定，只能调停顿
  const bySpeaker = listenFeatures.speakers && listen.speakers
  const speakFeatures = featuresOf(speak.model)
  const holdMode = speak.mode === 'hold' && speakFeatures.manualTurn
  const set = (patch: SettingsPatch): void => void save(patch)
  const myName = findLanguage(settings.myLanguage)?.name ?? settings.myLanguage
  const peer = findLanguage(settings.peerLanguage)
  const canRead = findLanguage(settings.myLanguage)?.speech ?? false
  const canSpeak = peer?.speech ?? false
  const muted = speak.outputDeviceId === MUTED_OUTPUT
  const toDevice = speak.outputDeviceId !== '' && !muted
  const namesHidden = [...devices.inputs, ...devices.outputs].every((device) => !device.label)

  const sources = [
    { value: SYSTEM_AUDIO_SOURCE, label: '系统声音（视频、会议软件）' },
    ...deviceOptions(devices.inputs, '').slice(1)
  ]
  const outputs = [
    ...deviceOptions(devices.outputs, '系统默认输出（自己也听得到）'),
    { value: MUTED_OUTPUT, label: '不出声，只出文字' }
  ]
  const virtualHint = hasVirtualDevice(devices.outputs)
    ? '要让会议里的人听到：这里选虚拟声卡，会议软件的麦克风也选它。'
    : `要让会议里的人听到，先装虚拟声卡（${window.api.platform === 'darwin' ? 'BlackHole' : 'VB-CABLE'}），再把这里和会议软件的麦克风都选它。`

  return (
    <>
      <header className="section-head">
        <h2>翻译</h2>
        <p>语言、声音从哪来、译音往哪去。</p>
      </header>

      <div className="section-body">
        {namesHidden && (
          <p className="notice">
            还没拿到麦克风权限，设备名称显示不出来。
            <button
              type="button"
              className="link"
              onClick={() => void unlockDeviceNames(devices.refresh)}
            >
              允许并显示设备名称
            </button>
          </p>
        )}

        <h3>语言</h3>
        <div className="field-row">
          <div className="field">
            <label htmlFor={ids.mine}>我说</label>
            <select
              id={ids.mine}
              value={settings.myLanguage}
              onChange={(event) => set({ myLanguage: event.target.value })}
            >
              {MY_LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.peer}>对方说</label>
            <select
              id={ids.peer}
              value={settings.peerLanguage}
              onChange={(event) => set({ peerLanguage: event.target.value })}
            >
              {PEER_LANGUAGE_GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.languages.map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.speech ? language.name : `${language.name}（仅文字）`}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        </div>

        <h3>听：对方的话翻成{myName}</h3>
        <ModelField value={listen.model} onChange={(model) => set({ listen: { model } })} />
        <div className="field-row">
          <SelectField
            label="声音来源"
            value={listen.source}
            options={sources}
            onChange={(source) => set({ listen: { source } })}
          />
          {listen.readAloud && canRead && (
            <SelectField
              label="朗读输出到"
              value={listen.outputDeviceId}
              options={deviceOptions(devices.outputs, '系统默认输出')}
              onChange={(outputDeviceId) => set({ listen: { outputDeviceId } })}
            />
          )}
        </div>
        <Switch
          label="朗读译文"
          checked={listen.readAloud && canRead}
          disabled={!canRead}
          hint={canRead ? '除了字幕，也把译文念出来。建议戴耳机。' : `${myName}只支持字幕`}
          onChange={(readAloud) => set({ listen: { readAloud } })}
        />
        {listenFeatures.speakers && (
          <Switch
            label="按说话人断句"
            checked={listen.speakers}
            hint="换人说话就另起一句，适合多人对话的视频和会议。打开后背景音过滤由服务端固定。"
            onChange={(speakers) => set({ listen: { speakers } })}
          />
        )}
        {listenFeatures.vadTuning && (
          <div className="field-row">
            <div className="field">
              <label htmlFor={ids.listenSilence}>
                停顿 {(listen.silenceMs / 1000).toFixed(1)} 秒算一句
              </label>
              <input
                id={ids.listenSilence}
                type="range"
                min={500}
                max={3000}
                step={100}
                value={listen.silenceMs}
                onChange={(event) => set({ listen: { silenceMs: Number(event.target.value) } })}
              />
              <small className="field-hint">
                调长一点，一句话更完整、译得更准；调短一点，出字更快，但容易把一句话拆开译。
              </small>
            </div>
            {!bySpeaker && (
              <div className="field">
                <span className="field-label">背景音过滤</span>
                <Segmented
                  label="背景音过滤"
                  value={String(listen.vadThreshold)}
                  options={THRESHOLDS}
                  onChange={(value) => set({ listen: { vadThreshold: Number(value) } })}
                />
                <small className="field-hint">
                  视频里音乐、音效多时选「抗噪」，说话声小时选「灵敏」。
                </small>
              </div>
            )}
          </div>
        )}
        <Switch
          label="字幕里显示还没确认的译文"
          checked={listen.showPending}
          hint={
            listen.showPending
              ? '出字更快，但还没确认的部分会被改写，字幕会跳动。'
              : '只显示确认过的译文，出现了就不再变；比打开时晚一点出字。'
          }
          onChange={(showPending) => set({ listen: { showPending } })}
        />

        <h3>说：你的话翻成{peer?.name ?? settings.peerLanguage}</h3>
        <ModelField
          value={speak.model}
          onChange={(model: ModelChoice) =>
            // 新模型不支持按住说话时，退回停顿自动断句
            set({ speak: featuresOf(model).manualTurn ? { model } : { model, mode: 'auto' } })
          }
        />
        <div className="field-row">
          <SelectField
            label="麦克风"
            value={speak.inputDeviceId}
            options={deviceOptions(devices.inputs, '系统默认麦克风')}
            onChange={(inputDeviceId) => set({ speak: { inputDeviceId } })}
          />
          <SelectField
            label="译音输出到"
            value={canSpeak ? speak.outputDeviceId : MUTED_OUTPUT}
            options={outputs}
            disabled={!canSpeak}
            hint={canSpeak ? virtualHint : `${peer?.name ?? ''}只支持文字译文`}
            onChange={(outputDeviceId) => set({ speak: { outputDeviceId } })}
          />
        </div>
        <Switch
          label="耳机里也听自己的译音"
          checked={speak.monitor && toDevice}
          disabled={!canSpeak || !toDevice}
          hint={
            toDevice
              ? '译音送进会议的同时，本机默认输出也放一份。'
              : '译音输出选了虚拟声卡才用得上。'
          }
          onChange={(monitor) => set({ speak: { monitor } })}
        />
        <div className="field">
          <span className="field-label">断句方式</span>
          <Segmented
            label="断句方式"
            value={holdMode ? 'hold' : 'auto'}
            options={MODES}
            disabled={!speakFeatures.manualTurn}
            onChange={(mode) => set({ speak: { mode } })}
          />
          <small className="field-hint">
            {!speakFeatures.manualTurn
              ? '当前模型只支持停顿自动断句，由服务端判断一句话说完没有。'
              : holdMode
                ? `按住看板上的「按住说话」或空格说话，松开发送；在其他应用里按 ${shortcutLabel(window.api.platform)} 开始，再按一次发送。`
                : '一直开着麦克风，停顿超过下面的时长就翻译一句。'}
          </small>
        </div>
        {!holdMode && speakFeatures.vadTuning && (
          <div className="field">
            <label htmlFor={ids.silence}>停顿 {(speak.silenceMs / 1000).toFixed(1)} 秒算一句</label>
            <input
              id={ids.silence}
              type="range"
              min={300}
              max={2000}
              step={100}
              value={speak.silenceMs}
              onChange={(event) => set({ speak: { silenceMs: Number(event.target.value) } })}
            />
          </div>
        )}

        <h3>防回授</h3>
        <Switch
          label="播报我的译音时暂停收听"
          checked={settings.pauseListenWhileSpeaking}
          hint="外放时系统声音会把自己的译音录回去再翻一遍。戴耳机可以关掉。"
          onChange={(pauseListenWhileSpeaking) => set({ pauseListenWhileSpeaking })}
        />
      </div>
    </>
  )
}
