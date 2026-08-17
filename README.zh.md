# omdsh-remctrl

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的远程控
制：打开开关，这台机器上的 dsh 界面就会出现在一个公网地址上，前面挡着一道通行码。
它不是一个配套 app，也不是一个功能子集——一样的会话、一样的按钮、一样的一切，因为
它**就是** dsh，只是被转发了出去。

## 它提供什么

| 界面 | 从哪来 |
|---|---|
| 挡在 harness 前面的第二个监听器 | 本插件绑定的一个 `node:http` server；harness 自己的 `webServer` 一动不动 |
| 整个界面，出现在公网地址上 | 到 `127.0.0.1:<webServer.port>` 的 HTTP + WebSocket 反向代理 |
| 任意路径上的通行码表单 | 门自己的页面，在浏览器登录之前顶替 app 显示 |
| 会话 Cookie | `HttpOnly; SameSite=Lax`，走隧道时加 `Secure`；一个外来 web app 唯一会自己携带的凭证 |
| 一个不用配置的 `https://` 地址 | 作为子进程托管的 `cloudflared` quick tunnel |
| 插件中心里的一张卡片 | `omdsh.plugin.card` 槽位上的一条注册，槽位由 `@omdsh-plugins/omdsh-plughub` 声明 |
| 开关、通行码、已登录浏览器列表、门口的记录 | `ctx.connection.rpc`，`authority: 'loopback'` |

## 只有一条路

只有一扇门，它是一个反向代理。请求打到本插件绑定的端口上，通行码决定它能不能继续
往里走，能的那些被原样交给 harness 自己的回环端口——HTTP 和两条 WebSocket 下行，
一字不改。

这个端口怎么变得可达，是你唯一要做的选择，而且它有默认值：

- **`publicHost` 留空。** `cloudflared` 建立一条出站 quick tunnel，返回一个
  `https://….trycloudflare.com` 域名。不用做端口映射，不用开防火墙，不用配证书。
  这是几乎所有笔记本的情况，也是你只动开关、别的什么都不改时会发生的事。
- **填上 `publicHost`**，当这台机器本来就有公网地址时——`121.43.252.12`、
  `harness.example.com`。门会绑定所有网卡，别人直接访问。这是明文 HTTP，所以在你
  手动打开 `allowInsecure` 之前它不会启动。

除此之外没有别的可配的，因为不需要。

## 通行码挡着的是什么

是全部。

本插件早先的版本提供的是一个小小的专用 app，走方法白名单，权限档位由桌面端决定，
所以它可以诚实地说「手机能做的比桌面少」。转发真实界面终结了这个承诺，而且是有意
终结的：代理会把 `Host` 改写成回环地址，这正是 harness 自己的信任围栏放行的原因，
也意味着一个已登录的浏览器能触达桌面端能触达的每一个 loopback 方法——设置、凭证、
工具批准、执行命令。

所以通行码周围的这些控制不是「功能」，它们就是设计本身：

1. **默认关闭。** `enabled` 是 `false`。装上这个插件，在有人打开它的卡片并开启之
   前，这台机器不会有任何变化。
2. **Cookie 没通过之前，什么都不转发。** 首页不转发，静态资源不转发，WebSocket
   握手也不转发。一个未登录的浏览器能拿到的只有通行码表单和两个文件，公网上暴露的
   就这么多。
3. **每个地址每分钟六次。** 十位通行码是 50 bit，这不是密钥——这是一道前面挡着令
   牌桶的通行码，而正是这个桶让「十位、能在手机上打出来」变得够用。
4. **来源围栏，在公网边界上重建了一遍。** harness 会拒绝跨站请求和不匹配的
   `Origin`，而向上游改写 `Host` 会把它这份检查抹掉——所以门会先问同样的三个问题，
   针对的是浏览器**实际用的**那个地址。
5. **传输检查。** 走隧道时，非 HTTPS 到达的请求在**读取任何凭证之前**就被 `421`
   拒绝，这样一个配错的通道换来的是一次拒绝，而不是一枚明文的会话 Cookie。

还有第六件事，它是形状带来的而不是加上去的：控制面走 `ctx.connection.rpc` 的
`authority: 'loopback'`，围栏是 harness 的而不是这里写的。这道围栏现在也放行已登录
的浏览器了——这是设计如此，而且它往往是好事：你可以用已经带出门的那台手机，把远程
控制关掉。

## 怎么登录

卡片上有三样东西：地址、一条已经带上通行码的链接、以及通行码本身。

把链接发给自己的手机，点开就行。门会把通行码从 query 里取走、种下 Cookie，然后重定
向到去掉它的同一个 URL——所以它从地址栏里消失了，但不会从那个浏览器的历史记录里消
失，这是「免密链接」的代价。你也可以选择手输：不区分大小写，中间的横杠随便加，字母
表里没有 `I`、`L`、`O`、`U`，屏幕上不会有认不准的字符。

一个浏览器登录后保持 `sessionTtlDays` 天。卡片会列出所有已登录的浏览器：任何一个都
能被立刻退出，也可以经二次确认一次性全部退出。重新生成通行码只会换掉**进门**的方
式——已经登录的浏览器不受影响，因为「通行码被人从背后看见了」和「手机落在出租车上
了」是两个不同的问题，答案也不同。

## 门口发生了什么

卡片上记着：每一次成功的登录，和每一次失败的尝试，都带着来源地址。登录成功还会在
它发生的那一刻打一行出来——`a new browser signed in — iPhone from 203.0.113.9`——
所以只要有终端开着，它就会说出来。

是**记录**而不是**通知**，这个区别就是重点：通知只能送达正在看的人，而值得抓住的恰
恰是没人在看的那次。这份记录能扛过重启，保留最近 50 条，并且带着「上次看过之后新增
了几条」的计数。

同一个地址的失败尝试会合并成一条，上面带个次数——否则一台机器慢慢磨通行码（被限速
到每分钟六次）也足以在十分钟内把所有真实事件挤出这份有上限的记录。同一个地址失败到
第六次之前不会出声，第六次是「这不再像是打错了」并且它的令牌桶正好耗尽的那一刻。

## 在手机上

harness 的界面里没有任何一条宽度媒体查询。它有的是一个写在 JavaScript 里的断点：
低于 1024px 时侧边栏自动收成 56px 的窄条，所以手机上本来就是「窄条 + 会话」，而不是
三栏在 390px 里互相挤。

有两件事它没处理，本插件把这两件补上——只补在转发出去的那一份上，你桌面上的那个窗
口一个字节都不变：

- **键盘。** harness 用 `height: 100%` 给自己定高，而这在 iOS 上是相对**布局视口**
  的——键盘弹出时布局视口并不缩小，于是输入框被压在键盘下面，页面又没有可滚的地
  方：能打字，发不出去。几行脚本把 `visualViewport` 发布成一个自定义属性，改由它
  来定高。
- **展开的侧边栏。** 点一下窄条它会展开到 280px，剩给会话的大约只有 110px。在窄视
  口下它改成**盖在**会话上面，而不是从会话那里拿走一栏。

两者都挂在 `data-shell-overlay` 和 `data-sidebar-collapsed` 上——harness 的 frame
有意写下的两个属性，绝不用 CSS module 的类名，那些全是构建哈希。哪天 harness 不再
写它们，页面会回到它出厂的样子，而不是坏掉。

## 配置

所有项都在 `omdsh-remctrl` 这个设置命名空间里，插件中心里的卡片就是它的表单。五个
字段，多数人只会动其中一个。

| 字段 | 默认值 | 是什么 |
|---|---|---|
| `enabled` | `false` | 开关。不打开就什么都不监听。 |
| `publicHost` | `''` | 别人访问这台机器用的地址，如果它有的话。留空表示由 `cloudflared` 去取一个。不带协议，不带端口。 |
| `port` | `3081` | 本插件监听的端口——不是 harness 自己的那个。 |
| `allowInsecure` | `false` | 以明文 HTTP 对外提供 `publicHost`。填了公网地址就必须先打开它才会启动。 |
| `sessionTtlDays` | `30` | 已登录的浏览器保持登录多少天。`0` 表示永不过期。 |

还有三项由插件自己写入：`passcode`，第一次开启时生成，声明为 `.role('secret')`；
`browsers`，只存每个会话令牌的哈希，从不存令牌本身；以及 `access`，门口的记录。

## 安装

```sh
npx @omdsh-plugins/omdsh-plughub add omdsh-remctrl
```

这就是[插件中心](https://github.com/omdsh-plugins/omdsh-plughub)的安装器，只是入
口从按钮换成了 argv。它从这套集合的
[registry](https://github.com/omdsh-plugins/registry) 里解析出这个插件、从它的
GitHub 仓库装上，并把那条 pnpm 构建白名单写好——裸的 `dsh plugin add github:…`
会把这一步留给你，而那条记录里带着 pnpm 解析出来的 commit，只能从报错里抄，事先
写不出来。

`dsh plugin --profile web add @omdsh-plugins/omdsh-remctrl` 现在**还不是**那条命
令：这个包不在 npm 上，pnpm 会回 `ERR_PNPM_FETCH_404`。同样这一次安装也可以是一个
按钮——只要 profile 里已经有插件中心，它就在**设置 → 插件 → 插件中心**里这个插件
的卡片上。

或者从 checkout 装，这也是未发布版本该用的方式：

```sh
pnpm install && pnpm run build
dsh plugin --profile web add "$PWD"
```

卸载走同一条路：

```sh
dsh plugin --profile web remove @omdsh-plugins/omdsh-remctrl
```

`cloudflared` 不随包分发，也不会替你安装。macOS 上：`brew install cloudflared`；
其它平台见
[Cloudflare 的下载页](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)。
缺了它卡片会直说，而填了 `publicHost` 的机器根本不需要它。

各种「缺席状态」，按 CONVENTIONS 规则 9。没有
`@omdsh-plugins/omdsh-plughub` 时卡片没有槽位可坐，会自行撤下；每一项仍然可以从插
件中心的通用表单或设置文件里改。没有 `webServer` 时——比如 TUI profile——没有界面可
转发，插件会直说，而不是开一扇通向空气的门。没有 `settings` 时通行码和已登录浏览器
只活在内存里，重启即失。`remove` 之后设置段落会留在原处，所以重装后通行码还是原来
那个。

## 命令

```sh
pnpm install
pnpm run build        # tsdown 打包 host 与 browser 两半
pnpm run typecheck
pnpm run test
pnpm run harness:local   # 把 harness 依赖指向本地 checkout
pnpm run harness:npm     # 再指回已发布版本
pnpm run check:harness-pin
```

## 已知限制

- **已登录的浏览器就是桌面端。** 没有权限档位，也没有只读模式。这就是「转发真实界
  面」的含义，也是为什么通行码就是全部的安全。
- **quick tunnel 的域名每次重启都会变。** Cloudflare 的免账号隧道是临时的，也不提
  供可用性保证，所以卡片显示的是当前地址而不是保存下来的地址，昨天发出去的链接今天
  不管用。具名隧道暂不支持。
- **所有流量都经过 Cloudflare。** 默认通道下 TLS 是他们终结的，所以在他们那一侧流量
  是明文。如果这件事重要，答案是用 `publicHost` 加你自己的反向代理。
- **手机上打不开详情栏。** harness 的分栏求解器只要发现会话会低于 640px 就会关掉详
  情栏，手机上永远如此；而转发出去的 DOM 里也区分不了「因为放不下所以关着」和「因
  为你关了所以关着」。
- **手机样式表没在真机上验证过。** 它是照着 harness 自己的布局源码写的，覆盖它的是
  读它的测试，不是一台设备。
- **一条隧道，一扇门。** 一台机器上跑两个 harness 需要手动分配两个端口，这里不会去
  找空闲端口。
