import type { ServiceResult } from '../types'
import type MinecraftBot from '../platform/minecraft-bot'

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

  execute (act: string, p: ActionParams = {}): ServiceResult {
    if (!this.mcBot.isReady || !this.mcBot.bot) {
      return this.err('机器人未就绪')
    }
    const bot: any = this.mcBot.bot
    const a = String(act || '').toLowerCase().trim()
    const deg = Math.PI / 180

    try {
      switch (a) {
        case 'attack': {
          const e: any = typeof bot.nearestEntity === 'function' ? bot.nearestEntity() : null
          if (e && e.position) {
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
          bot.attack(e)
          return this.ok('左键：攻击了 ' + name)
        }

        case 'useentity': {
          const name = String(p.target || '').trim()
          if (!name) return this.err('缺目标名：useentity <玩家名>')
          const e: any = (bot.players && bot.players[name] && bot.players[name].entity) || null
          if (!e) return this.err('附近找不到玩家 ' + name)
          if (typeof bot.useOn === 'function') bot.useOn(e)
          return this.ok('右键：作用于 ' + name)
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
