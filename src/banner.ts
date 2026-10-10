import { Context, Logger } from 'koishi'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const logger = new Logger('vatsim-events:banner')

export type BannerFormat = 'jpeg' | 'webp' | 'png' | 'original'

export interface BannerSettings {
  /** 单次下载尝试的超时（毫秒）。实测 VATSIM banner 为 1~4MB PNG，直连需 4~14s。 */
  timeout: number
  /** 直连尝试次数上限。 */
  retry: number
  /** 全局并发下载数：避免一次转发 N 张图同时开 N 条连接把带宽打满导致集体超时。 */
  concurrency: number
  /** 缩放到的最大宽度（等比，不放大小图）。 */
  maxWidth: number
  /** 重新编码格式。jpeg 兼容性最好；webp 体积最小。 */
  format: BannerFormat
  /** 重新编码质量（jpeg/webp 生效）。 */
  quality: number
  /** 磁盘缓存保留天数。 */
  cacheDays: number
  /** 单张图体积上限，超过则视为失败。 */
  maxBytes: number
  /** 直连失败后是否用 puppeteer 打开图片再截图兜底。 */
  browserFallback: boolean
  /** 浏览器兜底的导航超时（毫秒）。 */
  browserTimeout: number
  /** 一次消息（可能含多张图）等待横幅的总预算；超时后改用原 URL 发出，下载仍在后台继续。 */
  batchTimeout: number
}

interface CacheEntry {
  data: Buffer
  mime: string
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export class BannerDownloader {
  /** 同一 URL 的并发请求合并为一次下载。 */
  private inflight = new Map<string, Promise<CacheEntry | null>>()
  private active = 0
  private waiters: (() => void)[] = []
  private cleanupPromise: Promise<void> | null = null

  constructor(private ctx: Context, public settings: BannerSettings) {
    // 启动时异步清理过期缓存，不阻塞插件就绪
    this.cleanupPromise = this.cleanupExpired().catch(() => {})
  }

  // ---------- 磁盘缓存 ----------

  private get cacheDir(): string {
    const base = (this.ctx as any).baseDir || process.cwd()
    return path.resolve(base, 'data', 'vatsim-event-banners')
  }

  private cacheNames(url: string): { dir: string; base: string } {
    const hash = createHash('sha1').update(url).digest('hex')
    const dir = path.join(this.cacheDir, hash.slice(0, 2))
    return { dir, base: dir + path.sep + hash.slice(2) }
  }

  private async readCache(url: string): Promise<CacheEntry | null> {
    const { base } = this.cacheNames(url)
    for (const [mime, ext] of Object.entries(MIME_EXT)) {
      try {
        const data = await fs.readFile(`${base}.${ext}`)
        if (data.length) return { data, mime }
      } catch { /* 未命中 */ }
    }
    return null
  }

  private async writeCache(url: string, entry: CacheEntry): Promise<void> {
    const ext = MIME_EXT[entry.mime]
    if (!ext) return
    const { dir, base } = this.cacheNames(url)
    try {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(`${base}.${ext}`, entry.data)
    } catch (e: any) {
      logger.debug(`写入 banner 缓存失败: ${e?.message || e}`)
    }
  }

  private async cleanupExpired(): Promise<void> {
    const root = this.cacheDir
    const ttl = Math.max(this.settings.cacheDays, 1) * 86_400_000
    try {
      const dirs = await fs.readdir(root, { withFileTypes: true })
      let removed = 0
      for (const d of dirs) {
        if (!d.isDirectory()) continue
        const sub = path.join(root, d.name)
        const files = await fs.readdir(sub)
        for (const f of files) {
          const full = path.join(sub, f)
          try {
            const st = await fs.stat(full)
            if (Date.now() - st.mtimeMs > ttl) {
              await fs.unlink(full)
              removed++
            }
          } catch { /* 忽略单个文件 */ }
        }
      }
      if (removed) logger.info(`已清理 ${removed} 个过期 banner 缓存文件`)
    } catch { /* 缓存目录尚不存在 */ }
  }

  // ---------- 并发控制 ----------

  private async acquire(): Promise<void> {
    if (this.active < this.settings.concurrency) {
      this.active++
      return
    }
    await new Promise<void>(resolve => this.waiters.push(resolve))
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.active--
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try { return await fn() } finally { this.release() }
  }

  // ---------- 对外接口 ----------

  /** 取一张横幅（已转码），失败返回 null。同一 URL 并发共享结果。 */
  async fetch(url: string): Promise<CacheEntry | null> {
    const pending = this.inflight.get(url)
    if (pending) return pending
    const task = this.withSlot(() => this.fetchOnce(url))
      .finally(() => this.inflight.delete(url))
    this.inflight.set(url, task)
    return task
  }

  /** 后台预热：不抛错，不做超时限制之外的额外等待。供轮询发现新活动时调用。 */
  prefetch(urls: (string | undefined | null)[]): void {
    const list = Array.from(new Set(urls.filter((u): u is string => !!u && /^https?:\/\//i.test(u))))
    if (!list.length) return
    void (async () => {
      for (const u of list) {
        try {
          const cached = await this.readCache(u)
          if (cached) continue
          await this.fetch(u)
        } catch { /* 预热失败无需处理 */ }
      }
    })()
  }

  toDataUrl(entry: CacheEntry): string {
    return `data:${entry.mime};base64,${entry.data.toString('base64')}`
  }

  // ---------- 内部实现 ----------

  private async fetchOnce(url: string): Promise<CacheEntry | null> {
    const cached = await this.readCache(url)
    if (cached) {
      logger.debug(`banner 缓存命中: ${url}`)
      return cached
    }

    let raw: Buffer | null = null
    const t0 = Date.now()
    for (let attempt = 1; attempt <= this.settings.retry; attempt++) {
      raw = await this.downloadRaw(url)
      if (raw) break
      if (attempt < this.settings.retry) {
        await new Promise(r => setTimeout(r, 500 * attempt))
      }
    }
    if (!raw) {
      if (this.settings.browserFallback) raw = await this.downloadViaBrowser(url)
      if (!raw) {
        logger.warn(`banner 下载失败，保留原始 URL: ${url}`)
        return null
      }
    }

    const entry = await this.reencode(raw)
    logger.info(`banner 下载完成: ${(raw.length / 1024).toFixed(0)}KB → ${(entry.data.length / 1024).toFixed(0)}KB (${entry.mime}) in ${Date.now() - t0}ms`)
    await this.writeCache(url, entry)
    return entry
  }

  /** 直连下载原图。 */
  private async downloadRaw(url: string): Promise<Buffer | null> {
    try {
      const buf = await this.ctx.http.get(url, {
        responseType: 'arraybuffer',
        timeout: this.settings.timeout,
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8' },
      })
      const bytes = Buffer.from(buf as ArrayBuffer)
      if (!bytes.length) throw new Error('empty body')
      if (bytes.length > this.settings.maxBytes) throw new Error(`too large (${bytes.length} bytes)`)
      return bytes
    } catch (e: any) {
      logger.debug(`banner 直连下载失败(${this.settings.timeout}ms): ${url} ${e?.message || e}`)
      return null
    }
  }

  /** 浏览器兜底：直连不通时，让 Edge 打开图片后截图。 */
  private async downloadViaBrowser(url: string): Promise<Buffer | null> {
    const puppeteer: any = (this.ctx as any).puppeteer
    if (!puppeteer?.page) return null
    let page: any
    try {
      page = await puppeteer.page()
      await page.setViewport({ width: 1280, height: 1280, deviceScaleFactor: 1 })
      await page.goto(url, { waitUntil: 'load', timeout: this.settings.browserTimeout })
      const buf = await page.screenshot({ type: 'png' }) as Buffer
      if (!buf?.length || buf.length > this.settings.maxBytes) return null
      return buf
    } catch (e: any) {
      logger.debug(`banner 浏览器兜底失败: ${url} ${e?.message || e}`)
      return null
    } finally {
      await page?.close?.().catch(() => {})
    }
  }

  /**
   * 重新编码 + 缩放。VATSIM banner 原图多为 2560x1440 的 PNG（1~4MB），
   * 转 base64 后单次 payload 可达数 MB；缩放 + 有损压缩可降到几十 KB。
   * sharp 为可选增强，不可用时原样返回。
   */
  async reencode(raw: Buffer): Promise<CacheEntry> {
    const fallback: CacheEntry = { data: raw, mime: sniffImageMime(raw) || 'image/png' }
    if (this.settings.format === 'original') return fallback
    try {
      const sharp = requireOptional('sharp')
      if (!sharp) throw new Error('sharp 不可用')
      let pipeline = sharp(raw)
      if (this.settings.maxWidth > 0) {
        pipeline = pipeline.resize({ width: this.settings.maxWidth, withoutEnlargement: true })
      }
      const format = this.settings.format === 'png' ? 'png' : this.settings.format
      const out = await pipeline
        .toFormat(format, { quality: this.settings.quality })
        .toBuffer()
      if (!out?.length || out.length >= raw.length * 0.98) return fallback
      const mime = this.settings.format === 'jpeg' ? 'image/jpeg'
        : this.settings.format === 'webp' ? 'image/webp'
          : 'image/png'
      return { data: out, mime }
    } catch (e: any) {
      logger.debug(`banner 转码失败，按原图发送: ${e?.message || e}`)
      return fallback
    }
  }
}

/**
 * 取本模块的 require，用于加载可选依赖 sharp。
 *
 * 不能直接写 `require('sharp')`：打包器会把静态 require 解析并内联进产物；
 * 也不能只 `(0, eval)('require')`：间接 eval 在**全局作用域**求值，而 Node 的
 * require 是每个模块包装函数的**局部参数**，在 `require()` 方式加载的模块里拿不到。
 * 因此依次尝试：模块局部 require → 间接 eval → 基于 cwd 的 createRequire。
 */
function requireOptional(id: string): any {
  const candidates: (() => any)[] = [
    () => (typeof require === 'function' ? require : null),
    () => (0, eval)('require'),
    () => createRequire(process.cwd() + '/index.js'),
  ]
  for (const get of candidates) {
    try {
      const req = get() as NodeRequire | null
      if (req) return req(id)
    } catch { /* 换下一种 */ }
  }
  return null
}

export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.length > 6 && bytes.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  if (bytes.length > 12 && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

// ---------------------------------------------------------------------------
// 插件内共享实例：precacheRemoteImages 只能拿到 Context，通过这里取回下载器。
// ---------------------------------------------------------------------------

const registry = new WeakMap<Context, BannerDownloader>()

export function ensureBannerDownloader(ctx: Context, settings: () => BannerSettings): BannerDownloader {
  const existing = registry.get(ctx)
  if (existing) {
    existing.settings = settings()
    return existing
  }
  const created = new BannerDownloader(ctx, settings())
  registry.set(ctx, created)
  return created
}

export function getBannerDownloader(ctx: Context): BannerDownloader | undefined {
  return registry.get(ctx)
}
