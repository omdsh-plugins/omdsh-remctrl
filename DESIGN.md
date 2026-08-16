# omdsh-remctrl 设计

手机上看见 dsh 正在做什么，批准它要做的事，给它派新活。

前置事实见 [`RESEARCH-harness-host-api.md`](RESEARCH-harness-host-api.md)；本文只写在那些事实之上的选择，以及调研之后新核实到的三条硬约束。

已定：**可达性走 Tailscale**，**手机端权限上限 `drive`（能派活）**。

---

## 0. 一句话架构

**remctrl 在宿主进程里开自己的监听端口，用自己的 token 认证，转发到进程内的 `apiProxy`。**

它不新建数据面。`ctx.get('apiProxy')` 已经把会话列表、历史、实时流、发消息、审批回传全说完了——官方 Web GUI 就是它的一个消费者。remctrl 要造的只有 harness 没有也不该有的东西：设备配对、长期 token、权限档位、方法白名单。

关键点是**它开的是自己的门，不是在 harness 的门框上加一把锁**。理由在第 2 节，那是本设计里唯一一个不显然的决定。

---

## 1. 三个正交的问题

| | 问题 | harness 给了什么 | remctrl 要做什么 |
|---|---|---|---|
| **可达** | 手机在网络上怎么到达宿主进程 | **什么都没有，而且明确关死了**（见 2.1） | 自己监听；绑定地址限死在 tailnet |
| **授权** | 谁被允许遥控 | **没有**。`trustedHosts` 是 DNS-rebinding 防御，不是认证；全仓无配对机制 | 配对码 → 设备 token → 权限档位 → 方法白名单 |
| **表现** | 手机上看什么、能做什么 | **几乎全部**：apiProxy + mux 流 | 一个移动端页面 + 一层帧过滤 |

第 3 层是抄，第 1、2 层是造。设计风险全在 1 和 2。

---

## 2. 为什么开自己的端口

### 2.1 harness 的门根本上不了 tailnet

调研报告记的 `Config.host: '127.0.0.1' | '0.0.0.0'` 不只是 TypeScript 类型，**是运行时 zod schema**：

```ts
// packages/host/webserver/src/index.ts:59-62
static Config: z<Config> = z.object({
  host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(),
  port: z.natural().max(65535).required(),
})
```

而 CLI 侧 `--host 0.0.0.0` 被显式拒绝（startup.ts:70，理由原话：*it would expose remote code execution to the network*）。两条合起来：

- `dsh web --host 100.x.y.z` → CLI 放行（它只拦 `0.0.0.0`）→ 值流进 webserver 行 → **schema 校验失败，boot 直接死**
- `dsh web --host 0.0.0.0` → CLI 拦掉

**harness 的 HTTP 服务实际上只能绑 `127.0.0.1`。** 想让它上 tailnet，只剩改 harness（禁止）或改 profile 的 webserver 行把 host 写成 `0.0.0.0`（等于插件偷偷推翻上游一条明写的安全决定，并且会让 `resolveLanTrust` 自动把 LAN 地址加进 `trustedHosts`，把 `/api` 向整个局域网打开——正是我们要避免的）。

两条都不走。所以门必须是我们自己的。

### 2.2 把手机放进 harness 的门里，代价是 `/api`

即使绕开 2.1（比如 `tailscale serve` 反代到 `127.0.0.1:3080`），也有一个不能接受的后果：**那扇门后面不只有 remctrl**，还有整个 `/api` 和桌面 SPA。

`/api` 的围栏 `isTrustedApiRequest` 判的是 **Host 头**。反代把 Host 传成什么，决定了结果：

- Host 保持 `myhost.tailnet.ts.net` → 不是 loopback、不在 trustedHosts → `/api` 关闭。安全。
- Host 被改写成 `127.0.0.1:3080` → **围栏认为这是本机**，`PRIVILEGED_METHODS`（settings、credentials 全家）连同整个 API 对整个 tailnet 敞开，remctrl 精心设计的 token 闸门被完全绕过。

这取决于反代实现的一个细节。让一个插件的全部安全性挂在"某个外部工具怎么处理 Host 头"上，是不可接受的设计。

**开自己的端口把这个问题消掉，而不是缓解掉**：那扇门后面只有 remctrl 的路由，`/api` 不在那里，SPA 不在那里，Host 头怎么传都无所谓。

### 2.3 顺带白拿的两样

- **干净的 PWA origin。** service worker 的 scope 受路径限制；挂在 `/omdsh-remctrl/` 下要处理 scope 和 `start_url` 的一堆边角，独占 origin 则 scope 就是 `/`。M4 要装 PWA 收推送，这个省事很多。
- **绑定地址自由。** 我们自己的 `node:http` server 不受 2.1 的 schema 管，可以直接绑 tailnet IP。

### 2.4 成本

一个额外端口。数据面完全不受影响——**`apiProxy` 是进程内服务，请求从哪个 listener 进来跟能不能调它没有关系**。这是整个决定成立的支点。

---

## 3. 两个平面

```
┌─ 控制面（桌面 → 宿主）── harness 自己的 loopback 围栏 ──────────┐
│  桌面 GUI 面板  ──ctx.connection.rpc.call('/omdsh-remctrl', …)──►  │
│  出配对码 / 列设备 / 撤销 / 读可达性状态                          │
└──────────────────────────────────────────────────────────────┘

┌─ 数据面（手机 → 宿主）── remctrl 自己的端口 + 自己的 token ─────┐
│  手机 PWA  ──HTTP/SSE──►  remctrl listener  ──进程内──►  apiProxy │
└──────────────────────────────────────────────────────────────┘
```

### 3.1 控制面：不用自己造

harness 有一对现成的对称 API，正好是"插件自有的、只对本机开放的 RPC 通道"：

```ts
// 宿主半
ctx.get('connection').rpc.handle('/omdsh-remctrl', handler, { authority: 'loopback' })
// packages/client/connection/src/rpc-host.ts:56-63、90-115
// authority:'loopback' → trustedHosts 传空数组 → 只有 Host 是环回口的请求能进

// 浏览器半（桌面配对面板）
await ctx.get('connection').rpc.call('/omdsh-remctrl', 'pair/mint', {})
// packages/client/connection/src/rpc.ts:64-79、client/index.ts:68
```

端点：`pair/mint`、`device/list`、`device/rename`、`device/revoke`、`status/read`。

用它而不是给面板开 HTTP 路由，省掉 CORS、省掉一条路由、且 loopback 围栏由 harness 强制执行，不是我们自己写的判断。

> 通道名受 `CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/` 限制（单段，不含斜杠），`/omdsh-remctrl` 合法；端点按 `/` 分段，每段匹配 `/^[A-Za-z0-9_$.-]+$/`。

### 3.2 数据面：remctrl 自己的 listener

```
GET   /                        移动端 shell（HTML）          ✅ M0
GET   /app.css  /app.js        样式与脚本（分开发，CSP 才能不带 unsafe-inline）✅ M0
POST  /pair                    {code} → {token, deviceId, tier}  ✅ M0
GET   /session                 Bearer → {deviceId, label, tier}  ✅ M0
POST  /rpc                     {method, payload} → apiProxy 转发   M1
POST  /respond                 ClientResponse → apiProxy.respond   M2
GET   /stream                  SSE：mux + host 帧下行              M1
GET   /sw.js  /manifest.webmanifest                                M4
POST  /push/subscribe          Web Push 订阅登记                   M4
```

`/session` 是实现时加的，不在最初的表里：它是"已配对"这件事唯一可观测的形式，
也是 M1 之后每条受保护路由的闸门形状——先把它单独立出来，比让第一条业务路由
顺手把认证一起发明出来要好。

三个端点的实现几乎就是转发：

```ts
// /rpc —— 查表，未列即拒
const tier = METHOD_TIER[method]
if (tier === undefined || !allows(device.tier, tier)) return deny(403)
const [domain, fn] = method.split('.')
return await (apiProxy as any)[domain][fn]({ rpcId, payload })

// /respond —— 审批答复是"回声 rpcId 的 client-response"，
// body 结构与 /api/respond 完全一致，逐字透传
await apiProxy.respond(body as ClientResponse)

// /stream —— 每台设备一条 mux + 一条 host
for await (const frame of apiProxy.events.mux({ rpcId, payload: {} }, signal)) {
  if (!visibleTo(device, frame)) continue
  write(`data: ${JSON.stringify(frame.payload)}\n\n`)
}
```

### 3.3 一个必须走 mux 的理由

审批帧 `approval/requested` / `question/requested` 是 apiProxy 内部 server-request 机制产生的，**订阅 cordis 的 `session/event` 拿不到**。自己拼事件流会静默丢掉审批——而审批恰恰是远程控制最核心的场景。

所以数据面必须是 `apiProxy.events.mux()`。走它还白捡一个能力：开流时它会"重放每个会话尚未解决的 approval/question 帧，rpcId 逐字复用"（events.ts:47-56）——手机断线重连后待批事项自动回来，不用自己做状态恢复。

### 3.4 为什么下行是 SSE 而不是 WebSocket

浏览器**既不能给 `EventSource` 也不能给 `WebSocket` 设自定义请求头**。所以带 `Authorization: Bearer` 的方案只剩一个：用 `fetch()` 拿 `ReadableStream` 手工消费 SSE。

对比：

| | token 放哪 | 依赖 | 重连 |
|---|---|---|---|
| `EventSource` | 只能塞 query string（进日志、进 referrer） | 无 | 自带 |
| `WebSocket` | query string，或 `Sec-WebSocket-Protocol` 夹带，或连上后首帧认证 | `ws` | 自己写 |
| **`fetch` + SSE** ← 选它 | **正规的 `Authorization` 头** | 无 | 自己写（~20 行） |

重连逻辑反正躲不掉——harness 自己写着 *reconnection = reopen the stream + refetch history*，`EventSource` 的自动重连也满足不了这个语义。既然都要手写，就选 token 放对地方的那个，顺便省掉 `ws` 依赖和 upgrade 路由。

---

## 4. 授权

### 4.1 绑定地址：结构上不可能暴露到公网

remctrl 自己的 server 只接受两类绑定地址，**启动时校验，不合格直接拒绝启动**：

1. `127.0.0.1`（默认）——只能通过 `tailscale serve` 反代到达
2. 一个**经校验属于 tailnet 的地址**：本机某个非 internal 接口上、落在 `100.64.0.0/10`（Tailscale 独占的 CGNAT 段）里的 IPv4

`0.0.0.0` 和任意 LAN 地址一律拒绝。

这是对上游那句 *"--host 0.0.0.0 is intentionally not supported yet for safety"* 的正面回答：他们拒绝的是**无认证地暴露到网络**；remctrl 加了认证，同时把暴露面限死在一张私有加密网里，并且这个限制是代码强制的，不是文档里的一句提醒。**remctrl 在结构上没有能力把 dsh 放到公网上。**

tailnet 地址探测：`os.networkInterfaces()` 扫 `100.64.0.0/10` 的非 internal IPv4（比匹配 `utun*` / `tailscale0` 这种平台相关的接口名稳）。MagicDNS 名字（HTTPS URL 要用）是可选增强：`tailscale status --json` 里的 `Self.DNSName`，取不到就退回裸 IP。

### 4.2 配对

```
桌面面板                              手机
  connection.rpc.call('pair/mint')
  → 6 位码，5 分钟 TTL，一次性
  显示 URL + 码（+ 二维码）
                                     打开 URL → 输码
                                     POST /pair {code}
  校验；连续 5 次失败作废当前码
  签发 256-bit device token
                                     ← {token, deviceId, tier}
                                     存 localStorage，此后 Bearer 携带
```

- 一次性码用 `node:crypto` 的 `randomInt` 生成，**存进程内 Map**，不持久化。
- device token **只存 SHA-256 哈希**到 settings，明文只在签发那一次出现在响应里。
- token 走 `Authorization` 头，**绝不用 cookie**。这一条让 remctrl 天然免疫 CSRF 和 DNS rebinding——攻击页面拿不到别的 origin 的 localStorage，而没有 cookie 就没有"浏览器自动带上凭据"这回事。同时响应不带任何 `Access-Control-Allow-Origin`，跨源读取被浏览器挡掉。
- **token 不绑 IP。** tailnet 地址稳定，但绑 IP 只会在换网络时制造神秘失联，换不来安全（同 tailnet 内伪造源地址不是威胁模型的一部分）。

### 4.3 设备表

持久化在 settings namespace `omdsh-remctrl` 的 `devices` 字段，`.hidden()`（不让 plughub 的通用表单去画它）：

```ts
{ deviceId: { label, tokenHash, tier, createdAt, lastSeenAt, userAgent } }
```

桌面面板列出、改名、改档位、撤销。撤销 = 删表项 + 立刻断掉在线 SSE。所以 `applies: 'live'`。

### 4.4 权限档位

远程控制的本质是"我在外面，agent 在家里干活，我负责看和批"。能力分四档，**已定默认为 `drive`**：

| 档位 | 能做什么 |
|---|---|
| `observe` | 会话列表、历史、实时流 |
| `respond` | + 审批工具调用、回答提问、**cancel** |
| **`drive`** ← 默认 | + 发消息 / steer / 改队列 / 新建会话 / 重命名 |
| `full` | + fork / 选模型 / workspace / goal |

`cancel` 故意放在 `respond` 而不是 `drive`：**止损能力应该比下达能力更早开放。**

白名单是一张显式表，未列即拒：

```ts
const METHOD_TIER: Record<string, Tier> = {
  'session.list': 'observe',      'session.history': 'observe',
  'session.search': 'observe',    'workspace.list': 'observe',
  'skill.list': 'observe',        'agentPreset.list': 'observe',
  'session.cancel': 'respond',
  'session.prompt': 'drive',      'session.create': 'drive',
  'session.updateQueue': 'drive', 'session.rename': 'drive',
  'session.fork': 'full',         'session.selectModel': 'full',
  'workspace.create': 'full',     'goal.create': 'full',   // …
}
```

**永不入表**：`settings.*`、`credentials.*`、`host.pickDirectory`、`host.listDirectory`、`host.createDirectory`、`host.openPath`、`llm.*`。前几类 harness 本来也锁 loopback，但白名单不该依赖别人的锁。

### 4.5 会话可见性（v2 留缝）

mux 是**全会话聚合**——一台配对手机默认看得见宿主上所有会话。单人自用没问题；tailnet 一旦是共享的（家庭、团队），或者"分配任务"变成多人协作，就需要按 workspace 给设备划范围。

现在只做一件事：把帧过滤写成 `visibleTo(device, frame)` 这个形状的函数，v1 恒返回 `true`。留缝比事后重构便宜得多。

---

## 5. 移动端

**不复用 harness 的 React SPA。** 它是桌面三栏布局，bundle 大，而且它的 client runtime 是 `window.__ModuleLoader__` 的 loader bundle，不是给外部页面消费的。

自己写一个极简移动页，remctrl 的 listener 直接 serve。preact / 纯 DOM 都行，唯一硬要求是**不拉 harness client runtime**。

`drive` 档需要四个屏：

1. **会话列表** —— 标题（走 `session/projection` 的 title 键）、running 徽标、cwd、最后活动时间。
2. **会话视图** —— 消息流；工具调用默认折叠成一行（`ToolEventView` 已经给了渲染意图）；todo 置顶。
3. **审批卡片** —— `approval/requested` 到达时**置顶 + 震动**。这张卡是整个插件安全性的最后一道防线：工具名和**完整参数原文**必须摊开，不截断、不省略、不折叠。手机屏小不是简化它的理由。
4. **新任务** —— 选 workspace（`workspace.list`）→ 选 agentPreset（`agentPreset.list`）→ 输 prompt → `session.create` + `session.prompt` 两步。

底部常驻输入条：发送 / steer / cancel。

**任务模板**：手机上打字很痛苦。常用任务（"跑一遍测试并修掉失败"、"看看 CI 为什么红"）存 settings 的 `templates`，列表页一键下发。"分配任务"这个场景里性价比最高的功能，成本几乎为零。

---

## 6. 两种 Tailscale 部署

### A. 直接绑 tailnet IP —— M0～M3 用这个

```
dsh --profile web                      # harness 照旧只绑 127.0.0.1，不动它
# remctrl 设置：bindHost = <本机 tailnet IP>, port = 3081
# 手机：http://100.x.y.z:3081/
```

明文 HTTP，但**跑在 WireGuard 里**——节点之间的流量是加密的，配对码和 token 不会被嗅探。零外部配置，最简单，先跑通。

代价：没有 TLS 就装不了 PWA，**没有 Web Push**。

### B. `tailscale serve` 终结 TLS —— M4 用这个

```
dsh --profile web
# remctrl 设置：bindHost = 127.0.0.1, port = 3081
tailscale serve --bg --https=443 http://127.0.0.1:3081
# 手机：https://<node>.<tailnet>.ts.net/
```

Tailscale 用 `*.ts.net` 的**真 Let's Encrypt 证书**终结 TLS（需要 tailnet 管理台打开 HTTPS，以及 MagicDNS）。于是：

- 浏览器信任 → iOS 16.4+ 可以"添加到主屏幕"装成 PWA → **Web Push 可用**
- harness 和 remctrl 都待在 loopback，暴露面只有 Tailscale 的那一个 443
- 因为反代后面**只有 remctrl**，2.2 说的 Host 头改写问题在这里彻底不存在

推送本身：VAPID 私钥进 settings 带 `.role('secret')`；手机需要联网才能收（Tailscale 默认不劫持出口流量），宿主需要出网 POST 到推送服务。审批到达、turn 结束、agent 报错时推。

**没有通知的远程控制只是个小屏只读页**——你不会一直盯着它。所以 B 不是可选项，是 M4 的必经之路；A 只是让 M0～M3 不必先跟 TLS 搏斗。

---

## 7. 包的形状

按 [CONVENTIONS](https://omdsh-plugins.github.io/conventions/) 的七条。

```
omdsh-remctrl/
  package.json          dsh.bundle.patch + dsh.plughub（dsh.client 等桌面半落地再加）
  cordis.patch.yml      一行 insert
  src/
    contract.ts       ✅ 路由 / 端点 / 档位 / 线上类型，两半共用的词汇表
    index.ts          ✅ host 半：apply()，起 listener + 控制面 + 设置注册 + 启动播报
    gate.ts           ★✅ METHOD_TIER 表、allows()、authorize()、visibleTo()
    pairing.ts        ★✅ 码的 TTL / 一次性 / 失败预算
    devices.ts        ★✅ 设备表、按哈希索引的认证
    bind.ts           ★✅ tailnet 地址探测与绑定地址策略
    secrets.ts         ✅ 唯一碰 node:crypto 的文件（码 / token / 哈希）
    server.ts          ✅ 自有 node:http listener + 路由分派
    control.ts         ✅ connection.rpc 控制面端点
    mobile/assets.ts   ✅ 手机页（HTML/CSS/JS 三个字符串；长大了再上构建）
    proxy.ts             M1  apiProxy 转发（rpc / respond）
    stream.ts            M1  mux + host → SSE
    push.ts              M4  Web Push
    client/              M0.5 桌面半：配对面板（omdsh.plugin.card 槽位）
```

`wire.ts` 没有单独存在——线上类型全在 `contract.ts` 里，编解码就是 `JSON.parse` 加
一次窄化，单开一个文件只会多一层间接。`secrets.ts` 是设计里没有的：把 `node:crypto`
挤到一个文件，换来另外四个 ★ 文件零 import、时钟与随机数全靠注入，安全逻辑因此完全
由测试决定而不是由跑测试的机器决定。

★ = harness import 全部是 `import type`。这样的模块在裸 clone 上 `pnpm install && pnpm test` 就能跑，不需要 `harness:local`（`omdsh-sidechat` 已验证）。授权逻辑是最该被单测钉死的部分，让它跑得起来很重要——**`gate.ts`、`pairing.ts`、`devices.ts`、`bind.ts` 四个文件承载了这个插件的全部安全性，它们必须是纯函数且被测透。**

服务注入：`inject: ['apiProxy', 'connection', 'settings']`。**不注入 `webServer`**——控制面通过 `connection.rpc` 间接用到它，数据面完全不用。

配置 schema（rule 1、2、3）：

```ts
Schema.object({
  enabled: Schema.boolean().default(true),
  bindHost: Schema.string().default('127.0.0.1')
    .description('监听地址；只接受 127.0.0.1 或本机的 Tailscale 地址'),
  port: Schema.natural().max(65535).default(3081)
    .description('remctrl 自有端口（harness 默认用 3080）'),
  defaultTier: Schema.union(['observe', 'respond', 'drive', 'full']).default('drive')
    .description('新配对设备的默认权限档位'),
  pairingTtlSeconds: Schema.natural().default(300),
  deviceTokenTtlDays: Schema.natural().default(30),
  templates: Schema.dict(Schema.string()).description('手机端一键下发的任务模板'),
  devices: Schema.dict(Schema.object({ /* … */ })).hidden(),
  vapidPrivateKey: Schema.string().role('secret'),
}).i18n({ zh: { /* … */ } })
```

`applies: 'live'`——撤销一台设备必须立刻生效。

桌面面板走 `omdsh.plugin.card` 槽位：配对码、二维码、设备列表、可达性状态（"未检测到 tailnet 地址"要给出可复制的处置办法），正是 rule 6 说的"通用表单画不出来的控件"。

**二维码**：仓库里没有 `qrcode` 依赖，要自己加（第三方 npm 不受 rule 7 的跨插件限制）。也可以推到 v2——6 位数字码手机输入完全可行。

---

## 8. 分期

| | 内容 | 验收 |
|---|---|---|
| **M0** ✅ | 自有 listener + bind 校验 + 控制面 + 配对 + token 闸门 | 手机在 tailnet 上输码后看到"已配对" |
| **M1** | `observe`：session.list / history + SSE 转发 + 会话视图 | 手机上实时看 agent 干活 |
| **M2** | `respond`：审批卡片 + `/respond` + cancel | 手机上批准一次工具调用 |
| **M3** | `drive`：prompt / steer / queue + 新任务 + 模板 | 手机上派一个新任务 |
| **M4** | `tailscale serve` + PWA + Web Push | 锁屏收到审批提醒 |
| **M5** | `visibleTo()` 真正实现：按 workspace 给设备划范围 | 共享 tailnet 下可用 |

**M2 是价值拐点**：看 + 批已经覆盖远程控制的主要场景。M3 之后是锦上添花，M4 决定你会不会真的用它。

---

## 9. 风险

1. **手机批准工具调用 = 远程授予任意命令执行。** 这是本插件的核心风险，跟网络方案无关。对策：审批卡片显示完整参数原文；**永不提供"记住此选择 / 自动批准"**；`defaultTier` 不给 `full`。
2. **tailnet 成员资格 ≠ 授权。** 共享 tailnet（家庭、团队）里每个节点都能连到端口。所以 token 层不能省。可以叠 Tailscale ACL 限制哪些节点能到这个端口。
3. **绝不要对这个端口开 Tailscale Funnel。** Funnel 是唯一一个能把它捅到公网的开关。README 要写死这一条。
4. **`apiProxy` 是宿主内部接口，不是稳定 API。** 白名单表是唯一耦合点，harness 升级时先跑一遍表——这也是"表要显式、未列即拒"的另一个理由：新增方法不会悄悄漏出去。
5. **mux 全会话可见**（4.5），M5 之前不适合共享 tailnet。
6. ~~LAN 明文嗅探~~、~~DHCP 导致 IP 漂移~~ —— Tailscale 方案下这两条不再存在：WireGuard 加密，且 tailnet 地址按节点固定。

---

## 10. M0 落地后的账

### 已验证（真机 `dsh web`，scratch `$DSH_HOME`）

- 插件装进 web profile 后 boot 不炸，patch 行正常 compose，门在 `127.0.0.1:3081` 起来
- 启动日志给出 URL + tailscale serve 提示；**仅当无设备配对时**给出 6 位码
- 用日志里的码 curl `/pair` → 拿到 token → `/session` 报出 `iPhone / drive`（**M0 验收点**）
- 错码扣预算并报剩余次数；撤销后 token 立刻失效
- 设备表落进 `settings.yaml`，存的是 `tokenHash` 不是 token；**重启后同一 token 仍然有效**
- `/api/*` 在这扇门上是 404 —— 两扇门的隔离成立
- LAN 地址 / `0.0.0.0` 绑定被拒绝，且拒绝时不留监听

92 条单测 + 23 条端到端冒烟，`bind/gate/pairing/devices` 全部零 import、
时钟与随机数注入，裸 clone `pnpm install && pnpm test` 即可跑。

### 实现中撞到的两条 harness 事实

- **cordis 的 `ctx.logger` 方法不能被摘下来。** `const log = ctx.logger.info` 会脱离
  接收者，首次调用抛 `this is not a function`——在 loader entry 里这不是少了一行日志，
  而是**整棵插件树加载失败**。必须始终 `ctx.logger?.info?.(…)` 这样以方法形式调用。
- **`ctx.logger` 的 info 不落 stdout。** harness 自己打印就绪 URL 用的是 `console.log`
  （`bundle/web-app/src/index.ts`）。启动播报（尤其是配对码）属于同一类"给盯着终端的人
  看的就绪行"，也走 `console.log`；运行期故障才走 logger。

### 设计外补的一个时序修正

"仅当无设备配对时才出码"——第一版把这个判断放在 listener 启动时，结果**每次重启都会给
一个可用的安装白送一个 5 分钟配对窗口**：设备表来自 settings fiber，跑在插件自身 effect
之后，问早了答案永远是"没有配对"。改成等 loader settle 之后再问，用的是 harness 自己
打印 URL 时用的同一个缝（`ctx.get('loader')?.await()`），无 loader 的组合（单测、手搭
的树）则立即回答。

### 仍待核实

- `tailscale serve` 的 Host 头行为。**安全性不依赖它**（反代后面只有 remctrl），但移动页要生成正确的绝对 URL，得知道它传下来的是什么。
- 本机未装 Tailscale，所以 tailnet 绑定这条路径只有单测覆盖，没有真机验证。
- Tailscale 未登录 / 未开 MagicDNS 时 `tailscale status --json` 的失败形态，好让面板给出准确提示而不是"不可达"。
- `apiProxy.events.mux()` 在宿主内直接调用（而非经 HTTP 承载）时的取消语义：`signal` abort 后迭代器是否干净结束，决定设备断线时会不会漏掉一个订阅。（M1 第一件事）
