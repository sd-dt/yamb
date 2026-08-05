import type { BrewingContext } from './types'

function formatRemaining (finishAt: number, now: number): string {
  const totalSeconds = Math.max(0, Math.ceil((finishAt - now) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}min ${seconds}s` : `${seconds}s`
}

export function formatBrewingStatus (
  context: BrewingContext,
  now = Date.now()
): string {
  if (
    context.phase === 'distillery-loading' ||
    context.phase === 'distilling' ||
    context.phase === 'distillery-unloading'
  ) {
    const total = context.distillationRuns ?? 0
    if (total > 0) {
      const completed = context.phase === 'distillery-loading'
        ? 0
        : context.phase === 'distillery-unloading'
          ? total
          : Math.min(
              total,
              Math.max(0, Math.floor((now - (context.distillationStartedAt ?? now)) / 45000))
            )
      return `Distilled ${completed}/${total} times`
    }
  }

  if (
    context.phase === 'fermenting' ||
    context.phase === 'waiting' ||
    context.phase === 'bottling'
  ) {
    return `Fermenting ${formatRemaining(context.finishAt, now)}`
  }

  return 'Brewing'
}
