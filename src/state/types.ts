export type BotMode = 'idle' | 'ride' | 'brewing' | 'lock'

export interface BrewingContext {
  phase: 'checking' | 'fermenting' | 'waiting'
  recipe: string
  finishAt: number
}

export interface LockContext {
  hover: boolean
  by: string
}

export interface RideContext {
  kind: 'player' | 'minecart'
  target?: string
  vehicleId?: number
}

export type ModeContext = BrewingContext | RideContext | LockContext

export interface CombatContext {
  enabled: boolean
  target?: string
}

/** 等待玩家响应的短暂上下文（与主模式正交） */
export interface PendingContext {
  owner: string
  type: 'tpa' | 'confirm' | 'trade'
  timeout: number
}

export interface BotContextSnapshot {
  mode: BotMode
  pending?: PendingContext
  combat: CombatContext
  context?: ModeContext
}

export function isLockContext (ctx: ModeContext | undefined): ctx is LockContext {
  return !!ctx && typeof (ctx as LockContext).by === 'string' && 'hover' in ctx
}

export function isRideContext (ctx: ModeContext | undefined): ctx is RideContext {
  return !!ctx && ((ctx as RideContext).kind === 'player' || (ctx as RideContext).kind === 'minecart')
}

export function isBrewingContext (ctx: ModeContext | undefined): ctx is BrewingContext {
  return !!ctx && typeof (ctx as BrewingContext).recipe === 'string' && 'phase' in ctx
}
