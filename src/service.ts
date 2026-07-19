import { Context, Logger, h } from 'koishi'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import type { Config } from './config'
import { EventApi } from './api'
import { Translator } from './translator'
import type { NormalizedEvent, NotifyType, VatsimEvent, VatsimNotifyChannel, VatsimSubscription } from './types'

dayjs.extend(utc)
dayjs.extend(timezone)

const logger = new Logger('vatsim-events')

export class EventService {
  api: EventApi
  translator: Translator
  private polling = false

  constructor(private ctx: Context, private config: Config) {
    this.api = new EventApi(ctx, config)
    this.translator = new Translator(ctx, config)
  }

  async renderCard(ev: VatsimEvent, translate = false) {
    const banner = ev.banner ? h.image(ev.banner) : ''
    const desc = stripHtml(ev.description || ev.shortDescription || '')
    const descOut = translate && desc ? await this.translator.translate(desc) : desc
    const durMin = Math.round((+ev.endTime - +ev.startTime) / 60000)
    const durStr = durMin >= 60 ? `${Math.floor(durMin / 60)} 小时${durMin % 60 ? ` ${durMin % 60} 分` : ''}` : `${durMin} 分钟`
    const organisers = asArray(ev.organisers)
    const routes = asArray(ev.routes)
    const airports = asArray(ev.airports)
    const orgList = organisers.map(o =>
      [o?.region, o?.division, o?.subdivision].filter(Boolean).join(' → ')
    ).filter(Boolean)
    const routesText = routes.map((r: any) =>
      `  ${r?.departure || '?'} → ${r?.arrival || '?'}: ${r?.route || '(无路由)'}`
    ).join('\n')

    return h('message', {},
      banner,
      `Event ID: ${ev.remoteId}\n`,
      `类型: ${ev.eventType || 'Event'}\n`,
      `活动名称: ${ev.name}\n`,
      ev.link ? `链接: ${ev.link}\n` : '',
      orgList.length ? `来源: ${orgList.join('；')}\n` : '',
      `\n🕐 开始: ${this.fmtUtc(ev.startTime)} / ${this.fmtFull(ev.startTime)}\n`,
      `🕐 结束: ${this.fmtUtc(ev.endTime)} / ${this.fmtFull(ev.endTime)}\n`,
      `⏱️ 持续: ${durStr}\n`,
      ev.airports.length ? `\n✈️ 机场: ${airports.join(', ')}\n` : '',
      routesText ? `\n📍 航路:\n${routesText}\n` : '',
      descOut ? `\n📝 简介${translate ? '（已翻译）' : ''}:\n${descOut}` : '',
    )
  }

  fmtUtc(d: Date) {
    return dayjs(d).utc().format('YYYY-MM-DD HH:mm') + ' UTC'
  }

  fmt(d: Date) {
    return dayjs(d).tz(this.config.timezone).format('MM-DD HH:mm')
  }

  fmtFull(d: Date) {
    return dayjs(d).tz(this.config.timezone).format('YYYY-MM-DD HH:mm (Z)')
  }

  async poll() {
    if (this.polling) return
    this.polling = true
    const t0 = Date.now()
    try {
      const remote = await this.api.fetchAll()
      this.vlog(`poll: fetched ${remote.length} remote events`)

      const newEvents: VatsimEvent[] = []
      for (const ev of remote) {
        const result = await this.upsert(ev)
        if (result.isNew) newEvents.push(result.row)
      }
      this.vlog(`poll: ${newEvents.length} new`)

      for (const ev of newEvents) {
        await this.broadcastNew(ev)
      }

      await this.checkReminders()
      await this.checkStartAndEnd()
      await this.cleanup()
      this.vlog(`poll: done in ${Date.now() - t0}ms`)
    } catch (e: any) {
      logger.warn(`poll error: ${e?.message || e}`)
    } finally {
      this.polling = false
    }
  }

  private vlog(msg: string) {
    if (this.config.verboseLog) logger.info(msg)
    else logger.debug(msg)
  }

  private async upsert(ev: NormalizedEvent): Promise<{ isNew: boolean; row: VatsimEvent }> {
    const now = new Date()
    const existing = await this.ctx.database.get('vatsim_event', {
      source: ev.source,
      remoteId: ev.remoteId,
    })
    if (!existing.length) {
      const status = ev.endTime < now ? 'ended' : ev.startTime <= now ? 'ongoing' : 'pending'
      const created = await this.ctx.database.create('vatsim_event', {
        ...ev,
        status,
        createdAt: now,
        updatedAt: now,
      })
      return { isNew: status !== 'ended', row: created }
    }
    const row = existing[0]
    const changed =
      row.name !== ev.name ||
      +row.startTime !== +ev.startTime ||
      +row.endTime !== +ev.endTime ||
      row.link !== ev.link
    if (changed) {
      await this.ctx.database.set('vatsim_event', row.id, {
        eventType: ev.eventType,
        name: ev.name,
        link: ev.link,
        description: ev.description,
        shortDescription: ev.shortDescription,
        banner: ev.banner,
        startTime: ev.startTime,
        endTime: ev.endTime,
        airports: ev.airports,
        routes: ev.routes,
        organisers: ev.organisers,
        updatedAt: now,
      })
    }
    return { isNew: false, row }
  }

  private async checkReminders() {
    const now = Date.now()
    const intervalMs = this.config.pollInterval * 60_000
    const pending = await this.ctx.database.get('vatsim_event', { status: 'pending' })

    for (const ev of pending) {
      const channels = await this.ctx.database.get('vatsim_notify_channel', { enableStart: true })
      for (const ch of channels) {
        const minutes = (ch.remindMinutes?.length ? ch.remindMinutes : this.config.defaultRemindMinutes).map(Number)
        for (const m of minutes) {
          const triggerAt = +ev.startTime - m * 60_000
          if (now >= triggerAt && now < triggerAt + intervalMs) {
            const ats = await this.buildSubAts(ch.platform, ch.selfId, ch.channelId, ch.guildId)
            const msg = this.renderRemind(ev, m, ch, ats)
            await this.sendIfNotLogged(ev, ch, `remind-${m}` as NotifyType, msg)
          }
        }
      }
    }
  }

  private async checkStartAndEnd() {
    const now = new Date()
    const toStart = await this.ctx.database.get('vatsim_event', {
      status: 'pending',
      startTime: { $lte: now },
    })
    for (const ev of toStart) {
      await this.ctx.database.set('vatsim_event', ev.id, { status: 'ongoing', updatedAt: now })
      if (this.config.notifyStart) {
        const channels = await this.ctx.database.get('vatsim_notify_channel', { enableStart: true })
        for (const ch of channels) {
          const ats = await this.buildSubAts(ch.platform, ch.selfId, ch.channelId, ch.guildId)
          await this.sendIfNotLogged(ev, ch, 'start', this.renderStart(ev, ch, ats))
        }
      }
    }

    const toEnd = await this.ctx.database.get('vatsim_event', {
      status: { $in: ['pending', 'ongoing'] as any },
      endTime: { $lte: now },
    })
    for (const ev of toEnd) {
      await this.ctx.database.set('vatsim_event', ev.id, { status: 'ended', updatedAt: now })
      if (this.config.notifyEnd) {
        const channels = await this.ctx.database.get('vatsim_notify_channel', { enableEnd: true })
        for (const ch of channels) {
          await this.sendIfNotLogged(ev, ch, 'end', this.renderEnd(ev))
        }
      }
    }
  }

  /**
   * 构造某个频道内"仍在群里"的订阅者 @ 列表。
   * 只查询 channelId/guildId 对应该群的订阅，并通过 OneBot get_group_member_info 验证用户仍是成员。
   */
  private async buildSubAts(platform: string, selfId: string, channelId: string, guildId: string): Promise<any[]> {
    if (platform !== 'onebot') return []
    const subs = await this.ctx.database.get('vatsim_subscription', {
      platform,
      channelId,
      atMe: true,
    })
    if (!subs.length) return []
    const bot: any = this.ctx.bots.find(b => b.platform === platform && b.selfId === selfId)
      ?? this.ctx.bots.find(b => b.platform === platform)
    if (!bot) return []

    const groupId = guildId || channelId
    const result: any[] = []
    for (const s of subs) {
      try {
        const info = await this.callOneBot(bot, 'get_group_member_info', { group_id: Number(groupId) || groupId, user_id: Number(s.userId) || s.userId, no_cache: false })
        if (info) result.push(h.at(s.userId))
      } catch (e: any) {
        this.vlog(`skip @${s.userId} in ${channelId}: not in group (${e?.message || e})`)
      }
    }
    return result
  }

  private async callOneBot(bot: any, action: string, params: any): Promise<any> {
    const method = action.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    const candidates = [
      bot?.[`$${action}`], bot?.[action], bot?.[method],
      bot?.internal?.[`$${action}`], bot?.internal?.[action], bot?.internal?.[method],
    ].filter(fn => typeof fn === 'function')
    let lastErr: any
    for (const fn of candidates) {
      try { return await fn.call(bot.internal ?? bot, params) } catch (e) { lastErr = e }
    }
    if (lastErr) throw lastErr
    throw new Error(`OneBot action not available: ${action}`)
  }

  private async broadcastNew(ev: VatsimEvent) {
    const channels = await this.ctx.database.get('vatsim_notify_channel', { enableNew: true })
    for (const ch of channels) {
      const ats = await this.buildSubAts(ch.platform, ch.selfId, ch.channelId, ch.guildId)
      const msg = this.renderNew(ev, ats)
      await this.sendIfNotLogged(ev, ch, 'new', msg)
    }
  }

  private renderNew(ev: VatsimEvent, ats: any[] = []) {
    const banner = ev.banner ? h.image(ev.banner) : ''
    const desc = stripHtml(ev.shortDescription || ev.description || '').slice(0, 200)
    const orgList = asArray(ev.organisers).map((o: any) =>
      [o?.region, o?.division, o?.subdivision].filter(Boolean).join('→')
    ).filter(Boolean)
    return h('message', {},
      ...ats, ats.length ? ' ' : '',
      `📢 有新的活动发布啦！\n`,
      banner,
      `🆕 [${ev.source.toUpperCase()}] ${ev.name}\n`,
      `🕐 ${this.fmt(ev.startTime)} - ${this.fmt(ev.endTime)}\n`,
      ev.airports.length ? `✈️ 机场: ${ev.airports.join(', ')}\n` : '',
      orgList.length ? `🏷️ 主办: ${orgList.join('；')}\n` : '',
      ev.link ? `🔗 ${ev.link}\n` : '',
      desc ? `\n📝 ${desc}${desc.length >= 200 ? '…' : ''}` : '',
    )
  }

  private renderRemind(ev: VatsimEvent, minutes: number, ch: VatsimNotifyChannel, ats: any[] = []) {
    const at = ch.atAll ? h('at', { type: 'all' }) : ''
    return h('message', {},
      at, at ? ' ' : '',
      ...ats, ats.length ? ' ' : '',
      `⏰ ${minutes} 分钟后开始：${ev.name}\n`,
      `🕐 ${this.fmt(ev.startTime)}\n`,
      ev.airports.length ? `✈️ ${ev.airports.join(', ')}\n` : '',
      ev.link ? `🔗 ${ev.link}` : '',
    )
  }

  private renderStart(ev: VatsimEvent, ch: VatsimNotifyChannel, ats: any[] = []) {
    const at = ch.atAll ? h('at', { type: 'all' }) : ''
    return h('message', {},
      at, at ? ' ' : '',
      ...ats, ats.length ? ' ' : '',
      `🚀 活动开始：${ev.name}\n`,
      `🕐 至 ${this.fmt(ev.endTime)}\n`,
      ev.airports.length ? `✈️ ${ev.airports.join(', ')}\n` : '',
      ev.link ? `🔗 ${ev.link}` : '',
    )
  }

  renderEventBrief(ev: VatsimEvent) {
    return h('message', {},
      ev.banner ? h.image(ev.banner) : '',
      `[${ev.source.toUpperCase()}] ${ev.name}\n`,
      `🕐 ${this.fmt(ev.startTime)} - ${this.fmt(ev.endTime)}\n`,
      ev.airports.length ? `✈️ ${ev.airports.join(', ')}\n` : '',
      ev.link ? `🔗 ${ev.link}` : '',
    )
  }

  private renderEnd(ev: VatsimEvent) {
    return h('message', {},
      `🏁 ${ev.name} 活动结束啦！\n`,
      `🕐 ${this.fmt(ev.startTime)} - ${this.fmt(ev.endTime)}\n`,
      ev.airports.length ? `✈️ 机场: ${ev.airports.join(', ')}\n` : '',
      ev.link ? `🔗 ${ev.link}` : '',
    )
  }

  private async sendIfNotLogged(ev: VatsimEvent, ch: VatsimNotifyChannel, type: NotifyType, content: any) {
    if (ch.platform !== 'onebot') {
      this.vlog(`skip ${type} ${ch.platform}:${ch.channelId}: non-onebot platform`)
      return
    }
    if (!this.isChannelAllowed(ch.channelId, ch.guildId)) {
      this.vlog(`skip ${type} ${ch.channelId}: not in whitelist`)
      return
    }
    const existed = await this.ctx.database.get('vatsim_notify_log', {
      eventId: ev.id, channelId: ch.channelId, type,
    })
    if (existed.length) return
    await this.sendTo(ch.platform, ch.selfId, ch.channelId, ch.guildId, content, ev.id, type)
  }

  isChannelAllowed(channelId: string, guildId?: string): boolean {
    if (this.config.channelMode === 'all') return true
    const list = this.config.allowedChannels || []
    if (!list.length) return false
    return list.includes(channelId) || (guildId ? list.includes(guildId) : false)
  }

  private async sendTo(
    platform: string, selfId: string,
    channelId: string, guildId: string,
    content: any, eventId: number, type: NotifyType,
  ) {
    try {
      const bot = this.ctx.bots.find(b => b.platform === platform && b.selfId === selfId)
        ?? this.ctx.bots.find(b => b.platform === platform)
      if (!bot) {
        logger.warn(`no bot available for ${platform}:${selfId}`)
        return
      }
      await bot.sendMessage(channelId, content, guildId || undefined)
      await this.ctx.database.create('vatsim_notify_log', {
        eventId, channelId, type, sentAt: new Date(),
      })
    } catch (e: any) {
      logger.warn(`send to ${platform}:${channelId} failed: ${e?.message || e}`)
    }
  }

  async listRecentWithinDays(days: number): Promise<VatsimEvent[]> {
    const now = new Date()
    const future = new Date(Date.now() + days * 86400_000)
    const all = await this.ctx.database.get('vatsim_event', {
      endTime: { $gte: now },
      startTime: { $lte: future },
    })
    all.sort((a, b) => +a.startTime - +b.startTime)
    return all
  }

  async listAllUpcoming(source?: 'vatsim' | 'vatprc'): Promise<VatsimEvent[]> {
    const now = new Date()
    const query: any = { endTime: { $gte: now } }
    if (source) query.source = source
    const all = await this.ctx.database.get('vatsim_event', query)
    all.sort((a, b) => +a.startTime - +b.startTime)
    return all
  }

  private async cleanup() {
    const threshold = new Date(Date.now() - this.config.cleanupDays * 86400_000)
    const old = await this.ctx.database.get('vatsim_event', {
      status: 'ended',
      endTime: { $lt: threshold },
    }, ['id'])
    if (!old.length) return
    const ids = old.map(o => o.id)
    await this.ctx.database.remove('vatsim_notify_log', { eventId: { $in: ids } })
    await this.ctx.database.remove('vatsim_event', { id: { $in: ids } })
  }
}

function stripHtml(s: string) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim()
}

function asArray(v: any): any[] {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v)
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }
  return []
}
