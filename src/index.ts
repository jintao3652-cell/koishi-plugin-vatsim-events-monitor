import { Context } from 'koishi'
import { Config } from './config.js'
import { defineModels } from './model.js'
import { EventService } from './service.js'
import { registerCommands } from './commands.js'
import './types.js'

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
