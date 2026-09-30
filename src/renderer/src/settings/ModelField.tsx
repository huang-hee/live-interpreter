import { useId, useState } from 'react'
import {
  findPreset,
  MODEL_PRESETS,
  PROTOCOL_NAMES,
  type ModelChoice,
  type ModelProtocol
} from '@shared/models'
import { Segmented } from '../components/fields'

const CUSTOM = 'custom'

const PROTOCOLS = (Object.keys(PROTOCOL_NAMES) as ModelProtocol[]).map((value) => ({
  value,
  label: PROTOCOL_NAMES[value]
}))

interface Props {
  value: ModelChoice
  onChange: (model: ModelChoice) => void
}

/** 预设模型下拉；百炼出了同一套协议的新模型，可以选「自定义」直接填 ID */
export function ModelField({ value, onChange }: Props): React.JSX.Element {
  const ids = { select: useId(), custom: useId() }
  const preset = findPreset(value.id)
  const [custom, setCustom] = useState(!preset)
  const [draft, setDraft] = useState(preset ? '' : value.id)

  const commit = (): void => {
    const id = draft.trim()
    if (id && id !== value.id) onChange({ id, protocol: value.protocol })
  }

  return (
    <div className="field">
      <label htmlFor={ids.select}>模型</label>
      <select
        id={ids.select}
        value={custom ? CUSTOM : value.id}
        onChange={(event) => {
          const next = findPreset(event.target.value)
          setCustom(!next)
          if (next) onChange({ id: next.id, protocol: next.protocol })
        }}
      >
        {MODEL_PRESETS.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
        <option value={CUSTOM}>自定义模型 ID…</option>
      </select>
      {custom ? (
        <div className="model-custom">
          <input
            id={ids.custom}
            aria-label="模型 ID"
            placeholder="百炼上的实时同传模型 ID"
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit()
            }}
          />
          <Segmented
            label="对接协议"
            value={value.protocol}
            options={PROTOCOLS}
            onChange={(protocol) => onChange({ id: draft.trim() || value.id, protocol })}
          />
          <small className="field-hint">
            填好按回车生效。协议看模型文档：参数用 output_modalities、文本事件是 delta 的按
            3.8，否则按 3.5。
          </small>
        </div>
      ) : (
        <small className="field-hint">{preset?.note}</small>
      )}
    </div>
  )
}
