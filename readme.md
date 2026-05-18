# koishi-plugin-vatsim-events-monitor

VATSIM / VATPRC 活动机器人：5 分钟轮询、合并转发列表、订阅推送、NVIDIA 翻译。

## 指令

| 指令 | 说明 |
|---|---|
| `vatsim` | 查看使用教程 |
| `vatsim.最近活动 [天数] [-t] [-s vatsim/vatprc]` | 列出最近 N 天（默认 7）所有活动；OneBot 平台会用合并转发，每个活动一条节点；`-t` 启用 NVIDIA 翻译简介 |
| `vatsim.订阅` | 把当前频道订阅为通知频道：新活动 / 开始前 30 分钟 / 活动结束 三类提醒 |
| `vatsim.取消订阅` | 关闭本频道订阅 |
| `vatsim.model [id] [-l] [-f kw]` | 不带参数：查看当前翻译模型；`-l` 列出可用模型；带 id：切换为指定模型 |

> 中文指令均带英文别名：`recent / subscribe / unsubscribe`。

## 数据源
- `https://my.vatsim.net/api/v2/events/latest`
- `https://uniapi.vatprc.net/api/compat/homepage/events/vatsim`

## 翻译
NVIDIA OpenAI 兼容接口：`https://integrate.api.nvidia.com/v1`，需在配置中填入 `nvidiaApiKey` 并启用 `enableTranslation`。可用 `vatsim.model -l` 拉取可用模型。

## 合并转发
仅在 OneBot 平台生效（`send_group_forward_msg` / `send_private_forward_msg`），其他平台自动回退为逐条发送。
