import { Context } from 'koishi'

export function defineModels(ctx: Context) {
  ctx.model.extend('vatsim_event', {
    id: 'unsigned',
    source: 'string',
    remoteId: 'string',
    eventType: 'string',
    name: 'string',
    link: 'string',
    description: 'text',
    shortDescription: 'text',
    banner: 'string',
    startTime: 'timestamp',
    endTime: 'timestamp',
    airports: 'list',
    routes: 'json',
    organisers: 'json',
    status: 'string',
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  }, {
    autoInc: true,
    unique: [['source', 'remoteId']],
  })

  ctx.model.extend('vatsim_subscription', {
    id: 'unsigned',
    platform: 'string',
    selfId: 'string',
    userId: 'string',
    channelId: 'string',
    guildId: 'string',
    keyword: 'string',
    atMe: 'boolean',
    createdAt: 'timestamp',
  }, {
    autoInc: true,
  })

  ctx.model.extend('vatsim_notify_channel', {
    platform: 'string',
    selfId: 'string',
    channelId: 'string',
    guildId: 'string',
    enableNew: 'boolean',
    enableStart: 'boolean',
    enableEnd: 'boolean',
    remindMinutes: 'list',
    atAll: 'boolean',
  }, {
    primary: ['platform', 'channelId'],
  })

  ctx.model.extend('vatsim_notify_log', {
    id: 'unsigned',
    eventId: 'unsigned',
    channelId: 'string',
    type: 'string',
    sentAt: 'timestamp',
  }, {
    autoInc: true,
    unique: [['eventId', 'channelId', 'type']],
  })
}
