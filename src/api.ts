import { Context, Logger } from 'koishi'
import type { Config } from './config'
import type { EventSource, NormalizedEvent, RemoteEvent } from './types'

const logger = new Logger('vatsim-events')

export class EventApi {
  constructor(private ctx: Context, private config: Config) {}

  private vlog(msg: string) {
    if (this.config.verboseLog) logger.info(msg)
    else logger.debug(msg)
  }

  private async fetchJson(url: string): Promise<any> {
    let lastErr: any
    for (let i = 0; i < this.config.maxRetry; i++) {
      try {
        this.vlog(`GET ${url}`)
        const t0 = Date.now()
        const data = await this.ctx.http.get(url, { timeout: this.config.requestTimeout })
        const len = Array.isArray(data?.data) ? data.data.length : (Array.isArray(data) ? data.length : 'n/a')
        this.vlog(`GET ${url} ok in ${Date.now() - t0}ms, items=${len}`)
        return data
      } catch (e) {
        lastErr = e
        const wait = Math.min(2000 * 2 ** i, 15000)
        logger.warn(`fetch failed (${i + 1}/${this.config.maxRetry}) ${url}: ${e?.message || e}`)
        await new Promise(r => setTimeout(r, wait))
      }
    }
    throw lastErr
  }

  async fetchVatsim(): Promise<RemoteEvent[]> {
    const data = await this.fetchJson(this.config.vatsimApi)
    return data?.data ?? []
  }

  async fetchVatprc(): Promise<RemoteEvent[]> {
    const data = await this.fetchJson(this.config.vatprcApi)
    // 兼容多种返回形态
    if (Array.isArray(data)) return data
    return data?.data ?? data?.events ?? []
  }

  /**
   * VATPRC 历史活动：GET {vatprcApi}/past?since=<N天前>&until=<现在>
   * since/until 由当前时间动态计算（RFC3339，URL 转义）。
   */
  async fetchVatprcPast(historyDays: number): Promise<RemoteEvent[]> {
    const until = new Date()
    const since = new Date(Date.now() - historyDays * 86400_000)
    const url = `${this.config.vatprcApi}/past` +
      `?since=${encodeURIComponent(since.toISOString())}` +
      `&until=${encodeURIComponent(until.toISOString())}`
    const data = await this.fetchJson(url)
    if (Array.isArray(data)) return data
    return data?.data ?? data?.events ?? []
  }

  async fetchDetail(id: number | string): Promise<RemoteEvent | null> {
    try {
      const data = await this.fetchJson(`https://my.vatsim.net/api/v2/events/view/${id}`)
      return data?.data ?? null
    } catch {
      return null
    }
  }

  async fetchAll(): Promise<NormalizedEvent[]> {
    const tasks: Promise<(NormalizedEvent | null)[]>[] = []
    if (this.config.sources.includes('vatsim')) {
      tasks.push(this.fetchVatsim().then(list => list.map(e => normalize(e, 'vatsim'))).catch(() => []))
    }
    if (this.config.sources.includes('vatprc')) {
      tasks.push(this.fetchVatprc().then(list => list.map(e => normalize(e, 'vatprc'))).catch(() => []))
      // 历史活动回填（已结束的活动只入库、不触发推送）；窗口受 cleanupDays 限制
      const historyDays = Math.min(this.config.vatprcHistoryDays ?? 0, this.config.cleanupDays)
      if (historyDays > 0) {
        tasks.push(this.fetchVatprcPast(historyDays).then(list => list.map(e => normalize(e, 'vatprc'))).catch((e) => {
          logger.warn(`vatprc 历史活动拉取失败: ${e?.message || e}`)
          return []
        }))
      }
    }
    const results = await Promise.all(tasks)
    return results.flat().filter(Boolean)
  }
}

export function normalize(e: any, source: EventSource): NormalizedEvent {
  // VATSIM 官方 feed 字段：name / start_time / end_time / banner / link
  // VATPRC uniapi 字段：title / start_at / end_at / image_url / community_link / vatsim_link
  const isVatprc = source === 'vatprc'
  const name = isVatprc ? (e.title || e.title_en) : e.name
  const start = isVatprc ? e.start_at : e.start_time
  const end = isVatprc ? e.end_at : e.end_time
  const link = isVatprc ? (e.vatsim_link || e.community_link) : e.link
  const banner = isVatprc ? e.image_url : e.banner
  const startMs = start ? new Date(start).getTime() : NaN
  const endMs = end ? new Date(end).getTime() : NaN
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    logger.warn(`[${source}] 活动 ${e.id ?? '?'} 时间字段无效（start=${start}, end=${end}），已跳过`)
    return null
  }
  return {
    source,
    remoteId: String(e.id),
    eventType: e.type ?? (isVatprc ? 'VATPRC Event' : 'Event'),
    name: name || '(未命名活动)',
    link: link ?? '',
    description: e.description ?? '',
    shortDescription: e.short_description ?? '',
    banner: banner ?? '',
    startTime: new Date(startMs),
    endTime: new Date(endMs),
    airports: (e.airports ?? []).map((a: any) => typeof a === 'string' ? a : a?.icao).filter(Boolean),
    routes: e.routes ?? [],
    organisers: e.organisers ?? [],
  }
}
