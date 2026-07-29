import fs from 'fs'
import path from 'path'
import { parse as parseYaml } from 'yaml'
import type {
  AppConfig,
  AstrbotConfig,
  BotBehaviorConfig,
  BrewConfig,
  CommandConfig,
  MessagesConfig,
  SharedEnvConfig,
  TeleportConfig,
  ViewerConfig,
  WaypointConfig
} from '../types'

const PROJECT_ROOT = path.join(__dirname, '..', '..')
const CONFIG_DIR = path.join(PROJECT_ROOT, 'config')
const GAME_CONFIG_DIR = path.join(CONFIG_DIR, 'game')
const BOTS_CONFIG_DIR = path.join(CONFIG_DIR, 'bots')
const RECIPES_CONFIG_DIR = path.join(CONFIG_DIR, 'recipes')

function envBool (value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue
  return value === 'true' || value === '1'
}

function envInt (value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === '') return defaultValue
  return parseInt(value, 10)
}

function resolvePath (relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  return path.join(PROJECT_ROOT, relativePath)
}

function readYaml<T> (filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[Config] File not found: ${filePath}`)
      return null
    }
    const raw = fs.readFileSync(filePath, 'utf-8')
    return parseYaml(raw) as T
  } catch (err) {
    console.warn(`[Config] Failed to read ${filePath}:`, (err as Error).message)
    return null
  }
}

/** 深层合并：数组整段替换；对象递归；undefined 不覆盖 */
function deepMerge<T> (base: T, override: unknown): T {
  if (override === undefined || override === null) return base
  if (Array.isArray(override)) return override as T
  if (typeof override !== 'object' || typeof base !== 'object' || base === null || Array.isArray(base)) {
    return override as T
  }

  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (value === undefined) continue
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value)
    } else {
      result[key] = value
    }
  }
  return result as T
}

function normalizeWaypoints (raw: unknown): WaypointConfig[] {
  if (!Array.isArray(raw)) return []
  const waypoints: WaypointConfig[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      waypoints.push({ id: item, alias: item })
      continue
    }
    if (item && typeof item === 'object') {
      const w = item as Partial<WaypointConfig>
      const id = w.id?.trim()
      const alias = w.alias?.trim()
      if (id && alias) waypoints.push({ id, alias })
    }
  }
  return waypoints
}

function normalizeHelpLines (raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.map(line => String(line)).filter(line => line.trim().length > 0)
}

function normalizeAdminList (raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.map(x => String(x).trim()).filter(Boolean)
}


interface GameDefaults {
  command: Omit<CommandConfig, 'messages'> & { messages?: MessagesConfig }
  teleport: TeleportConfig
  bot: BotBehaviorConfig
  viewer: ViewerConfig
  brew: BrewConfig
  messages: MessagesConfig
}

interface BotFileConfig {
  id?: string
  enabled?: boolean
  account?: {
    username?: string
    password?: string
    auth?: string
    /** 相对共享 profilesFolder 的子目录 */
    profilesSubdir?: string
  }
  adminList?: string[]
  astrbot?: Partial<AstrbotConfig>
  command?: Partial<CommandConfig>
  teleport?: Partial<TeleportConfig>
  bot?: Partial<BotBehaviorConfig>
  viewer?: Partial<ViewerConfig>
  brew?: Partial<BrewConfig>
  messages?: Partial<MessagesConfig>
  /** help 回复行（按 bot 分工配置；不再使用 game/messages 默认） */
  helpLines?: string[]
}

export function loadSharedEnv (): SharedEnvConfig {
  const mcVersion = process.env.MC_VERSION
  return {
    host: process.env.MC_HOST || 'localhost',
    port: envInt(process.env.MC_PORT, 25565),
    profilesFolder: resolvePath(process.env.MC_PROFILES_FOLDER || './mc-tokens'),
    version: !mcVersion || mcVersion === 'false' ? false : mcVersion,
    checkTimeoutInterval: envInt(process.env.MC_CHECK_TIMEOUT, 300000),
    messageQueue: {
      maxSize: envInt(process.env.QUEUE_MAX_SIZE, 100),
      delayMs: envInt(process.env.QUEUE_DELAY_MS, 1000)
    },
    apiKey: process.env.API_KEY || undefined
  }
}

function loadGameDefaults (): GameDefaults {
  const commandRaw = readYaml<Partial<CommandConfig>>(path.join(GAME_CONFIG_DIR, 'command.yaml')) ?? {}
  const teleportRaw = readYaml<Partial<TeleportConfig>>(path.join(GAME_CONFIG_DIR, 'teleport.yaml')) ?? {}
  const botRaw = readYaml<Partial<BotBehaviorConfig>>(path.join(GAME_CONFIG_DIR, 'bot.yaml')) ?? {}
  const viewerRaw = readYaml<Partial<ViewerConfig>>(path.join(GAME_CONFIG_DIR, 'viewer.yaml')) ?? {}
  const brewRaw = readYaml<Partial<BrewConfig>>(path.join(GAME_CONFIG_DIR, 'brew.yaml')) ?? {}
  const messages = readYaml<MessagesConfig>(path.join(GAME_CONFIG_DIR, 'messages.yaml'))
  if (!messages) {
    console.error('[Config] Error: config/game/messages.yaml is required')
    process.exit(1)
  }
  // helpLines 仅由各 bot 配置提供
  delete messages.helpLines

  return {
    messages,
    command: {
      prefix: commandRaw.prefix || '#ybot',
      whisperCommand: commandRaw.whisperCommand || '/msg',
      allowPublicCommands: commandRaw.allowPublicCommands ?? false,
      replyAlwaysWhisper: commandRaw.replyAlwaysWhisper ?? true
    },
    teleport: {
      databaseFile: teleportRaw.databaseFile || './data/db.db',
      tpacceptCommand: teleportRaw.tpacceptCommand || '/tpaccept',
      tpahereCommand: teleportRaw.tpahereCommand || '/tpahere',
      phomeCommand: teleportRaw.phomeCommand || '/phome',
      waypoints: normalizeWaypoints(teleportRaw.waypoints),
      waypointDelayMs: teleportRaw.waypointDelayMs ?? 3000,
      waypointsHelp: teleportRaw.waypointsHelp?.trim() || ''
    },
    bot: {
      idleTimeoutMs: botRaw.idleTimeoutMs ?? 90000,
      idleCheckIntervalMs: botRaw.idleCheckIntervalMs ?? 10000,
      homeCommand: botRaw.homeCommand || '/home',
      afkCommand: botRaw.afkCommand || '/afk',
      afkDelayMs: botRaw.afkDelayMs ?? 500,
      homeWaitMs: botRaw.homeWaitMs ?? 3000,
      replyDelayMs: botRaw.replyDelayMs ?? 500,
      interactionDistance: botRaw.interactionDistance ?? 3,
      approachDistance: botRaw.approachDistance ?? 10,
      forwardWaitMs: botRaw.forwardWaitMs ?? 2000,
      ridingCheckIntervalMs: botRaw.ridingCheckIntervalMs ?? 1500,
      homeMovementThreshold: botRaw.homeMovementThreshold ?? 30,
      statusMountDebugLog: botRaw.statusMountDebugLog ?? false,
      reconnectDelayMs: botRaw.reconnectDelayMs ?? 20000,
      authReconnectDelayMs: botRaw.authReconnectDelayMs ?? 15000,
      spamReconnectDelayMs: botRaw.spamReconnectDelayMs ?? 30000,
      spawnTimeoutMs: botRaw.spawnTimeoutMs ?? 30000
    },
    viewer: {
      enabled: viewerRaw.enabled ?? false,
      port: viewerRaw.port ?? 3007,
      firstPerson: viewerRaw.firstPerson ?? false,
      viewDistance: viewerRaw.viewDistance ?? 6
    },
    brew: {
      enabled: brewRaw.enabled ?? false
    }
  }
}

function listBotFiles (): string[] {
  if (!fs.existsSync(BOTS_CONFIG_DIR)) return []
  return fs.readdirSync(BOTS_CONFIG_DIR)
    .filter(name => name.endsWith('.yaml') || name.endsWith('.yml'))
    .map(name => path.join(BOTS_CONFIG_DIR, name))
    .sort()
}

function buildBotConfig (
  shared: SharedEnvConfig,
  game: GameDefaults,
  filePath: string,
  raw: BotFileConfig
): AppConfig {
  const fileId = path.basename(filePath).replace(/\.(yaml|yml)$/i, '')
  const id = (raw.id || fileId).trim()
  if (!id) {
    console.error(`[Config] Bot file missing id: ${filePath}`)
    process.exit(1)
  }

  const username = raw.account?.username?.trim()
  if (!username) {
    console.error(`[Config] Bot "${id}" missing account.username`)
    process.exit(1)
  }

  const password = raw.account?.password?.trim() || undefined
  const auth = raw.account?.auth || 'microsoft'
  const subdir = raw.account?.profilesSubdir?.trim()
  const profilesFolder = subdir
    ? path.join(shared.profilesFolder, subdir)
    : shared.profilesFolder

  const commandMerged = deepMerge(game.command, raw.command ?? {})
  const helpLines = normalizeHelpLines(raw.helpLines ?? raw.messages?.helpLines)
  if (helpLines.length === 0) {
    console.error(`[Config] Bot "${id}" missing helpLines (define in config/bots/${id}.yaml)`)
    process.exit(1)
  }
  const messagesMerged: MessagesConfig = {
    ...deepMerge(game.messages, raw.messages ?? {}),
    helpLines
  }
  const teleportOverride: Partial<TeleportConfig> = { ...(raw.teleport ?? {}) }
  if (raw.teleport?.waypoints !== undefined) {
    teleportOverride.waypoints = normalizeWaypoints(raw.teleport.waypoints)
  }
  if (teleportOverride.databaseFile === undefined) {
    teleportOverride.databaseFile = `./data/${id}.db`
  }
  const teleportMerged = deepMerge(game.teleport, teleportOverride)
  const botMerged = deepMerge(game.bot, raw.bot ?? {})
  const viewerMerged = deepMerge(game.viewer, raw.viewer ?? {})
  const brewMerged = deepMerge(game.brew, raw.brew ?? {})

  const astrbotEnabled = raw.astrbot?.enabled ?? false
  const astrbot: AstrbotConfig = {
    enabled: astrbotEnabled,
    port: raw.astrbot?.port ?? 15100,
    apiKey: raw.astrbot?.apiKey ?? shared.apiKey
  }

  return {
    id,
    minecraft: {
      host: shared.host,
      port: shared.port,
      username,
      password,
      auth,
      profilesFolder,
      version: shared.version,
      checkTimeoutInterval: shared.checkTimeoutInterval
    },
    astrbot,
    adminList: normalizeAdminList(raw.adminList),
    command: {
      ...commandMerged,
      messages: messagesMerged
    },
    teleport: {
      ...teleportMerged,
      waypoints: normalizeWaypoints(teleportMerged.waypoints)
    },
    bot: botMerged,
    viewer: viewerMerged,
    brew: brewMerged,
    messageQueue: { ...shared.messageQueue }
  }
}

/**
 * 加载所有 enabled=true 的 bot 实例配置。
 * game/*.yaml 为默认；bots/*.yaml 可覆盖对应段落。
 */
export function loadEnabledBotConfigs (): AppConfig[] {
  const shared = loadSharedEnv()
  const game = loadGameDefaults()

  console.log(`[Config] game dir: ${GAME_CONFIG_DIR}`)
  console.log(`[Config] bots dir: ${BOTS_CONFIG_DIR}`)
  console.log(`[Config] recipes dir: ${RECIPES_CONFIG_DIR}`)

  const files = listBotFiles()
  if (files.length === 0) {
    console.error('[Config] Error: no bot yaml found in config/bots/')
    process.exit(1)
  }

  const configs: AppConfig[] = []
  for (const filePath of files) {
    const raw = readYaml<BotFileConfig>(filePath)
    if (!raw) continue
    if (raw.enabled !== true) {
      const name = raw.id || path.basename(filePath)
      console.log(`[Config] Skip disabled bot: ${name}`)
      continue
    }
    const config = buildBotConfig(shared, game, filePath, raw)
    validateBotConfig(config)
    configs.push(config)
    console.log(`[Config] Enabled bot: ${config.id} (${config.minecraft.username})`)
  }

  if (configs.length === 0) {
    console.error('[Config] Error: no enabled bots (set enabled: true in config/bots/*.yaml)')
    process.exit(1)
  }

  const ids = new Set<string>()
  for (const c of configs) {
    if (ids.has(c.id)) {
      console.error(`[Config] Error: duplicate bot id "${c.id}"`)
      process.exit(1)
    }
    ids.add(c.id)
  }

  return configs
}

export function validateBotConfig (config: AppConfig): void {
  if (!config.minecraft.username) {
    console.error(`[Config] Error: bot "${config.id}" missing username`)
    process.exit(1)
  }
  if (config.astrbot.enabled && !config.astrbot.apiKey) {
    console.error(`[Config] Error: bot "${config.id}" AstrBot enabled but no apiKey (set astrbot.apiKey or API_KEY in .env)`)
    process.exit(1)
  }
}

export function resolveDataPath (relativePath: string): string {
  return path.join(PROJECT_ROOT, relativePath)
}

/** @deprecated 使用 loadEnabledBotConfigs */
export function loadConfig (): AppConfig {
  const configs = loadEnabledBotConfigs()
  return configs[0]
}

export function validateConfig (config: AppConfig): void {
  validateBotConfig(config)
}

export {
  PROJECT_ROOT,
  CONFIG_DIR,
  GAME_CONFIG_DIR,
  BOTS_CONFIG_DIR,
  RECIPES_CONFIG_DIR,
  deepMerge,
  envBool
}
