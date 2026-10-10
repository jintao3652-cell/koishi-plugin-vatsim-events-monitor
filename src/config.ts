import { Schema } from 'koishi'

export interface Config {
  pollInterval: number
  sources: ('vatsim' | 'vatprc')[]
  defaultRemindMinutes: number[]
  notifyEnd: boolean
  notifyStart: boolean
  requestTimeout: number
  translateTimeout: number
  maxRetry: number
  timezone: string
  vatsimApi: string
  vatprcApi: string
  vatprcHistoryDays: number
  cleanupDays: number
  // NVIDIA translation
  enableTranslation: boolean
  nvidiaApiKey: string
  nvidiaApiBase: string
  nvidiaModel: string
  verboseLog: boolean
  allowedChannels: string[]
  channelMode: 'whitelist' | 'all'
  // 活动横幅下载
  bannerTimeout: number
  bannerRetry: number
  bannerConcurrency: number
  bannerMaxWidth: number
  bannerFormat: 'jpeg' | 'webp' | 'png' | 'original'
  bannerQuality: number
  bannerCacheDays: number
  bannerBrowserFallback: boolean
  bannerPrefetch: boolean
  bannerBatchTimeout: number
}

export const Config: Schema<Config> = Schema.object({
  pollInterval: Schema.number().default(5).min(1).description('轮询间隔（分钟）'),
  sources: Schema.array(Schema.union(['vatsim', 'vatprc'] as const))
    .default(['vatsim', 'vatprc'])
    .description('启用的数据源'),
  defaultRemindMinutes: Schema.array(Schema.number())
    .default([30, 5])
    .description('开始前提醒的分钟数列表'),
  notifyStart: Schema.boolean().default(true).description('活动开始时是否提醒'),
  notifyEnd: Schema.boolean().default(true).description('活动结束时是否提醒'),
  requestTimeout: Schema.number().default(10000).description('请求超时（毫秒）'),
  translateTimeout: Schema.number().default(60000).description('翻译请求超时（毫秒，长文翻译较慢建议 ≥60s）'),
  maxRetry: Schema.number().default(3).description('请求失败重试次数'),
  timezone: Schema.string().default('Asia/Shanghai').description('显示时区'),
  vatsimApi: Schema.string().default('https://my.vatsim.net/api/v2/events/latest'),
  vatprcApi: Schema.string().default('https://uniapi.vatprc.net/api/events').description('VATPRC 活动列表端点（uniapi 官方）'),
  vatprcHistoryDays: Schema.number().default(30).min(0)
    .description('VATPRC 历史活动回填天数：轮询时通过 /api/events/past?since=&until= 拉取过去 N 天已结束的活动入库（不触发推送）。0 关闭；实际窗口同时受 cleanupDays 限制，超过 cleanupDays 的记录会被定期清理'),
  cleanupDays: Schema.number().default(30).description('结束多少天后清理活动记录'),
  enableTranslation: Schema.boolean().default(false).description('启用 NVIDIA API 翻译活动信息'),
  nvidiaApiKey: Schema.string().role('secret').default('').description('NVIDIA API Key'),
  nvidiaApiBase: Schema.string().default('https://integrate.api.nvidia.com/v1').description('NVIDIA API Base URL（OpenAI 兼容）'),
  nvidiaModel: Schema.string().default('nvidia/riva-translate-4b-instruct-v1.1')
    .description('翻译模型 id。可使用指令 `vatsim.model -l` 列出可用模型后填入。'),
  verboseLog: Schema.boolean().default(false).description('详细日志：打印 API 请求 / 翻译输入输出 / 轮询结果（调试用）'),
  channelMode: Schema.union([
    Schema.const('whitelist').description('白名单模式：仅向下方列表中的群推送'),
    Schema.const('all').description('全部模式：向所有已使用 vatsim.订阅 的频道推送'),
  ]).default('whitelist').description('推送范围模式'),
  allowedChannels: Schema.array(Schema.string())
    .role('table')
    .default([])
    .description('允许推送的群聊 / 频道 id 列表（仅 whitelist 模式生效）。点 ➕ 添加一行，输入群号即可。OneBot QQ 群直接填群号，例如 123456789。'),

  bannerTimeout: Schema.number().default(20000).min(1000)
    .description('活动横幅单次下载超时（毫秒）。VATSIM 官方横幅多为 1~4MB 的 PNG，实测跨国直连需 4~14 秒，旧版固定 3 秒会 100% 超时。'),
  bannerRetry: Schema.number().default(2).min(1).max(5)
    .description('单张横幅的直连尝试次数（失败间隔 0.5s 退避，全部失败后才走浏览器兜底）。'),
  bannerConcurrency: Schema.number().default(3).min(1).max(10)
    .description('横幅并发下载数。一次列出多个活动时会串行排队，避免多条连接互相挤占带宽导致集体超时。'),
  bannerMaxWidth: Schema.number().default(1280).min(0)
    .description('横幅等比缩放到的最大宽度（小于该尺寸的图不会放大）。0 表示不缩放。'),
  bannerQuality: Schema.number().default(80).min(1).max(100)
    .description('横幅重新编码质量（jpeg / webp 生效）。'),
  bannerFormat: Schema.union([
    Schema.const('jpeg').description('JPEG：兼容性最好（推荐）'),
    Schema.const('webp').description('WebP：体积最小，个别老协议端可能不支持'),
    Schema.const('png').description('PNG：无损但体积大'),
    Schema.const('original').description('原图：不压缩不缩放，直接发原文件'),
  ]).default('jpeg').description('横幅发送格式。原图多为 2560x1440 PNG（约 1~4MB，转 base64 后 2~5MB），压缩后可降到几十 KB。'),
  bannerCacheDays: Schema.number().default(30).min(1)
    .description('横幅磁盘缓存保留天数（缓存于 data/vatsim-event-banners，同一张图只在首次下载一次）。'),
  bannerBrowserFallback: Schema.boolean().default(true)
    .description('直连全部失败后，尝试用 puppeteer 打开图片截图兜底。'),
  bannerPrefetch: Schema.boolean().default(true)
    .description('轮询发现新活动后后台提前下载横幅，真正推送 / 查询时即可命中缓存。'),
  bannerBatchTimeout: Schema.number().default(60000).min(5000)
    .description('一条消息（可能含多张横幅）等待下载的总预算（毫秒）。超预算的图改用原 URL 发出，下载仍在后台继续并写入缓存，下次即命中。'),
})
