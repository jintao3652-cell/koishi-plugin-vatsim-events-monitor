import { Logger, Session, h } from 'koishi'

const logger = new Logger('vatsim-events:forward')

export interface OneBotNode {
  type: 'node'
  data: { name: string; uin: string; content: any }
}

export function buildNodes(items: any[], botName: string, botUin: string): OneBotNode[] {
  return items.map(content => ({
    type: 'node',
    data: { name: botName, uin: botUin, content },
  }))
}

/**
 * 通过 adapter-onebot 的 bot.internal 调用 OneBot 11 标准 API:
 *   send_group_forward_msg / send_private_forward_msg
 *
 * adapter-onebot 自动支持 ws / ws-reverse / http，所有方法都通过 bot.internal 暴露。
 * 节点过多时分批发送（默认 80 一批）。
 */
export async function sendForward(session: Session, nodes: OneBotNode[], batchSize = 80): Promise<boolean> {
  if (session.platform !== 'onebot') {
    logger.warn(`sendForward called on non-onebot platform: ${session.platform}`)
    return false
  }
  const bot: any = session.bot
  if (!bot?.internal) {
    logger.warn('bot.internal 不可用，请检查 adapter-onebot 是否已连接')
    return false
  }
  if (bot.status && bot.status !== 1 && bot.status !== 'online') {
    // koishi: 1 = online；尽量兼容字符串状态
    logger.warn(`bot 未在线 (status=${bot.status})，请等待 adapter-onebot 连接完成后重试`)
  }

  const batches: OneBotNode[][] = []
  for (let i = 0; i < nodes.length; i += batchSize) {
    batches.push(nodes.slice(i, i + batchSize))
  }

  try {
    for (const batch of batches) {
      if (session.guildId) {
        await bot.internal.sendGroupForwardMsg(session.guildId, batch)
      } else {
        await bot.internal.sendPrivateForwardMsg(session.userId, batch)
      }
    }
    return true
  } catch (e: any) {
    logger.warn(`sendGroupForwardMsg 失败: ${e?.message || e}`)
    if (/this\._request is not a function/.test(String(e?.message))) {
      logger.warn('提示：该错误来自 adapter-onebot 内部，常见于 bot 尚未完全连接或 adapter 版本较老。请：')
      logger.warn('  1) 在 Koishi 控制台确认 adapter-onebot 状态为"运行中"且已连接')
      logger.warn('  2) 升级 adapter-onebot 到最新版本')
      logger.warn('  3) 重启 Koishi 进程（热重载有时无法重新初始化反向 ws 连接）')
    }
    return false
  }
}
