export interface MinecraftConfig {
  host: string
  port: number
  username: string
  password: string | undefined
  auth: string
  profilesFolder: string
  version: string | false
  checkTimeoutInterval: number
}

export interface AstrbotConfig {
  enabled: boolean
  port: number
  apiKey: string | undefined
}

export interface MessagesConfig {
  emptyCommand?: string
  unknownCommand?: string
  noPermission?: string
  phomeUsage?: string
  phomeError?: string
  lockedBlocked?: string
  lockAlready?: string
  lockUsage?: string
  lockSuccess?: string
  lockHoverSuccess?: string
  lockHoverFailed?: string
  unlockNotLocked?: string
  unlockSuccess?: string
  addUsage?: string
  addAlready?: string
  addSuccess?: string
  removeUsage?: string
  removeNotFound?: string
  removeSuccess?: string
  statusLines?: string[]
  statusLocked?: string
  statusUnlocked?: string
  statusIdle?: string
  statusRidingPlayer?: string
  statusRidingMinecart?: string
  sayUsage?: string
  saySuccess?: string
  sayError?: string
  forwardUsage?: string
  forwardSuccess?: string
  forwardEmpty?: string
  forwardError?: string
  mountUsage?: string
  mountSuccess?: string
  mountError?: string
  mountAlready?: string
  unmountSuccess?: string
  unmountError?: string
  cartSuccess?: string
  cartError?: string
  invHeader?: string
  invEmpty?: string
  invError?: string
  storeUsage?: string
  storeSuccess?: string
  storeError?: string
  takeUsage?: string
  takeSuccess?: string
  takeError?: string
  dropUsage?: string
  dropSuccess?: string
  dropError?: string
  attackUsage?: string
  attackSuccess?: string
  attackError?: string
  nodeUsage?: string
  nodeRegUsage?: string
  nodeRegSuccess?: string
  nodeRegError?: string
  nodeRemoveUsage?: string
  nodeRemoveSuccess?: string
  nodeNotFound?: string
  nodeContainerNotFound?: string
  nodeListEmpty?: string
  nodeListHeader?: string
  nodeListEntry?: string
  nodeInfoUsage?: string
  nodeInfoLines?: string[]
  nodeNoTarget?: string
  dedicatedContainerMismatch?: string
  brewUsage?: string
  brewDisabled?: string
  brewRecipeNotFound?: string
  brewBusy?: string
  brewStarted?: string
  brewStatusIdle?: string
  brewStatusRunning?: string
  brewCancelRequested?: string
  brewStopped?: string
  helpLines?: string[]
}

export interface CommandConfig {
  prefix: string
  whisperCommand: string
  allowPublicCommands: boolean
  replyAlwaysWhisper: boolean
  /** 除 status/help 外，将命令回复写入日志而不发送给玩家 */
  silentMode: boolean
  messages: MessagesConfig
}

export interface WaypointConfig {
  id: string
  alias: string
}

export interface TeleportConfig {
  databaseFile: string
  tpacceptCommand: string
  tpahereCommand: string
  phomeCommand: string
  waypoints: WaypointConfig[]
  waypointDelayMs?: number
  /** help / phome 用法里 {waypoints} 的展示文案（固定字符串，与 alias 无关） */
  waypointsHelp?: string
}

export interface BotBehaviorConfig {
  idleTimeoutMs: number
  idleCheckIntervalMs: number
  homeCommand: string
  afkCommand: string
  afkDelayMs: number
  homeWaitMs: number
  replyDelayMs: number
  interactionDistance: number
  approachDistance: number
  forwardWaitMs: number
  ridingCheckIntervalMs: number
  homeMovementThreshold: number
  /** status 命令是否输出骑乘调试日志到控制台 */
  statusMountDebugLog: boolean
  reconnectDelayMs: number
  authReconnectDelayMs: number
  spamReconnectDelayMs: number
  spawnTimeoutMs: number
}

export interface ViewerConfig {
  enabled: boolean
  port: number
  firstPerson: boolean
  viewDistance: number
}

export interface FermentationIngredient {
  /** 专用原料容器的 BlockNode alias */
  container: string
  /** 每个炼药锅投入数量 */
  count: number
}

export const AGING_WOOD_TYPES = [
  'oak',
  'spruce',
  'birch',
  'jungle',
  'acacia',
  'mangrove',
  'cherry',
  'bamboo',
  'any'
] as const

export type AgingWoodType = typeof AGING_WOOD_TYPES[number]

export interface BrewRecipe {
  id: string
  fermentation: {
    durationSeconds: number
    ingredients: FermentationIngredient[]
  }
  /** 省略时，发酵产物直接入成品箱 */
  distillation?: {
    /** 蒸馏循环次数；每次按 45 秒（40 秒 + 5 秒冗余）等待 */
    runs: number
  }
  /** 省略时不进行陈化；days 为游戏日，每游戏日等待 20 分钟 */
  aging?: {
    days: number
    wood: AgingWoodType
  }
}

export type BrewWaterMode = 'source' | 'preloaded' | 'bucket-stock'

export interface BrewConfig {
  enabled: boolean
  group: string
  fermenterCount: number
  waterMode: BrewWaterMode
  toolbox: string
  waterSource: string
  waterBucketContainer: string
  emptyBucketContainer: string
  bottleContainer: string
  /** 按顺序使用的混合产物容器 BlockNode alias */
  productContainers: string[]
  /** @deprecated 使用 productContainers */
  productContainer?: string
  interactionDelayMs: number
  waterRefillDelayMs: number
  recipes: BrewRecipe[]
}

export interface MessageQueueConfig {
  maxSize: number
  delayMs: number
}

/** 进程级共享环境（来自 .env） */
export interface SharedEnvConfig {
  host: string
  port: number
  profilesFolder: string
  version: string | false
  checkTimeoutInterval: number
  messageQueue: MessageQueueConfig
  /** 各 bot AstrBot 可回落的共用密钥 */
  apiKey: string | undefined
}

/**
 * 单个 bot 运行时完整配置 = game 默认 + bots/*.yaml 覆盖
 */
export interface AppConfig {
  id: string
  minecraft: MinecraftConfig
  astrbot: AstrbotConfig
  adminList: string[]
  command: CommandConfig
  teleport: TeleportConfig
  bot: BotBehaviorConfig
  viewer: ViewerConfig
  brew: BrewConfig
  messageQueue: MessageQueueConfig
}

export interface ServiceResult {
  success: boolean
  message?: string
  code?: 'locked' | 'not_ready' | 'unknown_waypoint'
  lockedBy?: string | null
}

export interface PlayersResult extends ServiceResult {
  players?: string[]
  count?: number
}

export interface StatusResult extends ServiceResult {
  minecraft?: boolean
  username?: string | null
  uptime?: number
  whitelist_count?: number
}

export interface WhitelistEntry {
  addedBy: string
  addedAt: string
}

export type WhitelistData = Record<string, WhitelistEntry>

export interface QueueTask {
  message: string
  sender: string | null
  timestamp: number
}

export interface QueueStatus {
  size: number
  isProcessing: boolean
  isLocked: boolean
  maxSize: number
}
