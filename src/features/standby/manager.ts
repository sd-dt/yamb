import type { BotBehaviorConfig } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import logBus from '../../platform/log-bus'
import { eatGoldenCarrotsUntilFull } from './food'
import { sleep } from '../../platform/sleep'

import type RidingManager from '../riding/manager'

export default class StandbyManager {
  private mcBot: MinecraftBot
  private ridingManager: RidingManager | null = null
  private isLocked: () => boolean = () => false
  private isBusy: () => boolean = () => false
  private idleTimeoutMs: number
  private homeCommand: string
  private afkCommand: string
  private afkDelayMs: number
  private homeWaitMs: number
  private checkIntervalMs: number
  private lastActivity = Date.now()
  private checkTimer: ReturnType<typeof setInterval> | null = null
  private afkTimer: ReturnType<typeof setTimeout> | null = null
  private goingHome = false

  constructor (mcBot: MinecraftBot, config: BotBehaviorConfig) {
    this.mcBot = mcBot
    this.idleTimeoutMs = config.idleTimeoutMs
    this.homeCommand = config.homeCommand
    this.afkCommand = config.afkCommand
    this.afkDelayMs = config.afkDelayMs
    this.homeWaitMs = config.homeWaitMs
    this.checkIntervalMs = config.idleCheckIntervalMs
  }

  private withBot<T> (fn: () => T): T {
    return logBus.runAs(this.mcBot.botId, fn)
  }

  setRidingManager (ridingManager: RidingManager): void {
    this.ridingManager = ridingManager
  }

  setIsLocked (isLocked: () => boolean): void {
    this.isLocked = isLocked
  }

  setIsBusy (isBusy: () => boolean): void {
    this.isBusy = isBusy
  }

  start (): void {
    if (this.checkTimer) return
    this.touch()
    this.checkTimer = setInterval(() => {
      this.withBot(() => { void this.checkIdle() })
    }, this.checkIntervalMs)
    console.log(`[Standby] 空闲 ${this.idleTimeoutMs / 1000}s 后自动回家`)
  }

  stop (): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }
    this.cancelAfk()
  }

  touch (): void {
    this.lastActivity = Date.now()
  }

  cancelAfk (): void {
    if (this.afkTimer) {
      clearTimeout(this.afkTimer)
      this.afkTimer = null
    }
  }

  scheduleAfk (attempt = 0): void {
    if (this.afkTimer) clearTimeout(this.afkTimer)
    const delay = attempt === 0 ? this.afkDelayMs : 1000
    this.afkTimer = setTimeout(() => {
      this.withBot(() => {
        if (this.isBusy()) return
        const bot = this.mcBot.bot
        // 骑乘时 onGround 恒为 false，应照常 AFK；仅意外半空时推迟
        const riding = this.ridingManager?.isActive() ?? false
        if (bot && !bot.entity.onGround && !riding && !this.isLocked()) {
          if (attempt >= 10) {
            console.log('[Standby] 多次未落地，放弃本次 AFK')
            return
          }
          console.log(`[Standby] 未落地，推迟 AFK (${attempt + 1}/10)`)
          this.scheduleAfk(attempt + 1)
          return
        }
        if (this.mcBot.chat(this.afkCommand)) {
          console.log(`[Standby] 执行 ${this.afkCommand}`)
        }
      })
    }, delay)
  }

  private async checkIdle (): Promise<void> {
    if (!this.mcBot.isReady || this.goingHome) return
    if (this.isBusy()) {
      this.touch()
      return
    }
    // 空闲 / 骑乘 / 锁定互斥：锁定与骑乘时不进入待命回家
    if (this.isLocked()) {
      this.scheduleAfk()
      this.touch()
      return
    }
    if (this.ridingManager?.isActive()) return
    if (Date.now() - this.lastActivity < this.idleTimeoutMs) return
    await this.goHomeStandby()
  }

  async goHomeStandby (): Promise<void> {
    if (!this.mcBot.isReady || !this.mcBot.bot || this.goingHome) return
    if (this.isLocked()) {
      this.scheduleAfk()
      return
    }

    this.goingHome = true
    console.log(`[Standby] 超过 ${this.idleTimeoutMs / 1000}s 无互动，执行 ${this.homeCommand}`)

    try {
      if (this.isLocked()) {
        this.scheduleAfk()
        return
      }
      this.mcBot.chat(this.homeCommand)
      await sleep(this.homeWaitMs)

      if (this.isLocked()) {
        this.scheduleAfk()
        return
      }

      if (this.mcBot.bot) {
        await eatGoldenCarrotsUntilFull(this.mcBot.bot)
      }

      this.scheduleAfk()
      this.touch()
    } catch (err) {
      console.error('[Standby] 回家待命失败:', (err as Error).message)
    } finally {
      this.goingHome = false
    }
  }
}
