# omdsh-remctrl 宿主侧 API 调研报告

Harness checkout: `/Users/haowang/Workdir/Projs/Gits/deepseek-harness`(包路径下文简写为 `pkgs/`)。
插件模板: `/Users/haowang/Workdir/Projs/Gits/omdsh-plugins/omdsh-code`(下文简写为 `omdsh-code/`)。

---

## 1. host Context 服务表

**结论**: 服务解析用 `ctx.get('名字')`(omdsh-code 的做法,见 omdsh-code/src/index.ts:94-95),服务名就是 cordis Service 构造时的字符串;`ctx.webServer` 因有 declare-module 合并可直接 `ctx.webServer.xxx` 访问。注意 omdsh-code/src/index.ts:89-95 的警告:插件在 monorepo 外编译时,浏览器侧与宿主侧的 `Context` 声明会被合并进同一个程序,`ctx.sessions` 等点号访问可能解析成"编译器先看到的那一份"——因此**按名字 `ctx.get()` + `as unknown as T` 是插件侧最稳的写法**。`webRuntime` 没有 declare-module 类型(动态 `ctx.provide`),必须用结构镜像(omdsh-code/src/index.ts:78-81)或 `ctx.get('webRuntime') as unknown as ...`。

### 签名清单(服务名 → 类型 → 声明位置)

| 服务名 | 类型 | Context 声明位置 | Service 构造位置 |
|---|---|---|---|
| `webServer` | `WebServer` | pkgs/host/webserver/src/index.ts:18-22 (`declare module '@deepseek-ai/cordis'`) | 同文件 :75 `super(ctx, 'webServer')` |
| `sessions` | `SessionStore` | pkgs/core/session/src/index.ts:37-40 | 同文件 :797 `super(ctx, 'sessions')` |
| `webRuntime` | 动态 provide,无类型合并 — 实际值是 `WebRuntimeValues` | 无声明(pkgs/bundle/web-app/src/index.ts:138 `ctx.provide(WEB_RUNTIME_SERVICE, runtime)`,`WEB_RUNTIME_SERVICE = 'webRuntime'` :32);类型 `WebRuntimeValues { lanAddresses: string[]; trustedHosts: string[] }` 见同文件 :59-64 | — |
| `settings` | `SettingsProvider` | pkgs/settings/settings/src/index.ts:132-134 | 同文件 :367 `super(ctx, 'settings')` |
| `credentials` | `CredentialProvider` | pkgs/credentials/credentials/src/index.ts:49-51 | 同文件 :62 `super(ctx, 'credentials')` |
| `agents` | `AgentRegistry` | pkgs/core/agent/src/index.ts:37-38(另含 `agent?: Agent` 访问器 :39-44) | 同文件 :267 `super(ctx, 'agents')` |
| `apiProxy` | `ApiProxy` | pkgs/host/apiproxy/src/index.ts:34-37 | — |
| `typertGateway` | `TypertGateway` | pkgs/api/gateway/src/types.ts:50-53 | — |
| `connection` | `HostConnectionHandle` | pkgs/client/connection/src/rpc-host.ts:35-40 | 同文件 :52 `super(ctx, 'connection')` |
| `webStartup` | 动态 provide(`WebStartupValues`) | 无声明,pkgs/bundle/web-app/src/startup.ts:19 (`WEB_STARTUP_SERVICE = 'webStartup'`) | — |

omdsh-code 的写法(证据):

- `export const inject = ['webServer', 'sessions', 'webRuntime']` — omdsh-code/src/index.ts:48
- `const sessions = ctx.get('sessions') as unknown as SessionStore` — omdsh-code/src/index.ts:94
- `const webRuntime = ctx.get('webRuntime') as unknown as WebRuntimeTrust` — omdsh-code/src/index.ts:95
- `ctx.webServer.registerUpgrade(...)`(点号访问,依赖 declare-module)— omdsh-code/src/index.ts:132

---

## 2. webServer 路由注册(pkgs/host/webserver/src/index.ts,包 `@deepseek-ai/dsh-host-webserver`)

**结论**: `registerUpgrade` 只做**精确路径**的 HTTP Upgrade(WS 握手由插件自己的 `WebSocketServer({noServer:true})` 完成,见 omdsh-code/src/index.ts:131-145)。普通 GET/POST 用 `register()`:handler 拿到原生 `node:http` 的 `IncomingMessage`/`ServerResponse`,**可以长挂响应(文档明确支持 SSE 语义,见 :32)**——所以 remctrl 的手机页面和配对端点都用 `register({kind:'exact'|'prefix', ...})` 即可,不需要 upgrade。

### 服务接口全量方法

```ts
// WebRoute — :28-34
interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string                       // 绝对路径,无尾部斜杠
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
// WebUpgradeRoute — :37-42
interface WebUpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}
// Config — :45-50
interface Config { host: '127.0.0.1' | '0.0.0.0'; port: number }  // port 0 = 系统分配

// class WebServer extends Service — :59
register(route: WebRoute): () => void            // :94;重复 (kind,path) 抛错 :96-98
registerUpgrade(route: WebUpgradeRoute): () => void  // :109;重复 path 抛错 :110-112
registerFallback(handler: WebRoute['handler']): () => void  // :125;唯一席位,第二人注册抛错 :126-128
tapIndex(transform: (html: string) => string): () => void  // :139;index.html 变换
applyIndexTaps(html: string): string             // :259
get port(): number                               // :79(监听端口,port 0 时为 OS 实际分配值)
get host(): Config['host']                       // :84
```

请求分发: exact 表 → 最长前缀表(`match()` :242-251)→ fallback(SPA dist,由 `@deepseek-ai/dsh-host-frontend-static` 通过 fallback 席位持有)→ 404(:149-165);upgrade 事件按 pathname 查 upgrades 表,未命中直接 `socket.destroy()`(:181-214)。invariant 探针会验证 route disposer 对称性(pkgs/host/webserver/src/invariant.ts:26-50)。

---

## 3. /api 网关与信任围栏(pkgs/client/connection,包 `@deepseek-ai/dsh-client-connection`)

**结论**: 围栏不是认证,只是 DNS-rebinding + 跨站防御。手机从局域网访问时,若宿主绑定 `0.0.0.0`,`webRuntime.trustedHosts` 里已含本机 LAN IP 字面量,手机请求的 Host(LAN IP:port)会**通过**围栏——即"trusted"≠"被允许遥控"**;**且 `PRIVILEGED_METHODS` 里所有配置/凭据面方法(settings.*、credentials.*、host.pickDirectory 等)永远锁在 loopback**(index.ts:89-119,强制点在 :145-149)。所以 remctrl 必须自建 pairing token,不能靠 trustedHosts。

### 围栏实现

- `isTrustedApiRequest(request, trustedHosts)` — pkgs/client/connection/src/api-request-trust.ts:96-123:
  1. Host 头必须解析为 loopback(`isLoopbackHostname`,loopback-hostname.ts;omdsh-code 的等价实现 omdsh-code/src/trust-fence.ts:44-50)或 trustedHosts 权威(:108);
  2. `sec-fetch-site: cross-site` 拒绝(:111);
  3. 有 Origin 时必须与 Host 同源;无 Origin 放行(:116-122)。omdsh-code 的本地复刻:omdsh-code/src/trust-fence.ts:75-89。
- `trustedHosts` 来源链:
  - client-connection 配置 `ConnectionConfig.trustedHosts?` — pkgs/client/connection/src/index.ts:50-67;
  - bundle 里 wiring:`trustedHosts: !!js ctx.webRuntime.trustedHosts` — pkgs/bundle/web-app/cordis.patch.yml(connection 行);
  - `webRuntime.trustedHosts` 由 `resolveLanTrust(bindHost, extra)` 算出:`0.0.0.0` 绑定时采样全部 IPv4 非内网接口地址 + `--trusted-host` 追加值 — pkgs/bundle/web-app/src/index.ts:85-92。
- 宿主侧 `/api` 路由注册(client-connection 前缀路由 + 围栏):pkgs/client/connection/src/index.ts:161-173;WS 事件下行 `/api/events.mux`、`/api/events.host` 同样过围栏:同文件 :181-194。

### 现成的认证/凭据基建(给 pairing 复用)

**结论: harness 里没有任何现成的配对/一次性码机制**——全仓 grep `pairing|pairCode|one-time` 无相关实现(仅无关的 "pairing" 出现在 tools/bash 等);`packages/guard` 是 agent 循环护栏(repeat-tool-reminder、timeout-policy),与认证无关。可复用的只有两块存储缝:

- **Credentials**(`ctx.credentials: CredentialProvider`,抽象服务,名字 'credentials')— pkgs/credentials/credentials/src/index.ts:60-99:
  - `resolve(ref): Promise<ResolvedCredential | undefined>` :73
  - `describe(ref): Promise<CredentialInfo>` :81
  - `set(ref, value): Promise<void>` :91(空值拒绝)
  - `unset(ref): Promise<void>` :99
  - `ref` 是环境变量名风格(`credentialRef(value)` :23)。设计目标是模型凭据,写入口被 loopback 锁;可勉强存持久配对密钥,但不是为设备配对设计的。
- **Settings**(`ctx.settings: SettingsProvider`,名字 'settings')— pkgs/settings/settings/src/index.ts:
  - `register<T>(ns, schema, options?): SettingsScope<T>` :435-470(`SettingsScope = { get(); watch(cb); update(patch); replace(section) }` :103-128,注册是 fiber-scoped effect)
  - 服务级 `describe(opts?)` :479、`get(ns)` :519、`update(ns, patch, expectedRevision?)` :530、`replace(ns, section, expectedRevision?)` :549、`mutate(ns, ops, expectedRevision?)` :565
  - `settingsNamespace('omdsh-remctrl')`(:26)可用于持久化"已配对设备/长期密钥";短命 pairing code 不需要持久化。
- **自定义 RPC 通道**(可做 remctrl 自己的 JSON-RPC 面,但围栏仍只有 loopback/trusted-host 两档,自身 token 校验要写在 handler 里):
  - `ctx.connection.rpc.handle(channel, handler, {authority:'loopback'|'trusted-host'})` — pkgs/client/connection/src/rpc-host.ts:56-63、90-115;handler 签名 `(endpoint, payload, signal) => Promise<RpcResult>`(rpc.ts:15-19、25-53)。
  - typertGateway 可拦截 `/api` 下端点(claim 条件是服务带 `typertRemote` 绑定)— pkgs/api/gateway/src/index.ts:104-111;插件自建服务要用 `@typert remote` 标记,拦截 authority 同样仅两档。

### 最小配对方案(建议,基于以上事实)

1. 宿主插件(apply 里)用 `node:crypto`(`randomBytes`/`randomInt`)生成一次性 code(如 6 位数字或 ~20 字符 token)+ 短 TTL(如 5 分钟),存进程内 Map(code → {expiresAt, used});
2. 客户端插件半在 web GUI 里渲染二维码/短码(`window` 端 URL:`http://<LAN-IP>:<port>/omdsh-remctrl/pair?code=…`,LAN-IP 从 webRuntime.lanAddresses、端口从 webServer.port 取——见第 8 节);
3. 手机打开自己的静态页 → POST code 到 `/omdsh-remctrl/pair`(插件自有 exact route)→ 宿主验证一次性 code → 签发会话 token(随机 256-bit)并一次性返回(HTTPS 缺失下至少绑定 code+短 TTL);
4. 手机后续所有调用走插件自有前缀 `/omdsh-remctrl/*`(普通 HTTP route + 自有 WS route),每请求校验 `Authorization`/query 里的 token;token 表进程内留存(可选用 settings namespace 持久化为"记住设备");
5. **不要**复用 `/api` 给手机:手机 Host 可能过不了围栏(loopback 绑定)、配置面方法永远 loopback-only、且围栏没有 token 挂钩点。

---

## 4. SessionStore(pkgs/core/session/src/index.ts,包 `@deepseek-ai/dsh-session`)

**结论**: `ctx.sessions` 是纯内存事件溯源 store;枚举用 `list()`,按 id 取 `get(id)?.header.cwd`;事件流是 cordis Events(`session/event` 等),插件可直接 `ctx.on(...)` 订阅——api-proxy 的 mux 流就是这么做的(证据见第 5 节)。

### SessionStore 接口全貌(:792-1155)

```ts
create(id?: SessionId, options?: CreateSessionOptions): Session        // :830(已 enter+announce)
prepare(id?: SessionId, options?: PrepareSessionOptions): Session      // :863(未 enter)
enter(session: Session): () => void                                    // :913(返回 detach)
announce(session: Session): void                                       // :968
flush(session: Session): Promise<boolean>                              // :1022(持久化检查点)
get(id: SessionId): Session | undefined                                // :1055
list(): Session[]                                                      // :1063(创建序,新数组)
fork(source: Session | SessionId, boundary?: number, childSessionId?: SessionId): Session  // :1081
```

### Session 类关键成员

- `header: SessionHeader`(:443)— 含 `cwd?: string`(绝对路径,types.ts:73)、`id/createdAt/parentSession/seedLength/origin/delegationDepth/agentPreset`(types.ts:61-99)。**没有 title** —— 标题走 `session/title` 事件 + sessionProjections(见第 5 节 SessionSummary.projections)。
- `id` :446、`events: readonly SessionEvent[]` :559(不可变快照)、`seq` :565、`firstLiveSeq` :472
- `append<T>(type, data, ...opts): SessionEvent<T>` :604-655(surface 事件必须带 `surfaceOp`)
- `deriveMessages(): Message[]` :726、`requestHeader()` :670、`requestContext()` :691、`surface` :431

### 事件(declare module '@deepseek-ai/cordis' → interface Events,:42-86)

- `'session/created'(this, session: Session)` :54
- `'session/disposed'(this, session: Session)` :64
- `'session/event'(this, session: Session, event: SessionEvent)` :76 — **追加推送流,插件订阅入口**
- `'session/flush'(this, session: Session): Promise<void> | void` :85 — awaited 并行检查点

均 scope-filtered(`Scoped<Session>`)。事件字典 `SessionEventMap`(types.ts:236-333):`turn/start`、`turn/end`(带 `TurnEndReason`)、`step/start`、`step/end`、`user/message`、`assistant/chunk`、`assistant/message`(带 usage)、`tool/call`、`tool/result`、`todo/write`、`request/header`、`request/context`、`session/end-seed`。事件信封 `SessionEvent = {type, seq, time, data, surfaceOp?, sourceEventSeqs?, ignorable?}`(types.ts:404-436)。

---

## 5. 程序化驱动会话(发消息 + 收回复流)

**结论**: 没有名为 `interaction` 的服务(全仓无此服务名)。发送链路是:**web RPC `session.prompt` → ApiProxy(`ctx.apiProxy`/`ctx.get('apiProxy')` 宿主内可直接调)→ `Agent.followup()/steer()`**。回复流:官方客户端用 `/api/events.mux` WebSocket(帧=MuxFrame);插件自己复制这条路径 = `ctx.on('session/event')` + `agent/status` 等,转发进自有 WS。宿主侧插件也可以完全不走 HTTP,直接调 `apiProxy.sessions.*` 或 `ctx.agents.get(id).followup(...)`。

### (a) /api RPC 方法表(宿主侧 host/apiproxy)

- RPC map 键:`'session.list'|'session.search'|'session.create'|'session.history'|'session.models'|'session.selectModel'|'session.rename'|'session.fork'|'session.prompt'|'session.attachment'|'session.updateQueue'|'session.cancel'` + subagent.*/host.*/workspace.*/skill.*/agentPreset.*/goal.*/settings.*/credentials.*/llm.* — pkgs/host/apiproxy/src/api/rpc-map.ts:24-77(wire 路径 = `POST /api/session.prompt` 等;`RpcRequest<P> = {rpcId, payload}`,见 api/rpc.ts)。
- `SessionsApi` 全签名 — pkgs/host/apiproxy/src/api/sessions.ts:232-373,关键:
  - `list(request: RpcRequest<{cursor?: string}>): Promise<RpcResponse<{items: SessionSummary[]}>>` :234 — `SessionSummary = {sessionId, updatedAt, running, blank, parentSessionId?, origin?, cwd?, agentPreset?, projections?}`(:177-222),`projections.values` 里带标题等(SessionProjectionMap,title 键由 session-projection 注册)。
  - `history(request: RpcRequest<{sessionId, beforeSeq?, maxMessages?}>): Promise<RpcResponse<{events: HistoryEntry[], hasMore, projections?}>>` :282-283(`HistoryEntry = {event: SessionEvent, view?}` :64-67)。
  - `prompt(request: RpcRequest<{sessionId, mode:'queue'|'steer', content: PromptContentPart[], clientTimeZone?}>): Promise<RpcResponse<{accepted: true, command?}>>` :347-353。
  - `cancel(request: RpcRequest<{sessionId}>): Promise<RpcResponse<{accepted: true}>>` :371。
  - `create(request: RpcRequest<{workspaceId?|cwd?|sessionId?|agentPreset?}>): Promise<RpcResponse<{sessionId, agentPreset?}>>` :261-262。
  - `rename({sessionId, title})` :312-313(追加 `session/title` 事件)。
- 宿主实现 `createApiProxy(ctx, defaults)` — pkgs/host/apiproxy/src/api-proxy.ts:1106;**prompt 实现** :2461-2517:经 `turnAgentFor` 解析到 `Agent` 后 `mode==='steer' ? agent.steer(message) : agent.followup(message)`(:2498-2499);create 走 `ctx.agents.create({sessionId, seed, meta, agentOptions, setup})`(:2423-2436);cancel 走 `agent.cancel({kind:'user'},{keepInbox:true})`(:2631);inbox 快照读 `agent.inbox.nextTurn / nextStep`(:1332)。
- `ApiProxy` 聚合接口(`sessions/subagents/host/workspace/skills/agentPresets/events/goals/settings/credentials/llm/downloads/respond`)— pkgs/host/apiproxy/src/api/index.ts:22-38。宿主插件可 `ctx.get('apiProxy')` 直接程序化调用。

### (b) 底层 Agent 服务接口(包 `@deepseek-ai/dsh-agent`)

- `interface Agent` — pkgs/core/agent/src/runtime-types.ts:64-144:
  - `readonly id/session/inbox/status('idle'|'running')/ctx` :66-76;`cancel(cause: AgentCancelCause, options?: CancelOptions)` :85;`whenIdle(): Promise<void>` :93;`send(message, target: InboxTarget, wakeup)` :117;`followup(message: UserMessage): void` :124;`steer(message: UserMessage): void` :133;`inject(message: UserMessage): void` :143。
  - `AgentStatus = 'idle' | 'running'` :50。
- `AgentRegistry`(`ctx.agents`)— pkgs/core/agent/src/index.ts:256-706:
  - `create(options: CreateAgentOptions): Promise<AgentHandle>` :405;`resume(options: ResumeAgentOptions): Promise<AgentHandle>` :424;`register(agent): () => void` :450;`get(id): Agent | undefined` :583;`list(): Agent[]` :603。
  - `CreateAgentOptions = {sessionId, meta?{cwd,parentSession,seedLength,origin,delegationDepth,agentPreset}, seed?, agentOptions?, signal?, setup?}` :80-133;`ResumeAgentOptions = {resumeSessionId, agentOptions?, signal?, setup?}` :139-149。
  - `AgentHandle = {agent, dispose(): Promise<void>}` :172-175。
- 事件:`'agent/created'|'agent/disposed'|'agent/status'|'agent/inbox/*'|'agent/session-start'|'agent/pre-step'|'agent/request'|'agent/request-error'|'agent/turn-stopping'|'agent/error'` — runtime-types.ts:146-291。

### (c) 事件流(手机端拉取/流式接收)

- 浏览器端 WS 下行:`/api/events.mux`(全会话聚合)+ `/api/events.host`(宿主级)— 注册于 pkgs/client/connection/src/index.ts:181-195,载体 `WebSocketDownlinks`(client/connection/src/websocket-downlink.ts:51-82);SSE 变体存在于 fetch handler(`sseResponse()` pkgs/host/apiproxy/src/fetch/handler.ts:203-236;`/api/events.mux` GET → SSE :254-258),但 connection 的 HTTP 层把这两个 GET 拦成 426 upgrade required(client/connection/src/index.ts:150-155),即**浏览器实际走 WS**。
- 帧:`MuxFrame`(`session/event`(带 view)、`session/subscribed`、`session/queue`、`session/jobs`、`session/projection`、approval/question 帧、`stream/error`)— pkgs/host/apiproxy/src/api/events.ts:69-108;`HostFrame`(`host/session-added/removed/status`、`host/agent-error`、workspace 帧、`host/remote-event`)— :127-155;`EventsApi.mux/host` 签名 :47-63。
- mux 流的产生方式(remctrl 复制此模式即可):每个订阅者 `ctx.on('session/event', …)` 转发成 `session/event` 帧 + `ctx.on('session/created'|'session/disposed'|'agent/status'|'agent/error')` — api-proxy.ts:3475-3521(以及 :3560-3566)。

---

## 6. QR 码 / 二维码

**结论: harness 仓库与 omdsh-plugins 根 node_modules 均无 `qrcode` 包**(对 harness 全部 packages 的 package.json 及两处 node_modules 的 `qrcode` 目录检索均为空;harness 内也未见任何二维码生成依赖)。方案:手机配对直接用**短数字码**(`node:crypto` 生成,`randomInt`/`randomBytes` 取模),或给 omdsh-remctrl 自行添加 `qrcode` 依赖(生成 data URL 由 web 客户端半渲染)。数字码在输入体验上对手机也完全可行,无需新依赖。

---

## 7. 路由前缀约定

**结论**: webServer 的路径表是平面的,没有保留字表;唯一硬约束是 `/api` 前缀已被 client-connection 认领为 prefix 路由(pkgs/client/connection/src/index.ts:161-173),重复注册同 (kind,path) 会抛错(webserver index.ts:96-98)。插件用自己的前缀(omdsh-code 用 `/omdsh-code`,TERMINAL_PATH `/omdsh-code/terminal` — omdsh-code/src/shared.ts:12-15)即可;**普通请求(手机页面、配对端点)一律走 `webServer.register({kind:'exact'|'prefix', handler(req,res)})`**,handler 是原生 node http,可读 body、可长挂 SSE;未匹配路径会落进 fallback(SPA dist,由 `@deepseek-ai/dsh-host-frontend-static` 持有 fallback 席位,bundle/web-app/src/index.ts:139),所以若想从手机直达静态页,注册 exact route 覆盖 SPA 兜底即可。WS 则用 `registerUpgrade` + 自有 `WebSocketServer({noServer:true})`(omdsh-code/src/index.ts:131-145)。**不要**把插件路由挂到 `/api/*` 下(那是 RPC 信封协议通道,GET 行为被 connection 定死 :150-155)。

---

## 8. webRuntime 与 bind 信息(手机要连的 LAN 地址)

**结论**: 端口 = `ctx.webServer.port`(port 0 时为 OS 分配值,webserver index.ts:79-81);bind 主机 = `ctx.webServer.host`(:84-86);LAN 地址列表 = `webRuntime.lanAddresses`——**仅当 bind 是 `0.0.0.0` 时才有值**(resolveLanTrust:85-92)。重要警示:

- 默认 bind 是 `127.0.0.1`(bundle patch:`host: !!js ctx.webStartup.host ?? '127.0.0.1'` — cordis.patch.yml webserver 行);
- CLI 目前**故意拒绝 `--host 0.0.0.0`**(startup.ts: "intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead"),即用户需显式 `--host <LAN-IP>` 才能让手机连上。remctrl 的配对 UI 应检测 `lanAddresses.length === 0` 并提示用户用 LAN IP/端口重启。
- `webRuntime: WebRuntimeValues { lanAddresses: string[]; trustedHosts: string[] }` — bundle/web-app/src/index.ts:59-64;`ctx.provide` :138;CLI 标志来源 `webStartup: WebStartupValues {host?, port?, trustedHosts}` — bundle/web-app/src/startup.ts:16-21。
- URL 行打印本地 + LAN URL(方便用户复制):bundle/web-app/src/index.ts:164-169。

---

## 附:测试模板

omdsh-code 的宿主单测演示了最小编排:fake `ctx = {effect, get, webServer}` + 名字解析服务,不启动真实 server — omdsh-code/tests/host-apply.spec.ts:33-62;路由表对称性由 harness 的 invariant 探针保障(pkgs/host/webserver/src/invariant.ts:26-50)。
