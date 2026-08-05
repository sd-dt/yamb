import type { CommandSource } from '../parser'
import type { CommandContext } from './types'
import { getBlockNodeAt, normalizeMinecraftId } from '../../block-node-utils'

export async function handleNode (
  ctx: CommandContext,
  username: string,
  parts: string[],
  source: CommandSource
): Promise<void> {
  if (!ctx.isAdmin(username)) {
    await ctx.reply(username, ctx.messages.text('noPermission'), source)
    return
  }

  const sub = (parts.shift() || '').toLowerCase()
  switch (sub) {
    case 'reg':
      await handleNodeRegister(ctx, username, parts, source)
      break
    case 'remove':
      await handleNodeRemove(ctx, username, parts[0], source)
      break
    case 'list':
      await handleNodeList(ctx, username, parts[0], source)
      break
    case 'info':
      await handleNodeInfo(ctx, username, parts[0], source)
      break
    default:
      await ctx.reply(username, ctx.messages.text('nodeUsage'), source)
  }
}

async function handleNodeRegister (
  ctx: CommandContext,
  username: string,
  parts: string[],
  source: CommandSource
): Promise<void> {
  const [alias, xRaw, yRaw, zRaw, ...options] = parts
  if (!alias ||
      !isIntegerText(xRaw) ||
      !isIntegerText(yRaw) ||
      !isIntegerText(zRaw)) {
    await ctx.reply(username, ctx.messages.text('nodeRegUsage'), source)
    return
  }

  const parsedOptions = parseRegisterOptions(options)
  if (!parsedOptions) {
    await ctx.reply(username, ctx.messages.text('nodeRegUsage'), source)
    return
  }

  const bot = ctx.mcBot.bot
  if (!bot) {
    await ctx.reply(username, ctx.messages.text('nodeNoTarget'), source)
    return
  }

  const x = Number(xRaw)
  const y = Number(yRaw)
  const z = Number(zRaw)
  const target = getBlockNodeAt(bot, x, y, z)
  if (!target) {
    await ctx.reply(username, ctx.messages.text('nodeNoTarget'), source)
    return
  }

  if (target.blockType !== 'Container' && parsedOptions.mixed) {
    await ctx.reply(username, ctx.messages.text('nodeRegUsage'), source)
    return
  }

  const isDedicated = target.blockType === 'Container'
    ? !parsedOptions.mixed
    : null

  try {
    const itemId = isDedicated
      ? await readFirstContainerSlotItemId(ctx, target.block, x, y, z)
      : null

    const node = ctx.blockRegistry.register({
      alias,
      blockType: target.blockType,
      nodeGroup: parsedOptions.nodeGroup,
      x,
      y,
      z,
      dimension: bot.game?.dimension || 'overworld',
      isDedicated,
      itemId,
      createdBy: username
    })

    await ctx.reply(username, ctx.messages.text('nodeRegSuccess', {
      alias: node.alias,
      blockType: node.blockType,
      group: node.nodeGroup ?? '-',
      containerMode: node.blockType === 'Container'
        ? (node.isDedicated ? `专用 (${node.itemId})` : '混合')
        : '-',
      x: node.x,
      y: node.y,
      z: node.z
    }), source)
  } catch (err) {
    await ctx.reply(username, ctx.messages.text('nodeRegError', {
      message: (err as Error).message
    }), source)
  }
}

function isIntegerText (value: string | undefined): value is string {
  return value != null && /^-?\d+$/.test(value)
}

function parseRegisterOptions (
  options: string[]
): { mixed: boolean, nodeGroup: string | null } | null {
  let mixed = false
  let nodeGroup: string | null = null

  for (let i = 0; i < options.length; i++) {
    const option = options[i].toLowerCase()
    if (option === '-m' || option === '-mixed' || option === '--mixed') {
      mixed = true
      continue
    }
    if (option === '-g' || option === '-group' || option === '--group') {
      const group = options[++i]
      if (!group || nodeGroup != null) return null
      nodeGroup = group
      continue
    }
    return null
  }

  return { mixed, nodeGroup }
}

async function readFirstContainerSlotItemId (
  ctx: CommandContext,
  block: NonNullable<ReturnType<typeof getBlockNodeAt>>['block'],
  x: number,
  y: number,
  z: number
): Promise<string> {
  const bot = ctx.mcBot.bot
  if (!bot) throw new Error('机器人未就绪')

  const approach = await ctx.inventoryActions.approachBlock(
    x,
    y,
    z,
    ctx.interactionDistance,
    ctx.approachDistance
  )
  if (!approach.success) {
    throw new Error(approach.message || '无法接近容器')
  }

  const container = await bot.openContainer(block)
  try {
    const firstItem = container.slots[0]
    if (!firstItem) {
      throw new Error('专用容器第一格没有物品，无法绑定')
    }
    return normalizeMinecraftId(firstItem.name)
  } finally {
    container.close()
  }
}

async function handleNodeRemove (
  ctx: CommandContext,
  username: string,
  alias: string | undefined,
  source: CommandSource
): Promise<void> {
  if (!alias) {
    await ctx.reply(username, ctx.messages.text('nodeRemoveUsage'), source)
    return
  }
  if (!ctx.blockRegistry.remove(alias)) {
    await ctx.reply(username, ctx.messages.text('nodeNotFound', { alias }), source)
    return
  }
  await ctx.reply(username, ctx.messages.text('nodeRemoveSuccess', { alias }), source)
}

async function handleNodeList (
  ctx: CommandContext,
  username: string,
  nodeGroup: string | undefined,
  source: CommandSource
): Promise<void> {
  const list = ctx.blockRegistry.list(nodeGroup)
  if (list.length === 0) {
    await ctx.reply(username, ctx.messages.text('nodeListEmpty'), source)
    return
  }

  const lines = [
    ctx.messages.text('nodeListHeader', {
      count: list.length,
      group: nodeGroup ?? '全部'
    }),
    ...list.map(node => ctx.messages.text('nodeListEntry', {
      alias: node.alias,
      blockType: node.blockType,
      group: node.nodeGroup ?? '-',
      x: node.x,
      y: node.y,
      z: node.z
    }))
  ]
  await ctx.reply(username, lines.join('\n'), source)
}

async function handleNodeInfo (
  ctx: CommandContext,
  username: string,
  alias: string | undefined,
  source: CommandSource
): Promise<void> {
  if (!alias) {
    await ctx.reply(username, ctx.messages.text('nodeInfoUsage'), source)
    return
  }

  const node = ctx.blockRegistry.get(alias)
  if (!node) {
    await ctx.reply(username, ctx.messages.text('nodeNotFound', { alias }), source)
    return
  }

  const containerMode = node.blockType === 'Container'
    ? (node.isDedicated ? `专用 (${node.itemId})` : '混合')
    : '-'
  const lines = ctx.messages.lines('nodeInfoLines', {
    alias: node.alias,
    blockType: node.blockType,
    group: node.nodeGroup ?? '-',
    x: node.x,
    y: node.y,
    z: node.z,
    dimension: node.dimension,
    containerMode,
    createdBy: node.createdBy ?? '-',
    date: node.createdAt.slice(0, 10)
  })
  await ctx.reply(username, lines.join('\n'), source)
}
