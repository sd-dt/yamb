import 'dotenv/config'
import { loadEnabledBotConfigs, resolveDataPath } from './config/loader'
import { closeDatabase } from './platform/database'
import { startBotInstance, type BotInstance } from './platform/bot-runtime'

async function main (): Promise<void> {
  const configs = loadEnabledBotConfigs()
  console.log(`[Main] Starting ${configs.length} bot(s)...`)

  const instances: BotInstance[] = []
  for (const config of configs) {
    const instance = await startBotInstance(config)
    instances.push(instance)
  }

  const findInstanceForError = (): BotInstance | null => {
    // 进程级异常无法精确归属时，优先通知尚未就绪的实例，否则全部尝试
    return instances.find(i => !i.mcBot.isReady) ?? instances[0] ?? null
  }

  process.on('SIGINT', () => {
    console.log('[Main] Shutting down...')
    for (const instance of instances) {
      try { instance.stop() } catch (err) {
        console.error(`[Main] Stop ${instance.id} failed:`, (err as Error).message)
      }
      closeDatabase(instance.dbPath)
    }
    closeDatabase()
    process.exit(0)
  })

  process.on('uncaughtException', (err) => {
    if (isTransientStartupError(err)) {
      console.error('[Main] 可恢复异常（触发重连）:', err.message)
      const target = findInstanceForError()
      target?.scheduleReconnect('未捕获异常', isMicrosoftAuthMessage(err.message))
      return
    }
    console.error('[Main] Uncaught exception:', err)
    process.exit(1)
  })

  process.on('unhandledRejection', (reason, promise) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    if (isTransientStartupError(err)) {
      console.error('[Main] 可恢复的未处理 rejection（触发重连）:', err.message)
      const target = findInstanceForError()
      target?.scheduleReconnect('未处理 rejection', isMicrosoftAuthMessage(err.message))
      return
    }
    console.error('[Main] Unhandled rejection at:', promise, 'reason:', reason)
    process.exit(1)
  })

  console.log(`[Main] All bots launched. Data root: ${resolveDataPath('./data')}`)
}

function isMicrosoftAuthMessage (message: string): boolean {
  const msg = (message || '').toLowerCase()
  return msg.includes('fetch failed') ||
    msg.includes('sign in failed') ||
    msg.includes('microsoft') ||
    msg.includes('xbox') ||
    msg.includes('oauth') ||
    msg.includes('profile data') ||
    msg.includes('own minecraft') ||
    msg.includes('invalid session') ||
    msg.includes('authentication')
}

function isTransientStartupError (err: Error): boolean {
  const msg = (err.message || '').toLowerCase()
  const code = (err as NodeJS.ErrnoException).code || ''
  return code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    msg.includes('fetch failed') ||
    msg.includes('sign in failed') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('getaddrinfo') ||
    msg.includes('timeout') ||
    msg.includes('profile data') ||
    msg.includes('own minecraft') ||
    msg.includes('invalid session') ||
    msg.includes('authentication')
}

main().catch(err => {
  console.error('[Main] Fatal error:', err)
  process.exit(1)
})
