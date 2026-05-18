import { Context, Logger, Session, segment, Fragment } from 'koishi'

const logger = new Logger('vatsim-events:forward')

type OneBotSegment = { type: string; data: Record<string, any> }

type OneBotForwardNode = {
  type: 'node'
  data: {
    user_id: string
    nickname: string
    content: OneBotSegment[]
  }
}

function extractOneBotTargetId(value?: string): string | null {
  if (!value) return null
  const text = String(value).trim()
  if (!text) return null
  const matches = text.match(/\d+/g)
  if (!matches?.length) return null
  return matches[matches.length - 1]
}

function toOneBotImageFile(src: string): string {
  const base64Token = ';base64,'
  const i = src.indexOf(base64Token)
  if (i > -1) return `base64://${src.slice(i + base64Token.length)}`
  return src
}

function toOneBotSegments(message: Fragment): OneBotSegment[] {
  const segments = segment.normalize(message) as any[]
  const out: OneBotSegment[] = []
  for (const item of segments) {
    if (!item || typeof item !== 'object') continue
    const type = String(item.type || '')
    if (type === 'text') {
      const text = String(item.attrs?.content ?? '')
      if (text) out.push({ type: 'text', data: { text } })
    } else if (type === 'img' || type === 'image') {
      const src = String(item.attrs?.src ?? item.attrs?.url ?? '')
      if (src) out.push({ type: 'image', data: { file: toOneBotImageFile(src) } })
    } else if (type === 'br') {
      out.push({ type: 'text', data: { text: '\n' } })
    } else if (type === 'at') {
      const id = item.attrs?.id ?? item.attrs?.type ?? 'all'
      out.push({ type: 'at', data: { qq: String(id) } })
    }
  }
  if (out.length) return out
  return [{ type: 'text', data: { text: ' ' } }]
}

function toCamelCase(s: string) { return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) }

async function callOneBotApi(bot: any, action: string, params: Record<string, any>) {
  const method = toCamelCase(action)
  const candidates: Array<{ target: any; fn: Function }> = []
  const push = (target: any, key: string) => {
    const fn = target?.[key]
    if (typeof fn === 'function') candidates.push({ target, fn })
  }
  push(bot, `$${action}`)
  push(bot, action)
  push(bot, method)
  push(bot?.internal, `$${action}`)
  push(bot?.internal, action)
  push(bot?.internal, method)

  let lastErr: any
  for (const c of candidates) {
    try { return await c.fn.call(c.target, params) } catch (e) { lastErr = e }
  }
  if (lastErr) throw lastErr
  throw new Error(`OneBot action not available: ${action}`)
}

export interface ForwardItem {
  message: Fragment
  name?: string
  uin?: string
}

/**
 * 仅在 onebot 平台调用 send_group/private_forward_msg。
 * 失败时回退到 segment('message',{forward:true},...) 包装；再失败则逐条发送。
 */
export async function sendForwardItems(
  session: Session | undefined,
  items: ForwardItem[],
  options: { mergedOnly?: boolean } = {},
): Promise<boolean> {
  if (!session || !items.length) return false
  const bot: any = session.bot
  if ((session.platform === 'onebot' || bot?.platform === 'onebot') && bot) {
    try {
      const fallbackUid = extractOneBotTargetId(session.userId || (bot as any)?.selfId) || '10000'
      const fallbackName = String(session.username || session.author?.name || 'Koishi')
      const messages: OneBotForwardNode[] = items.map(it => ({
        type: 'node',
        data: {
          user_id: it.uin && extractOneBotTargetId(it.uin) || fallbackUid,
          nickname: it.name || fallbackName,
          content: toOneBotSegments(it.message),
        },
      }))

      if (session.isDirect) {
        const userId = extractOneBotTargetId(session.userId || session.channelId)
        if (userId) {
          await callOneBotApi(bot, 'send_private_forward_msg', { user_id: userId, messages, message: messages })
          return true
        }
      } else {
        const groupId = extractOneBotTargetId(session.guildId || session.channelId)
        if (groupId) {
          await callOneBotApi(bot, 'send_group_forward_msg', { group_id: groupId, messages, message: messages })
          return true
        }
      }
    } catch (e: any) {
      logger.warn(`合并转发失败，尝试 forward 包装: ${e?.message || e}`)
    }
  }

  try {
    const forwardMessage = segment('message', { forward: true }, items.map(it => segment('message', {}, it.message)))
    await session.send(forwardMessage)
    return true
  } catch (e: any) {
    logger.warn(`forward 包装也失败: ${e?.message || e}`)
  }

  if (options.mergedOnly) return false

  for (const it of items) {
    await session.send(it.message)
  }
  return true
}
