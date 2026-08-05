import { Vec3 } from 'vec3'
import type { Item } from 'prismarine-item'
import type { Block } from 'prismarine-block'
import type { Bot } from 'mineflayer'
import type { Window } from 'prismarine-windows'
import type { ServiceResult } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import { ensurePathfinder } from '../shared/entity-utils'
import { goals } from 'mineflayer-pathfinder'
import { sleep } from '../../platform/sleep'

export function normalizeItemKey (name: string): string {
  return name.toLowerCase().replace(/^minecraft:/, '').trim()
}

export function findMatchingItems (items: Item[], query: string): Item[] {
  const key = normalizeItemKey(query)
  const exact = findExactMatchingItems(items, query)
  if (exact.length > 0) return exact
  return items.filter(i => normalizeItemKey(i.name).includes(key))
}

export function findExactMatchingItems (items: Item[], query: string): Item[] {
  const key = normalizeItemKey(query)
  return items.filter(item => normalizeItemKey(item.name) === key)
}

export function formatItemList (items: Item[]): string[] {
  const merged = new Map<string, number>()
  for (const item of items) {
    const name = normalizeItemKey(item.name)
    merged.set(name, (merged.get(name) ?? 0) + item.count)
  }
  return [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name} x${count}`)
}

export default class InventoryActions {
  private mcBot: MinecraftBot

  constructor (mcBot: MinecraftBot) {
    this.mcBot = mcBot
  }

  listInventory (): ServiceResult & { lines?: string[] } {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const items = bot.inventory.items()
    if (items.length === 0) {
      return { success: true, message: '背包为空', lines: [] }
    }

    return { success: true, message: 'ok', lines: formatItemList(items) }
  }

  async dropItem (itemQuery: string, count?: number): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const matches = findMatchingItems(bot.inventory.items(), itemQuery)
    if (matches.length === 0) {
      return { success: false, message: `背包中没有 ${itemQuery}` }
    }

    const item = matches[0]
    const dropCount = count != null && count > 0
      ? Math.min(count, item.count)
      : item.count

    try {
      await bot.toss(item.type, item.metadata ?? null, dropCount)
      console.log(`[Inventory] 丢弃 ${item.name} x${dropCount}`)
      return { success: true, message: `已丢弃 ${normalizeItemKey(item.name)} x${dropCount}` }
    } catch (err) {
      return { success: false, message: (err as Error).message }
    }
  }

  async approachBlock (
    x: number,
    y: number,
    z: number,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!bot) return { success: false, message: '机器人未就绪' }

    const target = new Vec3(x + 0.5, y + 0.5, z + 0.5)
    let distance = bot.entity.position.distanceTo(target)
    if (distance > approachDistance) {
      return {
        success: false,
        message: `容器超过 ${approachDistance} 格 (当前 ${distance.toFixed(1)} 格)`
      }
    }

    if (distance <= interactionDistance) {
      return { success: true }
    }

    const pfBot = ensurePathfinder(bot)
    const goal = new goals.GoalNear(
      target.x,
      target.y,
      target.z,
      Math.max(1, interactionDistance - 0.5)
    )

    try {
      await pfBot.pathfinder.goto(goal)
      await sleep(150)
      distance = bot.entity.position.distanceTo(target)
      if (distance > interactionDistance + 0.5) {
        return { success: false, message: `无法接近容器 (当前 ${distance.toFixed(1)} 格)` }
      }
      return { success: true }
    } catch (err) {
      pfBot.pathfinder.stop()
      return { success: false, message: `无法接近容器: ${(err as Error).message}` }
    }
  }

  async countInContainer (
    x: number,
    y: number,
    z: number,
    itemQuery: string,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult & { count?: number }> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block) return { success: false, message: '容器方块不可见' }

    try {
      const container = await this.openContainer(block)
      try {
        const count = findExactMatchingItems(container.containerItems(), itemQuery)
          .reduce((sum, item) => sum + item.count, 0)
        return { success: true, count }
      } finally {
        container.close()
        await sleep(150)
      }
    } catch (err) {
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch { /* */ }
      return { success: false, message: (err as Error).message }
    }
  }

  async takeExactFromContainer (
    x: number,
    y: number,
    z: number,
    itemQuery: string,
    count: number,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }
    if (!Number.isInteger(count) || count <= 0) {
      return { success: false, message: `无效数量: ${count}` }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block) return { success: false, message: '容器方块不可见' }

    try {
      const container = await this.openContainer(block)
      try {
        const containerItems = container.containerItems()
        const matches = findExactMatchingItems(containerItems, itemQuery)
        const total = matches.reduce((sum, item) => sum + item.count, 0)
        if (total < count || matches.length === 0) {
          return { success: false, message: `容器中 ${itemQuery} 不足 (${total}/${count})` }
        }
        const item = matches[0]
        await container.withdraw(item.type, item.metadata ?? null, count)
        return { success: true, message: `已取出 ${normalizeItemKey(item.name)} x${count}` }
      } finally {
        container.close()
        await sleep(150)
      }
    } catch (err) {
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch { /* */ }
      return { success: false, message: (err as Error).message }
    }
  }

  async storeFilteredInContainer (
    x: number,
    y: number,
    z: number,
    filter: (item: Item) => boolean,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult & { count?: number }> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block) return { success: false, message: '容器方块不可见' }

    const selected = bot.inventory.items().filter(filter)
    if (selected.length === 0) return { success: true, count: 0 }

    try {
      const container = await this.openContainer(block)
      try {
        let moved = 0
        for (const selectedItem of selected) {
          const current = bot.inventory.items().find(item =>
            item.type === selectedItem.type &&
            (item.metadata ?? null) === (selectedItem.metadata ?? null)
          )
          if (!current) continue
          await container.deposit(current.type, current.metadata ?? null, current.count)
          moved += current.count
        }
        return { success: true, count: moved, message: `已存入 ${moved} 个物品` }
      } finally {
        container.close()
        await sleep(150)
      }
    } catch (err) {
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch { /* */ }
      return { success: false, message: (err as Error).message }
    }
  }

  async storeInContainer (
    x: number,
    y: number,
    z: number,
    itemQuery: string,
    count: number | undefined,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach

    const matches = findMatchingItems(bot.inventory.items(), itemQuery)
    if (matches.length === 0) {
      return { success: false, message: `背包中没有 ${itemQuery}` }
    }

    const item = matches[0]
    const moveCount = count != null && count > 0
      ? Math.min(count, item.count)
      : item.count

    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block) {
      return { success: false, message: '容器方块不可见' }
    }

    try {
      const chest = await this.openContainer(block)
      await chest.deposit(item.type, item.metadata ?? null, moveCount)
      chest.close()
      console.log(`[Container] 存入 ${item.name} x${moveCount} @ ${x},${y},${z}`)
      return { success: true, message: `已存入 ${normalizeItemKey(item.name)} x${moveCount}` }
    } catch (err) {
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch { /* */ }
      return { success: false, message: (err as Error).message }
    }
  }

  async takeFromContainer (
    x: number,
    y: number,
    z: number,
    itemQuery: string,
    count: number | undefined,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach

    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block) {
      return { success: false, message: '容器方块不可见' }
    }

    try {
      const chest = await this.openContainer(block)
      const containerItems = chest.containerItems()
      const matches = findMatchingItems(containerItems, itemQuery)
      if (matches.length === 0) {
        chest.close()
        return { success: false, message: `容器中没有 ${itemQuery}` }
      }

      const item = matches[0]
      const totalInContainer = containerItems
        .filter(i => i.type === item.type && (i.metadata ?? null) === (item.metadata ?? null))
        .reduce((sum, i) => sum + i.count, 0)
      const moveCount = count != null && count > 0
        ? Math.min(count, totalInContainer)
        : totalInContainer

      await chest.withdraw(item.type, item.metadata ?? null, moveCount)
      chest.close()
      console.log(`[Container] 取出 ${item.name} x${moveCount} @ ${x},${y},${z}`)
      return { success: true, message: `已取出 ${normalizeItemKey(item.name)} x${moveCount}` }
    } catch (err) {
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch { /* */ }
      return { success: false, message: (err as Error).message }
    }
  }

  async loadBrewingStand (
    x: number,
    y: number,
    z: number,
    filter: (item: Item) => boolean,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult & { count?: number, loadedAt?: number }> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block || block.name !== 'brewing_stand') {
      return { success: false, message: '蒸馏方块不可见或不是酿造台' }
    }

    let window: Window | null = null
    try {
      window = await this.openBlockWindow(block)
      if (window.inventoryStart !== 5) {
        throw new Error(`酿造台窗口结构异常: inventoryStart=${window.inventoryStart}`)
      }

      // Java 版酿造台：0..2 为药水槽，3 为原料槽，4 为燃料槽。
      for (let slot = 0; slot < 3; slot++) {
        if (window.slots[slot]) throw new Error(`药水槽 ${slot + 1} 已被占用`)
      }

      let moved = 0
      let loadedAt = 0
      for (let targetSlot = 0; targetSlot < 3; targetSlot++) {
        const sourceSlot = this.findWindowInventorySlot(window, filter)
        if (sourceSlot < 0) throw new Error(`可用发酵产物不足 (${moved}/3)`)
        await bot.moveSlotItem(sourceSlot, targetSlot)
        if (!window.slots[targetSlot] || !filter(window.slots[targetSlot]!)) {
          throw new Error(`放入药水槽 ${targetSlot + 1} 后未确认到产物`)
        }
        moved++
        loadedAt = Date.now()
      }
      return {
        success: true,
        count: moved,
        loadedAt,
        message: `已放入 ${moved} 瓶发酵产物`
      }
    } catch (err) {
      return { success: false, message: (err as Error).message }
    } finally {
      if (window) {
        try { bot.closeWindow(window) } catch { /* ignore */ }
        await sleep(150)
      }
    }
  }

  async unloadBrewingStand (
    x: number,
    y: number,
    z: number,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult & { count?: number }> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block || block.name !== 'brewing_stand') {
      return { success: false, message: '蒸馏方块不可见或不是酿造台' }
    }

    let window: Window | null = null
    try {
      window = await this.openBlockWindow(block)
      if (window.inventoryStart !== 5) {
        throw new Error(`酿造台窗口结构异常: inventoryStart=${window.inventoryStart}`)
      }

      let moved = 0
      for (let sourceSlot = 0; sourceSlot < 3; sourceSlot++) {
        if (!window.slots[sourceSlot]) throw new Error(`药水槽 ${sourceSlot + 1} 为空`)
        const targetSlot = this.findEmptyWindowInventorySlot(window)
        if (targetSlot < 0) throw new Error('背包空间不足，无法取出蒸馏产物')
        await bot.moveSlotItem(sourceSlot, targetSlot)
        if (window.slots[sourceSlot]) {
          throw new Error(`取出药水槽 ${sourceSlot + 1} 后槽位仍非空`)
        }
        moved++
      }
      return { success: true, count: moved, message: `已取出 ${moved} 瓶蒸馏产物` }
    } catch (err) {
      return { success: false, message: (err as Error).message }
    } finally {
      if (window) {
        try { bot.closeWindow(window) } catch { /* ignore */ }
        await sleep(150)
      }
    }
  }

  async depositPotionsToAgingBarrel (
    x: number,
    y: number,
    z: number,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult & { count?: number }> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const before = bot.inventory.items()
      .filter(item => normalizeItemKey(item.name).includes('potion'))
      .reduce((sum, item) => sum + item.count, 0)
    if (before === 0) return { success: false, message: '背包中没有可陈化的酒品' }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block || !block.name.endsWith('_planks')) {
      return { success: false, message: '陈化节点不可见或不是木板' }
    }

    let window: Window | null = null
    try {
      window = await this.openBlockWindow(block)
      if (window.inventoryStart <= 0) {
        throw new Error('酒桶未打开有效的容器界面')
      }

      let moved = 0
      while (true) {
        const sourceSlot = this.findWindowInventorySlot(
          window,
          item => normalizeItemKey(item.name).includes('potion')
        )
        if (sourceSlot < 0) break
        const item = window.slots[sourceSlot]
        if (!item) break

        const emptyTarget = this.findEmptyContainerSlot(window)
        if (emptyTarget < 0) {
          if (moved === 0) throw new Error('酒桶没有空位')
          break
        }

        const count = item.count
        await bot.moveSlotItem(sourceSlot, emptyTarget)
        if (!window.slots[emptyTarget]) {
          throw new Error('放入酒桶后未确认到酒品')
        }
        moved += count
      }

      if (moved === 0) throw new Error('未能将酒品放入酒桶')
      return { success: true, count: moved, message: `已放入酒桶 ${moved} 瓶` }
    } catch (err) {
      return { success: false, message: (err as Error).message }
    } finally {
      if (window) {
        try { bot.closeWindow(window) } catch { /* ignore */ }
        await sleep(150)
      }
    }
  }

  async withdrawPotionsFromAgingBarrel (
    x: number,
    y: number,
    z: number,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult & { count?: number }> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block || !block.name.endsWith('_planks')) {
      return { success: false, message: '陈化节点不可见或不是木板' }
    }

    let window: Window | null = null
    try {
      window = await this.openBlockWindow(block)
      if (window.inventoryStart <= 0) {
        throw new Error('酒桶未打开有效的容器界面')
      }

      let moved = 0
      for (let sourceSlot = 0; sourceSlot < window.inventoryStart; sourceSlot++) {
        const item = window.slots[sourceSlot]
        if (!item || !normalizeItemKey(item.name).includes('potion')) continue
        const targetSlot = this.findEmptyWindowInventorySlot(window)
        if (targetSlot < 0) throw new Error('背包空间不足，无法取出陈化产物')
        const count = item.count
        await bot.moveSlotItem(sourceSlot, targetSlot)
        if (window.slots[sourceSlot]) {
          throw new Error(`取出酒桶槽位 ${sourceSlot} 后仍非空`)
        }
        moved += count
      }

      if (moved === 0) {
        // 桶内没有酒品（可能已被人工提前收取），返回 count=0 供调用方区分，不作为失败重试。
        return { success: true, count: 0, message: '酒桶中没有酒品' }
      }
      return { success: true, count: moved, message: `已取出陈化产物 ${moved} 瓶` }
    } catch (err) {
      return { success: false, message: (err as Error).message }
    } finally {
      if (window) {
        try { bot.closeWindow(window) } catch { /* ignore */ }
        await sleep(150)
      }
    }
  }

  private findEmptyContainerSlot (window: Window): number {
    for (let slot = 0; slot < window.inventoryStart; slot++) {
      if (!window.slots[slot]) return slot
    }
    return -1
  }

  private findWindowInventorySlot (window: Window, filter: (item: Item) => boolean): number {
    for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot++) {
      const item = window.slots[slot]
      if (item && filter(item)) return slot
    }
    return -1
  }

  private findEmptyWindowInventorySlot (window: Window): number {
    for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot++) {
      if (!window.slots[slot]) return slot
    }
    return -1
  }

  /**
   * 连续开关容器时服务端可能尚未处理上一个 close，导致 windowOpen 超时。
   * 开启前清理残留窗口，并对失败做一次短暂退避重试。
   */
  private async openContainer (
    block: Block
  ): Promise<Awaited<ReturnType<Bot['openContainer']>>> {
    const bot = this.mcBot.bot
    if (!bot) throw new Error('机器人未就绪')

    let lastError: Error | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      if (bot.currentWindow) {
        try { bot.closeWindow(bot.currentWindow) } catch { /* ignore */ }
        await sleep(250)
      }
      try {
        return await bot.openContainer(block)
      } catch (err) {
        lastError = err as Error
        try {
          if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        } catch { /* ignore */ }
        if (attempt === 0) await sleep(750)
      }
    }
    throw lastError ?? new Error('打开容器失败')
  }

  private async openBlockWindow (block: Block): Promise<Window> {
    const bot = this.mcBot.bot
    if (!bot) throw new Error('机器人未就绪')

    let lastError: Error | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      if (bot.currentWindow) {
        try { bot.closeWindow(bot.currentWindow) } catch { /* ignore */ }
        await sleep(250)
      }
      try {
        return await bot.openBlock(block)
      } catch (err) {
        lastError = err as Error
        try {
          if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        } catch { /* ignore */ }
        if (attempt === 0) await sleep(750)
      }
    }
    throw lastError ?? new Error('打开方块窗口失败')
  }
}
