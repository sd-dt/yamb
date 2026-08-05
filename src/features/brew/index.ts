import { Vec3 } from 'vec3'
import type { AgingWoodType, BrewConfig, BrewRecipe, ServiceResult } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import type BlockRegistry from '../block-registry'
import type { BlockNode } from '../block-registry'
import type InventoryActions from '../../actions/inventory'
import { findExactMatchingItems, normalizeItemKey } from '../../actions/inventory'
import type BotState from '../../state/bot-state'
import { sleep } from '../../platform/sleep'
import { loadBrewRecipes } from '../../config/loader'
import { formatBrewingStatus } from '../../state/brewing-status'
import { ensurePathfinder } from '../../actions/shared/entity-utils'
import { getAgingWoodType } from '../block-node-utils'

/** 一个游戏日按 20 分钟现实时间计时 */
const AGING_MS_PER_DAY = 20 * 60 * 1000
const AGING_REMIND_10_MS = 10 * 60 * 1000
const AGING_REMIND_5_MS = 5 * 60 * 1000
const AGING_TICK_MS = 15_000

interface AgingTask {
  id: string
  recipeId: string
  owner: string
  barrel: BlockNode
  finishAt: number
  reminded10: boolean
  reminded5: boolean
  pendingAwayNotified: boolean
  phase: 'aging' | 'pending-collect'
  collecting: boolean
}

export default class BrewModule {
  private readonly mcBot: MinecraftBot
  private readonly config: BrewConfig
  private readonly blockRegistry: BlockRegistry
  private readonly inventoryActions: InventoryActions
  private readonly botState: BotState
  private readonly interactionDistance: number
  private readonly approachDistance: number
  private cancelRequested = false
  private taskRunning = false
  private report: ((message: string) => Promise<void>) | null = null
  private errors = 0
  private currentOwner: string | null = null
  private readonly agingTasks = new Map<string, AgingTask>()
  private agingTimer: ReturnType<typeof setInterval> | null = null

  constructor (
    mcBot: MinecraftBot,
    config: BrewConfig,
    blockRegistry: BlockRegistry,
    inventoryActions: InventoryActions,
    botState: BotState,
    interactionDistance: number,
    approachDistance: number
  ) {
    this.mcBot = mcBot
    this.config = config
    this.blockRegistry = blockRegistry
    this.inventoryActions = inventoryActions
    this.botState = botState
    this.interactionDistance = interactionDistance
    this.approachDistance = approachDistance
  }

  register (): void {
    if (!this.config.enabled) {
      console.log('[Brew] Module disabled')
      return
    }
    console.log(`[Brew] Module ready: ${this.config.recipes.length} recipe(s)`)
  }

  async start (
    recipeId: string,
    report: (message: string) => Promise<void>,
    owner: string
  ): Promise<ServiceResult> {
    if (!this.config.enabled) {
      return { success: false, message: '酿酒模块未启用' }
    }
    if (!this.mcBot.isReady || !this.mcBot.bot) {
      return { success: false, message: '机器人未就绪' }
    }
    if (!Number.isInteger(this.config.fermenterCount) || this.config.fermenterCount <= 0) {
      return { success: false, message: 'fermenterCount 必须是正整数' }
    }
    if (this.taskRunning) {
      return { success: false, message: '上一酿酒任务仍在停止或清理中' }
    }
    if (!this.botState.isIdle()) {
      return { success: false, message: `bot 当前处于 ${this.botState.getMode()} 状态` }
    }

    const recipe = this.config.recipes.find(item => item.id === recipeId)
    if (!recipe) {
      return { success: false, message: `配方不存在: ${recipeId}` }
    }

    this.cancelRequested = false
    this.taskRunning = true
    this.errors = 0
    this.report = report
    this.currentOwner = owner
    await this.botState.enterBrewing({
      phase: 'checking',
      recipe: recipe.id,
      finishAt: 0
    })
    void this.runFermentation(recipe)
    return { success: true, message: `已开始发酵 ${recipe.id}` }
  }

  status (): {
    running: boolean
    recipe?: string
    phase?: string
    finishAt?: number
    detail?: string
    aging?: string[]
  } {
    const aging = this.formatAgingStatusLines()
    if (!this.botState.isBrewing()) {
      return aging.length > 0
        ? { running: false, aging }
        : { running: false }
    }
    const context = this.botState.getContext()
    if (!context || !('recipe' in context) || !('phase' in context)) {
      return { running: true, aging }
    }
    return {
      running: true,
      recipe: context.recipe,
      phase: context.phase,
      finishAt: context.finishAt,
      detail: formatBrewingStatus(context),
      aging
    }
  }

  formatAgingStatusLines (now = Date.now()): string[] {
    return [...this.agingTasks.values()]
      .sort((a, b) => a.finishAt - b.finishAt)
      .map(task => {
        const when = new Date(task.finishAt).toLocaleTimeString()
        if (task.phase === 'pending-collect') {
          return `Aging ${task.recipeId} @ ${task.barrel.alias} pending collect`
        }
        const remaining = Math.max(0, Math.ceil((task.finishAt - now) / 1000))
        const minutes = Math.floor(remaining / 60)
        const seconds = remaining % 60
        const left = minutes > 0 ? `${minutes}min ${seconds}s` : `${seconds}s`
        return `Aging ${task.recipeId} @ ${task.barrel.alias} ${left} (~${when})`
      })
  }

  reloadRecipes (): ServiceResult & { count?: number } {
    const recipes = loadBrewRecipes()
    if (recipes.length === 0) {
      return {
        success: false,
        message: '未加载到有效配方，已保留当前配方'
      }
    }
    this.config.recipes = recipes
    console.log(`[Brew] Reloaded ${recipes.length} recipe(s)`)
    return {
      success: true,
      count: recipes.length,
      message: `已重新加载 ${recipes.length} 个酿酒配方`
    }
  }

  cancel (): boolean {
    if (!this.taskRunning) return false
    this.cancelRequested = true
    return true
  }

  async stop (): Promise<boolean> {
    if (!this.taskRunning) return false
    this.cancelRequested = true
    const bot = this.mcBot.bot
    if (bot) {
      try { ensurePathfinder(bot).pathfinder.stop() } catch { /* ignore */ }
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch { /* ignore */ }
      try { bot.deactivateItem() } catch { /* ignore */ }
      bot.clearControlStates()
    }
    await this.botState.enterIdle()
    return true
  }

  dispose (): void {
    if (this.agingTimer) {
      clearInterval(this.agingTimer)
      this.agingTimer = null
    }
  }

  private async runFermentation (recipe: BrewRecipe): Promise<void> {
    let hasCollectedProducts = false
    try {
      const fermenters = this.resolveFermenters()
      await this.ensureFermentersFull(fermenters)
      this.assertNotCancelled()

      const ingredients = await this.checkSupplies(recipe)
      await this.takeSupplies(ingredients, fermenters.length)
      this.assertNotCancelled()

      let finishAt = 0
      const startedAtByFermenter = await this.addIngredients(fermenters, ingredients, lastStartedAt => {
        finishAt = lastStartedAt + recipe.fermentation.durationSeconds * 1000
        this.botState.patchContext({
          phase: 'fermenting',
          recipe: recipe.id,
          finishAt
        })
      })
      await this.returnBuckets()

      // 状态倒计时固定以最后一锅（最晚完成）为准。
      this.botState.patchContext({
        phase: 'waiting',
        recipe: recipe.id,
        finishAt
      })
      const remainingSeconds = Math.max(0, Math.ceil((finishAt - Date.now()) / 1000))
      await this.reportSafe(`原料投入完成，最后一锅剩余发酵时间约 ${remainingSeconds} 秒`)
      await this.bottleProductsWhenReady(
        fermenters,
        startedAtByFermenter,
        recipe.fermentation.durationSeconds,
        recipe.id,
        () => { hasCollectedProducts = true }
      )

      if (recipe.distillation) {
        await this.distillProducts(recipe)
      }

      if (recipe.aging) {
        await this.beginAging(recipe)
      } else {
        this.botState.patchContext({
          phase: 'storing',
          recipe: recipe.id,
          finishAt
        })
        await this.storeAllPotions()
        await this.reportSafe(
          this.errors > 0
            ? `酿酒 ${recipe.id} 已完成，但发生 ${this.errors} 个错误`
            : `酿酒 ${recipe.id} 已完成`
        )
      }
    } catch (err) {
      const cancelled = err instanceof BrewCancelledError
      const message = cancelled
        ? '酿酒任务已取消'
        : `酿酒任务停止: ${(err as Error).message}`
      console.error(`[Brew] ${message}`)
      await this.reportSafe(message)
      if (!cancelled && hasCollectedProducts) {
        await this.reportSafe('检测到异常中止，尝试将背包中的半成品存入产物箱')
        try {
          await this.storeAllPotions()
        } catch (storeError) {
          const storeMessage = `异常回收失败: ${(storeError as Error).message}`
          console.error(`[Brew] ${storeMessage}`)
          await this.reportSafe(storeMessage)
        }
      }
    } finally {
      this.report = null
      this.currentOwner = null
      this.cancelRequested = false
      if (this.botState.isBrewing()) await this.botState.enterIdle()
      this.taskRunning = false
    }
  }

  private resolveFermenters (): BlockNode[] {
    const bot = this.requireBot()
    const dimension = bot.game?.dimension || 'overworld'
    const fermenters = this.blockRegistry.list(this.config.group)
      .filter(node => node.blockType === 'Fermenter' && node.dimension === dimension)

    if (fermenters.length < this.config.fermenterCount) {
      throw new Error(
        `区域 ${this.config.group} 的发酵方块不足 ` +
        `(${fermenters.length}/${this.config.fermenterCount})`
      )
    }
    return fermenters.slice(0, this.config.fermenterCount)
  }

  private resolveDistilleries (): BlockNode[] {
    const bot = this.requireBot()
    const dimension = bot.game?.dimension || 'overworld'
    const distilleries = this.blockRegistry.list(this.config.group)
      .filter(node => node.blockType === 'Distillery' && node.dimension === dimension)

    if (distilleries.length < this.config.fermenterCount) {
      throw new Error(
        `区域 ${this.config.group} 的蒸馏方块不足 ` +
        `(${distilleries.length}/${this.config.fermenterCount})`
      )
    }
    return distilleries.slice(0, this.config.fermenterCount)
  }

  private async ensureFermentersFull (fermenters: BlockNode[]): Promise<void> {
    const empty: BlockNode[] = []
    for (const fermenter of fermenters) {
      this.assertNotCancelled()
      const full = await this.attempt(
        `检查炼药锅 ${fermenter.alias}`,
        async () => this.isFermenterFull(fermenter)
      )
      if (full !== true) empty.push(fermenter)
    }

    switch (this.config.waterMode) {
      case 'source':
        await this.fillFromWaterSource(empty)
        break
      case 'preloaded':
        break
      case 'bucket-stock':
        await this.fillFromBucketStock(empty)
        break
      default:
        throw new Error(`未知加水模式: ${String(this.config.waterMode)}`)
    }

    await this.verifyAllFermentersFull(fermenters)
  }

  private async fillFromWaterSource (empty: BlockNode[]): Promise<void> {
    if (empty.length === 0) return
    const setup = await this.attempt('准备加水工具', async () => {
      const toolbox = this.requireNode(this.config.toolbox, 'Container', true)
      const water = this.requireNode(this.config.waterSource, 'Water')
      await this.ensureOneBucket(toolbox)
      return { water }
    })
    if (!setup) return

    for (const fermenter of empty) {
      this.assertNotCancelled()
      await this.attempt(`为 ${fermenter.alias} 加水`, async () => {
        await this.ensureWaterBucket(setup.water)
        await this.interactWithItem(fermenter, 'minecraft:water_bucket')
        // 水桶已由服务端转换为空桶即可确认交互成功。
        // 方块状态包可能比背包包更晚到达，不能立即用缓存判定未满。
      })
    }
    await this.returnBuckets()
  }

  private async fillFromBucketStock (empty: BlockNode[]): Promise<void> {
    if (empty.length === 0) return

    const waterBuckets = this.requireDedicatedContainer(
      this.config.waterBucketContainer,
      'water_bucket'
    )
    const emptyBuckets = this.requireDedicatedContainer(
      this.config.emptyBucketContainer,
      'bucket'
    )
    // bucket-stock 按整批炼药锅数量领取；未使用的水桶稍后归还。
    const batchBucketCount = this.config.fermenterCount
    await this.assertContainerAmount(waterBuckets, waterBuckets.itemId!, batchBucketCount)

    await this.attempt('领取预装水桶', async () => {
      const result = await this.inventoryActions.takeExactFromContainer(
        waterBuckets.x,
        waterBuckets.y,
        waterBuckets.z,
        waterBuckets.itemId!,
        batchBucketCount,
        this.configDistance('interaction'),
        this.configDistance('approach')
      )
      if (!result.success) throw new Error(result.message || '领取预装水桶失败')
    })

    for (const fermenter of empty) {
      this.assertNotCancelled()
      await this.attempt(`为 ${fermenter.alias} 加水`, async () => {
        await this.interactWithItem(fermenter, 'minecraft:water_bucket')
      })
    }

    await this.attempt('存放空桶', async () => {
      const result = await this.inventoryActions.storeFilteredInContainer(
        emptyBuckets.x,
        emptyBuckets.y,
        emptyBuckets.z,
        item => normalizeItemKey(item.name) === 'bucket',
        this.configDistance('interaction'),
        this.configDistance('approach')
      )
      if (!result.success) throw new Error(result.message || '存放空桶失败')
    })

    // 若某锅倒水失败，将尚未使用的水桶归还原容器。
    await this.attempt('归还未使用水桶', async () => {
      const result = await this.inventoryActions.storeFilteredInContainer(
        waterBuckets.x,
        waterBuckets.y,
        waterBuckets.z,
        item => normalizeItemKey(item.name) === 'water_bucket',
        this.configDistance('interaction'),
        this.configDistance('approach')
      )
      if (!result.success) throw new Error(result.message || '归还水桶失败')
    })
  }

  private async verifyAllFermentersFull (fermenters: BlockNode[]): Promise<void> {
    const unfilled: string[] = []
    for (const fermenter of fermenters) {
      this.assertNotCancelled()
      const full = await this.attempt(
        `复查炼药锅 ${fermenter.alias}`,
        async () => this.waitForFermenterFull(fermenter)
      )
      if (full !== true) unfilled.push(fermenter.alias)
    }
    if (unfilled.length > 0) {
      throw new Error(`以下炼药锅未满水: ${unfilled.join(', ')}`)
    }
  }

  private async checkSupplies (
    recipe: BrewRecipe
  ): Promise<Array<{ node: BlockNode, itemId: string, perFermenter: number }>> {
    const plans: Array<{ node: BlockNode, itemId: string, perFermenter: number }> = []

    for (const ingredient of recipe.fermentation.ingredients) {
      const node = this.requireNode(ingredient.container, 'Container', false)
      if (!node.isDedicated || !node.itemId) {
        throw new Error(`原料容器 ${node.alias} 必须是专用容器`)
      }
      const required = ingredient.count * this.config.fermenterCount
      await this.assertContainerAmount(node, node.itemId, required)
      plans.push({
        node,
        itemId: node.itemId,
        perFermenter: ingredient.count
      })
    }

    const bottles = this.requireBottleContainer()
    const bottleId = bottles.itemId!
    await this.assertContainerAmount(
      bottles,
      bottleId,
      this.config.fermenterCount * 3
    )
    return plans
  }

  private async takeSupplies (
    ingredients: Array<{ node: BlockNode, itemId: string, perFermenter: number }>,
    fermenterCount: number
  ): Promise<void> {
    for (const ingredient of ingredients) {
      this.assertNotCancelled()
      await this.attempt(`拿取 ${ingredient.itemId}`, async () => {
        const result = await this.inventoryActions.takeExactFromContainer(
          ingredient.node.x,
          ingredient.node.y,
          ingredient.node.z,
          ingredient.itemId,
          ingredient.perFermenter * fermenterCount,
          this.configDistance('interaction'),
          this.configDistance('approach')
        )
        if (!result.success) throw new Error(result.message || '拿取失败')
      })
    }

    const bottles = this.requireBottleContainer()
    const bottleId = bottles.itemId!
    await this.attempt('拿取玻璃瓶', async () => {
      const result = await this.inventoryActions.takeExactFromContainer(
        bottles.x,
        bottles.y,
        bottles.z,
        bottleId,
        fermenterCount * 3,
        this.configDistance('interaction'),
        this.configDistance('approach')
      )
      if (!result.success) throw new Error(result.message || '拿取玻璃瓶失败')
    })
  }

  private async addIngredients (
    fermenters: BlockNode[],
    ingredients: Array<{ node: BlockNode, itemId: string, perFermenter: number }>,
    onAllFermentersReady: (lastStartedAt: number) => void
  ): Promise<Map<string, number>> {
    const startedAtByFermenter = new Map<string, number>()
    let lastStartedAt = 0

    // 逐锅投完所有原料后再开始该锅计时，避免早投料的锅过早装瓶。
    for (const fermenter of fermenters) {
      let anySucceeded = false
      for (const ingredient of ingredients) {
        for (let i = 0; i < ingredient.perFermenter; i++) {
          this.assertNotCancelled()
          let succeeded = false
          await this.attempt(
            `${fermenter.alias} 投入 ${ingredient.itemId} (${i + 1}/${ingredient.perFermenter})`,
            async () => {
              await this.interactWithItem(fermenter, ingredient.itemId)
              succeeded = true
            }
          )
          if (succeeded) anySucceeded = true
        }
      }

      const startedAt = Date.now()
      if (!anySucceeded) {
        console.warn(`[Brew] ${fermenter.alias} 未确认成功投料，仍按投料结束时刻计时`)
      }
      startedAtByFermenter.set(fermenter.alias, startedAt)
      lastStartedAt = startedAt
    }

    // 全部锅投完后以最后一锅的计时起点刷新状态，倒计时固定为最后一锅。
    onAllFermentersReady(lastStartedAt || Date.now())
    return startedAtByFermenter
  }

  private async bottleProductsWhenReady (
    fermenters: BlockNode[],
    startedAtByFermenter: Map<string, number>,
    durationSeconds: number,
    recipeId: string,
    onProductCollected: () => void
  ): Promise<void> {
    const schedule = fermenters
      .map(fermenter => ({
        fermenter,
        finishAt: (startedAtByFermenter.get(fermenter.alias) ?? Date.now()) +
          durationSeconds * 1000
      }))
      .sort((a, b) => a.finishAt - b.finishAt)

    // 装瓶阶段的倒计时同样固定为最后一锅（最晚完成）的时间。
    const lastFinishAt = schedule.reduce((max, entry) => Math.max(max, entry.finishAt), 0)

    for (const entry of schedule) {
      this.botState.patchContext({
        phase: 'waiting',
        recipe: recipeId,
        finishAt: lastFinishAt
      })
      await this.waitUntil(entry.finishAt)
      this.botState.patchContext({
        phase: 'bottling',
        recipe: recipeId,
        finishAt: lastFinishAt
      })

      for (let i = 0; i < 3; i++) {
        this.assertNotCancelled()
        let succeeded = false
        await this.attempt(
          `${entry.fermenter.alias} 装瓶 (${i + 1}/3)`,
          async () => {
            await this.interactWithItem(entry.fermenter, 'minecraft:glass_bottle')
            succeeded = true
          }
        )
        if (succeeded) onProductCollected()
      }
    }
  }

  private async distillProducts (recipe: BrewRecipe): Promise<void> {
    const runs = recipe.distillation?.runs
    if (!runs) return

    const distilleries = this.resolveDistilleries()
    const required = distilleries.length * 3
    const available = this.inventoryPotionCount()
    if (available < required) {
      throw new Error(`发酵产物不足，无法蒸馏 (${available}/${required})`)
    }

    this.botState.patchContext({
      phase: 'distillery-loading',
      recipe: recipe.id,
      finishAt: 0,
      distillationRuns: runs,
      distillationStartedAt: 0
    })
    await this.reportSafe(`开始装载 ${distilleries.length} 个蒸馏方块`)

    let firstStandLoadedAt = 0
    for (const distillery of distilleries) {
      this.assertNotCancelled()
      const result = await this.inventoryActions.loadBrewingStand(
        distillery.x,
        distillery.y,
        distillery.z,
        item => normalizeItemKey(item.name).includes('potion'),
        this.configDistance('interaction'),
        this.configDistance('approach')
      )
      if (!result.success || result.count !== 3 || !result.loadedAt) {
        throw new Error(
          `装载蒸馏方块 ${distillery.alias} 失败: ${result.message || '未装满三个药水槽'}`
        )
      }
      if (firstStandLoadedAt === 0) firstStandLoadedAt = result.loadedAt
    }

    // 从第一台的第三瓶放入成功开始计时；完成后按相同顺序从第一台取出。
    // 装载和取出采用同一顺序，可让各台的实际蒸馏时长尽量一致。
    const finishAt = firstStandLoadedAt + runs * 45 * 1000
    this.botState.patchContext({
      phase: 'distilling',
      recipe: recipe.id,
      finishAt,
      distillationRuns: runs,
      distillationStartedAt: firstStandLoadedAt
    })
    await this.reportSafe(`蒸馏已开始，共 ${runs} 次，预计等待 ${runs * 45} 秒`)
    await this.waitUntil(finishAt)

    this.botState.patchContext({
      phase: 'distillery-unloading',
      recipe: recipe.id,
      finishAt,
      distillationRuns: runs,
      distillationStartedAt: firstStandLoadedAt
    })
    for (const distillery of distilleries) {
      this.assertNotCancelled()
      await this.attempt(`取出 ${distillery.alias} 蒸馏产物`, async () => {
        const result = await this.inventoryActions.unloadBrewingStand(
          distillery.x,
          distillery.y,
          distillery.z,
          this.configDistance('interaction'),
          this.configDistance('approach')
        )
        if (!result.success || result.count !== 3) {
          throw new Error(result.message || '未能取出三个药水槽')
        }
      })
    }
  }

  private async beginAging (recipe: BrewRecipe): Promise<void> {
    const aging = recipe.aging
    if (!aging) return

    this.botState.patchContext({
      phase: 'storing',
      recipe: recipe.id,
      finishAt: 0
    })

    const barrel = this.resolveFreeAgingBarrel(aging.wood)
    if (!barrel) {
      await this.reportSafe(
        `没有可用的 ${aging.wood === 'any' ? '任意' : aging.wood} 酒桶，酒品将存入成品箱`
      )
      await this.storeAllPotions()
      await this.reportSafe(
        this.errors > 0
          ? `酿酒 ${recipe.id} 已结束（陈化跳过），但发生 ${this.errors} 个错误`
          : `酿酒 ${recipe.id} 已结束（陈化跳过，已入库）`
      )
      return
    }

    const deposit = await this.inventoryActions.depositPotionsToAgingBarrel(
      barrel.x,
      barrel.y,
      barrel.z,
      this.configDistance('interaction'),
      this.configDistance('approach')
    )
    if (!deposit.success) {
      throw new Error(`放入酒桶 ${barrel.alias} 失败: ${deposit.message || '未知错误'}`)
    }

    const finishAt = Date.now() + aging.days * AGING_MS_PER_DAY
    const task: AgingTask = {
      id: `${recipe.id}:${barrel.alias}:${finishAt}`,
      recipeId: recipe.id,
      owner: this.currentOwner || 'unknown',
      barrel,
      finishAt,
      reminded10: false,
      reminded5: false,
      pendingAwayNotified: false,
      phase: 'aging',
      collecting: false
    }
    this.agingTasks.set(task.id, task)
    this.ensureAgingTimer()

    const when = new Date(finishAt).toLocaleTimeString()
    await this.reportSafe(
      `已将 ${deposit.count ?? 0} 瓶放入酒桶 ${barrel.alias}，陈化 ${aging.days} 游戏日，预计 ${when} 完成`
    )
  }

  private resolveFreeAgingBarrel (wood: AgingWoodType): BlockNode | null {
    const bot = this.requireBot()
    const dimension = bot.game?.dimension || 'overworld'
    const occupied = new Set([...this.agingTasks.values()].map(task => task.barrel.alias))

    for (const node of this.blockRegistry.list(this.config.group)) {
      if (node.blockType !== 'Aging') continue
      if (node.dimension !== dimension) continue
      if (occupied.has(node.alias)) continue

      const block = bot.blockAt(new Vec3(node.x, node.y, node.z))
      if (!block) continue
      const blockWood = getAgingWoodType(block.name)
      if (!blockWood) continue
      if (wood !== 'any' && blockWood !== wood) continue
      return node
    }
    return null
  }

  private ensureAgingTimer (): void {
    if (this.agingTimer) return
    this.agingTimer = setInterval(() => {
      void this.tickAgingTasks()
    }, AGING_TICK_MS)
  }

  private async tickAgingTasks (): Promise<void> {
    if (this.agingTasks.size === 0) {
      if (this.agingTimer) {
        clearInterval(this.agingTimer)
        this.agingTimer = null
      }
      return
    }

    const now = Date.now()
    for (const task of [...this.agingTasks.values()]) {
      if (task.collecting) continue

      if (task.phase === 'aging') {
        const remaining = task.finishAt - now
        if (!task.reminded10 && remaining <= AGING_REMIND_10_MS) {
          task.reminded10 = true
          const near = this.isNearAgingBarrel(task.barrel)
          await this.notifyAgingOwner(
            task,
            near
              ? `陈化 ${task.recipeId} @ ${task.barrel.alias} 约 10 分钟后完成（当前在酒庄附近）`
              : `陈化 ${task.recipeId} @ ${task.barrel.alias} 约 10 分钟后完成（当前不在酒庄附近）`
          )
          if (near) task.reminded5 = true
        }
        if (!task.reminded5 && remaining <= AGING_REMIND_5_MS) {
          task.reminded5 = true
          if (!this.isNearAgingBarrel(task.barrel)) {
            await this.notifyAgingOwner(
              task,
              `陈化 ${task.recipeId} @ ${task.barrel.alias} 约 5 分钟后完成，请确保 bot 回到酒庄`
            )
          }
        }
        if (remaining > 0) continue
        task.phase = 'pending-collect'
      }

      if (task.phase === 'pending-collect') {
        await this.tryCollectAging(task)
      }
    }
  }

  private isNearAgingBarrel (barrel: BlockNode): boolean {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) return false
    const block = bot.blockAt(new Vec3(barrel.x, barrel.y, barrel.z))
    if (!block) return false
    const distance = bot.entity.position.distanceTo(
      new Vec3(barrel.x + 0.5, barrel.y + 0.5, barrel.z + 0.5)
    )
    return distance <= this.approachDistance
  }

  private canCollectAging (): boolean {
    return this.mcBot.isReady &&
      !!this.mcBot.bot &&
      this.botState.isIdle() &&
      !this.taskRunning
  }

  private async tryCollectAging (task: AgingTask): Promise<void> {
    if (!this.canCollectAging()) return
    if (!this.isNearAgingBarrel(task.barrel)) {
      if (!task.pendingAwayNotified) {
        task.pendingAwayNotified = true
        await this.notifyAgingOwner(
          task,
          `陈化 ${task.recipeId} @ ${task.barrel.alias} 已完成，但 bot 不在酒庄附近，稍后重试收取`
        )
      }
      return
    }

    task.collecting = true
    try {
      const withdraw = await this.inventoryActions.withdrawPotionsFromAgingBarrel(
        task.barrel.x,
        task.barrel.y,
        task.barrel.z,
        this.configDistance('interaction'),
        this.configDistance('approach')
      )
      if (!withdraw.success) {
        await this.notifyAgingOwner(
          task,
          `收取陈化 ${task.recipeId} @ ${task.barrel.alias} 失败: ${withdraw.message || '未知错误'}，稍后重试`
        )
        return
      }

      // 桶内没有成品（可能已被人工提前收取），视为已收取，结束任务不再重试。
      if ((withdraw.count ?? 0) === 0) {
        this.agingTasks.delete(task.id)
        await this.notifyAgingOwner(
          task,
          `陈化 ${task.recipeId} @ ${task.barrel.alias} 桶内没有成品（可能已被人工提前收取），任务已结束`
        )
        return
      }

      try {
        await this.storeAllPotions()
      } catch (err) {
        await this.notifyAgingOwner(
          task,
          `陈化产物已取出但入库失败: ${(err as Error).message}`
        )
        return
      }

      this.agingTasks.delete(task.id)
      await this.notifyAgingOwner(
        task,
        `陈化 ${task.recipeId} @ ${task.barrel.alias} 已完成并入库`
      )
    } finally {
      task.collecting = false
    }
  }

  private async notifyAgingOwner (task: AgingTask, message: string): Promise<void> {
    console.log(`[Brew][Aging] ${message}`)
    // 陈化提醒始终私聊发起者，不受静默模式影响。
    try {
      this.mcBot.whisper(task.owner, message)
    } catch (err) {
      console.warn('[Brew] 陈化提醒私聊失败:', (err as Error).message)
    }
  }

  private async storeAllPotions (): Promise<void> {
    const aliases = this.config.productContainers
    if (aliases.length === 0) throw new Error('未配置产物箱')

    const initial = this.inventoryPotionCount()
    if (initial === 0) throw new Error('背包中未发现药水产物')

    for (const alias of aliases) {
      if (this.inventoryPotionCount() === 0) break
      await this.attempt(`存放产物到 ${alias}`, async () => {
        const products = this.requireNode(alias, 'Container', true)
        const result = await this.inventoryActions.storeFilteredInContainer(
          products.x,
          products.y,
          products.z,
          item => normalizeItemKey(item.name).includes('potion'),
          this.configDistance('interaction'),
          this.configDistance('approach')
        )
        if (!result.success) throw new Error(result.message || '存放产物失败')
      })
    }

    const remaining = this.inventoryPotionCount()
    if (remaining > 0) {
      throw new Error(`所有产物箱均无法继续存放，背包剩余 ${remaining} 瓶`)
    }
  }

  private async assertContainerAmount (
    node: BlockNode,
    itemId: string,
    required: number
  ): Promise<void> {
    const result = await this.inventoryActions.countInContainer(
      node.x,
      node.y,
      node.z,
      itemId,
      this.configDistance('interaction'),
      this.configDistance('approach')
    )
    if (!result.success) {
      throw new Error(`检查 ${node.alias} 失败: ${result.message || '未知错误'}`)
    }
    if ((result.count ?? 0) < required) {
      throw new Error(`${node.alias} 原料不足 (${result.count ?? 0}/${required})`)
    }
  }

  private async ensureOneBucket (toolbox: BlockNode): Promise<void> {
    if (this.inventoryCount('water_bucket') + this.inventoryCount('bucket') > 0) return

    const waterBuckets = await this.inventoryActions.countInContainer(
      toolbox.x, toolbox.y, toolbox.z, 'water_bucket',
      this.configDistance('interaction'), this.configDistance('approach')
    )
    const query = waterBuckets.success && (waterBuckets.count ?? 0) > 0
      ? 'water_bucket'
      : 'bucket'
    const result = await this.inventoryActions.takeExactFromContainer(
      toolbox.x, toolbox.y, toolbox.z, query, 1,
      this.configDistance('interaction'), this.configDistance('approach')
    )
    if (!result.success) {
      throw new Error(`工具箱中没有可用水桶或空桶: ${result.message || ''}`)
    }
  }

  private async ensureWaterBucket (water: BlockNode): Promise<void> {
    if (this.inventoryCount('water_bucket') > 0) return
    if (this.inventoryCount('bucket') === 0) {
      throw new Error('背包中没有空桶')
    }
    await this.collectWater(water)
    await sleep(this.config.waterRefillDelayMs)
  }

  private async collectWater (water: BlockNode): Promise<void> {
    const bot = this.requireBot()
    const approach = await this.inventoryActions.approachBlock(
      water.x,
      water.y,
      water.z,
      this.configDistance('interaction'),
      this.configDistance('approach')
    )
    if (!approach.success) throw new Error(approach.message || '无法接近水源')

    const block = bot.blockAt(new Vec3(water.x, water.y, water.z))
    if (!block || block.name !== 'water') throw new Error('水源方块不可见')
    const bucket = findExactMatchingItems(bot.inventory.items(), 'minecraft:bucket')[0]
    if (!bucket) throw new Error('背包中没有空桶')

    const beforeWaterBuckets = this.inventoryCount('water_bucket')
    await bot.equip(bucket, 'hand')
    // 水是无碰撞流体；activateBlock 的“点击方块面”不会可靠地取水。
    // 看向水源后发送 use_item，让服务端执行水桶的流体射线检测。
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
    bot.activateItem()
    const filled = await this.waitForCondition(
      () => this.inventoryCount('water_bucket') > beforeWaterBuckets,
      Math.max(4000, this.config.interactionDelayMs * 4)
    )
    bot.deactivateItem()
    if (!filled) throw new Error('从水源取水后未获得水桶')
    await sleep(this.config.interactionDelayMs)
  }

  private async returnBuckets (): Promise<void> {
    await this.attempt('归还水桶', async () => {
      const toolbox = this.requireNode(this.config.toolbox, 'Container', true)
      const result = await this.inventoryActions.storeFilteredInContainer(
        toolbox.x,
        toolbox.y,
        toolbox.z,
        item => {
          const name = normalizeItemKey(item.name)
          return name === 'bucket' || name === 'water_bucket'
        },
        this.configDistance('interaction'),
        this.configDistance('approach')
      )
      if (!result.success) throw new Error(result.message || '归还水桶失败')
    })
  }

  private async interactWithItem (node: BlockNode, itemId: string): Promise<void> {
    const bot = this.requireBot()
    const approach = await this.inventoryActions.approachBlock(
      node.x,
      node.y,
      node.z,
      this.configDistance('interaction'),
      this.configDistance('approach')
    )
    if (!approach.success) throw new Error(approach.message || '无法接近方块')

    const block = bot.blockAt(new Vec3(node.x, node.y, node.z))
    if (!block) throw new Error('方块不可见')
    const item = findExactMatchingItems(bot.inventory.items(), itemId)[0]
    if (!item) throw new Error(`背包中没有 ${itemId}`)
    const beforeCount = this.inventoryCount(itemId)

    // 每次交互都重新装备，奶桶等使用后会变为空桶。
    await bot.equip(item, 'hand')
    await bot.activateBlock(block)
    const consumed = await this.waitForCondition(
      () => this.inventoryCount(itemId) < beforeCount,
      Math.max(4000, this.config.interactionDelayMs * 4)
    )
    if (!consumed) {
      throw new Error(`交互后 ${itemId} 数量未变化`)
    }
    await sleep(this.config.interactionDelayMs)
  }

  private async isFermenterFull (node: BlockNode): Promise<boolean> {
    const approach = await this.inventoryActions.approachBlock(
      node.x,
      node.y,
      node.z,
      this.configDistance('interaction'),
      this.configDistance('approach')
    )
    if (!approach.success) throw new Error(approach.message || '无法接近炼药锅')
    return this.readFermenterFull(node)
  }

  private readFermenterFull (node: BlockNode): boolean {
    const bot = this.requireBot()
    const block = bot.blockAt(new Vec3(node.x, node.y, node.z))
    if (!block) throw new Error('炼药锅方块不可见')
    const props = block.getProperties?.() as { level?: number | string } | undefined
    const level = Number(props?.level ?? block.metadata)
    return (
      (block.name === 'water_cauldron' && level >= 3) ||
      (block.name === 'cauldron' && block.metadata >= 3)
    )
  }

  private async waitForFermenterFull (node: BlockNode): Promise<boolean> {
    const approach = await this.inventoryActions.approachBlock(
      node.x,
      node.y,
      node.z,
      this.configDistance('interaction'),
      this.configDistance('approach')
    )
    if (!approach.success) throw new Error(approach.message || '无法接近炼药锅')
    if (this.readFermenterFull(node)) return true
    return this.waitForCondition(
      () => this.readFermenterFull(node),
      Math.max(3000, this.config.interactionDelayMs * 4)
    )
  }

  private requireNode (
    alias: string,
    blockType: BlockNode['blockType'],
    requireMixed = false
  ): BlockNode {
    const node = this.blockRegistry.get(alias)
    if (!node) throw new Error(`节点不存在: ${alias}`)
    if (node.nodeGroup !== this.config.group) {
      throw new Error(`节点 ${alias} 不属于区域 ${this.config.group}`)
    }
    if (node.blockType !== blockType) {
      throw new Error(`节点 ${alias} 类型应为 ${blockType}，实际为 ${node.blockType}`)
    }
    if (requireMixed && node.isDedicated !== false) {
      throw new Error(`节点 ${alias} 必须是混合容器`)
    }
    return node
  }

  private requireBottleContainer (): BlockNode {
    const node = this.requireNode(this.config.bottleContainer, 'Container')
    if (!node.isDedicated || !node.itemId) {
      throw new Error(`玻璃瓶容器 ${node.alias} 必须是专用容器`)
    }
    if (normalizeItemKey(node.itemId) !== 'glass_bottle') {
      throw new Error(`玻璃瓶容器 ${node.alias} 绑定的物品不是 glass_bottle`)
    }
    return node
  }

  private requireDedicatedContainer (alias: string, expectedItem: string): BlockNode {
    const node = this.requireNode(alias, 'Container')
    if (!node.isDedicated || !node.itemId) {
      throw new Error(`节点 ${alias} 必须是专用容器`)
    }
    if (normalizeItemKey(node.itemId) !== normalizeItemKey(expectedItem)) {
      throw new Error(`节点 ${alias} 应绑定 ${expectedItem}，实际为 ${node.itemId}`)
    }
    return node
  }

  private requireBot () {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) throw new Error('机器人未就绪')
    return bot
  }

  private inventoryCount (itemId: string): number {
    const bot = this.requireBot()
    return findExactMatchingItems(bot.inventory.items(), itemId)
      .reduce((sum, item) => sum + item.count, 0)
  }

  private inventoryPotionCount (): number {
    const bot = this.requireBot()
    return bot.inventory.items()
      .filter(item => normalizeItemKey(item.name).includes('potion'))
      .reduce((sum, item) => sum + item.count, 0)
  }

  private async attempt<T> (label: string, action: () => Promise<T>): Promise<T | null> {
    try {
      return await action()
    } catch (err) {
      if (err instanceof BrewCancelledError || this.cancelRequested) {
        throw new BrewCancelledError()
      }
      this.errors++
      const message = `${label}失败: ${(err as Error).message}`
      console.error(`[Brew] ${message}`)
      await this.reportSafe(message)
      return null
    }
  }

  private async waitUntil (finishAt: number): Promise<void> {
    while (Date.now() < finishAt) {
      this.assertNotCancelled()
      await sleep(Math.min(1000, finishAt - Date.now()))
    }
  }

  private async waitForCondition (
    condition: () => boolean,
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      this.assertNotCancelled()
      if (condition()) return true
      await sleep(50)
    }
    return condition()
  }

  private assertNotCancelled (): void {
    if (this.cancelRequested) throw new BrewCancelledError()
  }

  private async reportSafe (message: string): Promise<void> {
    try {
      await this.report?.(message)
    } catch (err) {
      console.warn('[Brew] 汇报失败:', (err as Error).message)
    }
  }

  private configDistance (kind: 'interaction' | 'approach'): number {
    return kind === 'interaction' ? this.interactionDistance : this.approachDistance
  }
}

class BrewCancelledError extends Error {
  constructor () {
    super('cancelled')
  }
}
