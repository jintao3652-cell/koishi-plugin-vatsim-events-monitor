import { Context, h } from 'koishi'
import type { EventService } from './service'
import type { Config } from './config'
import { sendForward } from './forward'

const HELP = `📘 VATSIM 活动机器人使用说明（仅支持 OneBot 平台）

• vatsim                  查看本帮助
• vatsim 最近活动 [天数]   列出近 N 天活动（默认 7，合并转发，一活动一条）
• vatprc 活动查询          列出所有 VATPRC 即将进行的活动（合并转发）
• vatsim 订阅              本频道订阅：新活动 / 开始前 30 分钟 / 结束 提醒
• vatsim 取消订阅          关闭本频道订阅
• vatsim.model [id|-l]     查看/切换 NVIDIA 翻译模型，-l 列出可用模型

提示：在最近活动 / 活动查询后加 -t 可启用 NVIDIA 翻译简介。
推送范围：在 Koishi 控制台 → 插件配置 → vatsim-events-monitor 内
  - channelMode 选择 whitelist 或 all
  - allowedChannels 列表里点 ➕ 添加群号`

async function sendEventList(
  ctx: Context, service: EventService, session: any,
  events: any[], translate: boolean,
): Promise<string | undefined> {
  if (session.platform !== 'onebot') {
    return '⚠️ 本插件仅支持 OneBot 平台。'
  }
  const botName = session.bot.user?.name || 'VATSIM Events'
  const botUin = String(session.selfId)
  const contents = await Promise.all(events.map(ev => service.renderCard(ev, translate)))
  const nodes = contents.map(content => ({
    type: 'node' as const,
    data: { name: botName, uin: botUin, content },
  }))
  const ok = await sendForward(session, nodes)
  if (!ok) return '❌ 合并转发失败，请检查 OneBot 实现是否支持 send_group_forward_msg。'
}

export function registerCommands(ctx: Context, service: EventService, config: Config) {
  const root = ctx.command('vatsim', 'VATSIM 活动机器人（OneBot）')
    .action(() => HELP)

  root.subcommand('.最近活动 [days:posint]', '列出最近 N 天活动（默认 7）')
    .alias('vatsim.recent')
    .option('translate', '-t 强制翻译简介')
    .option('noTranslate', '-T 关闭翻译')
    .option('source', '-s <src:string> vatsim|vatprc')
    .action(async ({ session, options }, days = 7) => {
      if (!session) return
      if (session.platform !== 'onebot') return '⚠️ 本插件仅支持 OneBot 平台。'

      await session.send(`🔍 正在查询最近 ${days} 天的活动，请稍候…`)

      let events = await service.listRecentWithinDays(days)
      if (options.source) events = events.filter(e => e.source === options.source)
      if (!events.length) return `最近 ${days} 天内暂无活动。`

      const translate = options.noTranslate
        ? false
        : (options.translate ?? service.translator.enabled)

      return sendEventList(ctx, service, session, events, translate)
    })

  ctx.command('vatprc', 'VATPRC 活动查询')
    .subcommand('.活动查询', '列出所有 VATPRC 即将进行的活动')
    .alias('vatprc.events')
    .option('translate', '-t 强制翻译简介')
    .option('noTranslate', '-T 关闭翻译')
    .action(async ({ session, options }) => {
      if (!session) return
      if (session.platform !== 'onebot') return '⚠️ 本插件仅支持 OneBot 平台。'

      await session.send('🔍 正在查询 VATPRC 活动，请稍候…')

      const events = await service.listAllUpcoming('vatprc')
      if (!events.length) return '当前没有即将进行的 VATPRC 活动。'

      const translate = options.noTranslate
        ? false
        : (options.translate ?? service.translator.enabled)

      return sendEventList(ctx, service, session, events, translate)
    })

  root.subcommand('.订阅', '本频道订阅活动通知（新活动 / 开始前30分钟 / 结束）')
    .alias('vatsim.subscribe')
    .action(async ({ session }) => {
      if (!session?.channelId) return '请在群内使用此指令。'
      if (session.platform !== 'onebot') return '⚠️ 本插件仅支持 OneBot 平台。'
      await ctx.database.upsert('vatsim_notify_channel', [{
        platform: session.platform,
        channelId: session.channelId,
        selfId: session.selfId,
        guildId: session.guildId || '',
        enableNew: true,
        enableStart: false,
        enableEnd: true,
        remindMinutes: [30],
        atAll: false,
      }])
      return '✅ 已订阅本群：新活动通知 / 开始前 30 分钟提醒 / 结束提醒。'
    })

  root.subcommand('.取消订阅', '关闭本频道订阅')
    .alias('vatsim.unsubscribe')
    .action(async ({ session }) => {
      if (!session?.channelId) return '请在群内使用。'
      await ctx.database.remove('vatsim_notify_channel', {
        platform: session.platform,
        channelId: session.channelId,
      })
      return '✅ 已取消本群订阅。'
    })

  root.subcommand('.model [id:string]', '查看/切换 NVIDIA 翻译模型')
    .option('list', '-l 列出可用模型')
    .option('filter', '-f <kw:string> 过滤模型 id')
    .action(async ({ options }, id) => {
      if (id) {
        const newConfig = { ...config, nvidiaModel: id }
        try {
          const loader: any = (ctx as any).loader
          if (!loader?.writable) {
            ctx.scope.update(newConfig, false)
            config.nvidiaModel = id
            return `⚠️ 已切换为 ${id}（运行时），但 loader 不可写，重载后会丢失。请直接在 koishi.yml 中修改 nvidiaModel。`
          }
          // 在 parent scope 的 kRecord 里找到本插件的 key（如 "vatsim-events-monitor"）
          const kRecord = Symbol.for('koishi.loader.record')
          const parentScope: any = ctx.scope.parent.scope
          const record = parentScope[kRecord] || {}
          const key = Object.keys(record).find(k => record[k] === ctx.scope)
          if (!key) throw new Error('未在 loader record 中找到当前插件 fork')
          // 改写"源配置对象"——loader.writeConfig 会把它序列化为 yaml
          parentScope.config[key] = newConfig
          // 触发重载（会重新创建 fork，使新 config 立刻生效）
          await loader.reload(parentScope.ctx ?? ctx.scope.parent, key, newConfig)
          await loader.writeConfig()
          return `✅ 已切换翻译模型为：${id}，已写入 koishi.yml。`
        } catch (e: any) {
          config.nvidiaModel = id
          return `⚠️ 已切换为 ${id}（运行时），但持久化失败：${e?.message || e}`
        }
      }
      if (options.list || options.filter) {
        try {
          const list = await service.translator.listModels()
          const kw = options.filter?.toLowerCase()
          const filtered = kw ? list.filter(m => m.id.toLowerCase().includes(kw)) : list
          if (!filtered.length) return '未获取到模型。'
          const lines = filtered.slice(0, 60).map(m => `- ${m.id}`)
          const more = filtered.length > 60 ? `\n…共 ${filtered.length} 个，已截断。` : ''
          return `当前模型：${config.nvidiaModel}\n可用模型：\n${lines.join('\n')}${more}\n\n使用 vatsim.model <id> 切换。`
        } catch (e: any) {
          return `获取模型失败：${e?.message || e}`
        }
      }
      return `当前翻译模型：${config.nvidiaModel}\n使用 vatsim.model -l 列出可用模型，vatsim.model <id> 切换。`
    })
}
