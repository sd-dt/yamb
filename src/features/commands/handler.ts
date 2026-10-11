import type { BotBehaviorConfig, CommandConfig } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import type GameApiService from '../../api/game-service'
import type TeleportService from '../teleport/service'
import type Whitelist from '../../permissions/whitelist'
import type StandbyManager from '../standby/manager'
import type PlayerInteractionService from '../../actions/player'
import type MinecartInteractionService from '../../actions/minecart'
import type RidingManager from '../riding/manager'
import type BlockRegistry from '../block-registry'
import type InventoryActions from '../../actions/inventory'
import type SystemMessageBuffer from './system-buffer'
import type BotState from '../../state/bot-state'
import type BrewModule from '../brew'
import type { CommandContext } from './handlers/types'
import CommandMessages from './messages'
import { sleep } from '../../platform/sleep'
import {
  type CommandSource,
  matchesPrefix,
  normalizeInput,
  parsePrefixedArgs,
  parseWhisperCommand
} from './parser'
import { handlePhome, handleLock, handleUnlock } from './handlers/teleport'
import { handleMount, handleUnmount, handleCart, handleAttack } from './handlers/riding'
import { handleHand, handleInv, handleSlot, handleStore, handleTake, handleDrop } from './handlers/inventory'
import { handleNode } from './handlers/nodes'
import { handleAdd, handleRemove, handleSay, handleForward } from './handlers/admin'
import { handleStatus, handleHelp } from './handlers/info'
import { handleBrew } from './handlers/brew'

/** 锁定后禁止的动作命令（仅允许 /tpa 与文本回复类命令） */
const LOCKED_BLOCKED_COMMANDS = new Set([
  'phome',
  'mount',
  'unmount',
  'cart',
  'attack',
  'store',
  'take',
  'drop',
  'say',
  'forward'
])

const BREWING_ALLOWED_COMMANDS = new Set(['brew', 'status', 'help', '帮助'])

export default class CommandHandler {
  private mcBot: MinecraftBot
  private teleportService: TeleportService
  private gameApiService: GameApiService
  private playerInteraction: PlayerInteractionService
  private minecartInteraction: MinecartInteractionService
  private ridingManager: RidingManager
  private blockRegistry: BlockRegistry
  private inventoryActions: InventoryActions
  private systemBuffer: SystemMessageBuffer
  private whitelist: Whitelist
  private standby: StandbyManager
  private botState: BotState
  private brewModule: BrewModule
  private messages: CommandMessages
  private prefix: string
  private adminList: Set<string>
  private allowPublicCommands: boolean
  private replyAlwaysWhisper: boolean
  private silentMode: boolean
  private replyDelayMs: number
  private forwardWaitMs: number
  private interactionDistance: number
  private approachDistance: number
  private statusMountDebugLog: boolean
  private _lastCmd?: { key: string; time: number }

  constructor (
    mcBot: MinecraftBot,
    teleportService: TeleportService,
    gameApiService: GameApiService,
    playerInteraction: PlayerInteractionService,
    minecartInteraction: MinecartInteractionService,
    ridingManager: RidingManager,
    blockRegistry: BlockRegistry,
    inventoryActions: InventoryActions,
    systemBuffer: SystemMessageBuffer,
    whitelist: Whitelist,
    standby: StandbyManager,
    botState: BotState,
    brewModule: BrewModule,
    config: CommandConfig,
    botConfig: BotBehaviorConfig,
    adminList: string[]
  ) {
    this.mcBot = mcBot
    this.teleportService = teleportService
    this.gameApiService = gameApiService
    this.playerInteraction = playerInteraction
    this.minecartInteraction = minecartInteraction
    this.ridingManager = ridingManager
    this.blockRegistry = blockRegistry
    this.inventoryActions = inventoryActions
    this.systemBuffer = systemBuffer
    this.whitelist = whitelist
    this.standby = standby
    this.botState = botState
    this.brewModule = brewModule
    this.prefix = config.prefix || '#ybot'
    this.messages = new CommandMessages(config.messages, this.prefix)
    this.adminList = new Set(adminList)
    this.allowPublicCommands = config.allowPublicCommands
    this.replyAlwaysWhisper = config.replyAlwaysWhisper
    this.silentMode = config.silentMode
    this.replyDelayMs = botConfig.replyDelayMs
    this.forwardWaitMs = botConfig.forwardWaitMs
    this.interactionDistance = botConfig.interactionDistance
    this.approachDistance = botConfig.approachDistance
    this.statusMountDebugLog = botConfig.statusMountDebugLog
  }

  getCommandMessages (): CommandMessages {
    return this.messages
  }

  isAdmin (username: string): boolean {
    return this.adminList.has(username)
  }

  isWhitelisted (username: string): boolean {
    return this.whitelist.isAllowed(username)
  }

  /**
   * API 注入指令（/api/command）的发送者兜底：QQ 侧不传 sender 时是 'player'，
   * 不在白名单会被 handle() 静默丢弃。API 有 x-api-key 保护，视为可信——
   * 回落到「配置管理员里第一个不是机器人自己且在白名单的名字」。
   */
  resolveTrustedSender (sender?: string | null): string {
    const s = (sender || '').trim()
    if (s && s !== this.mcBot.botId && this.isWhitelisted(s)) return s
    for (const a of this.adminList) {
      if (a !== this.mcBot.botId && this.isWhitelisted(a)) return a
    }
    return s || 'player'
  }

  private useWhisperReply (source: CommandSource): boolean {
    return this.replyAlwaysWhisper || source === 'whisper'
  }

  async reply (
    username: string,
    message: string,
    source: CommandSource,
    allowInSilentMode = false
  ): Promise<void> {
    const lines = message.split('\n').filter(line => line.trim())
    if (this.silentMode && !allowInSilentMode) {
      for (const line of lines) {
        console.log(`[Bot:${this.mcBot.botId}][Silent][Reply:${username}] ${line}`)
        // 静默模式不真发游戏消息，但要在 outgoing.log 留 /msg 痕迹，QQ 侧回捕（captureOutgoing）靠它
        const logOnly = (this.mcBot as unknown as { logOutgoingOnly?: (text: string) => void }).logOutgoingOnly
        if (typeof logOnly === 'function') logOnly.call(this.mcBot, '/msg ' + username + ' ' + line)
      }
      return
    }
    const viaWhisper = this.useWhisperReply(source)

    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await sleep(this.replyDelayMs)
      const line = lines[i]
      const ok = viaWhisper
        ? this.mcBot.whisper(username, line)
        : this.mcBot.chat(line)
      if (!ok) {
        console.warn(`[Bot:${this.mcBot.botId}][Command] 回复失败 -> ${username}: ${line}`)
      }
    }
  }

  private waypointHint (): string {
    return this.teleportService.getWaypointsHelp()
  }

  private async notifyLocked (username: string, source: CommandSource): Promise<void> {
    const lockedBy = this.teleportService.getLockedBy() || '未知'
    await this.reply(username, this.messages.text('lockedBlocked', { lockedBy }), source)
  }

  private buildContext (): CommandContext {
    return {
      mcBot: this.mcBot,
      teleportService: this.teleportService,
      gameApiService: this.gameApiService,
      playerInteraction: this.playerInteraction,
      minecartInteraction: this.minecartInteraction,
      ridingManager: this.ridingManager,
      blockRegistry: this.blockRegistry,
      inventoryActions: this.inventoryActions,
      systemBuffer: this.systemBuffer,
      whitelist: this.whitelist,
      standby: this.standby,
      botState: this.botState,
      brewModule: this.brewModule,
      messages: this.messages,
      interactionDistance: this.interactionDistance,
      approachDistance: this.approachDistance,
      forwardWaitMs: this.forwardWaitMs,
      statusMountDebugLog: this.statusMountDebugLog,
      reply: this.reply.bind(this),
      isAdmin: this.isAdmin.bind(this),
      waypointHint: this.waypointHint.bind(this),
      notifyLocked: this.notifyLocked.bind(this)
    }
  }

  async handle (username: string, message: string, source: CommandSource): Promise<void> {
    if (username === this.mcBot.bot?.username) return

    const text = normalizeInput(message)
    if (!text) return
    if (!this.isWhitelisted(username)) return

    let parts: string[] | null = null

    if (source === 'whisper') {
      parts = parseWhisperCommand(text)
      if (!parts) return
    } else {
      if (!this.allowPublicCommands) return
      if (!matchesPrefix(text, this.prefix)) return
      const args = parsePrefixedArgs(text, this.prefix)
      if (args.length === 0) {
        await this.reply(username, this.messages.text('emptyCommand'), source)
        this.standby.scheduleAfk()
        return
      }
      parts = args
    }

    const dedupeKey = `${source}:${username}:${text}`
    const now = Date.now()
    if (this._lastCmd?.key === dedupeKey && now - this._lastCmd.time < 2000) return
    this._lastCmd = { key: dedupeKey, time: now }

    this.standby.touch()

    const cmd = (parts.shift() || '').toLowerCase()
    console.log(`[Bot:${this.mcBot.botId}][Command:${source}] ${username} -> ${cmd} ${parts.join(' ')}`.trim())

    const ctx = this.buildContext()
    const locked = this.botState.isLocked()

    if (this.botState.isBrewing() && !BREWING_ALLOWED_COMMANDS.has(cmd)) {
      await this.reply(username, this.messages.text('brewBusy'), source)
      return
    }

    if (locked && LOCKED_BLOCKED_COMMANDS.has(cmd)) {
      await this.notifyLocked(username, source)
      this.standby.scheduleAfk()
      return
    }

    if (locked && cmd === 'node') {
      const sub = (parts[0] || '').toLowerCase()
      if (sub === 'reg' || sub === 'remove') {
        await this.notifyLocked(username, source)
        this.standby.scheduleAfk()
        return
      }
    }

    switch (cmd) {
      case 'phome':
        await handlePhome(ctx, username, parts[0], source)
        break
      case 'mount':
        await handleMount(ctx, username, parts[0], source)
        break
      case 'unmount':
        await handleUnmount(ctx, username, source)
        break
      case 'cart':
        await handleCart(ctx, username, source)
        break
      case 'attack':
        await handleAttack(ctx, username, parts[0], source)
        break
      case 'node':
        await handleNode(ctx, username, parts, source)
        break
      case 'brew':
        await handleBrew(ctx, username, parts, source)
        break
      case 'lock':
        await handleLock(ctx, username, parts[0], source)
        break
      case 'unlock':
        await handleUnlock(ctx, username, source)
        break
      case 'add':
        await handleAdd(ctx, username, parts[0], source)
        break
      case 'remove':
        await handleRemove(ctx, username, parts[0], source)
        break
      case 'status':
        await handleStatus(ctx, username, source)
        break
      case 'inv':
        await handleInv(ctx, username, source)
        break
      case 'slot':
        await handleSlot(ctx, username, parts, source)
        break
      case 'bag':
        await handleInv(ctx, username, source)
        break
      case 'hand':
        await handleHand(ctx, username, parts, source)
        break
      case 'store':
        await handleStore(ctx, username, parts, source)
        break
      case 'take':
        await handleTake(ctx, username, parts, source)
        break
      case 'drop':
        await handleDrop(ctx, username, parts, source)
        break
      case 'say':
        await handleSay(ctx, username, parts.join(' '), source)
        break
      case 'forward':
        await handleForward(ctx, username, parts.join(' '), source)
        break
      case 'help':
      case '帮助':
        await handleHelp(ctx, username, source)
        break
      default:
        await this.reply(username, this.messages.text('unknownCommand', { cmd }), source)
    }

    if (!this.botState.isBrewing()) {
      this.standby.scheduleAfk()
    }
  }
}
