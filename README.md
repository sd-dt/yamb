# yamb

**Yet Another MChatBot** — 基于 [Mineflayer](https://github.com/PrismarineJS/mineflayer) 的 Minecraft 游戏内机器人。

支持私聊/公屏命令、传送与白名单、玩家交互（骑乘/攻击/上车）、容器登记与存取、背包管理、待命与 AFK、可选网页 Viewer，以及 AstrBot HTTP API 集成。

## 功能概览

- **命令渠道**：私聊无前缀；公屏需在 `config/game/command.yaml`（或 bot 覆盖）配置前缀
- **权限**：SQLite 白名单 + 各 bot 的 `adminList`
- **传送**：自动接受传送、传送点、锁定
- **交互**：骑乘玩家、上车、攻击、（WIP）亲亲
- **资源管理**：方块登记、存取/丢弃物品、查背包
- **待命**：自动回家、吃饭、闲置
- **多实例 / TUI**：同一进程多 bot；默认终端界面可切换实例、看状态、发公屏
- **AstrBot**（可选）：提供 QQ 机器人接口
- **Viewer**（可选）： `prismarine-viewer` 网页可视化
- **酿酒**：目前支持多桶陈化，酿造队列功能仍在制作中
- （WIP）**交易**：持续交易指定物品
- （WIP）**哈气模式**：哈似你！
- （计划）**远程存取、互动回应、模糊命令、日志高亮、分布式 bot 集群协议**



## 安装

```bash
yarn install
cp .env.example .env
# 编辑 .env 与 config/bots/*.yaml、config/game/*.yaml
yarn start
```

无 TUI（当服务跑）：

```bash
yarn start --headless
# 或 yarn start:headless
```

使用 npm：

```bash
npm install
npm start
npm start -- --headless
```

## 配置

全部为 YAML，注释写在文件内。

| 层级 | 目录 |
|------|------|
| 进程共享 | `.env` |
| 游戏默认 | `config/game/*.yaml` |
| bot 实例 | `config/bots/*.yaml` |
| 配方 | `config/recipes/` |

启用某个 bot：在对应 yaml 设 `enabled: true`。未写出的字段继承 `config/game/`。

### 发酵配方

在 `config/recipes/*.yaml` 中定义配方。

工具箱与产物箱必须为混合容器，原料与玻璃瓶容器必须为专用容器。

配方 id 默认为文件名。

### Viewer

启用 viewer 需安装原生模块：

```bash
yarn add canvas
```

在对应 bot 的 yaml（或 `config/game/viewer.yaml`）中设置 `enabled: true`，注意多 bot 时 port 不要冲突。

## 游戏内命令

私聊无需前缀；公屏需 `{prefix}`（见 `command.yaml` / bot 覆盖）。`allowPublicCommands` 为 `false` 时仅私聊可用。
启用 `command.silentMode: true` 后，除 `status` 和 `help` 外的命令回复
只写入日志，不再私聊玩家；操作命令本身仍会正常执行。

### 白名单

| 命令 | 说明 |
|------|------|
| `help` | 帮助 |
| `status` | 状态 |
| `phome <别名>` | 经传送点拉取玩家 |
| `mount [玩家]` / `cart` / `unmount` | 骑乘（默认为自己）/ 登上最近矿车 / 下来 |
| `attack` | 攻击（调试用） |
| `lock` / `lock hover` / `unlock` | 锁定 / 滞空锁定 / 解锁 |
| `store <容器> <物品> [数量]` | 存入已登记容器 |
| `take <容器> <物品> [数量]` | 从容器取出 |
| `drop <物品> [数量]` | 丢弃背包物品 |
| `brew start <配方>` | 开始、查看或请求取消酿酒任务 |
| `brew stop` | 强制停止当前酿酒任务并立即进入空闲状态 |
| `brew reload` | 重新读取酿酒配方（仅管理员） |
| `brew status` / `brew cancel` | 读取队列信息和队列取消的预留命令 |

白名单玩家对 bot 发送 `/tpa` 或 `/tpahere` 时 bot 会自动接受（无回复）。

### 管理员

| 命令 | 说明 |
|------|------|
| `inv` | 查看 bot 背包 |
| `node reg <别名> <x> <y> <z> [-m\|-mixed] [-g <区域>]` | 登记方块；容器默认绑定第一格物品，`-m` 登记为混合容器 |
| `node list [区域]` / `node info <别名>` | 查看方块节点 |
| `node remove <别名>` | 删除方块节点 |
| `add <游戏名>` / `remove <游戏名>` | 白名单管理 |
| `say <消息>` | 发送公屏消息 |
| `forward <消息>` | 发公屏并转发随后系统消息 |

## AstrBot 集成（可选）

1. 在对应 bot 的 yaml 设 `astrbot.enabled: true` 与独立 `port`；`API_KEY` 可写在 `.env` 或 bot 的 `astrbot.apiKey`
2. 将 `integrations/astrbot-plugin/` 安装到 AstrBot
3. 配置插件中的 API 地址与密钥

HTTP 路由见 `src/api/routes/`。



## 许可证

本项目采用 [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html)（GPL-3.0）。

基于 GPL 发布：你可以自由使用、修改和分发本软件；若分发修改后的版本，须以相同许可证公开源代码。
