export interface Language {
  code: string
  name: string
  /** 译文能否输出语音；不能的只出文字 */
  speech: boolean
}

// 语种代码与输出能力取自百炼「实时音视频翻译」文档的「支持的语种」表
export const MY_LANGUAGES: Language[] = [
  { code: 'zh', name: '中文', speech: true },
  { code: 'yue', name: '粤语', speech: false }
]

export const PEER_LANGUAGE_GROUPS: { label: string; languages: Language[] }[] = [
  {
    label: '常用',
    languages: [
      { code: 'en', name: '英语', speech: true },
      { code: 'ja', name: '日语', speech: true },
      { code: 'ko', name: '韩语', speech: true },
      { code: 'ru', name: '俄语', speech: true }
    ]
  },
  {
    label: '欧洲',
    languages: [
      { code: 'de', name: '德语', speech: true },
      { code: 'fr', name: '法语', speech: true },
      { code: 'es', name: '西班牙语', speech: true },
      { code: 'pt', name: '葡萄牙语', speech: true },
      { code: 'it', name: '意大利语', speech: true },
      { code: 'nl', name: '荷兰语', speech: true },
      { code: 'pl', name: '波兰语', speech: true },
      { code: 'cs', name: '捷克语', speech: true },
      { code: 'sv', name: '瑞典语', speech: true },
      { code: 'da', name: '丹麦语', speech: true },
      { code: 'nb', name: '挪威语', speech: true },
      { code: 'fi', name: '芬兰语', speech: true },
      { code: 'is', name: '冰岛语', speech: true },
      { code: 'el', name: '希腊语', speech: false },
      { code: 'uk', name: '乌克兰语', speech: false },
      { code: 'ro', name: '罗马尼亚语', speech: false },
      { code: 'hu', name: '匈牙利语', speech: false },
      { code: 'bg', name: '保加利亚语', speech: false },
      { code: 'hr', name: '克罗地亚语', speech: false },
      { code: 'sk', name: '斯洛伐克语', speech: false },
      { code: 'sl', name: '斯洛文尼亚语', speech: false }
    ]
  }
]

const ALL_LANGUAGES = [...MY_LANGUAGES, ...PEER_LANGUAGE_GROUPS.flatMap((group) => group.languages)]

export function findLanguage(code: string): Language | undefined {
  return ALL_LANGUAGES.find((language) => language.code === code)
}
