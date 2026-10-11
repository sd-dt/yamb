import type { CommandSource } from '../parser'
import type { CommandContext } from './types'

export async function handlePhome (
  ctx: CommandContext,
  username: string,
  alias: string | undefined,
  source: CommandSource
): Promise<void> {
  const waypoints = ctx.teleportService.listWaypoints()

  // phome / phome help|list：按固定顺序给出编号列表（phome <数字> 的数字就是这里的序号）
  if (!alias || ['help', 'list', '帮助', '列表'].indexOf(alias.toLowerCase().trim()) >= 0) {
    if (waypoints.length === 0) {
      await ctx.reply(username, ctx.messages.text('phomeUsage', { waypoints: ctx.waypointHint() }), source)
      return
    }
    const lines = waypoints.map((w, i) => {
      const label = w.alias === w.id ? w.alias : w.alias + '（' + w.id + '）'
      return (i + 1) + '. ' + label
    })
    await ctx.reply(username, ['传送点列表（用法：phome <编号> 或 phome <名字>）：', ...lines].join('\n'), source)
    return
  }

  // 纯数字：先按别名精确匹配（兼容本身就是数字的别名），否则按列表序号取第 N 个
  const key = alias.trim()
  if (/^\d+$/.test(key) && !ctx.teleportService.resolveWaypointId(key)) {
    const n = parseInt(key, 10)
    if (n < 1 || n > waypoints.length) {
      await ctx.reply(username, '❌ 编号超出范围：1~' + waypoints.length + '（发 phome 看列表）', source)
      return
    }
    alias = waypoints[n - 1].alias
  }

  const result = await ctx.teleportService.goToPlayerViaWaypoint(username, alias)
  if (result.code === 'locked') {
    await ctx.notifyLocked(username, source)
    return
  }
  if (!result.success && result.message) {
    await ctx.reply(username, ctx.messages.text('phomeError', { message: result.message }), source)
  }
}

export async function handleLock (
  ctx: CommandContext,
  username: string,
  arg: string | undefined,
  source: CommandSource
): Promise<void> {
  if (ctx.teleportService.isLocked()) {
    await ctx.reply(username, ctx.messages.text('lockAlready'), source)
    return
  }

  const mode = (arg || '').toLowerCase().trim()
  if (mode && mode !== 'hover') {
    await ctx.reply(username, ctx.messages.text('lockUsage'), source)
    return
  }

  const hover = mode === 'hover'
  const result = await ctx.teleportService.prepareAndLock(username, { hover })

  if (!result.success) {
    if (result.code === 'hover_failed' || result.code === 'not_ready') {
      await ctx.reply(username, ctx.messages.text('lockHoverFailed'), source)
      return
    }
    await ctx.reply(username, ctx.messages.text('lockAlready'), source)
    return
  }

  await ctx.reply(
    username,
    ctx.messages.text(hover ? 'lockHoverSuccess' : 'lockSuccess'),
    source
  )
}

export async function handleUnlock (
  ctx: CommandContext,
  username: string,
  source: CommandSource
): Promise<void> {
  if (!ctx.teleportService.isLocked()) {
    await ctx.reply(username, ctx.messages.text('unlockNotLocked'), source)
    return
  }

  ctx.teleportService.unlock()
  await ctx.reply(username, ctx.messages.text('unlockSuccess'), source)
}
