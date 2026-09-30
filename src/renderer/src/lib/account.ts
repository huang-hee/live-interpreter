import type { Region } from '@shared/types'

export const REGION_NAMES: Record<Region, string> = {
  'cn-beijing': '北京',
  'ap-southeast-1': '新加坡'
}

export const KEY_HELP_URL = 'https://help.aliyun.com/zh/model-studio/get-api-key'

export interface GlossaryReport {
  count: number
  /** 格式不对的行，行号从 1 开始 */
  problems: string[]
}

/** 和主进程 parseGlossary 同一套规则：# 开头和空行跳过，其余必须是「原词 = 译法」 */
export function checkGlossary(text: string): GlossaryReport {
  let count = 0
  const problems: string[] = []
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const at = trimmed.indexOf('=')
    if (at < 0) problems.push(`第 ${index + 1} 行缺少 =`)
    else if (!trimmed.slice(0, at).trim()) problems.push(`第 ${index + 1} 行 = 前面没有原词`)
    else if (!trimmed.slice(at + 1).trim()) problems.push(`第 ${index + 1} 行 = 后面没有译法`)
    else count++
  })
  return { count, problems }
}
