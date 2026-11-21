# 架构

## 现有运行结构

`main.ts` 是终端入口。它读取本地输入，输出 JSON Lines 并处理退出信号。`config.ts` 在建立网络连接前校验地址、端口、认证、采样和可选的控制配置。

`client.ts` 持有唯一的 Mineflayer 实例，处理登录、首次定位、出生、聊天、踢出和断线。客户端默认关闭物理模拟，启用控制时才运行物理。首次收到出生信号和服务端定位后开放即时状态读取和定频快照。维度切换时暂停输出，直到收到新的出生和定位。维度切换、死亡和断开时取消工作，断开时清理采样计时器和记忆连接。

`perception.ts` 把 Mineflayer 当前缓存映射为 `Observation`。坐标、槽位和实体等数据复制到普通对象。没有区块数据时，方块状态为 `null`。附近实体只包含服务端已同步到客户端的有效实体。完整背包槽位数据到达后才发布背包摘要。

`controls.ts` 处理终端和聊天命令。游戏指令基于协议提供的发送者 UUID 与玩家列表核对身份，Microsoft 模式还要求消息签名已验证。`actions.ts` 校验操作类型和输入。

`tasks.ts` 串行执行提交的工作，跟踪状态并提供取消信号和截止时间。替换任务时先取消旧工作，等清理结束再启动新工作。未能及时停止的操作触发断线。路径搜索超时可重试一次，涉及世界、物品或窗口的操作出现不确定结果时，由操作者或代理根据新的状态决定下一步。

`skills.ts` 使用 Mineflayer 和 Pathfinder 实际执行操作。移动检查最终位置，挖掘等待服务器方块更新，放置检查目标方块，容器转移重新同步窗口后检查物品数量。实体交互目前以窗口打开为成功条件。技能层保有游戏协议对象，调用方只接收结果。

`io.ts` 定义外部控制器使用的 `MinecraftIO` 接口，包含即时观测、已加载方块查询、异步动作和停止。Mineflayer 对象留在适配器内部。`round-trip-controller.ts` 只依赖此接口，通过固定状态转换验证从读取起点到移动、检查和返回的往返过程。`controller-cli.ts` 建立会话、传递取消信号、记录状态转换并清理连接。

`workstation-controller.ts` 用同一操作接口驱动工作台合成和熔炉产出，并用同步后的背包数量重新验收。创造模式夹具只在显式运行工作台测试时启用，与常规动作共用任务队列；它负责准备测试物品、清空临时炉槽和移除剩余测试物品。控制器在独立的清理时限内确认两处临时方块恢复为空气。

## 一期桌面设计

本节描述计划中的桌面能力。第一项可运行交付是带模拟数据的 Electron 界面。界面提供消息输入、游戏观测、任务与播报状态、连接和模型设置，并明确标识模拟或实机模式。模拟模式能预演正常回复、回复逾期、改口和停止，在未配置 Minecraft、模型和音频设备时也可操作。[架构决策](adr/0001-gui-first-desktop-companion.md)

### 运行边界

Electron 渲染进程只负责呈现状态和提交操作，通过 preload 暴露的有限接口与主进程通信。Node 侧管理会话、推理请求、音频与游戏适配器。`client.ts` 继续拥有 Mineflayer 实例，游戏状态与动作经过 `MinecraftIO`。游戏聊天需要独立的接收与发送接口，并与动作 I/O 共用会话身份。现有 CLI 可继续作为游戏 I/O 的入口。[Electron IPC 文档](https://www.electronjs.org/docs/latest/tutorial/ipc)

API 与本地后端使用同一份游戏意图和回复协议，由本地控制器校验游戏意图并调用现有动作。模型请求跟踪所属窗口和会话。切换后端、会话关闭或请求过期时，旧结果失效。API 和本地后端分别记录产生完整可校验结果的耗时。本地主模型实测推理显存峰值须严格低于 6,000,000,000 字节，计入权重、缓存和主模型推理开销。

### 游戏接入

GUI 接受 Minecraft Java 服务器或 LAN 的地址、端口、认证方式和账号设置。Microsoft 登录的游戏角色名和对其他玩家可见的皮肤依账号与服务端而定，离线玩家名由连接设置提供。桌面昵称与皮肤预览标注其作用范围。第一人称视角复用同一机器人已同步到的区块与朝向，视角切换通过 GUI 操作。游戏状态读数仍按已同步的游戏观测解释。[Prismarine Viewer](https://github.com/PrismarineJS/prismarine-viewer)

可信 Minecraft 聊天沿用现有发送者 UUID 和玩家名录的授权检查，Microsoft 模式要求有效签名。显示昵称由界面使用。离线控制仅在显式允许的隔离世界启用。GUI、可信 Minecraft 聊天和本机 CPU 语音识别进入同一会话，语音识别仅提交最终文本。回复可发往 GUI、Minecraft 聊天和本机 CPU 语音合成。Minecraft 公开发送需要操作者显式启用对应的输出路由。KOOK 排到后续阶段。

### 调度与可验证状态

读取窗口汇总已提交输入与游戏观测。每个窗口有明确的结束边界，完整有效结果供紧接的下一窗口使用。首字耗时用于观察首段回复体验，后台适配以完整可校验结果的耗时为依据，按当前后端实测数据调整未来窗口的长度。调度预案在边界更新长度，过期窗口在 GUI 显示超时并丢弃其待发结果，避免旧动作延后提交。

模拟调度以单调时钟每 800 毫秒开启一窗，读取初始占 400 毫秒。读取截止时冻结输入与最新游戏观测，下一窗前 400 毫秒内允许提交结果。后续读取长度在 100 至 650 毫秒之间，近期成功的完整校验耗时增加时缩短读取，为推理预留更多时间。界面可切换快、慢、抖动和重复结果，也可模拟重连。成功、超时、取消和校验失败共同计入样本总数，P50 和 P95 使用最近 32 个成功结果。

操作者提交新输入后，当前播报停止，尚未提交的旧结果失效。正在执行的跟随按原任务规则继续。明确的停止请求或经确认的替换意图可以结束当前跟随。

GUI 分别呈现播报是否已经停止和游戏任务是否已经终止。现有 `MinecraftIO.stop()` 提交取消请求。游戏任务终止需要结合任务完成与清理结果确认，超时无法清理时按现有恢复路径关闭游戏会话。自动化验证使用单调假时钟、可控的模拟后端、`MinecraftIO` 假实现和模拟音频输出，在 GUI 检查窗口超时、失效结果、播报中断和任务清理对应的状态。

Windows 桌面版通过系统已安装的 `zh-CN` 桌面语音在 CPU 上生成 WAV。请先安装 Windows 普通话语音包，在「本机播报」选择输出设备并试听，再按需启用已校验回复的播报。界面分别记录合成耗时和 Web Audio 设备时钟上的首音帧、最近输出末帧。停播清空播放器的 PCM，并等待已渲染的最后一帧越过设备时钟；实际扬声器出声由实机确认。`MCPAL_TTS_FIXTURE=1` 以静音目的地和固定 PCM 验证应用播放器，不会唤起系统语音合成。

## 依赖

- Node.js 24 LTS 自带 `.env` 加载、TypeScript 类型擦除和 `node:test`。TypeScript 6 检查类型，锁文件固定实际安装版本。[Node.js 发布周期](https://nodejs.org/en/about/previous-releases) · [Node.js 测试运行器](https://nodejs.org/docs/latest-v24.x/api/test.html) · [TypeScript 6.0](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)
- Mineflayer `4.39.0` 要求 Node.js ≥22。上游列出了多代 Java 版协议，当前安装包最高声明支持 `26.1`。仓库的回环用例覆盖 `1.21.11` 和 `26.1`。[Mineflayer 发布记录](https://github.com/PrismarineJS/mineflayer/releases/tag/4.39.0) · [Mineflayer API](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md)
- `minecraft-protocol`、`minecraft-data`、`prismarine-chunk` 和 `vec3` 是直接开发依赖，用来构造隔离协议测试的区块、数据包和本地服务端。[node-minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol)
- Pathfinder `2.4.5` 在 Java `26.1` 隔离平地区块中通过移动和跟随测试。显式挖掘与放置使用 Mineflayer 的基础接口。[Pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) · [Mineflayer API](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md)
