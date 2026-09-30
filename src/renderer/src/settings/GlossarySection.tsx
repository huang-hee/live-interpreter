import { useEffect, useId, useRef, useState } from 'react'
import type { PublicSettings, SettingsPatch } from '@shared/types'
import { checkGlossary } from '../lib/account'

/** 停手这么久或离开输入框就保存 */
const SAVE_DELAY_MS = 600

interface FieldProps {
  label: string
  value: string
  onSave: (value: string) => void
}

function GlossaryField({ label, value, onSave }: FieldProps): React.JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(value)
  const timer = useRef<number | undefined>(undefined)
  const report = checkGlossary(draft)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const flush = (text: string): void => {
    window.clearTimeout(timer.current)
    if (text !== value) onSave(text)
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={12}
        spellCheck={false}
        value={draft}
        onChange={(event) => {
          const text = event.target.value
          setDraft(text)
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => flush(text), SAVE_DELAY_MS)
        }}
        onBlur={() => flush(draft)}
      />
      <small className="field-hint" data-kind={report.problems.length ? 'warn' : undefined}>
        {report.count} 条生效
        {report.problems.length > 0 &&
          `；${report.problems.slice(0, 2).join('，')}${report.problems.length > 2 ? '…' : ''}，这些行会被跳过`}
      </small>
    </div>
  )
}

interface Props {
  settings: PublicSettings
  save: (patch: SettingsPatch) => Promise<void>
}

export function GlossarySection({ settings, save }: Props): React.JSX.Element {
  return (
    <>
      <header className="section-head">
        <h2>术语表</h2>
        <p>
          一行一条「原词 = 译法」，# 开头的行不生效。适合固定项目名、技术词的译法，建议不超过 1000
          条。
        </p>
      </header>
      <div className="section-body">
        <div className="field-row">
          <GlossaryField
            label="听：对方的词 → 中文"
            value={settings.listen.glossary}
            onSave={(glossary) => void save({ listen: { glossary } })}
          />
          <GlossaryField
            label="说：中文 → 对方的词"
            value={settings.speak.glossary}
            onSave={(glossary) => void save({ speak: { glossary } })}
          />
        </div>
      </div>
    </>
  )
}
