import 'dotenv/config'
import { loadEnabledBotConfigs, resolveDataPath } from './config/loader'
import { closeDatabase } from './platform/database'
import { startBotInstance, type BotInstance } from './platform/bot-runtime'
import { startTui } from './features/tui'
import logBus from './platform/log-bus'

function wantsHeadless (argv: string[]): boolean {
  return argv.some(arg => {
    const a = arg.replace(/^--?/, '').toLowerCase()
    return a === 'headless'
  })
}

function errorText (err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof Error) {
      parts.push(current.message || '')
      parts.push((current as NodeJS.ErrnoException).code || '')
      parts.push(current.name || '')
      current = (current as Error & { cause?: unknown }).cause
      continue
    }
    parts.push(String(current))
    break
  }
  return parts.join(' ').toLowerCase()
}

function isMicrosoftAuthMessage (message: string): boolean {
  const msg = (message || '').toLowerCase()
  return msg.includes('fetch failed') ||
    msg.includes('connect time') ||
    msg.includes('login.live.com') ||
    msg.includes('sign in failed') ||
    msg.includes('microsoft') ||
    msg.includes('xbox') ||
    msg.includes('oauth') ||
    msg.includes('profile data') ||
    msg.includes('own minecraft') ||
    msg.includes('invalid session') ||
    msg.includes('authentication')
}

function isTransientStartupError (err: unknown): boolean {
  const text = errorText(err)
  const code = err instanceof Error
    ? ((err as NodeJS.ErrnoException).code || '')
    : ''
  return code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    text.includes('fetch failed') ||
    text.includes('connect timeout') ||
    text.includes('connect time') ||
    text.includes('login.live.com') ||
    text.includes('sign in failed') ||
    text.includes('socket hang up') ||
    text.includes('network') ||
    text.includes('getaddrinfo') ||
    text.includes('timeout') ||
    text.includes('profile data') ||
    text.includes('own minecraft') ||
    text.includes('invalid session') ||
    text.includes('authentication')
}

async function main (): Promise<void> {
  const headless = wantsHeadless(process.argv.slice(2))
  if (!headless) {
    logBus.startCapture()
  }

  // 必须在启动 bot / 微软登录之前挂上，否则登录超时会直接打崩进程。
  const instances: BotInstance[] = []
  let tui: { destroy: () => void } | null = null
  let shuttingDown = false

  const findInstanceForError = (): BotInstance | null => {
    return instances.find(i => !i.mcBot.isReady) ?? instances[0] ?? null
  }

  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    try { tui?.destroy() } catch { /* ignore */ }
    console.log('[Main] Shutting down...')
    for (const instance of instances) {
      try { instance.stop() } catch (err) {
        console.error(`[Main] Stop ${instance.id} failed:`, (err as Error).message)
      }
      closeDatabase(instance.dbPath)
    }
    closeDatabase()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  process.on('uncaughtException', (err) => {
    if (isTransientStartupError(err)) {
      console.error('[Main] 可恢复异常（触发重连）:', err.message)
      const target = findInstanceForError()
      if (target) {
        target.scheduleReconnect('未捕获异常', isMicrosoftAuthMessage(errorText(err)))
      } else {
        console.error('[Main] 尚无 bot 实例可重连，等待实例启动后自动处理')
      }
      return
    }
    console.error('[Main] Uncaught exception:', err)
    process.exit(1)
  })

  process.on('unhandledRejection', (reason, promise) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    if (isTransientStartupError(reason) || isTransientStartupError(err)) {
      console.error('[Main] 可恢复的未处理 rejection（触发重连）:', err.message)
      const target = findInstanceForError()
      if (target) {
        target.scheduleReconnect('未处理 rejection', isMicrosoftAuthMessage(errorText(reason)))
      } else {
        console.error('[Main] 尚无 bot 实例可重连，等待实例启动后自动处理')
      }
      return
    }
    console.error('[Main] Unhandled rejection at:', promise, 'reason:', reason)
    process.exit(1)
  })

  const configs = loadEnabledBotConfigs()
  console.log(`[Main] Starting ${configs.length} bot(s)...${headless ? ' (headless)' : ''}`)

  for (const config of configs) {
    const instance = await startBotInstance(config)
    instances.push(instance)
  }

  if (!headless) {
    tui = startTui(instances, { onExit: shutdown })
  } else {
    console.log(`[Main] All bots launched (headless). Data root: ${resolveDataPath('./data')}`)
  }
}

main().catch(err => {
  if (isTransientStartupError(err)) {
    console.error('[Main] 启动阶段可恢复错误（进程保持运行）:', (err as Error).message)
    return
  }
  console.error('[Main] Fatal error:', err)
  process.exit(1)
})
