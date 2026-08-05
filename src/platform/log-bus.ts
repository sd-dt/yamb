import { AsyncLocalStorage } from 'async_hooks'
import { EventEmitter } from 'events'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  botId: string | null
  level: LogLevel
  text: string
  at: number
}

const botContext = new AsyncLocalStorage<string>()

class LogBus extends EventEmitter {
  private buffer: LogEntry[] = []
  private readonly maxBuffer = 2000
  private capturing = false
  private original: {
    log: typeof console.log
    warn: typeof console.warn
    error: typeof console.error
  } | null = null

  /** 在异步上下文中绑定当前 bot，未带 [Bot:id] 前缀的日志也会归入该实例 */
  runAs<T> (botId: string, fn: () => T): T {
    return botContext.run(botId, fn)
  }

  emitLog (botId: string | null, level: LogLevel, text: string): void {
    const entry: LogEntry = { botId, level, text, at: Date.now() }
    this.buffer.push(entry)
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.splice(0, this.buffer.length - this.maxBuffer)
    }
    this.emit('log', entry)
  }

  /**
   * botId === null → 仅进程级（无实例）日志
   * botId 字符串 → 该实例日志
   */
  getRecent (botId: string | null, limit = 200): LogEntry[] {
    const filtered = botId == null
      ? this.buffer.filter(e => e.botId == null)
      : this.buffer.filter(e => e.botId === botId)
    return filtered.slice(-limit)
  }

  /** 从日志前缀 [Bot:id] 解析实例；否则用 ALS；再否则 system */
  parseBotId (text: string): string | null {
    const m = text.match(/\[Bot:([^\]]+)\]/)
    return m ? m[1] : null
  }

  resolveBotId (text: string): string | null {
    return this.parseBotId(text) ?? botContext.getStore() ?? null
  }

  startCapture (): void {
    if (this.capturing) return
    this.capturing = true
    this.original = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console)
    }

    const wrap = (level: LogLevel) => {
      return (...args: unknown[]) => {
        const text = args.map(formatArg).join(' ')
        const botId = this.resolveBotId(text)
        this.emitLog(botId, level, text)
      }
    }

    console.log = wrap('info')
    console.warn = wrap('warn')
    console.error = wrap('error')
  }

  stopCapture (): void {
    if (!this.capturing || !this.original) return
    console.log = this.original.log
    console.warn = this.original.warn
    console.error = this.original.error
    this.original = null
    this.capturing = false
  }
}

function formatArg (arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack || arg.message
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

const logBus = new LogBus()
export default logBus
