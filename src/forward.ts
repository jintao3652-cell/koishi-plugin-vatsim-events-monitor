import { Context, Logger, Session, segment, Fragment } from 'koishi'
import { getBannerDownloader } from './banner'

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
  const out: OneBotSegment[] = []
  // 递归展开：renderCard 等返回的 h('message', ...) 是容器元素，
  // segment.normalize 不会拆掉它，若不展开会导致转发节点内容为空（只剩兜底空格）
  const walk = (items: any[]) => {
    for (const item of items) {
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
      } else if (Array.isArray((item as any).children) && (item as any).children.length) {
        walk(segment.normalize((item as any).children) as any[])
      }
    }
  }
  walk(segment.normalize(message) as any[])
  if (out.length) return out
  return [{ type: 'text', data: { text: ' ' } }]
}

/** ms 内没完成就返回 null（不取消底层任务，让它继续跑进缓存）。 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(null)
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>(resolve => setTimeout(() => resolve(null), ms)),
  ])
}

function toCamelCase(s: string) { return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) }

const ACTION_RETRY_DELAY = 800

/**
 * 预下载 fragment 里所有远程 URL 图片并转成 data URL（base64）。
 * 协议端对转发节点里的外链图片支持不稳（需要自行拉取再走 highway 上传），
 * 提前在插件侧下载转 base64 可避开该环节；下载失败时保留原 URL。
 *
 * 下载统一走 BannerDownloader：长超时 + 重试 + 并发节流 + 磁盘缓存 + 压缩，
 * 换成 data URL 后单次消息体积也从数 MB 降到几十 KB。
 */
export async function precacheRemoteImages(ctx: Context, fragment: Fragment, depth = 0): Promise<Fragment> {
  if (depth > 4) return fragment
  const downloader = getBannerDownloader(ctx)
  const items = segment.normalize(fragment) as any[]
  // 整条消息的下载总预算：个别慢图不能拖住发送。超时后先按原 URL 发出，
  // 对应的下载 Promise 仍在 inflight 里继续跑，完成后写入缓存，下次即命中。
  const deadline = downloader
    ? Date.now() + downloader.settings.batchTimeout
    : Number.POSITIVE_INFINITY
  const out: any[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') { out.push(item); continue }
    const type = String(item.type || '')
    if (type === 'img' || type === 'image') {
      const src = String(item.attrs?.src ?? item.attrs?.url ?? '')
      if (downloader && /^https?:\/\//i.test(src)) {
        const remain = deadline - Date.now()
        if (remain <= 0) logger.debug(`横幅下载总预算耗尽，按原 URL 发送: ${src}`)
        else {
          try {
            const entry = await withDeadline(downloader.fetch(src), remain)
            if (entry) {
              out.push(segment.image(downloader.toDataUrl(entry)))
              continue
            }
          } catch (e: any) {
            logger.debug(`预下载图片异常，保留原 URL: ${src} ${e?.message || e}`)
          }
        }
      }
      out.push(item)
      continue
    }
    if (Array.isArray(item.children) && item.children.length) {
      const children = await Promise.all(
        item.children.map((c: any) => precacheRemoteImages(ctx, c, depth + 1)),
      )
      out.push(segment(type, item.attrs ?? {}, ...children))
      continue
    }
    out.push(item)
  }
  if (!out.length) return ''
  if (out.length === 1) return out[0]
  return out
}

// adapter-onebot 的 internal 暴露了通用入口 `_get(action, params)`，可以调用协议端实现的
// 任意接口，因此 NapCat 与 LLOneBot 共用同一套 OneBot 11 / Go-CQHTTP 的 action 与参数。
// 仅在通用入口不可用时才退回方法名探测（旧版适配器 / 驼峰方法实现）。
// adapter-onebot 6.x 在 WS 重连瞬间存在空窗：socket close 时 delete 了
// `internal._request`，重连 accept 重新赋值前所有 action 都会抛
// `TypeError: this._request is not a function`。这里对这类瞬时错误做 1~2 次重试。
async function callOneBotApi(bot: any, action: string, params: Record<string, any>) {
  const internal: any = bot?.internal
  const isTransient = (e: any) => {
    const msg = String(e?.message || e || '')
    return /this\._request is not a function|this\._get is not a function/i.test(msg)
  }
  let lastErr: any
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (typeof internal?._get === 'function') return await internal._get(action, params)
      if (typeof internal?._request === 'function') return await internal._request(action, params)
    } catch (e) {
      lastErr = e
      if (!isTransient(e) || attempt === 1) throw e
      await new Promise(r => setTimeout(r, ACTION_RETRY_DELAY))
      continue
    }
    break
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
      // SnowLuma 主发送路径：通用 send_msg + message_type（其能力档案不含部分专用动作）
      ['send_msg', { message_type: 'group', group_id: groupId, message: messages }],
      ['send_forward_msg', { message_type: 'group', group_id: groupId, message: messages }],
      ['send_forward_msg', { message_type: 'group', group_id: groupId, messages }],
    ]
    : userId
      ? [
        ['send_private_forward_msg', { user_id: userId, messages }],
        ['send_msg', { message_type: 'private', user_id: userId, message: messages }],
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
  const appCtx: Context | undefined = (session as any).app ?? (bot as any)?.ctx
  // SnowLuma 适配：先把外链图片下载转 base64，避免协议端拉取远程媒体失败
  if (appCtx) {
    await Promise.all(items.map(async (it, i) => {
      try { items[i].message = await precacheRemoteImages(appCtx, it.message) } catch { /* 保留原样 */ }
    }))
  }
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
