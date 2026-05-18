import { Schema } from 'koishi'

export interface Config {
  pollInterval: number
  sources: ('vatsim' | 'vatprc')[]
  defaultRemindMinutes: number[]
  notifyEnd: boolean
  notifyStart: boolean
  requestTimeout: number
  maxRetry: number
  timezone: string
  vatsimApi: string
  vatprcApi: string
  cleanupDays: number
  // NVIDIA translation
  enableTranslation: boolean
  nvidiaApiKey: string
  nvidiaApiBase: string
  nvidiaModel: string
  verboseLog: boolean
  allowedChannels: string[]
  channelMode: 'whitelist' | 'all'
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
  maxRetry: Schema.number().default(3).description('请求失败重试次数'),
  timezone: Schema.string().default('Asia/Shanghai').description('显示时区'),
  vatsimApi: Schema.string().default('https://my.vatsim.net/api/v2/events/latest'),
  vatprcApi: Schema.string().default('https://uniapi.vatprc.net/api/compat/homepage/events/vatsim'),
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
})
