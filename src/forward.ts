import { Bot, Logger, Session, h } from 'koishi'
import type { VatsimEvent } from './types'

const logger = new Logger('vatsim-events:forward')

interface OneBotNode {
  type: 'node'
  data: { name: string; uin: string; content: any }
}

export function buildNodes(events: VatsimEvent[], render: (ev: VatsimEvent) => any, botName: string, botUin: string): OneBotNode[] {
  return events.map(ev => ({
    type: 'node',
    data: { name: botName, uin: botUin, content: render(ev) },
  }))
}

export async function sendForward(session: Session, nodes: OneBotNode[]): Promise<boolean> {
  if (session.platform !== 'onebot') return false
  const bot: any = session.bot
  try {
    if (session.guildId) {
      await bot.internal.sendGroupForwardMsg(session.guildId, nodes)
    } else {
      await bot.internal.sendPrivateForwardMsg(session.userId, nodes)
    }
    return true
  } catch (e: any) {
    logger.warn(`forward send failed: ${e?.message || e}`)
    return false
  }
}
