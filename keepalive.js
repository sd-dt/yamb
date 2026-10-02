// keepalive.js —— 轻量保活补丁（防止长时间无操作被服务器判定挂机）
//
// 每 30~50 秒随机轻微转一下视角（±0.25 弧度）。
//   · 不发任何聊天/指令 → 聊天栏无任何输出
//   · 不产生位移     → 不会把自己走进岩浆/悬崖，也不触发反作弊的移动检测
//
// 用法：NODE_OPTIONS=--require=/opt/qqbot/yamb/keepalive.js
//   ⚠ 与 rp-fix.js 同理，必须放在 /opt/qqbot/yamb/ 根目录。

const mineflayer = require('mineflayer')
const origCreateBot = mineflayer.createBot

mineflayer.createBot = function (options) {
  const bot = origCreateBot.call(mineflayer, options)
  let alive = true

  bot.once('end', () => { alive = false })
  bot.once('kicked', () => { alive = false })

  function schedule () {
    const delay = 30000 + Math.floor(Math.random() * 20000) // 30~50 秒
    setTimeout(() => {
      if (!alive) return
      try {
        if (bot.entity) {
          const d = Math.random() < 0.5 ? 0.25 : -0.25
          bot.look(bot.entity.yaw + d, bot.entity.pitch, true)
        }
      } catch (e) { /* 忽略 */ }
      schedule()
    }, delay)
  }
  schedule()

  console.log('[keepalive] 保活补丁已加载（每 30~50 秒轻微转头）')
  return bot
}
