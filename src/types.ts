import {} from 'koishi'

export type EventSource = 'vatsim' | 'vatprc'
export type EventStatus = 'pending' | 'ongoing' | 'ended'
export type NotifyType = 'new' | 'start' | 'end' | `remind-${number}`

export interface RemoteAirport { icao: string }
export interface RemoteOrganiser {
  region?: string
  division?: string
  subdivision?: string
  organised_by_vatsim?: boolean
}
export interface RemoteRoute {
  departure?: string
  arrival?: string
  route?: string
}
export interface RemoteEvent {
  id: number
  type?: string
  name: string
  link?: string
  description?: string
  short_description?: string
  banner?: string
  start_time: string
  end_time: string
  airports?: RemoteAirport[]
  routes?: RemoteRoute[]
  organisers?: RemoteOrganiser[]
}

export interface NormalizedEvent {
  source: EventSource
  remoteId: string
  eventType: string
  name: string
  link: string
  description: string
  shortDescription: string
  banner: string
  startTime: Date
  endTime: Date
  airports: string[]
  routes: RemoteRoute[]
  organisers: RemoteOrganiser[]
}

// ---------- DB rows ----------
export interface VatsimEvent {
  id: number
  source: EventSource
  remoteId: string
  eventType: string
  name: string
  link: string
  description: string
  shortDescription: string
  banner: string
  startTime: Date
  endTime: Date
  airports: string[]
  routes: RemoteRoute[]
  organisers: RemoteOrganiser[]
  /** 命中的目标分部 ID（逗号分隔，如 "PRC,SEA"），空串表示不属于目标分部 */
  divisionTags: string
  status: EventStatus
  createdAt: Date
  updatedAt: Date
}

export interface VatsimSubscription {
  id: number
  platform: string
  selfId: string
  userId: string
  channelId: string
  guildId: string
  keyword: string
  atMe: boolean
  createdAt: Date
}

export interface VatsimNotifyChannel {
  platform: string
  selfId: string
  channelId: string
  guildId: string
  enableNew: boolean
  enableStart: boolean
  enableEnd: boolean
  remindMinutes: number[]
  atAll: boolean
}

export interface VatsimNotifyLog {
  id: number
  eventId: number
  channelId: string
  type: NotifyType
  sentAt: Date
}

/** 分部推送频道（由 vatsim.分部推送 指令自助登记） */
export interface VatsimDivisionChannel {
  platform: string
  selfId: string
  channelId: string
  guildId: string
  createdAt: Date
}

declare module 'koishi' {
  interface Tables {
    vatsim_event: VatsimEvent
    vatsim_subscription: VatsimSubscription
    vatsim_notify_channel: VatsimNotifyChannel
    vatsim_notify_log: VatsimNotifyLog
    vatsim_division_channel: VatsimDivisionChannel
  }
}
