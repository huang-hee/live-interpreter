import { useId, useState, type ReactNode } from 'react'
import type { Option } from '../lib/devices'
import { EyeIcon } from './icons'

interface SelectFieldProps {
  label: string
  value: string
  options: Option[]
  disabled?: boolean
  hint?: ReactNode
  onChange: (value: string) => void
}

export function SelectField({
  label,
  value,
  options,
  disabled,
  hint,
  onChange
}: SelectFieldProps): React.JSX.Element {
  const id = useId()
  // 保存的设备被拔掉后，列表里找不到它，先临时挂一个选项，避免 select 显示错位
  const missing = !options.some((option) => option.value === value)
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        {missing && <option value={value}>已断开的设备</option>}
      </select>
      {hint && <small className="field-hint">{hint}</small>}
    </div>
  )
}

interface SegmentedProps<T extends string> {
  label: string
  value: T
  options: { value: T; label: string; disabled?: boolean }[]
  disabled?: boolean
  onChange: (value: T) => void
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange
}: SegmentedProps<T>): React.JSX.Element {
  const name = useId()
  return (
    <div className="segmented" role="radiogroup" aria-label={label} data-disabled={disabled}>
      {options.map((option) => (
        <label key={option.value}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled || option.disabled}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  )
}

interface SwitchProps {
  label: string
  checked: boolean
  disabled?: boolean
  hint?: ReactNode
  onChange: (checked: boolean) => void
}

/** 一行标题，下面一行说明 */
export function Switch({
  label,
  checked,
  disabled,
  hint,
  onChange
}: SwitchProps): React.JSX.Element {
  return (
    <label className="switch" data-disabled={disabled}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch-track" aria-hidden="true" />
      <span className="switch-text">
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  )
}

export function KeyInput({
  id,
  value,
  placeholder,
  onChange
}: {
  id: string
  value: string
  placeholder: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  return (
    <div className="key-input">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className="icon-button"
        aria-label={visible ? '隐藏 Key' : '显示 Key'}
        aria-pressed={visible}
        onClick={() => setVisible(!visible)}
      >
        <EyeIcon off={visible} />
      </button>
    </div>
  )
}
