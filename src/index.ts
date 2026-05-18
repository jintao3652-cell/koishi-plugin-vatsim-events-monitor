import { Context } from 'koishi'
import { Config } from './config'
import { defineModels } from './model'
import { EventService } from './service'
import { registerCommands } from './commands'
import './types'

export { Config }
export const name = 'vatsim-events-monitor'
export const inject = ['database', 'http']

export function apply(ctx: Context, config: Config) {
  defineModels(ctx)
  const service = new EventService(ctx, config)
  registerCommands(ctx, service, config)

  ctx.setInterval(() => service.poll(), config.pollInterval * 60_000)
  ctx.on('ready', () => { service.poll() })
}
