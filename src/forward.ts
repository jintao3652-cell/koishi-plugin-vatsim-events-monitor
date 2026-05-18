import { Context, Logger, Session, h } from 'koishi'
import type { Config } from './config'

const logger = new Logger('vatsim-events:forward')

export interface OneBotNode {
  type: 'node'
  data: { name: string; uin: string | number; content: any }
}

export function buildNodes(items: any[], botName: string, botUin: string | number): OneBotNode[] {
  return items.map(content => ({
    type: 'node',
    data: { name: botName, uin: botUin, content },
  }))
}

/**
 * Satori h.* 元素 → OneBot 原生消息段数组（CQ 协议结构）。
 * 仅覆盖 text / image，足够本插件输出。
 */
function elementsToOnebotSegments(content: any): any[] {
  const arr: any[] = []
  const stack: any[] = Array.isArray(content) ? [...content] : [content]
  while (stack.length) {
    const node = stack.shift()
    if (node == null) continue
    if (typeof node === 'string') {
      if (node) arr.push({ type: 'text', data: { text: node } })
      continue
    }
    if (Array.isArray(node)) { stack.unshift(...node); continue }
    // h() 元素
    const type = node.type
    const attrs = node.attrs || {}
    const children = node.children || []
    if (type === 'text') {
      if (attrs.content) arr.push({ type: 'text', data: { text: attrs.content } })
      stack.push(...children)
    } else if (type === 'image' || type === 'img') {
      const url = attrs.src || attrs.url
      if (url) arr.push({ type: 'image', data: { file: url, url } })
    } else if (type === 'at') {
      arr.push({ type: 'at', data: { qq: attrs.id ?? attrs.type ?? 'all' } })
    } else if (type === 'message' || type === 'root' || !type) {
      stack.unshift(...children)
    } else {
      // 兜底：拼成文本
      stack.push(...children)
    }
  }
  // 合并相邻 text
  const merged: any[] = []
  for (const seg of arr) {
    if (seg.type === 'text' && merged.length && merged[merged.length - 1].type === 'text') {
      merged[merged.length - 1].data.text += seg.data.text
    } else merged.push(seg)
  }
  return merged
}

/**
 * 通过 OneBot HTTP API 直接发送合并转发，绕过 adapter-onebot。
 */
export async function sendForwardViaHttp(
  ctx: Context, config: Config,
  groupId: string, nodes: OneBotNode[], userId?: string,
): Promise<boolean> {
  const base = config.onebotHttpUrl?.replace(/\/$/, '')
  if (!base) return false
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.onebotAccessToken) headers['Authorization'] = `Bearer ${config.onebotAccessToken}`

  // 把每个 node 的 content 转成 OneBot 消息段
  const messages = nodes.map(n => ({
    type: 'node',
    data: {
      name: n.data.name,
      uin: typeof n.data.uin === 'string' ? Number(n.data.uin) || n.data.uin : n.data.uin,
      content: elementsToOnebotSegments(n.data.content),
    },
  }))

  const url = groupId
    ? `${base}/send_group_forward_msg`
    : `${base}/send_private_forward_msg`
  const body: any = groupId
    ? { group_id: Number(groupId) || groupId, messages }
    : { user_id: Number(userId) || userId, messages }

  try {
    const resp: any = await ctx.http.post(url, body, { headers, timeout: 30000 })
    if (resp?.status === 'ok' || resp?.retcode === 0) return true
    logger.warn(`forward http retcode=${resp?.retcode} msg=${resp?.message || resp?.wording || ''}`)
    return false
  } catch (e: any) {
    logger.warn(`forward http failed: ${e?.message || e}`)
    return false
  }
}

/**
 * OneBot 合并转发：优先使用直连 HTTP（若配置），否则走适配器。
 */
export async function sendForward(
  session: Session, nodes: OneBotNode[],
  ctx?: Context, config?: Config,
  batchSize = 80,
): Promise<boolean> {
  if (session.platform !== 'onebot') {
    logger.warn(`sendForward called on non-onebot platform: ${session.platform}`)
    return false
  }

  const batches: OneBotNode[][] = []
  for (let i = 0; i < nodes.length; i += batchSize) {
    batches.push(nodes.slice(i, i + batchSize))
  }

  // 路径 A：直连 HTTP
  if (ctx && config?.onebotHttpUrl) {
    for (const batch of batches) {
      const ok = await sendForwardViaHttp(
        ctx, config,
        session.guildId || '', batch, session.userId,
      )
      if (!ok) return false
    }
    return true
  }

  // 路径 B：通过适配器
  const bot: any = session.bot
  if (!bot?.internal) {
    logger.warn('onebot bot.internal not available')
    return false
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
