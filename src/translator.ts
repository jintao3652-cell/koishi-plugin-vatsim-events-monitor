import { Context, Logger } from 'koishi'
import type { Config } from './config.js'

const logger = new Logger('vatsim-events:translate')

export interface NvidiaModel {
  id: string
  object?: string
  owned_by?: string
  created?: number
}

export class Translator {
  private cache = new Map<string, string>()

  constructor(private ctx: Context, private config: Config) {}

  get enabled() {
    return this.config.enableTranslation && !!this.config.nvidiaApiKey
  }

  log(msg: string) {
    if (this.config.verboseLog) logger.info(msg)
    else logger.debug(msg)
  }

  async listModels(): Promise<NvidiaModel[]> {
    if (!this.config.nvidiaApiKey) throw new Error('未配置 nvidiaApiKey')
    const url = `${this.config.nvidiaApiBase.replace(/\/$/, '')}/models`
    this.log(`GET ${url}`)
    const resp = await this.ctx.http.get(url, {
      timeout: this.config.requestTimeout,
      headers: {
        Authorization: `Bearer ${this.config.nvidiaApiKey}`,
        Accept: 'application/json',
      },
    })
    return resp?.data ?? []
  }

  async translate(text: string): Promise<string> {
    if (!this.enabled) {
      this.log(`translate skipped: enabled=${this.config.enableTranslation} hasKey=${!!this.config.nvidiaApiKey}`)
      return text
    }
    if (!text?.trim()) return text
    if (/[一-龥]/.test(text)) {
      this.log(`translate skipped: text already contains CJK`)
      return text
    }
    const key = text.slice(0, 1000)
    if (this.cache.has(key)) {
      this.log(`translate cache hit (${text.length} chars)`)
      return this.cache.get(key)!
    }

    const url = `${this.config.nvidiaApiBase.replace(/\/$/, '')}/chat/completions`
    const isRiva = /riva-translate/i.test(this.config.nvidiaModel)
    const messages = isRiva
      ? [
          { role: 'system', content: 'You are an expert at translating text from English to Simplified Chinese.' },
          { role: 'user', content: `What is the Simplified Chinese translation of the sentence: ${text}?` },
        ]
      : [
          { role: 'system', content: '你是一名航空领域专业翻译。请将用户输入翻译成简体中文，保留专有名词（机场代码、航路名）。只输出翻译结果，不要解释、不要前言后语。' },
          { role: 'user', content: text },
        ]
    const body: any = {
      model: this.config.nvidiaModel,
      messages,
      temperature: 0,
      max_tokens: 2048,
    }
    this.log(`POST ${url} model=${body.model} input(${text.length})=${text.slice(0, 80).replace(/\n/g, ' ')}…`)
    try {
      const resp = await this.ctx.http.post(url, body, {
        timeout: this.config.requestTimeout,
        headers: {
          Authorization: `Bearer ${this.config.nvidiaApiKey}`,
          Accept: 'application/json',
        },
      })
      const choice = resp?.choices?.[0]
      const out = choice?.message?.content?.trim()
      if (!out) {
        logger.warn(`translate empty response: ${JSON.stringify(resp).slice(0, 300)}`)
        return text
      }
      this.log(`translate ok finish=${choice?.finish_reason} output(${out.length})=${out.slice(0, 80).replace(/\n/g, ' ')}…`)
      this.cache.set(key, out)
      return out
    } catch (e: any) {
      const status = e?.response?.status ?? e?.status
      const statusText = e?.response?.statusText ?? e?.statusText
      const data = e?.response?.data ?? e?.data
      let dataStr: string
      try {
        if (typeof data === 'string') dataStr = data
        else if (Buffer.isBuffer?.(data)) dataStr = data.toString('utf8')
        else dataStr = JSON.stringify(data)
      } catch { dataStr = String(data) }
      logger.warn(`translate failed: status=${status} ${statusText || ''} msg=${e?.message || ''} body=${(dataStr || '').slice(0, 500)}`)
      return text
    }
  }
}
