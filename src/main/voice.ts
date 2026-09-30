import type { AppSettings, ClonedVoice, Region } from '../shared/types'

// 接口见百炼文档「声音复刻 API 参考」（qwen-voice-enrollment）。
// 同传模型的文档要求复刻时 target_model 填实际使用的翻译模型，会话里再用 frequency=never 加这个音色 ID。

const LEGACY_HOSTS: Record<Region, string> = {
  'cn-beijing': 'dashscope.aliyuncs.com',
  'ap-southeast-1': 'dashscope-intl.aliyuncs.com'
}

const ENROLLMENT_PATH = '/api/v1/services/audio/tts/customization'
/** 只能用字母、数字、下划线，不超过 16 个字符，会出现在音色 ID 里 */
const PREFERRED_NAME = 'interpreter'

interface EnrollmentResponse {
  output?: { voice?: string }
  code?: string
  message?: string
}

/** endpointOverride 是开发调试用的 WebSocket 地址，取它的协议和主机，换成 HTTP */
function restBase(settings: AppSettings, endpointOverride?: string): string {
  if (endpointOverride) {
    const url = new URL(endpointOverride)
    return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`
  }
  const workspaceId = settings.workspaceId.trim()
  const host = workspaceId
    ? `${workspaceId}.${settings.region}.maas.aliyuncs.com`
    : LEGACY_HOSTS[settings.region]
  return `https://${host}`
}

async function enroll(
  settings: AppSettings,
  input: Record<string, unknown>,
  endpointOverride?: string
): Promise<EnrollmentResponse> {
  const response = await fetch(`${restBase(settings, endpointOverride)}${ENROLLMENT_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen-voice-enrollment',
      parameters: { voice_clone_mode: 'normal' },
      input
    })
  })
  const body = (await response.json().catch(() => ({}))) as EnrollmentResponse
  if (!response.ok) {
    if (response.status === 401) throw new Error('API Key 无效，没法复刻音色')
    throw new Error(
      body.message
        ? `${body.message}（${body.code ?? response.status}）`
        : `复刻失败（HTTP ${response.status}）`
    )
  }
  return body
}

/** wav 需是单声道 16 位、采样率不低于 24kHz、10~20 秒的朗读 */
export async function createVoice(
  settings: AppSettings,
  wav: Buffer,
  endpointOverride?: string
): Promise<ClonedVoice> {
  const body = await enroll(
    settings,
    {
      action: 'create',
      target_model: settings.speak.model.id,
      preferred_name: PREFERRED_NAME,
      audio: { data: `data:audio/wav;base64,${wav.toString('base64')}` }
    },
    endpointOverride
  )
  const id = body.output?.voice
  if (!id) throw new Error('服务没有返回音色 ID')
  return { id, model: settings.speak.model.id, createdAt: Date.now() }
}

export async function deleteVoice(
  settings: AppSettings,
  voiceId: string,
  endpointOverride?: string
): Promise<void> {
  await enroll(settings, { action: 'delete', voice: voiceId }, endpointOverride)
}
