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
