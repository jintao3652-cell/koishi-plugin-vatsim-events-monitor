import { Logger, Session } from 'koishi'

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
 * OneBot 合并转发。仅 onebot 平台可用。
 * 自动拆批（go-cqhttp/Lagrange/NapCat 通常对单次节点数有限制，保守 80 一批）。
 */
export async function sendForward(session: Session, nodes: OneBotNode[], batchSize = 80): Promise<boolean> {
  if (session.platform !== 'onebot') {
    logger.warn(`sendForward called on non-onebot platform: ${session.platform}`)
    return false
  }
  const bot: any = session.bot
  if (!bot?.internal) {
    logger.warn('onebot bot.internal not available')
    return false
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
    logger.warn(`forward send failed: ${e?.message || e}`)
    return false
  }
}

