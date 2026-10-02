import type { PlayersResult, ServiceResult, StatusResult } from '../types'
import type MinecraftBot from '../platform/minecraft-bot'
import type Whitelist from '../permissions/whitelist'
import ActionService, { type ActionParams } from './action-service'

export default class GameApiService {
  private mcBot: MinecraftBot
  private whitelist: Whitelist
  private isLocked: () => boolean

  constructor (mcBot: MinecraftBot, whitelist: Whitelist, isLocked: () => boolean = () => false) {
    this.mcBot = mcBot
    this.whitelist = whitelist
    this.isLocked = isLocked
  }

  private actionService: ActionService | null = null

  private commandInvoker: ((sender: string, text: string) => void) | null = null

  setCommandInvoker (fn: (sender: string, text: string) => void): void {
    this.commandInvoker = fn
  }

  invokeCommand (sender: string, text: string): ServiceResult {
    if (!this.mcBot.isReady) {
      return { success: false, message: '机器人未就绪' }
    }
    if (!this.commandInvoker) {
      return { success: false, message: '指令通道未就绪' }
    }
    this.commandInvoker(sender, text)
    return { success: true, message: '已注入指令' }
  }

  say (message: string): ServiceResult {
    if (!this.mcBot.isReady) {
      return { success: false, message: '机器人未就绪' }
    }
    if (this.isLocked()) {
      return { success: false, message: 'bot 已锁定，无法发送公屏消息' }
    }

    this.mcBot.chat(message)
    console.log(`[Command] Sent chat: ${message}`)
    return { success: true, message: '已发送消息' }
  }

  getPlayers (): PlayersResult {
    if (!this.mcBot.isReady || !this.mcBot.bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const players = Object.keys(this.mcBot.bot.players || {})
    return { success: true, players, count: players.length }
  }

  /** 无状态动作：一次调用 = 一个动作（连点由控制器驱动） */
  action (act: string, params: ActionParams = {}): ServiceResult {
    if (!this.actionService) {
      this.actionService = new ActionService(this.mcBot)
    }
    const r = this.actionService.execute(act, params)
    console.log(`[Action] ${act} -> ${r.success ? 'OK' : 'FAIL'}: ${r.message}`)
    return r
  }

  getStatus (): StatusResult {
    return {
      success: true,
      minecraft: this.mcBot.isReady,
      username: this.mcBot.bot?.username || null,
      uptime: process.uptime(),
      whitelist_count: this.whitelist.count()
    }
  }
}
