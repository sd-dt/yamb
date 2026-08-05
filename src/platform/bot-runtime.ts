import type { AppConfig } from '../types'
import type { DatabaseSync } from '../platform/database'
import { initDatabase, migrateFromJson } from '../platform/database'
import { resolveDataPath } from '../config/loader'
import MessageQueue from '../platform/message-queue'
import MinecraftBot from '../platform/minecraft-bot'
import StandbyManager from '../features/standby/manager'
import { startViewer, stopViewer } from '../features/viewer'
import Whitelist from '../permissions/whitelist'
import TeleportService from '../features/teleport/service'
import TeleportIncomingHandler from '../features/teleport/incoming-handler'
import PlayerInteractionService from '../actions/player'
import MinecartInteractionService from '../actions/minecart'
import RidingManager from '../features/riding/manager'
import InventoryActions from '../actions/inventory'
import BlockRegistry from '../features/block-registry'
import GameApiService from '../api/game-service'
import SystemMessageBuffer from '../features/commands/system-buffer'
import CommandHandler from '../features/commands/handler'
import { registerChatListeners } from '../features/commands/listeners'
import BrewModule from '../features/brew'
import AstrbotServer from '../api/server'
import BotState from '../state/bot-state'
import { isLockContext } from '../state/types'
import { resumeBotPhysics } from '../actions/shared/entity-utils'
import logBus from './log-bus'

export interface BotInstance {
  id: string
  config: AppConfig
  mcBot: MinecraftBot
  botState: BotState
  brewModule: BrewModule
  db: DatabaseSync
  dbPath: string
  messageQueue: MessageQueue
  ridingManager: RidingManager
  standbyManager: StandbyManager
  apiServer: AstrbotServer | null
  stop: () => void
  scheduleReconnect: (reason: string, authFailure?: boolean) => void
}

export async function startBotInstance (config: AppConfig): Promise<BotInstance> {
  const tag = `[Bot:${config.id}]`
  console.log(`${tag} Starting...`)
  console.log(`${tag} AstrBot: ${config.astrbot.enabled ? `enabled :${config.astrbot.port}` : 'disabled'}`)
  console.log(`${tag} Admins: ${config.adminList.length}`)
  console.log(`${tag} Prefix: ${config.command.prefix}`)
  console.log(`${tag} Interact: ${config.bot.interactionDistance} / approach: ${config.bot.approachDistance}`)

  const dbPath = resolveDataPath(config.teleport.databaseFile)
  const db = initDatabase(dbPath)
  migrateFromJson(db, resolveDataPath('./data/whitelist.json'))

  const messageQueue = new MessageQueue(config.messageQueue, config.id)
  const whitelist = new Whitelist(db)
  const autoAdded = whitelist.ensurePresent(config.adminList)
  if (autoAdded.length > 0) {
    console.log(`${tag} Auto-whitelisted admins: ${autoAdded.join(', ')}`)
  }
  const blockRegistry = new BlockRegistry(db)
  console.log(`${tag} Whitelist ${whitelist.count()}, block nodes ${blockRegistry.count()}`)

  const mcBot = new MinecraftBot(config.minecraft, config.command.whisperCommand, {
    reconnectDelayMs: config.bot.reconnectDelayMs,
    authReconnectDelayMs: config.bot.authReconnectDelayMs,
    spamReconnectDelayMs: config.bot.spamReconnectDelayMs,
    spawnTimeoutMs: config.bot.spawnTimeoutMs
  }, config.id)
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

  botState.setOnLeaveRide(async () => {
    console.log(`${tag} leave ride → dismount`)
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
  standbyManager.setIsBusy(() => botState.isBrewing())
  ridingManager.setBotState(botState)
  ridingManager.setOnBehaviorEnd(() => standbyManager.scheduleAfk())

  const inventoryActions = new InventoryActions(mcBot)
  const brewModule = new BrewModule(
    mcBot,
    config.brew,
    blockRegistry,
    inventoryActions,
    botState,
    config.bot.interactionDistance,
    config.bot.approachDistance
  )
  brewModule.register()
  const gameApiService = new GameApiService(mcBot, whitelist, isLocked)
  const commandHandler = new CommandHandler(
    mcBot,
    teleportService,
    gameApiService,
    playerInteraction,
    minecartInteraction,
    ridingManager,
    blockRegistry,
    inventoryActions,
    systemBuffer,
    whitelist,
    standbyManager,
    botState,
    brewModule,
    config.command,
    config.bot,
    config.adminList
  )
  const teleportHandler = new TeleportIncomingHandler(
    teleportService,
    whitelist,
    mcBot,
    commandHandler.getCommandMessages(),
    standbyManager,
    config.command.silentMode
  )

  mcBot.onSpawn(() => {
    logBus.runAs(config.id, () => {
      registerChatListeners(mcBot, commandHandler, teleportHandler, systemBuffer)
      ridingManager.start()
      standbyManager.start()
      void teleportService.restorePhysicalLockState()
      if (config.viewer.enabled && mcBot.bot) {
        startViewer(mcBot.bot, config.viewer)
      }
    })
  })
  mcBot.create()
  console.log(`${tag} Minecraft client starting as ${config.minecraft.username}`)

  let apiServer: AstrbotServer | null = null
  if (config.astrbot.enabled) {
    apiServer = new AstrbotServer(config.astrbot, teleportService, gameApiService, whitelist)
    await apiServer.start()
    console.log(`${tag} AstrBot API on :${config.astrbot.port}`)
  }

  const instance: BotInstance = {
    id: config.id,
    config,
    mcBot,
    botState,
    brewModule,
    db,
    dbPath,
    messageQueue,
    ridingManager,
    standbyManager,
    apiServer,
    stop: () => {
      stopViewer(mcBot.bot)
      ridingManager.stop()
      standbyManager.stop()
      brewModule.cancel()
      brewModule.dispose()
      apiServer?.stop()
      messageQueue.clear()
      mcBot.stop()
    },
    scheduleReconnect: (reason, authFailure) => {
      mcBot.scheduleReconnect(reason, authFailure)
    }
  }

  return instance
}
