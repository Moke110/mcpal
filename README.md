# Minecraft AI Companion

用 Mineflayer 将独立的无头玩家连入 Minecraft Java Edition。默认在终端输出结构化观测和聊天事件。可启用操作，由终端、授权游戏玩家或外部控制器发出动作。

## 安装与运行

使用 Node.js 24 LTS（24.12 或以上的 24.x 版本）和 npm。在 PowerShell 中安装依赖并复制配置文件。

```powershell
npm.cmd ci
Copy-Item .env.example .env
```

1. 在 Minecraft Java 版单人世界中选择「对局域网开放」，记录游戏显示的端口，联调期间保持世界运行。
2. 编辑 `.env`。同机使用 `MC_HOST=localhost`，跨设备填写房主的局域网 IP。把实际开放端口填入 `MC_PORT`。
3. 保留 `MC_AUTH=microsoft`，将拥有 Minecraft Java Edition 的独立账号填入 `MC_USERNAME`。首次运行按终端提示完成 Microsoft 设备授权。认证缓存写入 `.runtime/profiles/`。
4. 执行 `npm.cmd start`。看到 `login` 后，等待 `spawned` 和第一条 `snapshot`。在终端输入 `status` 可立即读取状态。输入 `quit` 或按 `Ctrl+C` 退出。通过管道发送命令时使用 `npm.cmd start -- --interactive`。

`MC_VERSION=auto` 先通过服务器状态查询协商版本。也可填具体游戏版本，例如 `1.21.11`。`MC_SNAPSHOT_INTERVAL_MS` 默认为 5000，可配置为 1000 至 60000。`MC_AUTH=offline` 供显式配置的隔离测试服务器使用，`MC_USERNAME` 在该模式下填写玩家名。

## 输出

标准输出使用 JSON Lines，每条带 UTC 时间戳和 `event`。设备授权提示写入标准错误流。`snapshot` 和就绪后的 `status` 包含玩家名、游戏版本、坐标、弧度朝向、维度、生命值、饥饿值、当前任务、背包槽位摘要、32 格内已收到的玩家和实体，以及脚下、脚部和头部所在方块。尚未收到的背包或方块用 `null` 表示。`chat` 记录 Mineflayer 识别出的玩家聊天。

## 控制和游戏内命令

设置 `MC_CONTROL=true` 以启用操作。终端是本机操作入口。通过游戏聊天控制时，将逗号分隔的玩家名填入 `MC_AUTHORIZED_PLAYERS`。Microsoft 模式的聊天指令必须来自已验证签名且 UUID 能对应到玩家列表的消息。离线模式额外要求 `MC_ALLOW_OFFLINE_CONTROL=true`。离线服务器上的玩家名缺少认证保证，只在自己控制的隔离世界启用此模式。

- `!follow` 持续跟随发出指令的玩家，`!come` 走到玩家发送指令时所在位置附近。
- `!stop` 取消当前工作，`!status` 报告状态摘要，`!help` 显示可用命令。
- `!act <JSON>` 提交一个明确操作。终端使用 `act <JSON>`。终端跟随请在 JSON 里提供 `player`。

| 操作 | JSON 示例 |
| --- | --- |
| 移动 | `{"kind":"move","at":{"x":12,"y":64,"z":8}}` |
| 跟随 | `{"kind":"follow","player":"Steve"}` |
| 挖掘 | `{"kind":"mine","at":{"x":13,"y":64,"z":8}}` |
| 放置 | `{"kind":"place","at":{"x":13,"y":64,"z":8},"against":{"x":13,"y":63,"z":8},"item":"dirt"}` |
| 门、按钮等 | `{"kind":"interact","at":{"x":13,"y":64,"z":8}}` |
| 使用实体 | `{"kind":"use","entityId":42}` |
| 合成 | `{"kind":"craft","item":"oak_planks","count":4}` |
| 存入容器 | `{"kind":"deposit","at":{"x":13,"y":64,"z":8},"item":"dirt","count":4}` |
| 取出容器 | `{"kind":"withdraw","at":{"x":13,"y":64,"z":8},"item":"dirt","count":4}` |
| 熔炼 | `{"kind":"smelt","at":{"x":13,"y":64,"z":8},"item":"raw_iron","count":1,"fuel":"coal","fuelCount":1,"output":"iron_ingot"}` |

使用工作台配方时，提供 `table` 坐标。合成数量是最少产出，可因配方批次而多出。放置目前支持物品名和目标方块名相同的物品。挖掘、容器等操作要求目标区块已加载，并且目标在交互距离内。熔炼使用空炉，取消任务后，已经放入熔炉的物品和燃料仍可能继续加工。实体使用以观察到界面打开为成功条件。移动寻路会尽量保持地形原状，挖掘和放置通过独立操作发起。

同一时间只运行一项工作。相同指令合并，新指令取消并替换正在运行的工作。终端记录任务的启动、完成、失败、超时和取消。若操作超时且无法安全结束，客户端会断开，避免旧操作与下一项任务重叠。

## I/O 接口和状态机测试

`connect(...).io` 提供 TypeScript 接口 `MinecraftIO`。调用 `read()` 获取即时观测，游戏状态尚未就绪时返回 `null`。`readBlock(at)` 查询当前维度内已加载方块的名称与状态 ID，未知时返回 `null`。调用 `execute(action, signal?)` 提交动作并等待结构化结果，可用 `AbortSignal` 取消该次提交。`stop()` 取消当前工作。终端、聊天和外部控制器共用同一任务队列。

在启用控制后，使用以下命令启动单次往返测试。将坐标换成机器人附近同一维度内可步行到达的脚部方块坐标。

```powershell
npm.cmd run controller -- 12 64 8
```

测试控制器等待初始观测，记录起点，移动到指定方块，读取即时状态确认抵达，再返回并确认起点。状态转换以 `controller_state` 输出。测试最多运行 90 秒，完成后退出；失败或取消时会断开并保留最后的位置供排查。

工作台和熔炉测试使用同一个控制器入口。机器人需在创造模式、背包为空，两个坐标需在它够得到的范围内。工作站可放在石头、圆石、玻璃、石砖或泥土上。若地面是草方块，把工作站坐标设在地面上方两格，控制器会在中间加一块临时玻璃，以免盖住草地。依次填写工作台和熔炉的坐标。

```powershell
$env:MC_CONTROL = 'true'
$env:MC_ALLOW_OFFLINE_CONTROL = 'true'  # 已明确使用离线认证的隔离存档
npm.cmd run controller -- workstations -154 65 -59 -154 65 -58
```

测试用 8 个圆石在工作台合成 1 个熔炉，再用 1 个煤把 1 个粗铁熔成 1 个铁锭。每步都检查服务器同步后的背包数量。结束或中断时，控制器会先清空临时炉槽，再移除工作站、临时玻璃和测试物品，并核对原地面。若连接中断或清理无法确认，命令返回失败，`cleanupErrors` 会列出待检查项。

## 验证

```powershell
npm.cmd run typecheck
npm.cmd test
```

自动化测试启动仅监听 `127.0.0.1` 的隔离协议服务器，在 Minecraft Java 版 `1.21.11` 和 `26.1` 上覆盖自动版本协商、登录、状态观测、正常断开及踢出。操作测试覆盖 `26.1` 的聊天授权、移动、跟随取消、放置、挖掘、拉杆交互、容器转移、背包合成和熔炉产出。各项真实联调状态见路线图。

[架构](docs/architecture.md) · [路线图](docs/roadmap.md)
