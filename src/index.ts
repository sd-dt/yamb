import 'dotenv/config'
import { loadConfig, validateConfig, resolveDataPath } from './config/loader'
import { initDatabase, migrateFromJson, closeDatabase } from './platform/database'
import MessageQueue from './platform/message-queue'
import MinecraftBot from './platform/minecraft-bot'
import StandbyManager from './features/standby/manager'
import { startViewer, stopViewer } from './features/viewer'
import Whitelist from './permissions/whitelist'
import TeleportService from './features/teleport/service'
import TeleportIncomingHandler from './features/teleport/incoming-handler'
import PlayerInteractionService from './actions/player'
import MinecartInteractionService from './actions/minecart'
import RidingManager from './features/riding/manager'
import InventoryActions from './actions/inventory'
import ContainerRegistry from './features/container/registry'
import GameApiService from './api/game-service'
import SystemMessageBuffer from './features/commands/system-buffer'
import CommandHandler from './features/commands/handler'
import { registerChatListeners } from './features/commands/listeners'
import BrewModule from './features/brew'
import AstrbotServer from './api/server'
import BotState from './state/bot-state'
import { isLockContext } from './state/types'
import { resumeBotPhysics } from './actions/shared/entity-utils'

async function main (): Promise<void> {
  const config = loadConfig()
  validateConfig(config)

  console.log('[Main] Starting mchatbot...')
  console.log(`[Main] AstrBot (QQ群): ${config.astrbot.enabled ? '已启用' : '已禁用'}`)
  console.log(`[Main] 管理员: ${config.adminList.length} 人`)
  console.log(`[Main] 游戏内命令前缀: ${config.command.prefix}`)
  console.log(`[Main] 交互距离: ${config.bot.interactionDistance} 格 / 接近距离: ${config.bot.approachDistance} 格`)
  console.log(`[Main] 公屏命令: ${config.command.allowPublicCommands ? '已启用' : '已禁用'}`)
  console.log(`[Main] 可视化 (viewer): ${config.viewer.enabled ? `已启用 :${config.viewer.port}` : '已禁用'}`)

  const dbPath = resolveDataPath(config.teleport.databaseFile)
  const db = initDatabase(dbPath)
  migrateFromJson(resolveDataPath('./data/whitelist.json'))

  const messageQueue = new MessageQueue(config.messageQueue)
  console.log('[Main] Message queue initialized')

  const whitelist = new Whitelist(db)
  const containerRegistry = new ContainerRegistry(db)
  console.log(`[Main] Whitelist loaded (${whitelist.count()} entries)`)
  console.log(`[Main] Containers loaded (${containerRegistry.count()} entries)`)

  const mcBot = new MinecraftBot(config.minecraft, config.command.whisperCommand, {
    reconnectDelayMs: config.bot.reconnectDelayMs,
    authReconnectDelayMs: config.bot.authReconnectDelayMs,
    spamReconnectDelayMs: config.bot.spamReconnectDelayMs,
    spawnTimeoutMs: config.bot.spawnTimeoutMs
  })
  mcBot.setMessageQueue(messageQueue)

  const systemBuffer = new SystemMessageBuffer()
  const botState = new BotState()
  const standbyManager = new StandbyManager(mcBot, config.bot)
  const teleportService = new TeleportService(mcBot, botState, config.teleport)
  const playerInteraction = new PlayerInteractionService(
    mcBot,
    config.bot.interactionDistance,
    config.bot.approachDistance
  )
  const minecartInteraction = new MinecartInteractionService(
    mcBot,
    config.bot.interactionDistance,
    config.bot.approachDistance
  )
  const ridingManager = new RidingManager(mcBot, playerInteraction, config.bot)
  const isLocked = (): boolean => botState.isLocked()

  // 主模式互斥：离开 ride 时下马；离开 hover lock 时恢复物理
  botState.setOnLeaveRide(async () => {
    console.log('[BotState] 离开骑乘，执行下马')
    await ridingManager.leaveForStateTransition()
  })
  botState.setOnLeaveLock((ctx) => {
    if (isLockContext(ctx) && ctx.hover && mcBot.bot) {
      resumeBotPhysics(mcBot.bot)
    }
  })

  teleportService.setOnLock(() => standbyManager.scheduleAfk())
  teleportService.setOnUnlock(() => standbyManager.scheduleAfk())

  standbyManager.setRidingManager(ridingManager)
  standbyManager.setIsLocked(isLocked)
  ridingManager.setBotState(botState)
  ridingManager.setOnBehaviorEnd(() => standbyManager.scheduleAfk())
  const inventoryActions = new InventoryActions(mcBot)
  const gameApiService = new GameApiService(mcBot, whitelist, isLocked)
  const commandHandler = new CommandHandler(
    mcBot,
    teleportService,
    gameApiService,
    playerInteraction,
    minecartInteraction,
    ridingManager,
    containerRegistry,
    inventoryActions,
    systemBuffer,
    whitelist,
    standbyManager,
    botState,
    config.command,
    config.bot,
    config.adminList
  )
  const teleportHandler = new TeleportIncomingHandler(
    teleportService,
    whitelist,
    mcBot,
    commandHandler.getCommandMessages(),
    standbyManager
  )

  mcBot.onSpawn(() => {
    registerChatListeners(mcBot, commandHandler, teleportHandler, systemBuffer)
    ridingManager.start()
    standbyManager.start()
    void teleportService.restorePhysicalLockState()
    if (config.viewer.enabled && mcBot.bot) {
      startViewer(mcBot.bot, config.viewer)
    }
  })
  mcBot.create()
  console.log('[Main] Minecraft bot starting...')

  const brewModule = new BrewModule(mcBot, config.brew)
  brewModule.register()

  let apiServer: AstrbotServer | null = null
  if (config.astrbot.enabled) {
    apiServer = new AstrbotServer(config.astrbot, teleportService, gameApiService, whitelist)
    await apiServer.start()
    console.log('[Main] AstrBot API server started')
  } else {
    console.log('[Main] AstrBot API server skipped (disabled)')
  }

  process.on('SIGINT', () => {
    console.log('[Main] Shutting down...')
    stopViewer(mcBot.bot)
    ridingManager.stop()
    standbyManager.stop()
    apiServer?.stop()
    messageQueue.clear()
    mcBot.stop()
    closeDatabase()
    process.exit(0)
  })

  process.on('uncaughtException', (err) => {
    if (isTransientStartupError(err)) {
      console.error('[Main] 可恢复异常（触发重连）:', err.message)
      mcBot.scheduleReconnect('未捕获异常', isMicrosoftAuthMessage(err.message))
      return
    }
    console.error('[Main] Uncaught exception:', err)
    process.exit(1)
  })

  process.on('unhandledRejection', (reason, promise) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    if (isTransientStartupError(err)) {
      console.error('[Main] 可恢复的未处理 rejection（触发重连）:', err.message)
      mcBot.scheduleReconnect('未处理 rejection', isMicrosoftAuthMessage(err.message))
      return
    }
    console.error('[Main] Unhandled rejection at:', promise, 'reason:', reason)
    process.exit(1)
  })
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
