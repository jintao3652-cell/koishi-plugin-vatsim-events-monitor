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

// adapter-onebot 的 internal 暴露了通用入口 `_get(action, params)`，可以调用协议端实现的
// 任意接口，因此 NapCat 与 LLOneBot 共用同一套 OneBot 11 / Go-CQHTTP 的 action 与参数。
// 仅在通用入口不可用时才退回方法名探测（旧版适配器 / 驼峰方法实现）。
async function callOneBotApi(bot: any, action: string, params: Record<string, any>) {
  const internal: any = bot?.internal
  if (typeof internal?._get === 'function') return await internal._get(action, params)
  if (typeof internal?._request === 'function') {
    const response = await internal._request(action, params)
    if (response && typeof response === 'object' && 'retcode' in response) {
      if (response.retcode === 0) return response.data
      throw new Error(`OneBot ${action} failed: retcode=${response.retcode} ${response.message || response.wording || ''}`.trim())
    }
    return response
  }

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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 调用超时（${ms}ms）`)), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

const FORWARD_ATTEMPT_TIMEOUT = 10000

// 合并转发的尝试顺序：
// 1. Go-CQHTTP 兼容的 `send_group_forward_msg` / `send_private_forward_msg`（NapCat 与 LLOneBot 都支持）；
// 2. NapCat 统一的 `send_forward_msg`（参数 `message`）；
// 3. NapCat 统一的 `send_forward_msg`（参数 `messages`）。
// 每次尝试都带超时，避免协议端不响应未知 action 时一直等待适配器的 responseTimeout（默认 1 分钟）。
async function callMergedForward(bot: any, session: Session, messages: OneBotForwardNode[]) {
  const groupId = session.isDirect ? null : extractOneBotTargetId(session.guildId || session.channelId)
  const userId = session.isDirect ? extractOneBotTargetId(session.userId || session.channelId) : null
  const attempts: Array<[string, Record<string, any>]> = groupId
    ? [
      ['send_group_forward_msg', { group_id: groupId, messages }],
      ['send_forward_msg', { message_type: 'group', group_id: groupId, message: messages }],
      ['send_forward_msg', { message_type: 'group', group_id: groupId, messages }],
    ]
    : userId
      ? [
        ['send_private_forward_msg', { user_id: userId, messages }],
        ['send_forward_msg', { message_type: 'private', user_id: userId, message: messages }],
        ['send_forward_msg', { message_type: 'private', user_id: userId, messages }],
      ]
      : []
  let lastErr: any
  for (const [action, params] of attempts) {
    try {
      return await withTimeout(callOneBotApi(bot, action, params), FORWARD_ATTEMPT_TIMEOUT, action)
    } catch (e) {
      lastErr = e
    }
  }
  if (lastErr) throw lastErr
  throw new Error('OneBot forward action not available')
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
          await callMergedForward(bot, session, messages)
          return true
        }
      } else {
        const groupId = extractOneBotTargetId(session.guildId || session.channelId)
        if (groupId) {
          await callMergedForward(bot, session, messages)
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
