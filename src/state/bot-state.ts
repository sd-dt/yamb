import type {
  BotContextSnapshot,
  BotMode,
  BrewingContext,
  CombatContext,
  LockContext,
  ModeContext,
  PendingContext,
  RideContext
} from './types'
import { isLockContext, isRideContext } from './types'

type LeaveHandler = (prevContext?: ModeContext) => void | Promise<void>

/**
 * 轻量统一状态：主模式互斥，combat/pending 正交。
 * 不是完整 FSM，只做真相源 + 进入/离开时的清理约定。
 */
export default class BotState {
  private mode: BotMode = 'idle'
  private context: ModeContext | undefined
  private pending: PendingContext | undefined
  private combat: CombatContext = { enabled: false }

  private onLeaveRide: LeaveHandler | null = null
  private onLeaveLock: LeaveHandler | null = null
  private onLeaveBrewing: LeaveHandler | null = null

  setOnLeaveRide (handler: LeaveHandler): void {
    this.onLeaveRide = handler
  }

  setOnLeaveLock (handler: LeaveHandler): void {
    this.onLeaveLock = handler
  }

  setOnLeaveBrewing (handler: LeaveHandler): void {
    this.onLeaveBrewing = handler
  }

  getMode (): BotMode {
    return this.mode
  }

  getContext (): ModeContext | undefined {
    return this.context
  }

  getCombat (): CombatContext {
    return { ...this.combat }
  }

  getPending (): PendingContext | undefined {
    return this.pending ? { ...this.pending } : undefined
  }

  snapshot (): BotContextSnapshot {
    return {
      mode: this.mode,
      pending: this.getPending(),
      combat: this.getCombat(),
      context: this.context ? { ...this.context } as ModeContext : undefined
    }
  }

  isIdle (): boolean {
    return this.mode === 'idle'
  }

  isRide (): boolean {
    return this.mode === 'ride'
  }

  isLocked (): boolean {
    return this.mode === 'lock'
  }

  isBrewing (): boolean {
    return this.mode === 'brewing'
  }

  isHoverLocked (): boolean {
    return this.mode === 'lock' && isLockContext(this.context) && this.context.hover
  }

  getLockedBy (): string | null {
    if (this.mode !== 'lock' || !isLockContext(this.context)) return null
    return this.context.by
  }

  getRideContext (): RideContext | null {
    if (this.mode !== 'ride' || !isRideContext(this.context)) return null
    return this.context
  }

  /** 空闲与骑乘可开战斗；锁定/酿造强制关闭 */
  canEnableCombat (): boolean {
    return this.mode === 'idle' || this.mode === 'ride'
  }

  setCombat (enabled: boolean, target?: string): void {
    if (enabled && !this.canEnableCombat()) {
      console.warn(`[BotState] 当前模式 ${this.mode} 不允许开启战斗`)
      return
    }
    this.combat = enabled
      ? { enabled: true, target }
      : { enabled: false }
  }

  setPending (pending: PendingContext | undefined): void {
    this.pending = pending
  }

  clearPending (): void {
    this.pending = undefined
  }

  async enterIdle (): Promise<void> {
    await this.transition('idle', undefined)
  }

  async enterRide (context: RideContext): Promise<void> {
    await this.transition('ride', context)
  }

  async enterLock (context: LockContext): Promise<void> {
    await this.transition('lock', context)
  }

  async enterBrewing (context: BrewingContext): Promise<void> {
    await this.transition('brewing', context)
  }

  /** 同模式内更新附加上下文（如切换骑乘目标） */
  patchContext (context: ModeContext): void {
    if (this.mode === 'idle') {
      console.warn('[BotState] idle 无 mode context，忽略 patchContext')
      return
    }
    this.context = context
  }

  private async transition (next: BotMode, context: ModeContext | undefined): Promise<void> {
    const prev = this.mode
    if (prev === next) {
      this.context = next === 'idle' ? undefined : context
      return
    }

    await this.leaveCurrent(prev)

    if (next === 'lock' || next === 'brewing') {
      this.combat = { enabled: false }
    }

    this.mode = next
    this.context = next === 'idle' ? undefined : context
    console.log(`[BotState] ${prev} -> ${next}`)
  }

  private async leaveCurrent (prev: BotMode): Promise<void> {
    const prevContext = this.context
    try {
      if (prev === 'ride') await this.onLeaveRide?.(prevContext)
      else if (prev === 'lock') await this.onLeaveLock?.(prevContext)
      else if (prev === 'brewing') await this.onLeaveBrewing?.(prevContext)
    } catch (err) {
      console.error(`[BotState] 离开 ${prev} 失败:`, (err as Error).message)
    }
  }
}
