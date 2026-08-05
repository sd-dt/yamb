import blessed from 'blessed'
import type { BotInstance } from '../../platform/bot-runtime'
import logBus, { type LogEntry } from '../../platform/log-bus'
import { isBrewingContext } from '../../state/types'
import { formatBrewingStatus } from '../../state/brewing-status'

const MAX_LINES_PER_TAB = 1000
const SYS_TAB = '__sys__'
/** ↑/↓ 每次滚动行数 */
const LINE_SCROLL = 3

type TabId = typeof SYS_TAB | string

export interface TuiOptions {
  onExit: () => void
}

export interface TuiHandle {
  destroy: () => void
}

/**
 * 多实例 TUI：标签切换、固定布局、可翻滚历史、底部发送。
 * 第一个标签 sys = 进程级日志；其后为各 bot 实例。
 *
 * 滚动不依赖 blessed.scroll（setContent 后常失效），
 * 改为维护「距底部偏移」并只渲染当前视口行。
 */
export function startTui (instances: BotInstance[], options: TuiOptions): TuiHandle {
  if (instances.length === 0) {
    throw new Error('startTui requires at least one bot instance')
  }

  logBus.startCapture()

  const tabs: TabId[] = [SYS_TAB, ...instances.map(i => i.id)]
  let selectedIndex = 1 // 默认打开第一个 bot 实例
  let destroyed = false
  /** 距底部的行偏移；0 = 贴底跟随新日志 */
  let viewOffset = 0
  let exiting = false

  const logLinesByTab = new Map<TabId, string[]>()
  for (const id of tabs) {
    logLinesByTab.set(id, [])
  }

  const screen = blessed.screen({
    smartCSR: true,
    title: 'yamb',
    fullUnicode: true,
    dockBorders: true,
    autoPadding: false
  })

  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    tags: true,
    mouse: true,
    autoFocus: false,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' } },
    label: ' Instances '
  })

  const logBox = blessed.box({
    parent: screen,
    top: 3,
    left: 0,
    width: '100%',
    bottom: 3,
    tags: true,
    border: { type: 'line' },
    scrollable: false,
    keys: false,
    mouse: false,
    style: {
      border: { fg: 'gray' }
    }
  })

  const input = blessed.textbox({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    keys: true,
    mouse: true,
    inputOnFocus: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'green' },
      focus: { border: { fg: 'yellow' } }
    },
    label: ' Send '
  })

  const cursorInput = input as typeof input & {
    _updateCursor?: (get?: boolean) => void
  }
  const cursorProgram = screen.program as typeof screen.program & {
    x: number
    y: number
  }

  // 屏幕重绘会让终端硬件光标短暂跟随日志输出。重绘期间隐藏光标，
  // 完成后强制 blessed 重新计算输入框位置再显示，避免光标停在日志区。
  screen.on('prerender', () => {
    cursorProgram.hideCursor()
  })
  screen.on('render', () => {
    if (destroyed || screen.focused !== input) return
    // 绕过 blessed 对 program.x/y 的错误缓存判断，强制发出 CUP 定位。
    cursorProgram.x = -1
    cursorProgram.y = -1
    cursorInput._updateCursor?.(true)
    cursorProgram.showCursor()
  })

  function currentTabId (): TabId {
    return tabs[selectedIndex]
  }

  function currentInstance (): BotInstance | null {
    const id = currentTabId()
    if (id === SYS_TAB) return null
    return instances.find(i => i.id === id) ?? null
  }

  function playerName (inst: BotInstance): string {
    return inst.mcBot.bot?.username || inst.config.minecraft.username || '?'
  }

  function statusLabel (inst: BotInstance): string {
    if (inst.mcBot.isReady) return '{green-fg}Online{/}'
    if (inst.mcBot.bot) return '{yellow-fg}Connecting{/}'
    return '{red-fg}Offline{/}'
  }

  function modeLabel (inst: BotInstance): string {
    try {
      if (inst.botState.isBrewing()) {
        const context = inst.botState.getContext()
        if (isBrewingContext(context)) return formatBrewingStatus(context)
      }
      const aging = inst.brewModule.formatAgingStatusLines()
      if (aging.length > 0) return aging[0]
      return inst.botState.getMode()
    } catch {
      return '?'
    }
  }

  function tabLabel (id: TabId): string {
    return id === SYS_TAB ? 'sys' : id
  }

  function viewportHeight (): number {
    const h = typeof logBox.height === 'number' ? logBox.height : 10
    // 减去上下边框
    return Math.max(1, h - 2)
  }

  function maxOffset (lineCount: number): number {
    return Math.max(0, lineCount - viewportHeight())
  }

  function renderHeader (): void {
    // 选中：浅蓝色 + []；未选中：默认（终端 TUI 粗体往往无效）
    const tabStr = tabs.map((id, i) => {
      const label = tabLabel(id)
      if (i === selectedIndex) return `{cyan-fg}[${label}]{/}`
      return ` ${label} `
    }).join('')

    const scrollHint = viewOffset > 0
      ? ` | {yellow-fg}↑${viewOffset}{/}`
      : ''

    const inst = currentInstance()
    if (!inst) {
      header.setContent(
        ` ${tabStr} | process${scrollHint}{|} — | — `
      )
      return
    }

    header.setContent(
      ` ${tabStr} | ${playerName(inst)}${scrollHint}{|} {cyan-fg}${modeLabel(inst)}{/} | ${statusLabel(inst)} `
    )
  }

  /** TUI 已按标签分页，去掉 [Bot:id]；headless 仍保留原日志 */
  function stripBotTag (text: string): string {
    return text.replace(/\[Bot:[^\]]+\]\s*/g, '')
  }

  function formatEntry (entry: LogEntry): string {
    const time = new Date(entry.at).toLocaleTimeString()
    const text = stripBotTag(entry.text)
    if (entry.level === 'error') return `{red-fg}${time} ${text}{/}`
    if (entry.level === 'warn') return `{yellow-fg}${time} ${text}{/}`
    return `${time} ${text}`
  }

  function pushLine (tabId: TabId, line: string): void {
    const list = logLinesByTab.get(tabId)
    if (!list) return
    list.push(line)
    if (list.length > MAX_LINES_PER_TAB) list.shift()
  }

  function refreshLogs (): void {
    const id = currentTabId()
    const lines = logLinesByTab.get(id) || []
    const vh = viewportHeight()
    const maxOff = maxOffset(lines.length)
    if (viewOffset > maxOff) viewOffset = maxOff

    if (lines.length === 0) {
      logBox.setContent('{gray-fg}(no logs){/}')
      return
    }

    // 从底部往上取视口：offset=0 显示最后 vh 行
    const end = lines.length - viewOffset
    const start = Math.max(0, end - vh)
    const slice = lines.slice(start, end)
    logBox.setContent(slice.join('\n'))
  }

  function selectIndex (index: number): void {
    selectedIndex = (index + tabs.length) % tabs.length
    viewOffset = 0
    renderHeader()
    refreshLogs()
    const inst = currentInstance()
    input.setLabel(inst ? ' Send ' : ' Send (sys · read-only) ')
    screen.render()
  }

  function scrollBy (delta: number): void {
    const lines = logLinesByTab.get(currentTabId()) || []
    const maxOff = maxOffset(lines.length)
    // delta>0 往上看更旧日志
    viewOffset = Math.max(0, Math.min(maxOff, viewOffset + delta))
    renderHeader()
    refreshLogs()
    screen.render()
  }

  // 回放：sys + 各实例（互不混入）
  for (const entry of logBus.getRecent(null, MAX_LINES_PER_TAB)) {
    pushLine(SYS_TAB, formatEntry(entry))
  }
  for (const inst of instances) {
    for (const entry of logBus.getRecent(inst.id, MAX_LINES_PER_TAB)) {
      pushLine(inst.id, formatEntry(entry))
    }
  }

  const onLog = (entry: LogEntry): void => {
    const tabId: TabId = entry.botId ?? SYS_TAB
    if (!logLinesByTab.has(tabId)) return

    pushLine(tabId, formatEntry(entry))
    if (tabId !== currentTabId()) return

    // 贴底时跟随；上翻查看时保持偏移（新行在底部之外）
    if (viewOffset === 0) {
      refreshLogs()
    } else {
      // 顶部被截断时偏移需跟着减，避免视口跳动
      const lines = logLinesByTab.get(tabId) || []
      if (lines.length >= MAX_LINES_PER_TAB) {
        viewOffset = Math.max(0, viewOffset - 1)
      }
      refreshLogs()
    }
    screen.render()
  }
  logBus.on('log', onLog)

  const statusTimer = setInterval(() => {
    if (destroyed) return
    renderHeader()
    screen.render()
  }, 1000)

  const switchPrev = (): void => { selectIndex(selectedIndex - 1) }
  const switchNext = (): void => { selectIndex(selectedIndex + 1) }

  // textbox 的 inputOnFocus 会打开 grabKeys：screen.key 全部被跳过，
  // 只能从 input 的 keypress 里处理导航（与内部 _listener 并存）。
  input.on('keypress', (_ch: string, key: { name?: string, shift?: boolean, full?: string }) => {
    if (!key?.name) return
    switch (key.name) {
      case 'up':
        scrollBy(LINE_SCROLL)
        break
      case 'down':
        scrollBy(-LINE_SCROLL)
        break
      case 'pageup':
        scrollBy(viewportHeight())
        break
      case 'pagedown':
        scrollBy(-viewportHeight())
        break
      case 'left':
        switchPrev()
        break
      case 'right':
        switchNext()
        break
      case 'tab':
        if (key.shift) switchPrev()
        else switchNext()
        break
      default:
        break
    }
  })

  input.key(['1', '2', '3', '4', '5', '6', '7', '8', '9'], (ch) => {
    if (input.getValue()) return
    const n = Number(ch) - 1
    if (n >= 0 && n < tabs.length) selectIndex(n)
  })

  header.on('click', (data: { x?: number }) => {
    const x = typeof data?.x === 'number' ? data.x : -1
    let cursor = 1
    for (let i = 0; i < tabs.length; i++) {
      const label = ` ${tabLabel(tabs[i])} `
      const start = cursor
      const end = cursor + label.length
      if (x >= start && x < end) {
        selectIndex(i)
        return
      }
      cursor = end
    }
  })

  input.on('click', () => { input.focus() })

  // blessed 默认把 Esc 视为取消输入，并关闭 grabKeys。导航/翻页键都绑定在
  // textbox 上，因此取消后必须重新进入输入模式，否则整个 TUI 看起来像被冻结。
  input.on('cancel', () => {
    setImmediate(() => {
      if (destroyed || exiting) return
      input.focus()
      screen.render()
    })
  })
  // 已经失去焦点时再次按 Esc，也可恢复输入框。
  screen.key(['escape'], () => {
    if (destroyed || exiting) return
    input.focus()
    screen.render()
  })

  input.on('submit', (value: string) => {
    const text = String(value || '').trim()
    input.clearValue()
    input.focus()
    screen.render()
    if (!text) return

    const inst = currentInstance()
    if (!inst) {
      logBus.emitLog(null, 'warn', '[TUI] sys 标签只读，请切换到 bot 实例后再发送')
      return
    }
    if (!inst.mcBot.isReady) {
      logBus.emitLog(inst.id, 'warn', '未上线，无法发送: ' + text)
      return
    }
    inst.messageQueue.enqueue(text, 'tui')
    logBus.emitLog(inst.id, 'info', `[TUI] → ${text}`)
  })

  const destroyUi = (): void => {
    if (destroyed) return
    destroyed = true
    clearInterval(statusTimer)
    logBus.removeListener('log', onLog)
    logBus.stopCapture()
    try {
      screen.destroy()
    } catch { /* ignore */ }
  }

  const requestExit = (): void => {
    if (exiting) return
    exiting = true
    destroyUi()
    try {
      options.onExit()
    } catch { /* ignore */ }
    setTimeout(() => {
      process.exit(0)
    }, 1500).unref?.()
  }

  // grabKeys 时 screen 键无效；退出键也绑到 input
  input.key(['C-c', 'f10'], requestExit)
  screen.key(['C-c', 'f10'], requestExit)

  selectIndex(selectedIndex)
  input.focus()
  screen.render()

  return {
    destroy: destroyUi
  }
}
