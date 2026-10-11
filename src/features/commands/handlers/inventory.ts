import type { CommandSource } from '../parser'
import type { CommandContext } from './types'

function isAllowedByDedicatedContainer (
  itemQuery: string,
  isDedicated: boolean | null,
  itemId: string | null
): boolean {
  if (!isDedicated) return true
  const query = itemQuery.toLowerCase().replace(/^minecraft:/, '')
  const dedicatedItem = (itemId || '').toLowerCase().replace(/^minecraft:/, '')
  return query === dedicatedItem
}

export async function handleInv (
  ctx: CommandContext,
  username: string,
  source: CommandSource
): Promise<void> {
  if (!ctx.isAdmin(username)) {
    await ctx.reply(username, ctx.messages.text('noPermission'), source)
    return
  }

  const result = ctx.inventoryActions.listInventory()
  if (!result.success) {
    await ctx.reply(username, ctx.messages.text('invError', { message: result.message || '失败' }), source)
    return
  }

  if (!result.lines?.length) {
    await ctx.reply(username, ctx.messages.text('invEmpty'), source)
    return
  }

  const header = ctx.messages.text('invHeader', { count: result.lines.length })
  await ctx.reply(username, [header, ...result.lines].join('\n'), source)
}

export async function handleStore (
  ctx: CommandContext,
  username: string,
  parts: string[],
  source: CommandSource
): Promise<void> {
  const alias = parts[0]
  const itemQuery = parts[1]
  const count = parts[2] ? parseInt(parts[2], 10) : undefined

  if (!alias || !itemQuery) {
    await ctx.reply(username, ctx.messages.text('storeUsage'), source)
    return
  }

  const record = ctx.blockRegistry.getContainer(alias)
  if (!record) {
    await ctx.reply(username, ctx.messages.text('nodeContainerNotFound', { alias }), source)
    return
  }
  if (!isAllowedByDedicatedContainer(itemQuery, record.isDedicated, record.itemId)) {
    await ctx.reply(username, ctx.messages.text('dedicatedContainerMismatch', {
      alias,
      itemId: record.itemId ?? '-'
    }), source)
    return
  }

  const result = await ctx.inventoryActions.storeInContainer(
    record.x,
    record.y,
    record.z,
    itemQuery,
    Number.isFinite(count) ? count : undefined,
    ctx.interactionDistance,
    ctx.approachDistance
  )
  await ctx.reply(username, result.success
    ? ctx.messages.text('storeSuccess', { message: result.message || '已存入' })
    : ctx.messages.text('storeError', { message: result.message || '存入失败' }), source)
}

export async function handleTake (
  ctx: CommandContext,
  username: string,
  parts: string[],
  source: CommandSource
): Promise<void> {
  const alias = parts[0]
  const itemQuery = parts[1]
  const count = parts[2] ? parseInt(parts[2], 10) : undefined

  if (!alias || !itemQuery) {
    await ctx.reply(username, ctx.messages.text('takeUsage'), source)
    return
  }

  const record = ctx.blockRegistry.getContainer(alias)
  if (!record) {
    await ctx.reply(username, ctx.messages.text('nodeContainerNotFound', { alias }), source)
    return
  }
  if (!isAllowedByDedicatedContainer(itemQuery, record.isDedicated, record.itemId)) {
    await ctx.reply(username, ctx.messages.text('dedicatedContainerMismatch', {
      alias,
      itemId: record.itemId ?? '-'
    }), source)
    return
  }

  const result = await ctx.inventoryActions.takeFromContainer(
    record.x,
    record.y,
    record.z,
    itemQuery,
    Number.isFinite(count) ? count : undefined,
    ctx.interactionDistance,
    ctx.approachDistance
  )
  await ctx.reply(username, result.success
    ? ctx.messages.text('takeSuccess', { message: result.message || '已取出' })
    : ctx.messages.text('takeError', { message: result.message || '取出失败' }), source)
}

export async function handleDrop (
  ctx: CommandContext,
  username: string,
  parts: string[],
  source: CommandSource
): Promise<void> {
  const itemQuery = parts[0]
  const count = parts[1] ? parseInt(parts[1], 10) : undefined

  if (!itemQuery) {
    await ctx.reply(username, ctx.messages.text('dropUsage'), source)
    return
  }

  const result = await ctx.inventoryActions.dropItem(
    itemQuery,
    Number.isFinite(count) ? count : undefined
  )
  await ctx.reply(username, result.success
    ? ctx.messages.text('dropSuccess', { message: result.message || '已丢弃' })
    : ctx.messages.text('dropError', { message: result.message || '丢弃失败' }), source)
}

/** slot [1-9]：切换主手快捷栏格子；不带参数 = 报当前格子和手持物 */
export async function handleSlot (
  ctx: CommandContext,
  username: string,
  parts: string[],
  source: CommandSource
): Promise<void> {
  if (!ctx.isAdmin(username)) {
    await ctx.reply(username, ctx.messages.text('noPermission'), source)
    return
  }
  const bot: any = ctx.mcBot.bot
  if (!ctx.mcBot.isReady || !bot) {
    await ctx.reply(username, '机器人未就绪', source)
    return
  }
  const heldName = (h: any) => (h ? (h.displayName || h.name) : '空手')
  const cur = typeof bot.quickBarSlot === 'number' ? bot.quickBarSlot : 0
  const arg = (parts[0] || '').trim()
  if (!arg) {
    await ctx.reply(username, '当前格子 ' + (cur + 1) + '/9：手持 ' + heldName(bot.heldItem) + '（用法：slot <1-9>）', source)
    return
  }
  const n = parseInt(arg, 10)
  if (isNaN(n) || n < 1 || n > 9) {
    await ctx.reply(username, '❌ 格子号只能是 1~9', source)
    return
  }
  bot.setQuickBarSlot(n - 1)
  await ctx.reply(username, '已切到格子 ' + n + '/9：手持 ' + heldName(bot.heldItem), source)
}

/** hand [物品名]：查看主手 / 把背包里的物品换到主手（按 name 或显示名匹配） */
export async function handleHand (
  ctx: CommandContext,
  username: string,
  parts: string[],
  source: CommandSource
): Promise<void> {
  if (!ctx.isAdmin(username)) {
    await ctx.reply(username, ctx.messages.text('noPermission'), source)
    return
  }
  const bot: any = ctx.mcBot.bot
  if (!ctx.mcBot.isReady || !bot) {
    await ctx.reply(username, '机器人未就绪', source)
    return
  }
  const heldName = (h: any) => (h ? (h.displayName || h.name) + (h.count > 1 ? ' x' + h.count : '') : '空手')
  const query = (parts[0] || '').trim().toLowerCase()
  if (!query) {
    await ctx.reply(username, '当前主手：' + heldName(bot.heldItem) + '（用法：hand <物品名>；bag 看背包）', source)
    return
  }
  const q = query.replace(/^minecraft:\//, '').replace(/^minecraft:/, '')
  const items: any[] = (bot.inventory && typeof bot.inventory.items === 'function') ? bot.inventory.items() : []
  const hit = items.find((it) => (it.name || '').toLowerCase() === q)
    || items.find((it) => (it.name || '').toLowerCase().replace(/^minecraft:/, '').indexOf(q) >= 0)
    || items.find((it) => (it.displayName || '').toLowerCase().indexOf(q) >= 0)
  if (!hit) {
    await ctx.reply(username, '❌ 背包里没有匹配「' + query + '」的物品（发 bag 看背包）', source)
    return
  }
  try {
    await bot.equip(hit, 'hand')
  } catch (e) {
    await ctx.reply(username, '❌ 换手失败：' + (e as Error).message, source)
    return
  }
  await ctx.reply(username, '已切换主手：' + heldName(bot.heldItem), source)
}
