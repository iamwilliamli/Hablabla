# Hablabla 后端调用接口

更新：2026-09-12。面向前端和其他后端的对接说明，按当前源码核对；William 只负责后端，不在此任务中修改前端。

**“有接口”不等于“已上线”。** 本文未验证公网部署、API 账号或真实模型推理。公网地址和凭证由后端负责人单独提供，示例域名不是已部署地址。工作区仍有并行开发中的改动，联调前应确认双方使用的版本。

## 前端接入分工与当前阻塞

语音网关接口已经定义，但 `apps/web` 目前没有保护长期 Bearer key 的语音代理路由。因此前端不能把 `HABLABLA_SPEECH_API_KEY` 放进浏览器，也不能直接从页面调用受保护的 `/v1/*` HTTP 接口。

| Owner | 现在要做什么 | 完成标准 |
| --- | --- | --- |
| Renzo（Web 后端） | 增加同源 server routes：创建 Parakeet ticket、转发 MOSS 上传、查询/取消任务，并选择代理 SSE 或让页面轮询；key 只从服务端环境读取，ticket 的 `origin` 从可信请求上下文推导 | 浏览器网络请求和构建产物中都没有长期 key；错误状态和 `requestId` 原样映射给前端 |
| Ahmad（录音与转写前端） | 接入 PCM worklet；等 `ready` 后再发送实时音频；按 `revision` 替换 transcript 快照；结束时 flush 后发 `finish` 并等待 `isFinal: true`；离线录音保留真实 MIME/文件名并上传给同源代理 | 真实录音可显示 loading、live、final、failed、cancelled；不会重复追加修订文本，也不会把 socket close 当成功 |
| Arjun（分析与 Agent 前端） | 只消费已确认的 transcript/segments；`speakerId` 先显示为通用标签，不推断真人；分析和任务审批继续走既有契约 | 分析输入可追溯到当前 transcript revision；未经用户批准不写任务 |
| William（语音后端） | 维护本文、OpenAPI、帧协议和 worker/gateway；提供联调地址、允许的 Origin、独立 key 与实测模型状态 | `/healthz`、capabilities、一次实时流和一次完整文件任务分别有真实联调证据 |

前端开始实现前仍需要后端负责人确定同源 proxy 的最终路径；本文中的 `/api/hablabla/parakeet-session` 只是示例名，不是当前已存在的路由。详细浏览器代码和验收清单见 [Speech API contract](speech-api-frontend.md#frontend-integration-handoff)。

## 1. 服务地址和调用边界

| 服务 | 默认本地地址 | 使用范围 |
| --- | --- | --- |
| 语音网关 | `http://127.0.0.1:8765` | 本文主要对接入口；对外部署需 HTTPS/WSS 和受控访问 |
| Web 内部 API | `http://127.0.0.1:3100` | 本机应用内部；不是已加固的公网 API |
| Companion 开发 relay | 独立进程，见其协议文档 | 设备控制工作流，不属于语音网关 |

语音网关启动方式和模型构建要求见 [网关 README](../apps/speech-gateway/README.md)。网关配置用 `HABLABLA_SPEECH_PUBLIC_URL`；调用方服务器可自行用 `HABLABLA_SPEECH_URL` 保存它拿到的地址，两者不是同一个配置项。

网关接受 `HABLABLA_SPEECH_API_KEYS` 中配置的 Bearer key。调用方服务器保存自己的 key，例如 `HABLABLA_SPEECH_API_KEY`。浏览器只能拿短期 WebSocket ticket，不能拿长期 key。带 `Origin` 的 HTTP 请求必须通过 `HABLABLA_SPEECH_ALLOWED_ORIGINS` 白名单检查，包括健康检查；无 `Origin` 的服务器请求仍须通过受保护接口的 key 检查。

## 2. 语音网关：8 个调用入口

| 方法 | 路径 | 鉴权 | 功能 / 成功返回 |
| --- | --- | --- | --- |
| GET | `/healthz` | 无 key | `200 {"status":"ok"}`；只证明进程存活 |
| GET | `/v1/capabilities` | Bearer | 支持的模型、传输格式、MIME 和上传上限；不证明模型 ready |
| POST | `/v1/parakeet/sessions` | Bearer | `201`，创建实时转写 ticket |
| WebSocket | `/v1/parakeet/stream?ticket=...` | 一次性 ticket + 匹配的 Origin | 输入 PCM，返回实时转写事件 |
| POST | `/v1/moss/transcriptions` | Bearer + Idempotency-Key | `202`，上传完整音频并排队 |
| GET | `/v1/moss/transcriptions/:jobId` | Bearer | `200`，任务状态及结果 |
| GET | `/v1/moss/transcriptions/:jobId/events` | Bearer | `200 text/event-stream`，SSE 状态快照 |
| DELETE | `/v1/moss/transcriptions/:jobId` | Bearer | `200`，取消未结束任务，返回当前状态；不是删除结果 |

详细流式协议与接入示例见 [Speech API contract](speech-api-frontend.md)，HTTP schema 见 [OpenAPI 3.1](speech-api.openapi.yaml)。下文示例输出都是结构示意，不是真实推理记录。

### 2.1 检查能力

以下命令在调用方服务器执行，预先通过安全方式配置环境变量，不把真实 key 粘贴到文档或提交中：

```bash
curl --fail-with-body "$HABLABLA_SPEECH_URL/healthz"
curl --fail-with-body "$HABLABLA_SPEECH_URL/v1/capabilities" \
  -H "Authorization: Bearer $HABLABLA_SPEECH_API_KEY"
```

能力响应包含 `streaming.model/transport/audio` 和 `offline.model/transport/acceptedContentTypes/maximumUploadBytes`。以接口返回的 MIME 列表和上限为准。

### 2.2 Parakeet 实时转写

调用顺序：自己的服务器申请 ticket → 浏览器连接返回的 URL → 等待 `ready` → 连续发送音频帧 → 发送 `finish` → 等待最终转写。

```bash
curl --fail-with-body "$HABLABLA_SPEECH_URL/v1/parakeet/sessions" \
  -H "Authorization: Bearer $HABLABLA_SPEECH_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"origin":"https://partner.example.com","language":"en","audio":{"encoding":"pcm_s16le","sampleRateHz":16000,"channels":1}}'
```

`origin` 必填且须在白名单中；上面的占位域名需要替换。`language` 默认 `en`，格式为两位小写语言代码，可附地区后缀，例如 `en-US`；格式通过不代表模型支持该语言。`audio` 三个值必须与示例一致。

```json
{
  "sessionId": "st_...",
  "websocketUrl": "wss://speech.example.com/v1/parakeet/stream?ticket=ticket_...",
  "ticketExpiresAt": "2026-09-12T18:30:00.000Z"
}
```

ticket 有效期 60 秒、仅用一次，升级连接的 `Origin` 必须匹配。重连需要重新申请。不要把返回 URL 记入普通日志。

- 音频必须是 **16 kHz、单声道、signed Int16 little-endian PCM**，不是 WebM Blob 或浏览器 MediaStream 对象。
- 每个二进制帧：4 字节 UInt32 LE 序号（从 0 连续递增）+ 4 字节 UInt32 LE 采样点数 + PCM 数据。每帧 1–16000 个采样点，PCM 字节数等于采样点数 × 2。
- JSON 文本帧支持 `{"type":"start"}` 和 `{"type":"finish"}`；`start` 不代替创建 session 时的音频参数。结束前应先发送剩余 PCM。
- 返回事件包括 `connected`、`progress`、`ready`、`transcript`、`error`。`connected` 不表示模型加载完成。
- `transcript` 含 `revision`、`confirmedText`、`volatileText`、`audioEndMs`、`isFinal`。按 revision 更新完整快照，不能把每个事件直接追加成文本。
- 连接关闭不等于成功；以 `isFinal: true` 为最终文本标志。

### 2.3 MOSS 完整文件转写与说话人分段

```bash
# 同一逻辑上传的重试必须复用这个值；新录音才生成新值。
speech_request_id=$(uuidgen)
curl --fail-with-body "$HABLABLA_SPEECH_URL/v1/moss/transcriptions" \
  -H "Authorization: Bearer $HABLABLA_SPEECH_API_KEY" \
  -H "Idempotency-Key: $speech_request_id" \
  -F 'audio=@/absolute/path/recording.webm;type=audio/webm' \
  -F 'language=auto' \
  -F 'hotwords=["Hablabla"]' \
  -F 'clientReference=meeting-123'
```

| 字段 | 约束 |
| --- | --- |
| `audio` | 必填、非空文件；MIME 必须在能力接口返回的列表中 |
| `language` | 默认 `auto`；也接受 `en`、`zh`、`en-US` 等格式，不保证模型语言覆盖 |
| `hotwords` | 可选 JSON 字符串数组，最多 64 项，每项最多 80 字符 |
| `clientReference` | 可选业务关联字符串，超过 200 字符会被截断；不是鉴权凭证 |
| `Idempotency-Key` 请求头 | 必填，去空格后 1–200 字符；同 key 命中存活任务时直接返回它，不比较新文件内容 |

不要自行设置 multipart 的 `Content-Type`，让 curl/fetch 生成 boundary。当前 MIME 列表：`audio/wav`、`audio/x-wav`、`audio/mpeg`、`audio/mp4`、`audio/x-m4a`、`audio/webm`、`audio/ogg`。文件名为 `.mp4` 不意味着可用 `video/mp4` 上传。

默认上传限制为 200 MiB，原始 multipart 请求体也受此限制，须为字段和封装开销留余量。后端用 FFmpeg 解码、转单声道并重采样，再交给 MOSS。

首次创建返回：

```json
{"jobId":"moss_...","status":"queued","statusUrl":"/v1/moss/transcriptions/moss_...","eventsUrl":"/v1/moss/transcriptions/moss_.../events"}
```

同 key 重试命中时是 `200` 的任务快照，而不是上述 `202` 创建结构。返回的两个 URL 是相对路径，须与语音网关地址拼接。

```bash
# 用创建响应中的真实 jobId 替换。
speech_job_id='moss_...'
curl --fail-with-body "$HABLABLA_SPEECH_URL/v1/moss/transcriptions/$speech_job_id" \
  -H "Authorization: Bearer $HABLABLA_SPEECH_API_KEY"
curl --fail-with-body -N "$HABLABLA_SPEECH_URL/v1/moss/transcriptions/$speech_job_id/events" \
  -H "Authorization: Bearer $HABLABLA_SPEECH_API_KEY"
# 仅在用户要求取消时调用：
curl --fail-with-body -X DELETE "$HABLABLA_SPEECH_URL/v1/moss/transcriptions/$speech_job_id" \
  -H "Authorization: Bearer $HABLABLA_SPEECH_API_KEY"
```

任务快照固定含 `jobId/status/progress/clientReference`，按状态可附 `result` 或 `error`。状态为 `queued → processing → completed/failed`，未结束任务可变为 `cancelled`。`completed.result` 含 `model/language/durationMs/text/segments`；每段含 `id/startMs/endMs/speakerId/text`，时间单位为毫秒。说话人分段不代表识别出真人姓名，也不保证一定有分段。

SSE 使用 `data: <任务快照 JSON>`，无需自定义事件名。客户端收到终态后应主动断开；当前代码在已结束任务的新订阅场景不保证立即关闭连接。浏览器原生 EventSource 不能按这里的方式携带 Bearer header，应由调用方服务器代理或使用支持该 header 的流式请求。

### 2.4 错误与运行限制

HTTP 错误结构为 `{"error":{"code":"...","message":"...","retryable":false,"requestId":"req_..."}}`；WebSocket 错误还带 `type: "error"`。错误信息可能包含 worker/FFmpeg 诊断，应按敏感数据处理，不直接写入公开日志。

| 状态 | 常见原因 |
| --- | --- |
| 400 | 参数、帧配置或 multipart 无效；未提供有效 Idempotency-Key |
| 401 | 缺少或无效 Bearer key |
| 403 | Origin 不允许；WebSocket ticket 缺失、过期、已使用或不匹配 |
| 404 | 未知接口或不存在/已过期的 jobId |
| 413 | 超过上传限制 |
| 415 | 文件 MIME 不支持 |
| 500 | 网关内部异常 |

异步模型失败表现为任务 `status: "failed"`，查询 HTTP 仍可为 200。只在 `retryable` 和业务状态允许时重试；新上传 key 会创建新任务。

任务和 ticket 存于进程内存，重启即失效。任务在创建约一小时后且进入终态时可被定时清理，不是完成后再保留一小时。取消不是结果删除。MOSS 串行排队，目前不是持久化任务系统。API key 也不提供按用户的任务隔离：已授权 key 共享任务空间，不能把这个原型当多租户公共服务。

## 3. Web 内部 API（不要直接暴露公网）

### 3.1 会议分析原型：`/api/meeting-agent`

- `GET` → `200 {configured: boolean, model: string}`。configured 只表示服务端有非空 key，不验证账号、模型或余额。
- `POST` → 非流式 JSON；服务端读取 `OPENAI_API_KEY` 和 `OPENAI_MODEL`。模型值须由后端配置并实际验证，不在调用 body 中传 key 或模型。
- 该路由目前没有自身的用户鉴权、可信 Origin 校验或限流，不能直接接入公网。没有 Local/OpenAI 前端开关，也不会自动从本地推理切换过来。

下面的调用会把截取后的转写和问题发送到外部模型服务；仅用经授权的数据，示例使用虚构内容：

```bash
curl --fail-with-body http://127.0.0.1:3100/api/meeting-agent \
  -H 'Content-Type: application/json' \
  -d '{"meetingId":"MTG-example","transcript":"Alice will send the draft tomorrow.","question":"Summarize the agreed action.","structured":true}'
```

请求四个字段均必填，不允许额外字段：`meetingId` 长度 1–120，`transcript` 1–50000，`question` 去空格后 1–1000，`structured` 为 boolean。服务端还会截取 UTF-8 prompt，不能声称完整分析长篇转写；无多轮聊天历史输入。

`structured: false` 返回 `{text: string}`；`true` 返回 `{text: string, result: {summary, decisions, actions, questions}}`。decisions 含 `text/evidence`；actions 含 `title/description/owner/due/evidence`。证据必须能在输入转写中匹配；生成建议不会保存任务。服务端请求设置 `store: false`，这不等于音频/文本完全不出本机或对提供方所有保留政策作保证。

无 key 返回 503 `{error: string}`。当前实现把参数校验失败、取消和提供方错误都映射为 502；不要假设无效 body 一定返回 400。真实模型调用尚未在本次文档任务中验证。

### 3.2 任务审批：`/api/followups`

这是既有本机审批接口，不用语音网关的 Bearer key。限定 loopback Host；POST 必须有精确同源 Origin、JSON Content-Type 和有效会话 Cookie。首次 `GET ?session=1` 建立 HttpOnly Cookie 并返回 `{status:"ready"}`，不代表外部任务存储已配置。

| 调用 | 参数 | 响应用途 |
| --- | --- | --- |
| GET | `?incidentId=MTG-...` | 已连接时返回 `status/workspaceId/identityName/tasks`；字段仍名为 incidentId |
| GET | `?taskId=...` | `{task: ...}`，读回任务 |
| POST | `{operation:"propose",incidentId,title,details}` | `{proposal: ...}`，仅创建待审批提案 |
| POST | `{operation:"approve",proposalId:"UUID"}` | `{task: ...}`，明确用户批准后才写入并读回 |
| POST | `{operation:"deny",proposalId:"UUID"}` | `{status:"declined"}`，不创建任务 |

依赖服务端 `AMBIGUOUS_API_KEY` 和可写审批存储。未配置时普通 GET 返回 200 `status: "unconfigured"`，POST 返回 503。其他主要状态为 400 校验失败、403 来源/会话不允许、413 body 过大、502 提供方或审批失败；错误为 `{error: string}`。不能跳过用户确认自动调用 approve。

## 4. 其他路由：与语音服务区分

以下只做清单，不作为 William 语音网关的稳定对外合同：

| 方法 / 路径 | 定位 |
| --- | --- |
| GET/POST/OPTIONS `/api/copilotkit/*` | 继承模板的 SDK runtime 路由，不是语音 HTTP API |
| GET/POST/OPTIONS `/api/mobile-copilotkit/*` | 移动模板 runtime 路由 |
| POST `/api/search` | 继承搜索示例；body 为 `query` 和可选 `results` |
| POST `/api/realtime-token` | 继承语音示例，返回临时客户端凭证；不是 Parakeet ticket |

这些模板不能因“存在源码”就视为已对外发布；对外部署前需要各自的认证、授权和数据处理约定。

`/care` 演示与 `/api/care/*` 草稿已按用户要求移除。医疗场景仅保留在 [设计文档第 24 节](../TECH_STACK.md#24-doctor-and-patient-assistant--proposed-design)；前端接入使用本文的通用转录接口，William 不实现医疗前端、报告或浏览器 Agent。

Companion 有独立的 pairing/connect/poll/heartbeat/authorize/events/revoke 协议，见 [Companion protocol](../apps/companion/PROTOCOL.md)。当前 relay 是开发 fixture，不是语音端口上的路由，也没有已实现的公共设备管理 API。

目前未找到独立公开的 Nemotron HTTP 接口、speaker enrollment/identity HTTP 接口、会议 CRUD 或持久化 analysis-job API。不要把架构计划或 Python/Swift 模块误写成已开放接口。

## 5. 联调交付清单与源码依据

后端交付：实际 HTTPS/WSS 地址、单独安全发送的 key、允许的浏览器 Origin、版本、容量限制和模型 ready 的实测结果。调用方交付：服务器代理、PCM 帧序列、文件 MIME、幂等重试、取消及错误处理。本文仅记录接口，不实现前端。

- [语音路由](../apps/speech-gateway/src/server.ts)、[配置](../apps/speech-gateway/src/config.ts)、[帧协议与 MIME](../apps/speech-gateway/src/protocol.ts)
- [会议分析路由](../apps/web/src/app/api/meeting-agent/route.ts)、[请求及结果生成](../apps/web/src/lib/server/openai-meeting.ts)
- [审批路由实现](../apps/web/src/lib/server/followup-http.ts)

核对方式：源码逐项检查、文档链接和 diff 检查；本次没有发送真实音频、调用计费模型、写入任务或部署服务。
