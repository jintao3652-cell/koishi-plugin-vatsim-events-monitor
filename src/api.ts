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

  async fetchDetail(id: number | string): Promise<RemoteEvent | null> {
    try {
      const data = await this.fetchJson(`https://my.vatsim.net/api/v2/events/${id}`)
      return data?.data ?? null
    } catch {
      return null
    }
  }

  async fetchAll(): Promise<NormalizedEvent[]> {
    const tasks: Promise<NormalizedEvent[]>[] = []
    if (this.config.sources.includes('vatsim')) {
      tasks.push(this.fetchVatsim().then(list => list.map(e => normalize(e, 'vatsim'))).catch(() => []))
    }
    if (this.config.sources.includes('vatprc')) {
      tasks.push(this.fetchVatprc().then(list => list.map(e => normalize(e, 'vatprc'))).catch(() => []))
    }
    const results = await Promise.all(tasks)
    return results.flat().filter(Boolean)
  }
}

export function normalize(e: RemoteEvent, source: EventSource): NormalizedEvent {
  return {
    source,
    remoteId: String(e.id),
    eventType: e.type ?? 'Event',
    name: e.name ?? '(未命名活动)',
    link: e.link ?? '',
    description: e.description ?? '',
    shortDescription: e.short_description ?? '',
    banner: e.banner ?? '',
    startTime: new Date(e.start_time),
    endTime: new Date(e.end_time),
    airports: (e.airports ?? []).map(a => a.icao).filter(Boolean),
    routes: e.routes ?? [],
    organisers: e.organisers ?? [],
  }
}
