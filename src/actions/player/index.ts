import type { Bot } from 'mineflayer'
import type { ServiceResult } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import { sleep } from '../../platform/sleep'
import {
  approachEntity,
  entityDistance,
  entityLookPoint,
  getHeadSeatCloud,
  getPlayerEntity,
  isMountedOnPlayer,
  isOnPluginCloudSeat
} from '../shared/entity-utils'

export default class PlayerInteractionService {
  private mcBot: MinecraftBot
  private interactionDistance: number
  private approachDistance: number

  constructor (
    mcBot: MinecraftBot,
    interactionDistance: number,
    approachDistance: number
  ) {
    this.mcBot = mcBot
    this.interactionDistance = interactionDistance
    this.approachDistance = approachDistance
  }

  getApproachDistance (): number {
    return this.approachDistance
  }

  isPlayerInRange (targetName: string): boolean {
    const bot = this.mcBot.bot
    if (!bot) return false
    const entity = getPlayerEntity(bot, targetName)
    if (!entity) return false
    return entityDistance(bot, entity) <= this.approachDistance
  }

  isMountedOn (targetName: string): boolean {
    const bot = this.mcBot.bot
    if (!bot) return false
    return isMountedOnPlayer(bot, targetName)
  }

  async mount (targetName: string): Promise<ServiceResult> {
    return this.interactWithPlayer(targetName, 'mount')
  }

  async attack (targetName: string): Promise<ServiceResult> {
    return this.interactWithPlayer(targetName, 'attack')
  }

  async remountPlayer (targetName: string): Promise<boolean> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) return false

    const entity = getPlayerEntity(bot, targetName)
    if (!entity) return false

    const approach = await approachEntity(
      bot,
      entity,
      this.interactionDistance,
      this.approachDistance
    )
    if (!approach.success) return false

    return this.tryMountPlayer(bot, targetName)
  }

  private async interactWithPlayer (
    targetName: string,
    action: 'mount' | 'attack'
  ): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const entity = getPlayerEntity(bot, targetName)
    if (!entity) {
      return { success: false, message: `玩家 ${targetName} 不在线或不可见` }
    }

    const approach = await approachEntity(
      bot,
      entity,
      this.interactionDistance,
      this.approachDistance
    )
    if (!approach.success) return approach

    try {
      if (action === 'mount') {
        const mounted = await this.tryMountPlayer(bot, targetName)
        const distance = entityDistance(bot, getPlayerEntity(bot, targetName) ?? entity).toFixed(1)
        if (mounted) {
          console.log(`[Interaction] 骑乘 ${targetName} 成功 (距离 ${distance})`)
          return { success: true, message: `已骑乘 ${targetName}` }
        }
        console.log(`[Interaction] 骑乘 ${targetName} 失败 (距离 ${distance})`)
        return { success: false, message: `未能骑乘 ${targetName}，请确认距离与服务器插件支持` }
      }

      const target = getPlayerEntity(bot, targetName) ?? entity
      const lookPoint = entityLookPoint(target)
      await bot.lookAt(lookPoint, true)
      await sleep(200)
      bot.attack(target)
      console.log(`[Interaction] 攻击 ${targetName}`)
      return { success: true, message: `已攻击 ${targetName}` }
    } catch (err) {
      console.error(`[Interaction] ${action} 失败:`, (err as Error).message)
      return { success: false, message: (err as Error).message }
    }
  }

  private async tryMountPlayer (bot: Bot, targetName: string): Promise<boolean> {
    const maxAttempts = 8
    await bot.unequip('hand')
    await sleep(100)

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const entity = getPlayerEntity(bot, targetName)
      if (!entity) return false

      // 不同坐骑插件监听不同的交互路径，逐个换着试，每次试完用 isMountedOnPlayer 实测确认：
      // ① 普通 interact(type0) ② interact_at(头部) ③ 目标头顶的乘客座椅实体（passengers 里非玩家）
      // ④ 头顶附近的 AEC 云 ⑤ 右键空气（服务器射线判定） ⑥ 潜行状态 interact（包里 sneaking=true）
      const candidates: Array<{ label: string; run: () => any }> = []
      if (typeof bot.activateEntity === 'function') candidates.push({ label: 'interact(玩家)', run: async () => { await bot.activateEntity(entity) } })
      if (typeof bot.activateEntityAt === 'function') candidates.push({ label: 'interact_at(玩家头部)', run: async () => { await bot.activateEntityAt(entity, entityLookPoint(entity)) } })
      const seats: any[] = []
      const pax = (entity as any).passengers
      if (Array.isArray(pax)) for (const p of pax) { if (p && p.type !== 'player') seats.push(p) }
      const cloud = getHeadSeatCloud(bot, entity)
      if (cloud && seats.indexOf(cloud) < 0) seats.push(cloud)
      for (const s of seats) {
        if (typeof bot.activateEntity === 'function') candidates.push({ label: 'interact(头顶座椅实体)', run: async () => { await bot.activateEntity(s) } })
        if (typeof bot.activateEntityAt === 'function') candidates.push({ label: 'interact_at(头顶座椅实体)', run: async () => { await bot.activateEntityAt(s, entityLookPoint(s)) } })
      }
      if (typeof bot.activateItem === 'function') candidates.push({
        label: '右键空气(射线判定)',
        run: async () => {
          await bot.lookAt(entityLookPoint(entity), true)
          bot.activateItem()
          await sleep(150)
          try { if (typeof bot.deactivateItem === 'function') bot.deactivateItem() } catch (e2) {}
        }
      })
      if (typeof bot.setControlState === 'function' && typeof bot.useOn === 'function') candidates.push({
        label: '潜行+interact(玩家)',
        run: async () => {
          bot.setControlState('sneak', true)
          try { bot.useOn(entity) } finally {
            setTimeout(() => { try { bot.setControlState('sneak', false) } catch (e2) {} }, 400)
          }
        }
      })
      if (candidates.length === 0) return false
      const pick = candidates[(attempt - 1) % candidates.length]
      try { await pick.run() } catch (e) {
        console.log('[Interaction] ' + pick.label + ' 发包异常: ' + (e as Error).message)
      }
      await sleep(500)

      if (isMountedOnPlayer(bot, targetName)) {
        const dist = entityDistance(bot, getPlayerEntity(bot, targetName) ?? entity).toFixed(1)
        console.log(`[Interaction] 骑乘确认成功 (第 ${attempt} 次交互, 距离 ${dist}, cloudSeat=${isOnPluginCloudSeat(bot)})`)
        return true
      }

      const current = getPlayerEntity(bot, targetName) ?? entity
      const horizontal = Math.hypot(
        bot.entity.position.x - current.position.x,
        bot.entity.position.z - current.position.z
      )
      const dy = bot.entity.position.y - current.position.y
      console.log(
        `[Interaction] 未骑乘 [${pick.label}] (${attempt}/${maxAttempts})` +
        ` horiz=${horizontal.toFixed(2)} dy=${dy.toFixed(2)}` +
        ` onGround=${bot.entity.onGround} cloudSeat=${isOnPluginCloudSeat(bot)}`
      )

      if (attempt < maxAttempts) {
        await sleep(250)
      }
    }

    return isMountedOnPlayer(bot, targetName)
  }
}
