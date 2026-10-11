import type { ServiceResult } from '../types'
import { sleep } from '../platform/sleep'
import type MinecraftBot from '../platform/minecraft-bot'
import { entityLookPoint, isMountedOnPlayer } from '../actions/shared/entity-utils'

/**
 * 无状态动作执行器 —— 一次调用 = 一个动作。
 *
 * 设计：yamb 只负责"立刻做一下"，不维护定时器；
 *       attack interval / use continuous 这类循环由控制器（mcbot controller）驱动。
 *       这样以后加新玩法基本不用再动 yamb。
 *
 * 由 GameApiService.action() 调用，路由是 POST /api/action
 */

export interface ActionParams {
  target?: string
  dir?: string
  x?: number
  y?: number
  z?: number
  yaw?: number
  pitch?: number
  seconds?: number
  slot?: number
}

const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']

export default class ActionService {
  private mcBot: MinecraftBot

  constructor (mcBot: MinecraftBot) {
    this.mcBot = mcBot
  }

  private ok (message: string): ServiceResult {
    return { success: true, message }
  }

  private err (message: string): ServiceResult {
    return { success: false, message }
  }

  async execute (act: string, p: ActionParams = {}): Promise<ServiceResult> {
    if (!this.mcBot.isReady || !this.mcBot.bot) {
      return this.err('机器人未就绪')
    }
    const bot: any = this.mcBot.bot
    const a = String(act || '').toLowerCase().trim()
    const deg = Math.PI / 180

    try {
      switch (a) {
        case 'attack': {
          // 不可攻击实体（打了会被服务器 invalid_entity_attacked 踢出）：
          // 玩家头顶的隐姓 AEC 座椅云、经验球、掉落物、弹射物等 —— nearestEntity 必须过滤掉
          const unattackable = /area_effect_cloud|experience_orb|xp_orb|item_frame|glow_item_frame|painting|leash_knot|lightning_bolt|fishing_bobber|snowball|arrow|spectral_arrow|ender_pearl|egg\b|item\b|item_display|block_display|text_display|interaction\b|marker\b/
          const e: any = typeof bot.nearestEntity === 'function'
            ? bot.nearestEntity((c: any) => {
                if (!c || !c.position) return false
                const n = String(c.name || c.displayName || '').toLowerCase()
                if (unattackable.test(n)) return false
                return true
              })
            : null
          if (e && e.position) {
            const dist = bot.entity.position.distanceTo(e.position)
            if (dist > 3.6) {
              return this.err('目标太远（' + dist.toFixed(1) + ' 格），已放弃攻击（防 invalid_entity 被踢）')
            }
            bot.attack(e)
            const name = e.username || e.name || e.displayName || e.type || '目标'
            return this.ok('左键：攻击了 ' + name)
          }
          if (typeof bot.swingArm === 'function') bot.swingArm()
          return this.ok('左键：空挥一次')
        }

        case 'use': {
          if (typeof bot.activateItem === 'function') bot.activateItem()
          setTimeout(() => { try { if (typeof bot.deactivateItem === 'function') bot.deactivateItem() } catch (e) {} }, 150)
          return this.ok('右键：使用了手上的物品')
        }

        case 'useblock': {
          if (p.x === undefined || p.y === undefined || p.z === undefined) return this.err('缺坐标：useblock <x> <y> <z>')
          const b = bot.blockAt({ x: p.x, y: p.y, z: p.z })
          if (!b) return this.err('那个位置没有方块（可能还没加载）')
          bot.activateBlock(b)
          return this.ok('右键：作用于 ' + b.name + ' @ ' + p.x + ',' + p.y + ',' + p.z)
        }

        case 'dig': {
          if (p.x === undefined || p.y === undefined || p.z === undefined) return this.err('缺坐标：dig <x> <y> <z>')
          const b = bot.blockAt({ x: p.x, y: p.y, z: p.z })
          if (!b) return this.err('那个位置没有方块')
          bot.dig(b).then(() => {}).catch(() => {})
          return this.ok('左键：开始挖 ' + b.name + ' @ ' + p.x + ',' + p.y + ',' + p.z)
        }

        case 'attackentity': {
          const name = String(p.target || '').trim()
          if (!name) return this.err('缺目标名：attackentity <玩家名>')
          const e: any = (bot.players && bot.players[name] && bot.players[name].entity) || null
          if (!e) return this.err('附近找不到玩家 ' + name)
          const dist = bot.entity.position.distanceTo(e.position)
          if (dist > 3.6) {
            return this.err(name + ' 太远（' + dist.toFixed(1) + ' 格），已放弃攻击（防 invalid_entity 被踢）')
          }
          bot.attack(e)
          return this.ok('左键：攻击了 ' + name)
        }

        case 'useentity': {
          const name = String(p.target || '').trim()
          if (!name) return this.err('缺目标名：useentity <玩家名>')
          const e: any = (bot.players && bot.players[name] && bot.players[name].entity) || null
          if (!e) return this.err('附近找不到玩家 ' + name)
          // 本服"坐头"插件要求空手右键：先清主手，再按 普通 interact / interact_at 各试一次
          if (typeof bot.unequip === 'function') { try { await bot.unequip('hand') } catch (e2) {} }
          const attempts: Array<() => any> = []
          if (typeof bot.activateEntity === 'function') attempts.push(async () => { await bot.activateEntity(e) })
          if (typeof bot.activateEntityAt === 'function') attempts.push(async () => { await bot.activateEntityAt(e, entityLookPoint(e)) })
          if (attempts.length === 0) return this.err('mineflayer 缺少实体交互接口（activateEntity）')
          let mounted = false
          for (const fn of attempts) {
            try { await fn() } catch (e2) {}
            await sleep(500)
            if (isMountedOnPlayer(bot, name)) { mounted = true; break }
          }
          if (mounted) return this.ok('右键成功：已坐上 ' + name + ' 的头顶（主手已清空）')
          return this.err('右键已发给 ' + name + '（两种 interact 包都试了），但没检测到坐上头顶')
        }

        case 'slot': {
          const cur = typeof bot.quickBarSlot === 'number' ? bot.quickBarSlot : 0
          const heldName = (h: any) => (h ? (h.displayName || h.name) : '空手')
          if (p.slot === undefined || p.slot === null || isNaN(Number(p.slot))) {
            return this.ok('当前格子 ' + (cur + 1) + '/9：手持 ' + heldName(bot.heldItem) + '（切格子：slot <1-9>）')
          }
          const n = Math.round(Number(p.slot))
          if (n < 1 || n > 9) return this.err('格子号只能是 1~9（当前在第 ' + (cur + 1) + ' 格）')
          bot.setQuickBarSlot(n - 1)
          return this.ok('已切到格子 ' + n + '/9：手持 ' + heldName(bot.heldItem))
        }

        case 'jump': {
          bot.setControlState('jump', true)
          setTimeout(() => { try { bot.setControlState('jump', false) } catch (e) {} }, 250)
          return this.ok('跳一下')
        }

        case 'sneak':
        case 'sprint': {
          const cur = typeof bot.getControlState === 'function' ? !!bot.getControlState(a) : false
          bot.setControlState(a, !cur)
          return this.ok((a === 'sneak' ? '潜行' : '疾跑') + '：' + (!cur ? '开' : '关'))
        }

        case 'move': {
          const dir = String(p.dir || p.target || 'forward').toLowerCase()
          if (CONTROLS.indexOf(dir) < 0) return this.err('方向只能是 forward / back / left / right')
          const secs = Math.max(0.2, Math.min(30, Number(p.seconds) || 1))
          bot.setControlState(dir, true)
          setTimeout(() => { try { bot.setControlState(dir, false) } catch (e) {} }, secs * 1000)
          return this.ok('向 ' + dir + ' 走 ' + secs + ' 秒')
        }

        case 'look': {
          const yaw = Number(p.yaw)
          const pitch = Number(p.pitch)
          if (isNaN(yaw) || isNaN(pitch)) return this.err('用法：look <yaw角度> <pitch角度>')
          bot.look(yaw * deg, pitch * deg, true)
          return this.ok('视角 -> yaw=' + yaw + ' pitch=' + pitch)
        }

        case 'pos': {
          const pos = bot.entity.position
          const yaw = Math.round(bot.entity.yaw / deg)
          const pitch = Math.round(bot.entity.pitch / deg)
          return this.ok('位置 ' + pos.x.toFixed(1) + ' ' + pos.y.toFixed(1) + ' ' + pos.z.toFixed(1) +
                         ' / 朝向 yaw=' + yaw + ' pitch=' + pitch)
        }

        case 'drop': {
          const held: any = bot.heldItem
          if (!held) return this.err('手上没东西')
          if (typeof bot.toss === 'function') bot.toss(held.type, null, 1)
          return this.ok('丢了一个 ' + held.name)
        }

        case 'stop': {
          for (const c of CONTROLS) { try { bot.setControlState(c, false) } catch (e) {} }
          try { if (typeof bot.deactivateItem === 'function') bot.deactivateItem() } catch (e) {}
          try { if (typeof bot.stopDigging === 'function') bot.stopDigging() } catch (e) {}
          return this.ok('已松手（清掉所有持续动作）')
        }

        default:
          return this.err('不认识的动作：' + act)
      }
    } catch (e: any) {
      return this.err('执行失败：' + (e && e.message ? e.message : String(e)))
    }
  }
}
