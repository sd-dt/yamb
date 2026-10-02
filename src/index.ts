import 'dotenv/config'
import http from 'http'
import { loadBotConfigById, loadEnabledBotConfigs, resolveDataPath } from './config/loader'
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

  // ── _p65: 热上下号控制口 ──────────────────────────────────────────
  // 只启停"指令点名的账号"，其它在线账号的连接完全不受影响。
  // 控制口出任何问题都不影响 bot 本体（switch.sh 侧会自动退回整服务重启）。
  const CONTROL_PORT = (() => {
    const v = parseInt(process.env.YAMB_CONTROL_PORT || '15199', 10)
    return Number.isInteger(v) && v > 0 ? v : 15199
  })()

  const findInstance = (id: string): BotInstance | undefined =>
    instances.find(i => i.id === id)

  const hotStart = async (id: string): Promise<{ ok: boolean, code: number, message: string }> => {
    const name = String(id || '').trim()
    if (!name) return { ok: false, code: 400, message: '缺少 account' }
    if (findInstance(name)) return { ok: false, code: 409, message: `账号 ${name} 已在运行` }
    const loaded = loadBotConfigById(name)
    if (!loaded) return { ok: false, code: 404, message: `找不到 bot 配置：config/bots/${name}.yaml` }
    if (!loaded.enabled) {
      return { ok: false, code: 409, message: `账号 ${name} 的 enabled=false（先用 switch.sh set/enable 打开标记）` }
    }
    try {
      const instance = await startBotInstance(loaded.config)
      instances.push(instance)
      console.log(`[Main] 热上号完成: ${name}（约 15~25 秒后进服）`)
      return { ok: true, code: 200, message: `账号 ${name} 正在上线（约 15~25 秒后进服）` }
    } catch (err) {
      console.error(`[Main] 热上号失败 ${name}:`, (err as Error).message)
      return { ok: false, code: 500, message: `上线失败: ${(err as Error).message}` }
    }
  }

  const hotStop = (id: string): { ok: boolean, code: number, message: string } => {
    const name = String(id || '').trim()
    if (!name) return { ok: false, code: 400, message: '缺少 account' }
    const instance = findInstance(name)
    if (!instance) return { ok: false, code: 404, message: `账号 ${name} 当前没有在运行` }
    try {
      const idx = instances.indexOf(instance)
      if (idx >= 0) instances.splice(idx, 1)
      instance.stop()
      try { closeDatabase(instance.dbPath) } catch { /* ignore */ }
      console.log(`[Main] 热下号完成: ${name}`)
      return { ok: true, code: 200, message: `账号 ${name} 已下线` }
    } catch (err) {
      console.error(`[Main] 热下号失败 ${name}:`, (err as Error).message)
      return { ok: false, code: 500, message: `下线失败: ${(err as Error).message}` }
    }
  }

  const controlServer = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0]
    const readBody = async (): Promise<string> => {
      let data = ''
      req.on('data', (chunk: Buffer) => { data += chunk.toString() })
      return await new Promise<string>(resolve => req.on('end', () => resolve(data)))
    }
    void (async () => {
      try {
        const apiKey = process.env.API_KEY || ''
        if (apiKey && String(req.headers['x-api-key'] || '') !== apiKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, message: 'unauthorized' }))
          return
        }
        if (req.method === 'GET' && url === '/api/instances') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, running: instances.map(i => i.id) }))
          return
        }
        if (req.method === 'POST' && (url === '/api/instances/start' || url === '/api/instances/stop')) {
          const body = JSON.parse((await readBody()) || '{}') as { account?: string }
          const r = url.endsWith('/start')
            ? await hotStart(body.account || '')
            : hotStop(body.account || '')
          res.writeHead(r.code, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: r.ok, message: r.message }))
          return
        }
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, message: 'not found' }))
      } catch (err) {
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, message: (err as Error).message }))
        } catch { /* ignore */ }
      }
    })()
  })
  controlServer.on('error', (err) => {
    console.error('[Main] 热上下号控制口启动失败（不影响 bot 运行，switch.sh 会退回整服务重启）:',
      (err as Error).message)
  })
  controlServer.listen(CONTROL_PORT, '127.0.0.1', () => {
    console.log(`[Main] 热上下号控制口: http://127.0.0.1:${CONTROL_PORT}/api/instances`)
  })

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
