import { useId, useState, type FormEvent } from 'react'
import type { PublicSettings, Region, Result, SettingsPatch } from '@shared/types'
import { KeyInput } from '../components/fields'
import { KEY_HELP_URL, REGION_NAMES } from '../lib/account'

interface Props {
  settings: PublicSettings
  save: (patch: SettingsPatch) => Promise<void>
}

export function AccountSection({ settings, save }: Props): React.JSX.Element {
  const ids = { key: useId(), region: useId(), workspace: useId() }
  const [apiKey, setApiKey] = useState('')
  const [region, setRegion] = useState<Region>(settings.region)
  const [workspaceId, setWorkspaceId] = useState(settings.workspaceId)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setResult(null)
    const draft = { apiKey: apiKey.trim() || undefined, region, workspaceId: workspaceId.trim() }
    const checked = await window.api.checkConnection(draft)
    if (checked.ok) {
      await save({
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        region,
        workspaceId: draft.workspaceId
      })
      setApiKey('')
      setResult({ ok: true, message: `已连上百炼（${REGION_NAMES[region]}），已保存。` })
    } else {
      setResult(checked)
    }
    setBusy(false)
  }

  const clear = async (): Promise<void> => {
    if (!(await window.api.clearAccount())) return
    setApiKey('')
    setRegion('cn-beijing')
    setWorkspaceId('')
    setResult({ ok: true, message: '账号已清除，所有通道都已停止。' })
  }

  const canSubmit = (apiKey.trim() || settings.hasApiKey) && !busy

  return (
    <>
      <header className="section-head">
        <h2>账号</h2>
        <p>
          {settings.hasApiKey
            ? `已保存 Key（末四位 ${settings.apiKeyHint}），地域：${REGION_NAMES[settings.region]}`
            : '还没有保存 API Key，收听和说话都用不了。'}
        </p>
      </header>

      <form className="section-body" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor={ids.key}>阿里云百炼 API Key</label>
          <KeyInput
            id={ids.key}
            value={apiKey}
            placeholder={
              settings.hasApiKey ? `留空保持原来的 Key（${settings.apiKeyHint}）` : 'sk-…'
            }
            onChange={setApiKey}
          />
          <small className="field-hint">
            只保存在这台电脑上，用系统的加密存储保存，安装包里不会带上。
            <a href={KEY_HELP_URL} target="_blank" rel="noreferrer">
              API Key 在哪找
            </a>
          </small>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor={ids.region}>地域</label>
            <select
              id={ids.region}
              value={region}
              onChange={(event) => setRegion(event.target.value as Region)}
            >
              {Object.entries(REGION_NAMES).map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.workspace}>业务空间 ID（可选）</label>
            <input
              id={ids.workspace}
              spellCheck={false}
              placeholder="留空走通用域名"
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
            />
          </div>
        </div>
        <small className="field-hint">
          Key 要和地域对应，北京的 Key 不能用在新加坡。业务空间 ID
          在百炼控制台的「业务空间详情」里。
        </small>
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={!canSubmit}>
            {busy ? '检查中…' : '检查并保存'}
          </button>
          {result && (
            <span className="form-result" data-ok={result.ok} role="status">
              {result.message}
            </span>
          )}
        </div>
      </form>

      <section className="danger-zone">
        <div>
          <h3>清除账号</h3>
          <p>停止所有通道，删掉这台电脑上保存的 Key，并删除复刻的音色。</p>
        </div>
        <button
          type="button"
          className="button-danger"
          disabled={!settings.hasApiKey && !settings.workspaceId && !settings.speak.clonedVoice}
          onClick={() => void clear()}
        >
          清除账号
        </button>
      </section>
    </>
  )
}
