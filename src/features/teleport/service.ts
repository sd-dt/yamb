import type { ServiceResult, TeleportConfig, WaypointConfig } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import type BotState from '../../state/bot-state'
import { jumpAndHover } from '../../actions/shared/entity-utils'
import { sleep } from '../../platform/sleep'

export default class TeleportService {
  private mcBot: MinecraftBot
  private botState: BotState
  private tpacceptCommand: string
  private tpahereCommand: string
  private phomeCommand: string
  private waypointByAlias: Map<string, string>
  private waypointDelayMs: number
  private onLock: (() => void) | null = null
  private onUnlock: ((info: { wasHover: boolean }) => void) | null = null

  constructor (mcBot: MinecraftBot, botState: BotState, config: TeleportConfig) {
    this.mcBot = mcBot
    this.botState = botState
    this.tpacceptCommand = config.tpacceptCommand
    this.tpahereCommand = config.tpahereCommand
    this.phomeCommand = config.phomeCommand
    this.waypointByAlias = new Map(
      config.waypoints.map(w => [w.alias, w.id])
    )
    this.waypointDelayMs = config.waypointDelayMs ?? 3000
  }

  setOnLock (onLock: () => void): void {
    this.onLock = onLock
  }

  setOnUnlock (onUnlock: (info: { wasHover: boolean }) => void): void {
    this.onUnlock = onUnlock
  }

  isLocked (): boolean {
    return this.botState.isLocked()
  }

  isHoverLocked (): boolean {
    return this.botState.isHoverLocked()
  }

  getLockedBy (): string | null {
    return this.botState.getLockedBy()
  }

  /**
   * 进入锁定：BotState 离开 ride 时会触发下马；
   * options.hover 时先滞空再进入 lock 模式。
   */
  async prepareAndLock (
    by: string,
    options?: { hover?: boolean }
  ): Promise<{ success: boolean; code?: 'already' | 'not_ready' | 'hover_failed' }> {
    if (this.botState.isLocked()) return { success: false, code: 'already' }

    const hover = !!options?.hover
    if (hover) {
      const bot = this.mcBot.bot
      if (!bot || !this.mcBot.isReady) {
        return { success: false, code: 'not_ready' }
      }
      const hovered = await jumpAndHover(bot)
      if (!hovered) return { success: false, code: 'hover_failed' }
    }

    await this.botState.enterLock({ hover, by })
    this.onLock?.()
    console.log(`[Teleport] Locked by ${by}${hover ? ' (hover)' : ''}`)
    return { success: true }
  }

  async unlock (): Promise<{ wasHover: boolean }> {
    const wasHover = this.botState.isHoverLocked()
    if (!this.botState.isLocked()) {
      return { wasHover: false }
    }
    await this.botState.enterIdle()
    this.onUnlock?.({ wasHover })
    console.log(`[Teleport] Unlocked${wasHover ? ' (resume physics)' : ''}`)
    return { wasHover }
  }

  /**
   * 重连进服后恢复锁定相关的“物理表现”。
   * 逻辑锁定在 BotState 内存中，掉线不会丢。
   */
  async restorePhysicalLockState (): Promise<void> {
    if (!this.botState.isLocked()) return

    const bot = this.mcBot.bot
    if (!bot || !this.mcBot.isReady) return

    const by = this.botState.getLockedBy() || '未知'
    if (this.botState.isHoverLocked()) {
      console.log(`[Teleport] 重连后恢复滞空锁定 (by ${by})`)
      const hovered = await jumpAndHover(bot)
      if (!hovered) {
        console.warn('[Teleport] 滞空恢复失败，逻辑锁定仍保持')
      }
    } else {
      console.log(`[Teleport] 重连后保持锁定状态 (by ${by})`)
    }

    this.onLock?.()
  }

  canAcceptRequest (type: 'tpa' | 'tpahere'): boolean {
    if (type === 'tpa') return true
    return !this.botState.isLocked()
  }

  canUseWaypoint (): boolean {
    return !this.botState.isLocked()
  }

  listWaypointAliases (): string[] {
    return [...this.waypointByAlias.keys()].sort()
  }

  listWaypoints (): WaypointConfig[] {
    return [...this.waypointByAlias.entries()]
      .map(([alias, id]) => ({ alias, id }))
      .sort((a, b) => a.alias.localeCompare(b.alias))
  }

  resolveWaypointId (alias: string): string | null {
    return this.waypointByAlias.get(alias) ?? null
  }

  async acceptRequest (playerName: string, type: 'tpa' | 'tpahere'): Promise<ServiceResult> {
    if (!this.mcBot.isReady) {
      return { success: false, message: '机器人未就绪', code: 'not_ready' }
    }

    try {
      this.mcBot.chat(`${this.tpacceptCommand} ${playerName}`)
      console.log(`[Teleport] Auto-accepted ${type} from ${playerName}`)
      return { success: true }
    } catch (err) {
      console.error('[Teleport] Accept error:', (err as Error).message)
      return { success: false, message: (err as Error).message }
    }
  }

  async goToPlayerViaWaypoint (playerName: string, alias: string): Promise<ServiceResult> {
    if (!this.mcBot.isReady) {
      return { success: false, message: '机器人未就绪', code: 'not_ready' }
    }
    if (!this.canUseWaypoint()) {
      return {
        success: false,
        code: 'locked',
        lockedBy: this.botState.getLockedBy(),
        message: 'bot 已锁定，无法使用传送点'
      }
    }

    const waypointId = this.resolveWaypointId(alias)
    if (!waypointId) {
      const available = this.listWaypointAliases()
      const hint = available.length > 0 ? `可用: ${available.join(', ')}` : '未配置传送点'
      return {
        success: false,
        code: 'unknown_waypoint',
        message: `未知传送点 "${alias}"，${hint}`
      }
    }

    try {
      this.mcBot.chat(`${this.phomeCommand} ${waypointId}`)
      console.log(`[Teleport] Sent ${this.phomeCommand} ${waypointId} (${alias}) for ${playerName}`)
      await sleep(this.waypointDelayMs)
      this.mcBot.chat(`${this.tpahereCommand} ${playerName}`)
      console.log(`[Teleport] Sent ${this.tpahereCommand} ${playerName} via ${alias}`)
      return { success: true }
    } catch (err) {
      console.error('[Teleport] Waypoint error:', (err as Error).message)
      return { success: false, message: (err as Error).message }
    }
  }
}
