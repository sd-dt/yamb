// rp-fix.js —— 部署补丁（材质包时序 + 内存保护）
//
// 【补丁1】材质包时序
//   问题：MC 服务器会强制推送材质包 (forced=true)。
//         mineflayer 默认在同一瞬间发出 "接受(3)" 和 "加载完成(0)"，
//         服务器认为不合常理，于是永远卡在 configuration 阶段。
//   修复：屏蔽库的自动回应，改按真人节奏手动发送：
//         接受(3) -> 2 秒 -> 下载完成(4) -> 2 秒 -> 加载完成(0)
//
// 【补丁2】视距限制
//   mineflayer 默认 viewDistance='far'，会加载大量区块，在 2G 内存机器上是
//   OOM 主因。此处若调用方未显式指定，则强制 'tiny'。
//
// 用法：NODE_OPTIONS=--require=/opt/qqbot/yamb/rp-fix.js
//   ⚠ 本文件必须放在 /opt/qqbot/yamb/ 根目录。
//     因为 require('mineflayer') 按“文件自身所在目录”解析；若放在别处，
//     补丁会打到另一个 node_modules/mineflayer 实例上而静默失效。

const mineflayer = require('mineflayer')
const origCreateBot = mineflayer.createBot

mineflayer.createBot = function (options) {
  const opts = Object.assign({}, options)
  if (!opts.viewDistance) {
    opts.viewDistance = 'tiny'
    console.log('[rp-fix] 未指定视距，强制 viewDistance=tiny（省内存）')
  }

  const bot = origCreateBot.call(mineflayer, opts)
  const origWrite = bot._client.write.bind(bot._client)

  // 屏蔽库的自动材质包回应
  bot._client.write = function (name, params) {
    if (String(name).indexOf('resource_pack_receive') >= 0) return
    return origWrite(name, params)
  }

  // 手动按真人节奏回应
  bot._client.on('add_resource_pack', (p) => {
    console.log('[rp-fix] 收到服务器材质包 (forced=' + p.forced + ')，按真人节奏回应')
    const u = p.uuid
    const send = (result) => {
      try {
        origWrite('resource_pack_receive', { uuid: u, result: result })
      } catch (e) {
        console.log('[rp-fix] 回应失败: ' + e.message)
      }
    }
    send(3)
    setTimeout(() => send(4), 2000)
    setTimeout(() => send(0), 4000)
  })

  return bot
}

console.log('[rp-fix] 部署补丁已加载（材质包时序 + 视距 tiny）')
