import { Logger, Session, h } from 'koishi'

const logger = new Logger('vatsim-events:forward')

export interface OneBotNode {
  type: 'node'
  data: { name: string; uin: string; content: any }
}

/** satori h() 元素 → OneBot 11 消息段数组 */
function toOnebotSegments(content: any): any[] {
  const out: any[] = []
  const visit = (node: any) => {
    if (node == null) return
    if (typeof node === 'string') {
      if (node) out.push({ type: 'text', data: { text: node } })
      return
    }
    if (Array.isArray(node)) { node.forEach(visit); return }
    const type = node.type
    const attrs = node.attrs || {}
    const children = node.children || []
    if (type === 'text') {
      if (attrs.content) out.push({ type: 'text', data: { text: attrs.content } })
      children.forEach(visit)
    } else if (type === 'image' || type === 'img') {
      const url = attrs.src || attrs.url
      if (url) out.push({ type: 'image', data: { file: url, url } })
    } else if (type === 'at') {
      out.push({ type: 'at', data: { qq: attrs.id ?? attrs.type ?? 'all' } })
    } else if (type === 'face') {
      out.push({ type: 'face', data: { id: attrs.id } })
    } else if (type === 'message' || !type) {
      children.forEach(visit)
    } else {
      // 其它未知节点：尝试递归子元素
      children.forEach(visit)
    }
  }
  visit(content)
  // 合并相邻 text
  const merged: any[] = []
  for (const seg of out) {
    if (seg.type === 'text' && merged.length && merged[merged.length - 1].type === 'text') {
      merged[merged.length - 1].data.text += seg.data.text
    } else merged.push(seg)
  }
  return merged
}

export function buildNodes(items: any[], botName: string, botUin: string): OneBotNode[] {
  return items.map(content => ({
    type: 'node',
    data: { name: botName, uin: botUin, content: toOnebotSegments(content) },
  }))
}

/**
 * 通过 adapter-onebot 的 bot.internal 调用 OneBot 11 标准 API
 *   send_group_forward_msg / send_private_forward_msg
 * 节点 content 已转为 OneBot 段数组。兼容 ws / ws-reverse / http。
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

  // 转换：每个节点的 content（可能是 h() 元素）→ OneBot 段数组
  const normalized = nodes.map(n => ({
    type: 'node' as const,
    data: {
      name: n.data.name,
      uin: n.data.uin,
      content: Array.isArray(n.data.content) && n.data.content[0]?.type && n.data.content[0]?.data
        ? n.data.content // 已经是 OneBot 段
        : toOnebotSegments(n.data.content),
    },
  }))

  const batches: typeof normalized[] = []
  for (let i = 0; i < normalized.length; i += batchSize) {
    batches.push(normalized.slice(i, i + batchSize))
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
    return false
  }
}

