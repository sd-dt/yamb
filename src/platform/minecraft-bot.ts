import mineflayer, { Bot, BotOptions } from 'mineflayer'
import type { BotBehaviorConfig, MinecraftConfig } from '../types'
import type MessageQueue from './message-queue'
import { getBotClient } from './bot-client'
import { resumeBotPhysics } from '../actions/shared/entity-utils'

export interface ReconnectTimingConfig {
  reconnectDelayMs: number
  authReconnectDelayMs: number
  spamReconnectDelayMs: number
  spawnTimeoutMs: number
}

const DEFAULT_RECONNECT: ReconnectTimingConfig = {
  reconnectDelayMs: 20000,
  authReconnectDelayMs: 15000,
  spamReconnectDelayMs: 30000,
  spawnTimeoutMs: 30000
}

export default class MinecraftBot {
  config: MinecraftConfig
  bot: Bot | null = null
  isReady = false
  readonly botId: string
  private readonly logTag: string
  private acceptedResourcePacks = new Set<string>()
  private reconnectDelay: number
  private authReconnectDelay: number
  private spamReconnectDelay: number
  private spawnTimeoutMs: number
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private spawnTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  private messageQueue: MessageQueue | null = null
  private onSpawnCallbacks: Array<(bot: MinecraftBot) => void> = []
  private whisperCommand = '/msg'
  /** 防止同一轮断开被 kicked/end/error 重复排队 */
  private reconnectScheduled = false
  private intentionallyStopping = false

  constructor (
    config: MinecraftConfig,
    whisperCommand = '/msg',
    reconnect?: Partial<ReconnectTimingConfig> | Pick<
      BotBehaviorConfig,
      'reconnectDelayMs' | 'authReconnectDelayMs' | 'spamReconnectDelayMs' | 'spawnTimeoutMs'
    >,
    botId = 'bot'
  ) {
    this.config = config
    this.whisperCommand = whisperCommand
    this.botId = botId
    this.logTag = `[Bot:${botId}]`
    this.reconnectDelay = reconnect?.reconnectDelayMs ?? DEFAULT_RECONNECT.reconnectDelayMs
    this.authReconnectDelay = reconnect?.authReconnectDelayMs ?? DEFAULT_RECONNECT.authReconnectDelayMs
    this.spamReconnectDelay = reconnect?.spamReconnectDelayMs ?? DEFAULT_RECONNECT.spamReconnectDelayMs
    this.spawnTimeoutMs = reconnect?.spawnTimeoutMs ?? DEFAULT_RECONNECT.spawnTimeoutMs
  }

  private log (...args: unknown[]): void {
    console.log(this.logTag, ...args)
  }

  private warn (...args: unknown[]): void {
    console.warn(this.logTag, ...args)
  }

  private error (...args: unknown[]): void {
    console.error(this.logTag, ...args)
  }

  setMessageQueue (queue: MessageQueue): void {
    this.messageQueue = queue
  }

  onSpawn (callback: (bot: MinecraftBot) => void): void {
    this.onSpawnCallbacks.push(callback)
  }

  create (): Bot {
    this.log('Creating bot...')
    this.intentionallyStopping = false
    // 重连前结束旧实例，避免僵尸连接继续触发 end/error
    this._disposeBot(true)

    const options = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      auth: this.config.auth as 'microsoft' | 'mojang' | 'offline',
      profilesFolder: this.config.profilesFolder,
      checkTimeoutInterval: this.config.checkTimeoutInterval || 300000,
      connectTimeout: 60000,
      keepAlive: true,
      skipValidation: true,
      hideErrors: true,
      physicsEnabled: true,
      ...(this.config.version !== false ? { version: this.config.version } : {})
    } as BotOptions

    // 微软账号走 OAuth，不能传 password
    if (this.config.auth !== 'microsoft' && this.config.password) {
      options.password = this.config.password
    }

    if (this.config.auth === 'microsoft') {
      this.log('使用微软账号登录，首次运行需在终端完成浏览器授权')
    }

    this.bot = mineflayer.createBot(options)
    this._setupEvents()
    return this.bot
  }

  /** 主动停止（进程退出时用），不再自动重连 */
  stop (): void {
    this.intentionallyStopping = true
    this._clearReconnectTimer()
    this._clearSpawnTimeout()
    this._disposeBot(true)
    this.isReady = false
  }

  private _disposeBot (endConnection: boolean): void {
    this._clearSpawnTimeout()
    const old = this.bot
    this.bot = null
    if (!old) return

    try {
      old.removeAllListeners()
    } catch { /* ignore */ }

    if (endConnection) {
      try {
        old.quit('stopping')
      } catch {
        try { old.end('stopping') } catch { /* ignore */ }
      }
    }
  }

  private _setupEvents (): void {
    if (!this.bot) return
    this._suppressProtocolErrors()

    this.bot.on('login', () => {
      this.log(`Logged in as ${this.bot!.username}`)
      // 登录后若长期不 spawn（无资源包或卡配置阶段），也强制重连
      this._armSpawnTimeout()
    })

    this.bot.on('spawn', () => {
      this.log('Bot spawned in world')
      this.isReady = true
      this.reconnectScheduled = false
      this._clearSpawnTimeout()
      this.bot!.physicsEnabled = true

      if (this.messageQueue) {
        this.messageQueue.setBot(this)
      }

      for (const callback of this.onSpawnCallbacks) {
        callback(this)
      }
    })

    // mount 会暂停物理；dismount 后 mineflayer 不会自动恢复，需手动打开
    this.bot.on('dismount', () => {
      this.log('dismount → 恢复物理')
      resumeBotPhysics(this.bot!)
    })

    this.bot.on('mount', () => {
      this.log('mount → 物理由 mineflayer 暂停（载具模式）')
    })

    this.bot.on('kicked', (reason) => {
      const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason)
      this.log('Kicked:', reasonStr)
      this.isReady = false
      this.acceptedResourcePacks.clear()
      // kicked 后通常还会 end；先排队，end 时用 reconnectScheduled 去重
      const label = reasonStr.toLowerCase().includes('spam') ? 'spam踢出' : '被踢出'
      setTimeout(() => this._handleReconnect(label), 1000)
    })

    this.bot.on('error', (err: NodeJS.ErrnoException) => {
      if (err.message && (err.message.includes('PartialReadError') ||
          err.message.includes('Read error') ||
          err.message.includes('resource_pack') ||
          err.message.includes('UUID') ||
          err.message.includes('configuration'))) {
        return
      }
      this.error('Error:', err.message)

      // 登录/网络错误：不依赖 end 是否触发，主动重连
      if (this._isTransientConnectError(err) || this._isMicrosoftAuthError(err)) {
        this.isReady = false
        this._handleReconnect(
          this._isMicrosoftAuthError(err) ? '微软登录失败' : '连接错误',
          this._isMicrosoftAuthError(err)
        )
      }
    })

    this.bot.on('resourcePack', (url, hash) => {
      this._handleResourcePack(url, hash ?? '')
    })

    getBotClient(this.bot)?.on('add_resource_pack', (data: unknown) => {
      this.log('add_resource_pack received')
      this._acceptResourcePackOnce(String((data as { uuid?: string }).uuid || ''))
    })

    getBotClient(this.bot)?.on('resource_pack_send', (data: unknown) => {
      this.log('resource_pack_send received')
      this._acceptResourcePackOnce(String((data as { uuid?: string }).uuid || ''))
    })

    this.bot.on('end', (reason) => {
      this.log('Disconnected:', reason)
      this.isReady = false
      this.acceptedResourcePacks.clear()
      if (this.intentionallyStopping) return
      this._handleReconnect(String(reason || '连接断开'))
    })
  }

  private _errorText (err: NodeJS.ErrnoException): string {
    const cause = (err as Error & { cause?: unknown }).cause
    return [
      err.message || '',
      err.code || '',
      err.name || '',
      cause instanceof Error ? cause.message : ''
    ].join(' ').toLowerCase()
  }

  private _isMicrosoftAuthError (err: NodeJS.ErrnoException): boolean {
    const msg = this._errorText(err)
    return msg.includes('fetch failed') ||
      msg.includes('connect timeout') ||
      msg.includes('login.live.com') ||
      msg.includes('sign in failed') ||
      msg.includes('microsoft') ||
      msg.includes('xbox') ||
      msg.includes('oauth') ||
      msg.includes('msa') ||
      msg.includes('profile data') ||
      msg.includes('own minecraft') ||
      msg.includes('invalid session') ||
      msg.includes('authentication')
  }

  private _isTransientConnectError (err: NodeJS.ErrnoException): boolean {
    const code = err.code || ''
    const msg = this._errorText(err)
    if (
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' ||
      code === 'ECONNABORTED' ||
      code === 'EHOSTUNREACH' ||
      code === 'ENETUNREACH' ||
      code === 'UND_ERR_CONNECT_TIMEOUT'
    ) {
      return true
    }
    return msg.includes('fetch failed') ||
      msg.includes('connect timeout') ||
      msg.includes('login.live.com') ||
      msg.includes('sign in failed') ||
      msg.includes('socket hang up') ||
      msg.includes('network') ||
      msg.includes('getaddrinfo') ||
      msg.includes('timed out') ||
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('connect')
  }

  private _suppressProtocolErrors (): void {
    if (!this.bot) return
    const client = getBotClient(this.bot)
    if (!client) return

    client.on('error', (err: Error) => {
      if (err?.message) {
        const msg = err.message
        if (msg.includes('PartialReadError') ||
            msg.includes('Read error') ||
            msg.includes('protocol') ||
            msg.includes('decoder') ||
            msg.includes('parser') ||
            msg.includes('f32') ||
            msg.includes('intArray')) {
          return
        }
      }
    })

    if (client.socket) {
      client.socket.on('error', (err: NodeJS.ErrnoException) => {
        if (err?.message) {
          const msg = err.message
          if (msg.includes('PartialReadError') ||
              msg.includes('read') ||
              msg.includes('ECONNRESET') ||
              msg.includes('EPIPE')) {
            return
          }
        }
      })
    }

    const originalEmit = client.emit.bind(client)
    client.emit = function (event: string, ...args: unknown[]) {
      if (event === 'error') {
        const err = args[0] as Error
        if (err?.message &&
            (err.message.includes('PartialReadError') ||
             err.message.includes('Read error') ||
             err.message.includes('f32'))) {
          return false
        }
      }
      return originalEmit(event, ...args)
    }
  }

  private _handleResourcePack (url: string, hash: { ascii?: string } | string): void {
    if (!this.bot) return
    this.log('Resource pack received')
    const hashObj = typeof hash === 'object' ? hash : { ascii: String(hash) }
    const packKey = String(hashObj?.ascii || hash || url || '')

    if (packKey && this.acceptedResourcePacks.has(packKey)) {
      this.log('Resource pack already accepted')
      return
    }

    try {
      const uuidStr = hashObj?.ascii ? hashObj.ascii : String(hash || '')
      this.log('Pack UUID:', uuidStr)

      const statuses: Array<[string, number]> = [
        ['ACCEPTED', 3],
        ['DOWNLOADED', 4],
        ['SUCCESSFULLY_LOADED', 0]
      ]

      const client = getBotClient(this.bot)
      if (!client) return
      for (const [label, result] of statuses) {
        try {
          client.write('resource_pack_receive', {
            uuid: uuidStr,
            result: result
          })
          this.log(`Resource pack ${label} sent`)
        } catch (err) {
          this.error(`Resource pack ${label} failed:`, (err as Error).message)
        }
      }

      if (packKey) {
        this.acceptedResourcePacks.add(packKey)
      }
      this.log('Resource pack response completed')

      // 资源包过后若一直不 spawn（卡在配置阶段），强制重连
      this._armSpawnTimeout()
    } catch (err) {
      this.error('Resource pack error:', (err as Error).message)
    }
  }

  private _armSpawnTimeout (): void {
    if (!this.bot || this.isReady) return
    this._clearSpawnTimeout()
    const bot = this.bot
    this.spawnTimeoutTimer = setTimeout(() => {
      this.spawnTimeoutTimer = null
      if (this.bot !== bot || this.isReady) return
      this.log(`Spawn timeout (${this.spawnTimeoutMs / 1000}s), forcing reconnect...`)
      this.acceptedResourcePacks.clear()
      try { this.bot?.end('spawn timeout') } catch { /* ignore */ }
      this._handleReconnect('spawn超时')
    }, this.spawnTimeoutMs)
    bot.once('spawn', () => this._clearSpawnTimeout())
  }

  private _clearSpawnTimeout (): void {
    if (this.spawnTimeoutTimer) {
      clearTimeout(this.spawnTimeoutTimer)
      this.spawnTimeoutTimer = null
    }
  }

  private _clearReconnectTimer (): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectScheduled = false
  }

  private _acceptResourcePackOnce (uuid: string): void {
    const key = String(uuid || '')
    if (key && this.acceptedResourcePacks.has(key)) {
      return
    }
    this._handleResourcePack('', uuid)
  }

  /** 供外部在未捕获的登录/网络异常时触发重连 */
  scheduleReconnect (reason = '外部触发重连', authFailure = false): void {
    this.isReady = false
    this._handleReconnect(reason, authFailure)
  }

  private _handleReconnect (reason: string, authFailure = false): void {
    if (this.intentionallyStopping) return

    // kicked / end / error / 外部触发可能连发，只排一次
    if (this.reconnectScheduled || this.reconnectTimer) {
      return
    }

    this.reconnectScheduled = true
    const reasonLower = reason.toLowerCase()
    const delay = reasonLower.includes('spam')
      ? this.spamReconnectDelay
      : (authFailure ? this.authReconnectDelay : this.reconnectDelay)

    this.log(`${reason} - 等待 ${delay / 1000} 秒后重连...`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectScheduled = false
      if (this.intentionallyStopping) return
      this.log('Reconnecting...')
      try {
        this.create()
      } catch (err) {
        this.error('重连创建失败:', (err as Error).message)
        this._handleReconnect('重连创建失败', authFailure)
      }
    }, delay)
  }

  chat (message: string): boolean {
    if (!this.isReady || !this.bot) return false
    this.bot.chat(message)
    return true
  }

  whisper (username: string, message: string): boolean {
    if (!this.isReady || !this.bot) return false
    this.bot.chat(`${this.whisperCommand} ${username} ${message}`)
    return true
  }
}
