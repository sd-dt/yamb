import type { CommandSource } from '../parser'
import type { CommandContext } from './types'

export async function handleBrew (
  ctx: CommandContext,
  username: string,
  parts: string[],
  source: CommandSource
): Promise<void> {
  const sub = (parts.shift() || '').toLowerCase()

  switch (sub) {
    case 'start': {
      const recipe = parts[0]
      if (!recipe) {
        await ctx.reply(username, ctx.messages.text('brewUsage'), source)
        return
      }
      const result = await ctx.brewModule.start(
        recipe,
        async message => ctx.reply(username, message, source),
        username
      )
      await ctx.reply(
        username,
        result.success
          ? ctx.messages.text('brewStarted', { recipe })
          : result.message || ctx.messages.text('brewBusy'),
        source
      )
      break
    }

    case 'status': {
      const status = ctx.brewModule.status()
      const agingLines = status.aging ?? []
      if (!status.running) {
        if (agingLines.length > 0) {
          await ctx.reply(username, [
            ctx.messages.text('brewStatusIdle'),
            ...agingLines
          ].join('\n'), source)
          return
        }
        await ctx.reply(username, ctx.messages.text('brewStatusIdle'), source)
        return
      }
      const lines = [
        ctx.messages.text('brewStatusRunning', {
          recipe: status.recipe || '-',
          phase: status.phase || '-',
          status: status.detail || status.phase || '-'
        }),
        ...agingLines
      ]
      await ctx.reply(username, lines.join('\n'), source)
      break
    }

    case 'reload': {
      if (!ctx.isAdmin(username)) {
        await ctx.reply(username, ctx.messages.text('noPermission'), source)
        return
      }
      const result = ctx.brewModule.reloadRecipes()
      await ctx.reply(username, result.message || '重新加载配方失败', source)
      break
    }

    case 'cancel':
      await ctx.reply(
        username,
        ctx.brewModule.cancel()
          ? ctx.messages.text('brewCancelRequested')
          : ctx.messages.text('brewStatusIdle'),
        source
      )
      break

    case 'stop':
      await ctx.reply(
        username,
        await ctx.brewModule.stop()
          ? ctx.messages.text('brewStopped')
          : ctx.messages.text('brewStatusIdle'),
        source
      )
      break

    default:
      await ctx.reply(username, ctx.messages.text('brewUsage'), source)
  }
}
