# omdsh-remctrl

[English](README.md) | 中文

DeepSeek Harness 的远程控制：在自己的端口上开第二扇门，门后是设备配对和分档方法白名单，
让 tailnet 上的手机能看会话、批准工具调用、下发新任务。

设计与取舍见 [DESIGN.md](DESIGN.md)，它依赖的 harness API 见
[RESEARCH-harness-host-api.md](RESEARCH-harness-host-api.md)。

## 当前进度：M0

门和锁做完了，门后还什么都没有。

- ✅ 自有 HTTP 监听，绑定策略**不可能**被配置到公网接口上
- ✅ 配对：6 位码，同时只有一个，5 分钟，5 次机会
- ✅ 设备 token，只存哈希，重启不丢，可撤销
- ✅ 只对本机开放的控制通道：出码、列设备、改名、撤销、读状态
- ✅ 能配对并显示"已配对"的手机页
- ⬜ 看会话、实时流、审批、派活 —— M1 到 M4

## 安装

```sh
pnpm install && pnpm run build
dsh plugin --profile web add /path/to/omdsh-remctrl
dsh web
```

启动时会打印手机该连哪里，以及——**仅当还没有任何设备配对时**——一个进门用的码：

```
omdsh-remctrl: listening on 127.0.0.1:3081; nothing off this machine can reach it yet.
omdsh-remctrl: put Tailscale in front of it — `tailscale serve --bg --https=443 http://127.0.0.1:3081` — …
omdsh-remctrl: no device is paired yet; pairing code 483212, good for 300s.
```

### 它需要 profile 提供什么

一个 harness 自带的服务：`connection`，桌面配对面板走的那条只对本机开放的控制通道就架在
它上面。它由 web 界面那层 bundle 组合进来，所以这一行要装在有界面的 profile 上——也就是
上面那条命令装进去的那个。cordis 对被注入的服务会无限期等待，而启动审计会因为任何仍是
`pending` 的 entry 判整个应用失败，所以没有 `connection` 的 headless profile 不能带这一行：
那不是安静地不工作，而是一次死掉的启动。

本插件的 `inject` 里没有任何由别的插件发布的服务，也不需要有。没有必须一起装的伴生插件，
也没有哪块功能会因为少装了谁而熄灭——这条规则以及它成为规则的理由，写在
[CONVENTIONS.zh.md](https://github.com/omdsh-plugins/omdsh-plugins/blob/HEAD/CONVENTIONS.zh.md) 里。

设置是可加的，正如那份约定所要求的。没有 settings 提供方时——测试台，或一棵手搭的树——门
照样按 profile patch 里写的值打开，只是设备表只活在内存里：配过对的手机在重启后要重新配
一次。`dsh web` 会带上 settings，所以在上面那套部署里，设备表是持久的，其余字段也能改。

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

## 它不会做的事

- **不会监听公网接口。** `bindHost` 只接受回环地址，或本机持有的、落在
  `100.64.0.0/10` 里的地址，没有第三种，也没有"我知道我在干什么"的开关。LAN 地址拒绝、
  `0.0.0.0` 拒绝、属于别的机器的 tailnet 地址也拒绝。拒绝会在启动时打印出来，门不会开。
- **不会暴露配置面。** `settings.*`、`credentials.*`、`host.*`、`llm.*` 整个域都不给，
  任何档位都不给，`full` 也不给。方法表是白名单，没写就是不许。
- **不会把 `/api` 放到这扇门后面。** harness 的服务保留自己的端口和自己的围栏；
  这个监听器只服务本插件，别的什么都没有。

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

## 开发

```sh
pnpm install
pnpm test          # 95 条测试，不需要 harness——所有 harness 导入都是 `import type`
pnpm run typecheck
pnpm run build
```

承载本插件全部安全性的四个文件——`bind.ts`、`gate.ts`、`pairing.ts`、`devices.ts`
——不 import 任何东西，时钟、随机数、哈希都由外部传入，所以它们的行为由测试决定，
而不是由跑测试的那台机器决定。
