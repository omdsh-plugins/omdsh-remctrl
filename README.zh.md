# omdsh-remctrl

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的远程控制：在自己的端口上开第二扇门，
门后是设备配对和分档方法白名单，让 tailnet 上的手机能看会话、批准工具调用、下发新任务。

**当前进度：M0** —— 门和锁做完了，门后还什么都没有。今天手机能做的事情是：和一台正在跑的
harness 配对，并看到自己被标记为"已配对"；看会话、实时流、审批、派活是 M1 到 M4 的事。

设计与取舍见 [DESIGN.md](DESIGN.md)，它依赖的 harness API 见
[RESEARCH-harness-host-api.md](RESEARCH-harness-host-api.md)。两份都是中文。

## 它提供什么

| 界面 | 从哪来 |
|---|---|
| 一个跑在 `3081` 端口上的第二监听器，绑在回环或 tailnet 地址上 | `src/server.ts` —— 自己的 `node:http` server，而不是 `ctx.webServer`：后者的运行时 schema 只认 `127.0.0.1` 和 `0.0.0.0` |
| 一个能配对、并显示"已配对"的手机页 | `src/mobile/assets.ts` —— `/`、`/app.css`、`/app.js` 三份资源，都不内联，所以页面能跑在严格 CSP 下 |
| `/pair` 和 `/session` | 令牌门：6 位码只兑换一次，之后由设备 token 证明自己 |
| 一条只对本机开放的控制通道：出码、读码、列设备、改名、撤销、读状态 | `ctx.connection.rpc.handle(…, { authority: 'loopback' })`，围栏是 harness 自带的，不是这里现写的 |
| `omdsh-remctrl` 设置命名空间 | `ctx.inject(['settings'])`，存放绑定地址、配对额度，以及只存哈希的设备表 |

按里程碑拆开：

- ✅ 自有 HTTP 监听，绑定策略**不可能**被配置到公网接口上
- ✅ 配对：6 位码，同时只有一个，5 分钟，5 次机会
- ✅ 设备 token，只存哈希，重启不丢，可撤销
- ✅ 只对本机开放的控制通道：出码、读码、列设备、改名、撤销、读状态
- ✅ 能配对并显示"已配对"的手机页
- ⬜ 看会话、实时流、审批、派活 —— M1 到 M4

**桌面端还没有配对面板。** 控制通道已经注册好、也会回话，只是界面上还没有任何东西去调它。
所以 M0 唯一的入口是启动时打印的那个配对码——而那一行**只在还没有任何设备配对时**才出现：
配好第一台之后，在面板落地之前，应用里没有办法再出一个码。

## 怎么连上

两种部署，都走 Tailscale，都不走公网。

**明文 HTTP 跑在 WireGuard 里。** 把 `bindHost` 设成本机的 tailnet 地址，手机打开
`http://100.x.y.z:3081/`。除了 Tailscale 本身在线，不需要任何额外配置。没有 TLS，
所以装不了 PWA，也没有推送。

**用 `tailscale serve` 终结 TLS。** `bindHost` 保持 `127.0.0.1`，然后：

```sh
tailscale serve --bg --https=443 http://127.0.0.1:3081
```

Tailscale 用 `<node>.<tailnet>.ts.net` 的**真 Let's Encrypt 证书**终结 TLS，于是手机可以
把页面装成 PWA，并在 M4 之后收到推送。需要在 tailnet 管理台开启 HTTPS 和 MagicDNS。

**绝不要对这个端口开 Tailscale Funnel。** Funnel 是唯一一个能把它捅到公网的开关。

## 配置

设置命名空间 `omdsh-remctrl`，可在 `omdsh-plughub` 里编辑。

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 是否开门 |
| `bindHost` | `127.0.0.1` | 回环地址，或本机的 tailnet 地址 |
| `port` | `3081` | 手机连的端口——不是 harness 的 `3080` |
| `defaultTier` | `drive` | 新配对设备的权限档位 |
| `pairingTtlSeconds` | `300` | 配对码有效期 |
| `maxPairingAttempts` | `5` | 配对码允许输错几次 |
| `devices` | — | 由插件写入；只存 token 的哈希，不存 token |

每个字段都是 `applies: 'live'`。改 `bindHost`、`port` 或 `enabled` 会就地重新绑定监听器，
改档位、撤销设备则在下一个请求上就已经生效。这里没有任何一项需要重启。

改之前有两条行为值得知道：

- **本机没有的 `bindHost` 在保存那一刻就会被拒**，而不是拖到下次启动。这个命名空间校验写入
  时跑的就是监听器跑的那套绑定策略，所以一台 Tailscale 掉线的笔记本存不进一个它随后根本
  听不上的地址——面板会报出拒绝原因，已存的值保持不变。
- **设备表以内存里那份为准。** 把它写回 settings 是可能失败的——只读的提供方、写不进去的
  磁盘——失败时本插件只记一行日志然后继续跑：配对关系撑到进程结束为止，而不是拖着整个
  agent 宿主一起倒下。

### 权限档位

每一档都包含它下面的所有能力。

| 档位 | 可以 |
| --- | --- |
| `observe` | 列出并读取会话、子 agent、工作区、技能、预设 |
| `respond` | ……以及中止一次运行、打断子 agent |
| `drive` | ……以及发消息、steer、改队列、新建与重命名会话 |
| `full` | ……以及 fork、选模型、改工作区与目标 |

`cancel` 特意放在 `respond` 而不是 `drive`：被信任来盯着运行的人，应该能在跑歪时叫停，
而不必同时被信任去发起新的运行。

## 安装

```sh
dsh plugin --profile web add @omdsh-plugins/omdsh-remctrl
```

或者从 checkout 装——M0 阶段用的就是这种：

```sh
pnpm install && pnpm run build
dsh plugin --profile web add "$PWD"
```

然后 `dsh web`。启动时会打印手机该连哪里，以及——**仅当还没有任何设备配对时**——一个进门用的码：

```
omdsh-remctrl: listening on 127.0.0.1:3081; nothing off this machine can reach it yet.
omdsh-remctrl: put Tailscale in front of it — `tailscale serve --bg --https=443 http://127.0.0.1:3081` — …
omdsh-remctrl: no device is paired yet; pairing code 483212, good for 300s.
```

卸载是同一条路：

```sh
dsh plugin --profile web remove @omdsh-plugins/omdsh-remctrl
```

**它需要 profile 提供什么。** 一个 harness 自带的服务：`connection`，将来桌面配对面板走的
那条只对本机开放的控制通道就架在它上面。它由 web 界面那层 bundle 组合进来，所以这一行要装
在有界面的 profile 上——也就是上面那条命令装进去的那个。cordis 对被注入的服务会无限期等待，
而启动审计会因为任何仍是 `pending` 的 entry 判整个应用失败，所以没有 `connection` 的
headless profile 不能带这一行：那不是安静地不工作，而是一次死掉的启动。

本插件的 `inject` 里没有任何由别的插件发布的服务，也不需要有。没有必须一起装的伴生插件，
也没有哪块功能会因为少装了谁而熄灭——这条规则以及它成为规则的理由，写在
[CONVENTIONS.zh.md](https://omdsh-plugins.github.io/conventions/#rule-9) 里。
卸载会把监听器、控制通道和设置命名空间一起带走，profile 的其余部分原样不动。

设置是可加的，正如那份约定所要求的。没有 settings 提供方时——测试台，或一棵手搭的树——门
照样按 profile patch 里写的值打开，只是设备表只活在内存里：配过对的手机在重启后要重新配
一次。`dsh web` 会带上 settings，所以在上面那套部署里，设备表是持久的，其余字段也能改。

## 命令

```sh
pnpm install
pnpm run build
pnpm run typecheck
pnpm test          # 95 条测试，而且不需要 harness 的 checkout
```

承载本插件全部安全性的四个文件——`bind.ts`、`gate.ts`、`pairing.ts`、`devices.ts`
——不 import 任何东西，时钟、随机数、哈希都由外部传入，所以它们的行为由测试决定，
而不是由跑测试的那台机器决定。

## 已知限制

- **不会监听公网接口。** `bindHost` 只接受回环地址，或本机持有的、落在
  `100.64.0.0/10` 里的地址，没有第三种，也没有"我知道我在干什么"的开关。LAN 地址拒绝、
  `0.0.0.0` 拒绝、属于别的机器的 tailnet 地址也拒绝。拒绝会在启动时打印出来，门不会开。
- **不会暴露配置面。** `settings.*`、`credentials.*`、`host.*`、`llm.*` 整个域都不给，
  `agentPreset.openDocument` 也不给，任何档位都不给，`full` 也不给：预设可以列、可以读，
  它背后的文档永远打不开。方法表是白名单，没写就是不许。
- **不会把 `/api` 放到这扇门后面。** harness 的服务保留自己的端口和自己的围栏；
  这个监听器只服务本插件，别的什么都没有。
- **配对码是一行启动日志，不是一个控件。** 在桌面面板落地之前，码只在"还没有任何设备"
  的那一次启动里出现；想再配一台，要么把设备清空后重启，要么等 M1。
