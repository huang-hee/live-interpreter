// 应用级端到端：Chromium 假麦克风 → 引擎窗口 AudioWorklet → IPC → 主进程 → 模拟百炼 → 看板 / 记录
// --use-mock-keychain 让加密 Key 走模拟钥匙串，不会弹系统授权框
// 运行：npm run test:e2e（会先构建）。截图和临时配置写到 tests/.output
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { startMock, MOCK_KEY, type MockConnection, type MockServer } from './mock-bailian'
import { writeTestSpeech } from './test-speech'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const out = join(project, 'tests/.output')
const shots = join(out, 'shots')
mkdirSync(shots, { recursive: true })
// 假麦克风循环播放的声音
const speech = join(out, 'speech48k.wav')
writeTestSpeech(speech, 48000)

const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`)
}

function makeProfile(name: string, patch: Record<string, unknown> = {}): string {
  const dir = join(out, 'profiles', name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const settings = {
    apiKey: MOCK_KEY,
    workspaceId: '',
    region: 'cn-beijing',
    model: 'qwen3.5-livetranslate-flash-realtime',
    myLanguage: 'zh',
    peerLanguage: 'en',
    pauseListenWhileSpeaking: true,
    theme: 'light',
    listen: { source: '', readAloud: true, outputDeviceId: '', glossary: 'staging = 预发' },
    speak: {
      inputDeviceId: '',
      outputDeviceId: '',
      monitor: false,
      mode: 'auto',
      silenceMs: 800,
      voiceMode: 'off',
      clonedVoice: null,
      glossary: '提测 = hand off to QA'
    },
    ...patch
  }
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2))
  return dir
}

interface Launched {
  app: ElectronApplication
  errors: string[]
}

async function launch(profile: string, mock: MockServer): Promise<Launched> {
  const app = await electron.launch({
    args: [
      '--use-mock-keychain',
      '--use-fake-device-for-media-stream',
      // 音频服务默认在沙箱里，读不到假麦克风用的音频文件
      '--disable-features=AudioServiceSandbox,AudioServiceOutOfProcess',
      `--use-file-for-fake-audio-capture=${speech}`,
      project
    ],
    // Playwright 默认把 prefers-color-scheme 固定成 light，关掉才能测主题切换
    colorScheme: null,
    env: {
      ...process.env,
      LIVE_INTERPRETER_USER_DATA: profile,
      LIVE_INTERPRETER_ENDPOINT: `ws://127.0.0.1:${mock.port}/api-ws/v1/realtime`
    }
  })
  const errors: string[] = []
  app.process().stderr?.on('data', (data) => {
    const text = String(data).trim()
    if (text && !/Debugger|inspector|DevTools listening/.test(text)) errors.push(text)
  })
  const watch = (page: Page): void => {
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`)
    })
  }
  // 引擎窗口在测试挂上监听之前就建好了，已有的窗口也要收集报错
  app.windows().forEach(watch)
  app.on('window', watch)
  await app.evaluate(({ app: electronApp, BrowserWindow, dialog }) => {
    const mute = (window: Electron.BrowserWindow): void => window.webContents.setAudioMuted(true)
    BrowserWindow.getAllWindows().forEach(mute)
    electronApp.on('browser-window-created', (_, window) => mute(window))
    // 清除账号会弹原生确认框，测试里直接当成点了「清除」
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  })
  return { app, errors }
}

/** 按 preload 报的角色找窗口 */
async function pageOf(app: ElectronApplication, role: string, timeout = 10000): Promise<Page> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    for (const page of app.windows()) {
      const found = await page.evaluate(() => window.api?.role).catch(() => undefined)
      if (found === role) {
        await page.waitForLoadState('domcontentloaded')
        return page
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`找不到 ${role} 窗口`)
}

async function hasRole(app: ElectronApplication, role: string): Promise<boolean> {
  for (const page of app.windows()) {
    if ((await page.evaluate(() => window.api?.role).catch(() => undefined)) === role) return true
  }
  return false
}

async function waitFor(predicate: () => Promise<boolean>, timeout = 8000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}

const statusOf = (page: Page, direction: 'listen' | 'speak'): Promise<string> =>
  page.evaluate((d) => window.api.getState().then((state) => state.channels[d].status), direction)

const lastConn = (mock: MockServer): MockConnection =>
  mock.stats.connections.at(-1) as MockConnection

const errorsIn = (errors: string[]): string[] => errors.filter((e) => /pageerror|console/.test(e))

/** 工具栏出现后会盖住字幕区，悬停不好用；直接派发进入、离开事件 */
async function showToolbar(overlay: Page): Promise<void> {
  await overlay.evaluate(() =>
    document
      .querySelector('.overlay')
      ?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: null }))
  )
  await overlay.waitForTimeout(250)
}

async function hideToolbar(overlay: Page): Promise<void> {
  await overlay.evaluate(() =>
    document
      .querySelector('.overlay')
      ?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }))
  )
  await overlay.waitForTimeout(900)
}

const mock = await startMock()
console.log('mock on', mock.port)

// ---------- 没有 Key：自动打开设置、功能禁用、填好后启用、清除后全部停止 ----------
{
  const profile = makeProfile('nokey', { apiKey: '' })
  const { app, errors } = await launch(profile, mock)
  const overlay = await pageOf(app, 'overlay')
  check('没 Key：启动时自动打开设置', await hasRole(app, 'settings'))
  const settings = await pageOf(app, 'settings')
  await overlay.waitForSelector('.caption-area')
  check(
    '没 Key：看板提示去填 Key',
    /还没填百炼 API Key/.test(await overlay.locator('.caption-area').innerText())
  )
  await showToolbar(overlay)
  check(
    '没 Key：看板上收听、说话禁用',
    (await overlay.getByRole('button', { name: /^收听/ }).isDisabled()) &&
      (await overlay.getByRole('button', { name: /^说话/ }).isDisabled())
  )
  await overlay.screenshot({ path: join(shots, '01-overlay-nokey.png') })
  await settings.screenshot({ path: join(shots, '02-settings-nokey.png') })

  await settings.getByLabel('阿里云百炼 API Key').fill('sk-wrong')
  await settings.getByRole('button', { name: '检查并保存' }).click()
  await settings.locator('.form-result').waitFor()
  check(
    '填错 Key：就地提示，不保存',
    /API Key 无效/.test(await settings.locator('.form-result').innerText())
  )
  await settings.getByLabel('阿里云百炼 API Key').fill(MOCK_KEY)
  await settings.getByRole('button', { name: '检查并保存' }).click()
  check(
    '填对 Key：检查通过后保存',
    await waitFor(async () => /已连上百炼/.test(await settings.locator('.form-result').innerText()))
  )
  await showToolbar(overlay)
  check(
    '填好 Key：看板上收听可用',
    !(await overlay.getByRole('button', { name: /^收听/ }).isDisabled())
  )
  await settings.waitForTimeout(700) // 设置写盘有 400ms 防抖
  const stored = readFileSync(join(profile, 'settings.json'), 'utf-8')
  check(
    'Key 加密后写进设置文件，没有明文',
    !stored.includes(MOCK_KEY) && stored.includes('encryptedApiKey')
  )

  await overlay.getByRole('button', { name: /^收听/ }).click()
  check('开始收听', await waitFor(async () => (await statusOf(overlay, 'listen')) === 'live'))
  const listenConn = lastConn(mock)
  await settings.getByRole('button', { name: '清除账号' }).click()
  check(
    '清除账号：收听停止',
    await waitFor(async () => (await statusOf(overlay, 'listen')) === 'idle')
  )
  check(
    '清除账号：到服务端的连接已断开',
    await waitFor(async () => listenConn.closedAt !== undefined)
  )
  check(
    '清除账号：Key 删掉了，功能重新禁用',
    !(await overlay.evaluate(() => window.api.getSettings().then((s) => s.hasApiKey))) &&
      (await overlay.getByRole('button', { name: /^收听/ }).isDisabled())
  )
  await app.close()
  check(
    '没 Key 流程无页面报错',
    errorsIn(errors).length === 0,
    errorsIn(errors).join(' | ').slice(0, 300)
  )
}

// ---------- 主流程 ----------
{
  const profile = makeProfile('main')
  const { app, errors } = await launch(profile, mock)
  const overlay = await pageOf(app, 'overlay')
  await overlay.waitForSelector('.caption-area')
  await overlay.waitForTimeout(500)
  check('有 Key：启动时不打开设置', !(await hasRole(app, 'settings')))

  await hideToolbar(overlay)
  const layout = await overlay.evaluate(() => {
    const area = document.querySelector('.caption-area')!.getBoundingClientRect()
    const toolbar = document.querySelector('.overlay-toolbar')!.getBoundingClientRect()
    return {
      root: getComputedStyle(document.querySelector('.overlay')!).backgroundColor,
      area: getComputedStyle(document.querySelector('.caption-area')!).backgroundColor,
      toolbar: getComputedStyle(document.querySelector('.overlay-toolbar')!).opacity,
      fullWidth: Math.round(area.width) === window.innerWidth,
      fillsBelowToolbar:
        Math.round(area.top) === Math.round(toolbar.bottom) &&
        Math.round(area.bottom) === window.innerHeight
    }
  })
  check(
    '看板：字幕区铺满宽高，没悬停时头部透明',
    layout.root === 'rgba(0, 0, 0, 0)' &&
      layout.area !== 'rgba(0, 0, 0, 0)' &&
      layout.toolbar === '0' &&
      layout.fullWidth &&
      layout.fillsBelowToolbar,
    JSON.stringify(layout)
  )
  await overlay.screenshot({ path: join(shots, '03-overlay-idle.png') })

  // 听和说
  await showToolbar(overlay)
  await overlay.getByRole('button', { name: /^收听/ }).click()
  check(
    '看板：点收听开始',
    await waitFor(async () => (await statusOf(overlay, 'listen')) === 'live')
  )
  const listenConn = lastConn(mock)
  await overlay.getByRole('button', { name: /^说话/ }).click()
  check(
    '看板：点说话开始',
    await waitFor(async () => (await statusOf(overlay, 'speak')) === 'live')
  )
  const speakConn = lastConn(mock)
  check(
    '模型：旧配置迁移后，听用 Qwen3.8、说保留原来的 Qwen3.5',
    /model=qwen3\.8-livetranslate-flash-realtime$/.test(listenConn.url ?? '') &&
      /model=qwen3\.5-livetranslate-flash-realtime$/.test(speakConn.url ?? ''),
    `${listenConn.url} / ${speakConn.url}`
  )
  check(
    '模型：听按 3.8 协议配置（默认普通断句，不发 3.5 的字段）',
    JSON.stringify(listenConn.config?.audio?.input?.turn_detection) ===
      JSON.stringify({ type: 'server_vad', threshold: 0.2, silence_duration_ms: 1000 }) &&
      listenConn.config?.output_modalities?.join() === 'text,audio' &&
      listenConn.config?.modalities === undefined &&
      listenConn.config?.translation?.corpus?.phrases?.['staging'] === '预发',
    JSON.stringify(listenConn.config)
  )
  const onair = await waitFor(
    async () => (await overlay.locator('.caption-area').getAttribute('data-onair')) === 'true',
    10000
  )
  check('看板：有人开口时亮上播灯', onair)
  await overlay.waitForTimeout(9000)
  check(
    '说：session.update 配置正确',
    speakConn.config?.sample_rate === 16000 &&
      (speakConn.config?.input_audio_transcription as { language?: string })?.language === 'zh' &&
      speakConn.config?.translation?.language === 'en' &&
      speakConn.config?.translation?.corpus?.phrases?.['提测'] === 'hand off to QA',
    JSON.stringify(speakConn.config)
  )
  check(
    '说：音频块 3200 字节（16kHz × 100ms）',
    speakConn.chunkSizes.size === 1 && speakConn.chunkSizes.has(3200)
  )
  const rate =
    (speakConn.audioBytes - 3200) /
    Math.max(0.5, ((speakConn.lastAppendAt ?? 0) - (speakConn.firstAppendAt ?? 0)) / 1000)
  check('说：上行码率约 32000 B/s', rate > 26000 && rate < 34000, `${Math.round(rate)} B/s`)
  const caption = await overlay.evaluate(() => {
    const element = document.querySelector<HTMLElement>('.caption[data-kind="translation"]')
    const lineHeight = element ? parseFloat(getComputedStyle(element).lineHeight) : 0
    return {
      text: element?.innerText ?? '',
      lines: element ? Math.round(element.clientHeight / lineHeight) : 0,
      source: document.querySelectorAll('.caption[data-kind="source"]').length,
      speakStrip: document.querySelectorAll('.speak-strip').length,
      width: element?.clientWidth ?? 0,
      areaWidth: element?.parentElement
        ? element.parentElement.clientWidth -
          parseFloat(getComputedStyle(element.parentElement).paddingLeft) -
          parseFloat(getComputedStyle(element.parentElement).paddingRight)
        : -1
    }
  })
  check(
    '看板：只显示对方的译文，原文和「说」默认不显示',
    /\[zh\] segment/.test(caption.text) &&
      !/\[en\]/.test(caption.text) &&
      caption.source === 0 &&
      caption.speakStrip === 0,
    caption.text.slice(0, 60)
  )
  check('看板：滚动字幕固定 2 行高', caption.lines === 2, `${caption.lines} 行`)
  check(
    '看板：字幕铺满看板宽度',
    Math.abs(caption.width - caption.areaWidth) <= 1,
    `字幕 ${caption.width}px / 可用 ${caption.areaWidth}px`
  )
  check(
    '防回授：自己的译音在播时收听暂停，按钮上显示「暂停中」',
    await waitFor(async () => {
      await showToolbar(overlay)
      return (await overlay.locator('.chip[data-channel="listen"] small').count()) > 0
    }, 10000)
  )
  const overlayBounds = (): Promise<{ y: number; height: number }> =>
    app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((w) => w.getTitle() === '同传')
      const bounds = window?.getBounds() ?? { y: 0, height: 0 }
      return { y: bounds.y, height: bounds.height }
    })
  const before = await overlayBounds()
  await showToolbar(overlay)
  await overlay.getByRole('button', { name: '说的字幕' }).click()
  const grown = await waitFor(async () => (await overlayBounds()).height > before.height)
  const after = await overlayBounds()
  check(
    '看板：打开「说的字幕」后窗口自动变高，底边不动',
    grown && after.y + after.height === before.y + before.height,
    `${JSON.stringify(before)} → ${JSON.stringify(after)}`
  )
  check(
    '看板：打开「说的字幕」后底部出现自己说的话',
    await waitFor(async () =>
      /\[en\] segment/.test(
        await overlay
          .locator('.speak-strip')
          .innerText()
          .catch(() => '')
      )
    )
  )
  // 说过好几句之后，字幕条上也只有最新一句
  await waitFor(async () => speakConn.segments >= 2, 12000)
  const stripText = await overlay.locator('.speak-strip').innerText()
  check(
    '看板：「说」的字幕条只显示最新一句，不往前拼',
    (stripText.match(/segment \d+/g) ?? []).length === 1,
    stripText.replace(/\s+/g, ' ').slice(0, 60)
  )
  await overlay.screenshot({ path: join(shots, '05b-overlay-speak-strip.png') })
  await overlay.getByRole('button', { name: '说的字幕' }).click()

  // 自定义颜色：看板在屏保层级置顶，系统取色面板会被压住，所以用页面内的取色器
  const textColor = (): Promise<string> =>
    overlay.evaluate(() => window.api.getSettings().then((s) => s.overlay.textColor))
  check(
    '取色：看板上不用系统取色控件',
    (await overlay.locator('input[type="color"]').count()) === 0
  )
  await waitFor(async () => (await overlayBounds()).height === before.height)
  const pickerClosed = await overlayBounds()
  await overlay.getByRole('button', { name: '自定义字色' }).click()
  const textPicker = overlay.getByRole('group', { name: '自定义字色' })
  const pickerGrown = await waitFor(
    async () => (await overlayBounds()).height > pickerClosed.height
  )
  const pickerOpen = await overlayBounds()
  check(
    '取色：点自定义字色，在看板里展开取色器，窗口变高、底边不动',
    (await textPicker.isVisible()) &&
      pickerGrown &&
      pickerOpen.y + pickerOpen.height === pickerClosed.y + pickerClosed.height,
    `${JSON.stringify(pickerClosed)} → ${JSON.stringify(pickerOpen)}`
  )
  await overlay.screenshot({ path: join(shots, '05c-overlay-color-picker.png') })
  await textPicker.getByRole('textbox', { name: '字色色值' }).fill('ff8800')
  check(
    '取色：输入色值（不带 #）后字幕变色并保存',
    await waitFor(
      async () =>
        (await textColor()) === '#ff8800' &&
        /255, 136, 0/.test(
          await overlay
            .locator('.caption[data-kind="translation"]')
            .evaluate((element) => getComputedStyle(element).color)
        )
    )
  )
  const hue = textPicker.getByRole('slider', { name: '色相' })
  const hueBefore = await hue.inputValue()
  await textPicker.getByRole('slider', { name: '饱和' }).press('Home')
  check(
    '取色：饱和度拖到 0 变灰，色相滑块不跟着跳',
    (await waitFor(async () => (await textColor()) === '#808080')) &&
      (await hue.inputValue()) === hueBefore,
    `${await textColor()}，色相 ${hueBefore} → ${await hue.inputValue()}`
  )
  await textPicker.getByRole('button', { name: '完成' }).click()
  check(
    '取色：点完成收起取色器，窗口缩回原高度',
    (await textPicker.count()) === 0 &&
      (await waitFor(async () => (await overlayBounds()).height === pickerClosed.height))
  )
  await overlay.getByRole('button', { name: '自定义底色' }).click()
  await overlay.getByRole('group', { name: '自定义底色' }).waitFor()
  await hideToolbar(overlay)
  check(
    '取色：工具栏收起时取色器一起收起',
    (await overlay.getByRole('group', { name: '自定义底色' }).count()) === 0 &&
      (await waitFor(async () => (await overlayBounds()).height === pickerClosed.height))
  )
  await showToolbar(overlay)
  await overlay.getByRole('radio', { name: '#ffffff' }).click()
  await waitFor(async () => (await textColor()) === '#ffffff')

  // 运行中切换对方语言：说的通道用新语言重连，听的通道（目标是我的语言）不受影响
  const connectionsBefore = mock.stats.connections.length
  await overlay.locator('.lang-select').nth(1).selectOption('ja')
  const restarted = await waitFor(async () => {
    const latest = mock.stats.connections.slice(connectionsBefore)
    return latest.some((conn) => conn.config?.translation?.language === 'ja')
  })
  check(
    '看板：运行中换语言，说的通道自动用新语言重连',
    restarted && mock.stats.connections.length - connectionsBefore === 1,
    `新建连接 ${mock.stats.connections.length - connectionsBefore} 条`
  )
  check(
    '看板：换语言后两条通道都还在跑',
    await waitFor(
      async () =>
        (await statusOf(overlay, 'listen')) === 'live' &&
        (await statusOf(overlay, 'speak')) === 'live'
    )
  )
  await overlay.locator('.lang-select').nth(1).selectOption('en')
  await waitFor(async () => lastConn(mock).config?.translation?.language === 'en')
  await hideToolbar(overlay)
  await overlay.screenshot({ path: join(shots, '04-overlay-live.png') })
  await showToolbar(overlay)
  await overlay.screenshot({ path: join(shots, '05-overlay-hover.png') })

  // 记录窗口
  await overlay.getByRole('button', { name: '记录' }).click()
  const records = await pageOf(app, 'records')
  await records.waitForSelector('.records-body')
  await records.waitForTimeout(1500)
  const listenRecords = await records
    .locator('.record-column[data-direction="listen"] .record')
    .count()
  const speakRecords = await records
    .locator('.record-column[data-direction="speak"] .record')
    .count()
  check(
    '记录：听、说两栏都有段落',
    listenRecords >= 1 && speakRecords >= 1,
    `听 ${listenRecords} 段，说 ${speakRecords} 段`
  )
  const firstSpeak = (
    await records.locator('.record-column[data-direction="speak"] .record').first().innerText()
  ).replace(/\s+/g, ' ')
  check(
    '记录：同一段里原文在上、译文在下',
    firstSpeak.indexOf('原文1') >= 0 &&
      firstSpeak.indexOf('原文1') < firstSpeak.indexOf('segment 1'),
    firstSpeak.slice(0, 80)
  )
  const subBg = (page: Page): Promise<string> =>
    page.evaluate(() =>
      getComputedStyle(document.querySelector('.panel')!).getPropertyValue('--sub-bg').trim()
    )
  check(
    '记录：颜色和透明度跟看板一致',
    (await subBg(records)) === (await subBg(overlay)),
    await subBg(records)
  )
  await overlay.evaluate(() =>
    window.api.saveSettings({ overlay: { backgroundOpacity: 0.8, backgroundColor: '#10263a' } })
  )
  check(
    '记录：看板改了底色，记录跟着变',
    await waitFor(async () => (await subBg(records)) === 'rgba(16, 38, 58, 0.8)')
  )
  await records.screenshot({ path: join(shots, '06-records.png') })
  await records.getByRole('button', { name: '置顶' }).click()
  const pinned = await waitFor(() =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((w) => w.getTitle() === '翻译记录' && w.isAlwaysOnTop())
    )
  )
  check('记录：点置顶后窗口保持在最上面', pinned)

  // 性能：服务端持续推送时界面收到的批次
  await overlay.evaluate(() => {
    ;(window as unknown as { __batches: number }).__batches = 0
    window.api.onTranslatorEvents(() => (window as unknown as { __batches: number }).__batches++)
  })
  await overlay.waitForTimeout(3000)
  const batches = await overlay.evaluate(
    () => (window as unknown as { __batches: number }).__batches
  )
  check('性能：3 秒内界面收到的批次不超过 70（50ms 合并）', batches <= 70, `${batches} 批`)

  // 断线重连、服务端错误（报错后紧跟着断开会被当成拒绝，所以先测断线）
  const beforeDrop = mock.stats.connections.length
  mock.stats.closeNext = true
  check(
    '断线：自动重连回来',
    await waitFor(async () => {
      const [listen, speak] = [await statusOf(overlay, 'listen'), await statusOf(overlay, 'speak')]
      return listen === 'live' && speak === 'live' && mock.stats.connections.length > beforeDrop
    }, 10000)
  )
  mock.stats.errorNext = true
  check(
    '错误事件：状态里带上服务端给的原因',
    await waitFor(() =>
      overlay.evaluate(() =>
        window.api
          .getState()
          .then((s) =>
            /模拟的服务端错误/.test(s.channels.listen.message + s.channels.speak.message)
          )
      )
    )
  )
  await showToolbar(overlay)
  await overlay.getByRole('button', { name: /停止收听/ }).click()
  await overlay.getByRole('button', { name: /停止说话/ }).click()
  check(
    '看板：点停止两条都结束',
    await waitFor(
      async () =>
        (await statusOf(overlay, 'listen')) === 'idle' &&
        (await statusOf(overlay, 'speak')) === 'idle'
    )
  )
  await records.getByRole('button', { name: '清空' }).click()
  check(
    '记录：清空后两栏都空了',
    await waitFor(
      async () =>
        (await records.locator('.record').count()) === 0 &&
        (await records.evaluate(() =>
          window.api.getRecords().then((r) => r.listen.length + r.speak.length)
        )) === 0
    )
  )

  // 设置：主题
  await overlay.getByRole('button', { name: '设置' }).click()
  const settings = await pageOf(app, 'settings')
  // 切换防回授开关后页面不能被顶上去
  await settings.getByRole('button', { name: '翻译' }).click()
  await settings.getByText('播报我的译音时暂停收听').click()
  const scrolled = await settings.evaluate(() => ({
    page: document.scrollingElement?.scrollTop ?? 0,
    nav: Math.round(document.querySelector('.settings-nav')!.getBoundingClientRect().bottom),
    height: window.innerHeight
  }))
  check(
    '设置：切换防回授开关后页面不错位',
    scrolled.page === 0 && scrolled.nav === scrolled.height,
    JSON.stringify(scrolled)
  )
  check(
    '设置：防回授开关确实生效',
    (await settings.evaluate(() =>
      window.api.getSettings().then((s) => s.pauseListenWhileSpeaking)
    )) === false
  )
  await settings.getByText('播报我的译音时暂停收听').click()
  await settings.getByRole('button', { name: '外观' }).click()
  await settings.getByText('黑夜', { exact: true }).click()
  check(
    '主题：选黑夜后设置窗口变深色',
    await waitFor(
      async () =>
        (await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)) === 'dark' &&
        (await settings.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
    )
  )
  await settings.screenshot({ path: join(shots, '07-settings-dark-appearance.png') })
  await settings.getByText('白天', { exact: true }).click()
  check(
    '主题：选白天后回到浅色',
    await waitFor(
      async () =>
        !(await settings.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
    )
  )

  // 设置窗口的外观页用同一个取色器
  await settings.getByRole('button', { name: '自定义底色' }).click()
  const backgroundPicker = settings.getByRole('group', { name: '自定义底色' })
  await backgroundPicker.getByRole('textbox', { name: '底色色值' }).fill('#224466')
  check(
    '取色：设置里的自定义底色可以输入色值',
    await waitFor(
      async () =>
        (await settings.evaluate(() =>
          window.api.getSettings().then((s) => s.overlay.backgroundColor)
        )) === '#224466'
    )
  )
  await settings.screenshot({ path: join(shots, '07b-settings-color-picker.png') })
  await backgroundPicker.getByRole('textbox', { name: '底色色值' }).press('Escape')
  check('取色：按 Esc 收起取色器', (await backgroundPicker.count()) === 0)
  await settings.getByRole('radio', { name: '#000000' }).click()

  // 按住说话
  await settings.getByRole('button', { name: '翻译' }).click()
  await settings.getByText('按住说话', { exact: true }).click()
  await settings.screenshot({ path: join(shots, '08-settings-translate.png') })
  await showToolbar(overlay)
  await overlay.getByRole('button', { name: /^说话/ }).click()
  await waitFor(async () => (await statusOf(overlay, 'speak')) === 'live')
  const holdConn = lastConn(mock)
  check('按住说话：turn_detection 为 null', holdConn.config?.turn_detection === null)
  await overlay.waitForTimeout(1200)
  check('按住说话：没按住时不上传音频', holdConn.audioBytes === 0, `${holdConn.audioBytes} 字节`)
  await showToolbar(overlay)
  const holdButton = overlay.getByRole('button', { name: '按住说话' })
  const box = await holdButton.boundingBox()
  await overlay.mouse.move((box?.x ?? 0) + 10, (box?.y ?? 0) + 10)
  await overlay.mouse.down()
  await overlay.waitForTimeout(2500)
  await overlay.mouse.up()
  const releasedBytes = holdConn.audioBytes
  check(
    '按住说话：按住期间上传，松开后再送一小段尾巴才提交',
    await waitFor(
      async () =>
        releasedBytes > 0 &&
        holdConn.commits === 1 &&
        // 尾巴 0.4 秒 = 4 块，留一块余量
        holdConn.audioBytes - releasedBytes >= 3200 * 3
    ),
    `松开时 ${releasedBytes} 字节，提交时 ${holdConn.audioBytes} 字节，commits=${holdConn.commits}`
  )
  await overlay.getByRole('button', { name: /停止说话/ }).click()
  await waitFor(async () => (await statusOf(overlay, 'speak')) === 'idle')

  // 固定音色：录一段复刻，会话里用上这个音色
  await settings.getByText('停顿自动断句', { exact: true }).click()
  await settings.getByRole('button', { name: '音色' }).click()
  await settings.getByText('固定音色', { exact: true }).click()
  await settings.getByRole('button', { name: '开始录音' }).click()
  await settings.waitForTimeout(11000)
  await settings.screenshot({ path: join(shots, '09-settings-voice-recording.png') })
  await settings.getByRole('button', { name: '录好了' }).click()
  check(
    '固定音色：复刻成功',
    await waitFor(
      async () =>
        /音色复刻好了/.test(
          await settings
            .locator('.form-result')
            .innerText()
            .catch(() => '')
        ),
      10000
    )
  )
  const enrollment = mock.stats.enrollments.find((item) => item.action === 'create')
  check(
    '固定音色：复刻请求用同传模型、采样率不低于 24kHz、10 秒以上',
    enrollment?.targetModel === 'qwen3.5-livetranslate-flash-realtime' &&
      (enrollment.sampleRate ?? 0) >= 24000 &&
      (enrollment.seconds ?? 0) >= 10,
    JSON.stringify(enrollment)
  )
  await showToolbar(overlay)
  await overlay.getByRole('button', { name: /^说话/ }).click()
  await waitFor(async () => (await statusOf(overlay, 'speak')) === 'live')
  const voiceConn = lastConn(mock)
  check(
    '固定音色：会话用复刻的音色 ID，frequency=never',
    voiceConn.config?.voice === 'qwen-translate-vc-mock-1' &&
      (voiceConn.config?.voice_clone_options as { frequency?: string })?.frequency === 'never',
    JSON.stringify({
      voice: voiceConn.config?.voice,
      options: voiceConn.config?.voice_clone_options
    })
  )
  await overlay.getByRole('button', { name: /停止说话/ }).click()
  await settings.getByRole('button', { name: '删除音色' }).click()
  check(
    '固定音色：删除时也删掉服务端的音色',
    await waitFor(async () => mock.stats.enrollments.some((item) => item.action === 'delete'))
  )

  await app.close()
  check(
    '主流程无页面报错',
    errorsIn(errors).length === 0,
    errorsIn(errors).join(' | ').slice(0, 300)
  )
}

// ---------- 退出：正常退出先结束会话，强杀进程连接也会断 ----------
// ---------- 换模型、字幕显示方式 ----------
{
  const profile = makeProfile('models')
  const { app } = await launch(profile, mock)
  const overlay = await pageOf(app, 'overlay')
  await overlay.waitForSelector('.caption-area')
  await showToolbar(overlay)
  await overlay.getByRole('button', { name: /^收听/ }).click()
  await waitFor(async () => (await statusOf(overlay, 'listen')) === 'live')
  // 只取字幕正文；没字时的提示语里也有「…」
  // 服务端报错后立刻断开：当成被拒绝，停下来显示原因，不无限重连
  const connectionsBefore = mock.stats.connections.length
  mock.stats.rejectNext = true
  const stopped = await waitFor(async () => (await statusOf(overlay, 'listen')) === 'error')
  await overlay.waitForTimeout(2500)
  const message = await overlay.evaluate(() =>
    window.api.getState().then((s) => s.channels.listen.message)
  )
  check(
    '被拒绝：报错后紧跟着断开就停下，不再重连',
    stopped &&
      mock.stats.connections.length === connectionsBefore &&
      /服务端拒绝了这次会话：模拟的拒绝/.test(message),
    message
  )
  await showToolbar(overlay)
  await overlay.getByRole('button', { name: /^收听/ }).click()
  await waitFor(async () => (await statusOf(overlay, 'listen')) === 'live')

  const caption = (): Promise<string> =>
    overlay.evaluate(
      () =>
        document.querySelector('.caption[data-kind="translation"] .caption-text')?.textContent ?? ''
    )

  await overlay.getByRole('button', { name: '设置' }).click()
  const settings = await pageOf(app, 'settings')
  await settings.getByRole('button', { name: '翻译' }).click()
  const before = mock.stats.connections.length
  await settings.getByLabel('模型', { exact: true }).first().selectOption({ label: 'Qwen3.5 同传' })
  const switched = await waitFor(
    async () =>
      mock.stats.connections.length > before &&
      /qwen3\.5/.test(lastConn(mock).url ?? '') &&
      (await statusOf(overlay, 'listen')) === 'live'
  )
  const conn = lastConn(mock)
  check(
    '模型：运行中把听换成 Qwen3.5，自动用新模型重连，断句参数按设置发',
    switched &&
      JSON.stringify(conn.config?.turn_detection) ===
        JSON.stringify({ type: 'server_vad', threshold: 0.2, silence_duration_ms: 1000 }),
    JSON.stringify(conn.config?.turn_detection)
  )
  await settings.screenshot({ path: join(shots, '08-settings-models.png') })

  // 稳定优先：模拟服务推的尾巴是「…」，默认不上字幕
  const samples: string[] = []
  for (let i = 0; i < 12; i++) {
    samples.push(await caption())
    await overlay.waitForTimeout(250)
  }
  check(
    '字幕：默认只显示确认过的译文，不显示会被改写的尾巴',
    samples.some((text) => /segment/.test(text)) && samples.every((text) => !text.includes('…')),
    samples.at(-1)?.slice(-40)
  )
  await settings.getByText('字幕里显示还没确认的译文').click()
  check(
    '字幕：打开「显示还没确认的译文」后尾巴也上字幕',
    await waitFor(async () => (await caption()).includes('…'))
  )

  // 说换成 3.8：按住说话能用（按 3.8 的写法关掉服务端断句），固定音色不支持
  await settings.getByLabel('模型', { exact: true }).nth(1).selectOption({ label: 'Qwen3.8 同传' })
  await settings.getByText('按住说话', { exact: true }).click()
  await showToolbar(overlay)
  await overlay.getByRole('button', { name: /^说话/ }).click()
  const holdStarted = await waitFor(
    async () =>
      (await statusOf(overlay, 'speak')) === 'live' && /qwen3\.8/.test(lastConn(mock).url ?? '')
  )
  const holdConn = lastConn(mock)
  check(
    '模型：说用 Qwen3.8 按住说话，关掉的是 audio.input 下的服务端断句',
    holdStarted &&
      holdConn.config?.audio?.input?.turn_detection === null &&
      holdConn.config?.turn_detection === undefined,
    JSON.stringify(holdConn.config?.audio)
  )
  await settings.getByRole('button', { name: '音色' }).click()
  check(
    '模型：说换成 Qwen3.8 后，固定音色不可选，边说边复刻可选',
    (await settings.getByRole('radio', { name: '固定音色' }).isDisabled()) &&
      !(await settings.getByRole('radio', { name: '边说边复刻' }).isDisabled()) &&
      (await settings.getByText(/不支持固定音色/).isVisible())
  )
  await app.close()
}

{
  const profile = makeProfile('quit')
  const { app } = await launch(profile, mock)
  const overlay = await pageOf(app, 'overlay')
  await overlay.waitForSelector('.caption-area')
  await showToolbar(overlay)
  await overlay.getByRole('button', { name: /^收听/ }).click()
  await overlay.getByRole('button', { name: /^说话/ }).click()
  await waitFor(
    async () =>
      (await statusOf(overlay, 'listen')) === 'live' &&
      (await statusOf(overlay, 'speak')) === 'live'
  )
  const live = mock.stats.connections.slice(-2)
  await app.close()
  check(
    '⌘Q 正常退出：两条会话都先发 session.finish 再断开',
    live.every((conn) => conn.finished && conn.closedAt !== undefined),
    JSON.stringify(
      live.map((conn) => ({ finished: conn.finished, closed: conn.closedAt !== undefined }))
    )
  )
}
{
  const profile = makeProfile('crash')
  const { app } = await launch(profile, mock)
  const overlay = await pageOf(app, 'overlay')
  await overlay.waitForSelector('.caption-area')
  await showToolbar(overlay)
  await overlay.getByRole('button', { name: /^收听/ }).click()
  await waitFor(async () => (await statusOf(overlay, 'listen')) === 'live')
  const conn = lastConn(mock)
  const killedAt = Date.now()
  app.process().kill('SIGKILL')
  const closed = await waitFor(async () => conn.closedAt !== undefined, 5000)
  check(
    '异常退出（强杀进程）：服务端很快看到连接断开',
    closed,
    closed ? `${(conn.closedAt ?? 0) - killedAt} ms 后断开` : '5 秒内没断开'
  )
}

await mock.close()
const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length)
  console.log('失败：\n' + failed.map((f) => `  - ${f.name}: ${f.detail}`).join('\n'))
process.exitCode = failed.length ? 1 : 0
