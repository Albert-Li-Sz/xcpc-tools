# Hydro/XCPC-TOOLS

A tool for CN XCPC contests

- 代码打印和小票机打印（全平台支持）
- 支持封榜期间发放鼓励气球
- 支持连接 DOMjudge 与 Hydro 系统，同时亦可独立运行
- 选手机赛时数据监控与屏幕监控

当前最新版本可直接在 [Releases](https://github.com/hydro-dev/xcpc-tools/releases/) 下载使用

### Server

Server 端分为 `Server Mode` 和 `Fetch Mode` ，在 `Fetch Mode` 下支持获取用户气球与连接小票机打印。各功能配置方法如下：

#### 安装

在 [Releases](https://github.com/hydro-dev/xcpc-tools/releases/) 下载已经封装好的 Windows, Linux, macOS 二进制使用，如有未封装好的架构但 Node.js 支持的系统或系统内已有 Node.js 亦可下载 `xcpc-tools-bundle.js`使用。

下载后首次运行会生成 `config.server.yaml`。如使用 `Fetch Mode`，请填写相关赛事系统配置；独立运行则使用 `type: server`，核对登录密码和客户端凭据后重启。

系统配置介绍如下：

```ts
const serverSchema = Schema.intersect([
    Schema.object({
        type: Schema.union([
            Schema.const('server'),
            Schema.const('domjudge'),
            Schema.const('hydro'),
        ] as const).description('server type').required(), // 服务类型
        port: Schema.number().default(5283), // 服务端口
        viewPass: Schema.string().default(String.random(8)), // UI登录密码，可通过 admin / {viewPass} 登录
        secretRoute: Schema.string().default(String.random(12)), // 打印路径，用于远程调用
        clients: Schema.array(Schema.object({
            token: Schema.string().required(), // 16-128 位 URL 安全随机密钥，同时写入 config.client.yaml
            name: Schema.string().required(), // 管理页面展示名称
            type: Schema.array(Schema.union(['printer', 'balloon'])).min(1).default(['printer']),
        })).default([]), // 打印与气球客户端，统一由服务端配置管理
        arenaLayouts: Schema.string().default('data/arena-layouts.json'), // Arena View 布局 JSON 文件路径
        ssh: Schema.object({
            enabled: Schema.boolean().default(false),
            username: Schema.string().default('root'),
        }),
    }).description('Basic Config'),
    Schema.union([
        Schema.object({
            type: Schema.union([
                Schema.const('domjudge'),
                Schema.const('hydro'),
            ] as const).required(), // 赛事系统类型
            server: Schema.string().role('url').required(), // 赛事系统地址
            contestId: Schema.string(), // 赛事ID，如无则自动获取（DOMjudge），hydro 请使用 domainId/contestId 作为ID
            token: Schema.string(), // 赛事系统 Token 如无可使用用户名密码登录
            username: Schema.string(), // 赛事系统用户名
            password: Schema.string(), // 赛事系统密码
            freezeEncourage: Schema.number().default(0), // 封榜后鼓励气球数（0 为不发放），需赛事系统配置封榜后仍生成气球
        }).description('Fetcher Config'), // token 与 username/password 二选一
        Schema.object({
            type: Schema.const('server').required(),
        }).description('Server Mode Config'),
    ]),
]);
```

填写好配置重启后即可使用，程序默认监听 0.0.0.0 ，可通过 `http://服务IP:5283` 访问 UI 界面。服务用户名为 `admin` ，密码为填写的 `viewPass` 。

#### Print

支持各类比赛系统推送打印信息，系统将自动调用 `typst` 为选手代码进行高亮并转换为 PDF 文件，由打印/气球客户端进行打印。 建议使用命令进行打印，避免服务交互数据泄漏，如需使用请从`https://github.com/hydro-dev/xcpc-tools/blob/main/scripts/print`下载脚本并提前将脚本放置在 `PATH` 中。

`print [file] [original] [language] [username] [teamname] [teamid] [location] [group]` 为打印命令，其中 `file` 为代码文件路径，`original` 为原文件名，`language` 为语言，`username` 为用户名，`teamname` 为队伍名，`teamid` 为队伍ID，`location` 为选手位置，`group` 为可选的打印路由组。

`group` 直接配置在 Client 原有的 `printers` 列表中，不需要再为每台打印机单独配置 route。字符串形式或对象中未填写 `group` 的打印机全局接收任务；只有明确填写 `group` 的打印机才限制为对应分组。提交任务时显式提供 `group` 会先精确匹配；未提供时按照 `location` 的最长前缀匹配；没有空闲的分组打印机时回退到全局打印机。

```yaml
printers:
  - printer: HP-East
    group: A
  - printer: HP-West
    group: B
  - HP-Backup # 未配置 group，全局使用
```

打印接口会在写入前校验队伍 ID、队名、原文件名及内容大小（最多 256 KiB），文件使用服务端生成的任务 ID 保存。队伍 ID 和原文件名不能包含路径分隔符。

打印客户端使用协议 v4，升级时必须同步更新服务端和打印客户端；旧版客户端会被明确拒绝。每次领取前，客户端先持久化随机请求编号；响应丢失或重启后，服务端按编号恢复同一次领取，防止额外分配任务。客户端将领取、提交打印和等待确认的状态写入 `data/print-journal/`，重启后继续确认已提交的任务。PDF 转换等提交前失败最多自动尝试 3 次；达到上限显示 `Failed`。已经提交给打印系统但结果不确定的任务显示 `Needs review`，不会自动重打。

管理员应先核对打印机队列和纸张输出，再将 `Needs review` 标记为 `Done`，或通过 `Reprint` 重新派发。`Done` 表示打印系统接受了任务或管理员确认完成，不能代替实际出纸检查。手动重新派发已提交任务可能造成重复打印。升级、迁移和重启时请保留原客户端工作目录中的打印日志；每个客户端工作目录仅运行一个打印进程，程序通过目录锁强制执行。`Checks` 会提示领取超过 5 分钟仍未结束的任务；需结合打印队列核对，不能直接假定未打印。

#### Balloon
服务支持 `Fetch Mode` 下的气球推送，支持 `DOMjudge` 与 `Hydro` 系统，支持 `DOMjudge` 与 `Hydro` 系统的 `Balloon` 推送，同时若赛事在封榜后仍然推送气球，则支持自定义鼓励气球数，高于设定值则不推送，为所有队伍打造优质赛场体验。

#### Monitor
服务端提供两种选手机上报方式：HTTP `/report` 只更新机器状态，WebSocket `/probe` 在更新状态之外还会接收命令并回传执行结果。旧镜像可以继续定时运行 [`scripts/monitor`](scripts/monitor) 进行 HTTP 上报；新镜像使用 Machine Tools 配置 heartbeat 和 WebSocket Probe。

两种上报共用 `monitor.reportToken`：

```yaml
monitor:
  reportToken: REPLACE_WITH_RANDOM_REPORT_TOKEN
  exporters:
    - job: node
      port: 9100
  auto:
    name: ''
    group: ''
    camera: ''
    desktop: ''
```

`reportToken` 首次生成配置时自动设置为随机密钥。HTTP 和 WebSocket 请求都必须携带 `?token=对应值`；空值会禁用机器上报并使 `Checks` 检查失败。升级旧配置时，应先生成一个稳定的随机密钥，并同步写入所有选手机的上报配置。

`monitor.auto.group` 为 `true` 时使用 hostname 开头的连续字母作为 Group；设置为数字 N 时使用 hostname 的前 N 位；设置为字符串时与其他 `monitor.auto` 字段一样使用模板，例如 `[hostname:1]`。未配置的字段不会修改。

Machine Tools 提供选手机本地配置页和赛前展示页。配置页根据服务器地址生成 `/report`、`/probe` 和 `/presentation` 地址，保存座位号、上报 Token 与 Probe 配置。“测试上报”使用独立验证消息，不替换正在运行的 Probe，也不领取待执行命令；此测试需要同步更新服务端。

Linux 镜像需要预装 Machine Tools、Python 3.8+、`python3-websockets`、Python Probe 和对应的 systemd unit。配置程序不会安装这些运行组件。

```bash
hydro-machine-tools                 # 本机配置
hydro-machine-tools --presentation  # 赛前展示
```

座位号写入 `/var/lib/icpc/config.json`。如果镜像提供 `hydro-machine-tools.service`，配置程序把 Probe 地址和上报 Token 写入 `/etc/default/hydro-machine-tools`，启用 WebSocket Probe 并停用 `heartbeat.timer`；旧镜像则写入 `/etc/default/icpc-heartbeat`，继续使用 HTTP heartbeat。

上报服务启动后，可在 `http://服务IP:5283/#/monitor` 查看选手机状态。

由于 VLC 自带的服务不支持 CORS ， 因此产品内置了一个代理服务，代理会先移除管理员认证头和 Cookie，再将请求转发到选手机上，您可以通过代理服务访问选手机上的 VLC 服务以实现监控。

请注意，默认上报的选手机是不支持查看屏幕的，需要在 UI 上配置选手机信息。点击选手机列表中的选手机的详情按钮，然后在弹出的对话框中即可修改选手机信息。字段含义如下：

- `Client Name` 选手机名称
- `Client group` 选手机组别
- `Camera Stream` 选手机摄像头地址（暂只支持 TS 流地址）
- `Desktop Stream` 选手机桌面地址（暂只支持 TS 流地址）

流地址可使用 `proxy://xxxx` 代理服务，`proxy://` 取代的是 `http://{ip}`， 如 `proxy://:9090/`, 此时代理服务会将请求转发到选手机 `http://{ip}:9090/` 上。

如您有可直接访问的 TS 流地址，可直接填写，您可通过 CDS 等服务获得此类流地址，注意流地址需要支持跨域访问，否则无法在 UI 上正常显示，如您的流地址不支持跨域访问，您可以使用代理服务进行转发，同时 CDS 服务提供的流在封榜后将无法观看，请自行取舍。如修改成功， Info 选项卡后便会多出桌面和摄像头的预览标签页，同时在选手机列表中也会支持直接查看选手机的摄像头和桌面。

#### Prometheus 服务发现

如需使用 Prometheus 采集选手机上的 exporter，可将 `/sd` 作为 [HTTP 服务发现](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#http_sd_config)端点。服务会根据选手机上报的 IP 自动生成采集目标；`monitor.exporters` 默认包含端口为 `9100` 的 `node` exporter，也可以配置多个 exporter：

```yaml
monitor:
  exporters:
    - job: node
      port: 9100
    - job: keyboard
      port: 9160
```

`/sd` 为每台机器的每个 exporter 返回一组目标，并通过 `__meta_prometheus_nodename` 提供机器名称；优先使用管理员配置的 `monitor.name`，未配置时使用机器记录 ID：

```json
[
  { "targets": ["192.168.0.2:9100"], "labels": { "__meta_prometheus_job": "node", "__meta_prometheus_nodename": "C415-01" } },
  { "targets": ["192.168.0.3:9100"], "labels": { "__meta_prometheus_job": "node", "__meta_prometheus_nodename": "C415-02" } }
]
```

该端点与管理界面共用 Basic Auth，用户名为 `admin`，密码为 `viewPass`。`__meta_*` 标签会在抓取前被 Prometheus 丢弃，如需保留机器名称，可在 `prometheus.yml` 中通过 `relabel_configs` 将它映射为普通标签：

```yaml
scrape_configs:
  - job_name: xcpc-machines
    http_sd_configs:
      - url: http://服务IP:5283/sd
        basic_auth:
          username: admin
          password: <viewPass>
    relabel_configs:
      - source_labels: [__meta_prometheus_job]
        target_label: job
      - source_labels: [__meta_prometheus_nodename]
        target_label: hostname
```

可以直接使用上述 `hostname` 标签识别机器；也可以不保留该发现标签，改用 `node_exporter` 的 `node_uname_info` 指标中的 `nodename`。掉线机器仍会保留在目标列表中，由 Prometheus 将其标记为 `up=0`。

#### Batch / Quick Operation
为了方便修改选手机信息，服务支持批量操作和根据选手机字段快速操作，如您需要批量修改选手机信息，可通过 `Batch Operation` 选项卡进行批量操作。

快速操作即你可以在对话框中填写 `[]` 指代已有的字段，如 `[hostname]`, `[ip]`, `[mac]` 等，系统会自动将对应字段填充到选手机信息中。

同时，组别名支持只取名字前缀，如 `[hostname:3]` 会取选手机名称的前三位，如您需要使用 hostname 为 AXX 的选手机 hostname 中的第一位作为组别名，您可以在快速操作中填写 `[hostname:1]`，系统会自动填充对应的选手机信息。

在字段中输入 `del` 可以删除对应字段的信息。批量编辑须先点击 `Preview changes` 查看影响数量和生成名称；存在重名时不能提交。预览后机器名称、地址等信息发生变化时，需要重新预览。列表以设备 ID 为索引，即使旧数据重名也会保留全部机器。

#### Commands
`Commands` 页面保留内置命令快捷入口，也可向选中的 v2 选手机或全部在线 v2 选手机下发自定义命令并查看执行结果。仅使用 v1 HTTP 上报的选手机无法接收命令，页面会单独提示其数量。

命令默认只发给在线机器，有效期为 15 分钟，页面提供 1、5、15、60 分钟选项（接口支持 1–1440 分钟）；选择 `Allow reconnect before expiry` 可等待离线 v2 机器重连。有效期限制首次下发时间，已下发的命令由 Probe 的执行超时控制。历史记录分别展示成功、失败、执行超时、过期和取消状态，非零退出码不会显示成功。

`Cancel waiting targets` 仅取消尚未下发的目标，不会中止已经运行的命令。Probe 在执行前持久化命令占位，并保留已确认命令的去重记录；连续重复消息及确认后的再次投递都不会重复执行。请同步更新发布包中的 `machine_tools_probe.py` 并保留其状态文件。

打印与命令历史使用服务端分页，每页默认 50 条（接口最多 100 条），搜索和状态筛选覆盖全部历史。命令列表仅返回摘要，执行输出在打开详情时按每页 10 台机器加载。部分失败、部分等待的命令同时出现在失败和等待筛选中。历史记录会保留，长期存档可使用下述停服备份。

OJ 队伍同步失败后会自动重试，成功后每 5 分钟刷新一次；比赛信息、队伍、气球和打印同步全部成功才更新最近同步成功时间。慢请求不会导致轮询重叠。

#### 赛前检查与备份恢复

管理界面的 `Checks` 页面检查客户端凭据配置、上报认证、OJ 最近同步、打印机在线状态、Probe 版本、座位冲突、展示名单匹配、数据目录可写性和待核对打印任务。`Print test page` 会在确认后提交一张真实测试页，请按打印分组分别检查输出。`Export diagnostics` 导出运行概况及检查结果，不包含配置密钥、命令内容或队伍名单；备份文件包含完整配置，需私密保存。

在原服务端工作目录中执行以下命令。备份和恢复前先停止服务端；运行中的服务会持有数据锁，阻止并发备份或恢复。若使用 JS bundle，将 `./xcpc-tools` 替换为 `node /路径/xcpc-tools-bundle.js`。

```bash
# 创建备份，已有同名文件不会被覆盖
./xcpc-tools --backup ./backups/contest.xcpc.gz

# 只检查归档并列出内容，不修改当前数据
./xcpc-tools --restore ./backups/contest.xcpc.gz

# 确认恢复；当前数据保留在 backups/before-restore-* 下
./xcpc-tools --restore ./backups/contest.xcpc.gz --confirm-restore

# 恢复过程中退出后，先回退到恢复前的数据，再重新操作
./xcpc-tools --recover-restore
```

归档包含 `config.server.yaml`、服务端 `data/` 和配置指定的 Arena 布局（恢复后统一放到 `data/arena-layouts.json`）；不包含操作日志 `data/actions.log` 和打印客户端 `data/print-journal/`。外部 SSH 私钥、客户端配置与 Probe 本地状态需要另外保存。归档拒绝符号链接、越界路径、校验和错误及超过 256 MiB 的解压内容。

恢复后，未完成的代码打印及气球任务暂停等待人工核对，待执行命令取消，客户端在线状态重置。完成现场核对后可按需重新派发。恢复中断会留下标记并阻止服务端启动，运行 `--recover-restore` 回退后再启动；不要直接删除恢复标记或原数据备份。

#### Presentation Teams

`Teams / Presentation` 页面维护选手设备展示页使用的独立 roster。Server Mode 可上传 JSON、CSV 或 TSV；选择文件后需将原始表头映射到队伍 ID、队名、学校、座位、队员 1/2/3、教练和组别。队伍 ID 未选择时使用座位号。Hydro 或 DOMjudge 已连接时也可点击 `Load from OJ` 现场刷新并复制当前比赛队伍。OJ 数据不会持续覆盖已经确认的展示 roster。

- `Fetch logos` 按完整学校名从 `hydro-dev/avatar-registry` 获取 WebP 校徽，下载后由本服务本地缓存和提供。
- `Export with IP` 会先显示实时 IP 的匹配、缺失和歧义统计，确认后下载 JSON 或带 UTF-8 BOM 的 CSV。
- `/presentation?seat=A01` 始终从该 roster 精确匹配座位，为 machine-tools 展示队名、学校、座位和校徽。

#### WebSSH

设置 `customKeyfile` 并启用 `ssh` 后，管理员可从 Computers 页面打开已上报机器的 WebSSH。服务端使用 `ssh.username` 和该私钥直接连接机器上报的 IP。

#### Arena Layouts
监视页面的座位图布局由服务端 `config.server.yaml` 的 `arenaLayouts` 指定，仅支持 JSON，默认保存到 `data/arena-layouts.json`。管理员可在 Computers 页的 Arena 视图打开编辑器，按区域数量、各区域排数/列数、通道、编号方向、指定行的左右留空和指定列的上下留空生成座位图。保存采用 revision 冲突保护并立即热更新，不需要重启服务端。
- 编辑器的 Seat ID Template 可自由修改，并内置 `[group:1][row:2][col:2]` 和 `[group]-[id]` 两个示例；选择保存在 `meta.generator` 中。
- 编辑器生成的参数保存在 `meta.generator`。没有该字段的手工布局保持只读，只有明确确认转换后才会由生成器覆盖。
- 单个布局最多允许 100,000 个座位和 100,000 个包含通道空位的网格单元；超出限制时编辑器不会构建预览或保存。
- 顶层字段：`id`（唯一标识，缺省使用文件名）、`name`、`description`(可选)、`seatKey`、`normalize`(`none`/`upper`/`lower`/`trim`/`trim-upper`/`trim-lower`)、`default`(可选，用于默认选中)、`sections`。机器匹配会依次尝试 `seatKey` 指定字段、`name` 和 `hostname`，并使用第一个确实存在于布局中的座位号。
- `sections` 数组中的每个对象需包含 `grid` 二维数组（元素只能是座位号字符串或 `null` 表示空位），可选字段包括 `title`、`rowLabels`、`seatSize`、`gapSize`、`meta` 等。
- 同一个布局文件可携带一个布局对象或布局数组，`default: true` 的布局会优先选中；用户最后选择的布局 ID 仅保存在浏览器中。

```json
{
  "id": "sample-layout",
  "name": "Sample Venue",
  "description": "Short note shown in the selector",
  "seatKey": "hostname",
  "normalize": "trim-upper",
  "default": true,
  "sections": [
    {
      "id": "main-hall",
      "title": "Main Hall",
      "rowLabels": ["3", "2", "1"],
      "seatSize": 40,
      "gapSize": 10,
      "grid": [
        ["A0301", "A0302", null],
        ["A0201", null, "A0203"],
        ["A0101", "A0102", "A0103"]
      ]
    }
  ]
}
```

### Client

Client 端分为打印代码和打印小票两个功能，支持 Windows, Linux, macOS 三大平台，支持打印机自动检测，支持自动分散打印机任务，为了方便使用， Server 与 Client 一同打包为单文件，启动时仅需添加 `--client` 参数即可启动 Client 。

由于 Windows 限制，在 Windows 下打印代码需要安装 `SumatraPDF` 用于打印 PDF 文件，如您的系统没有安装 `SumatraPDF` ，请根据提示下载便携版并放置于同一目录中；打印气球需将气球打印机设置为共享打印机，后续会自动检测。

Client 端的配置文件为 `config.client.yaml` ，配置文件介绍如下：

```ts
const clientSchema = Schema.object({
    server: Schema.string().role('url').required(), // XCPC-TOOLS 服务地址
    balloon: Schema.string(), // 气球小票机路径或名称，请自行根据启动后的提示填写
    balloonLang: Schema.union(['zh', 'en']).default('zh').required(), // 气球小票语言
    balloonType: Schema.union([58, 80, 'plain']).default(80), // 气球小票机纸张宽度，plain 使用纯文本命令
    balloonCommand: Schema.string().default(''), // 自定义气球打印命令
    balloonTemplate: Schema.string().default(balloonTemplateDefault), // 气球小票模板
    printColor: Schema.boolean().default(false), // 是否打印彩色代码
    printPageMax: Schema.number().default(5), // 单次代码打印页数上限
    printMergeQueue: Schema.number().default(1), // 合并处理的打印任务数量，整数 1–20
    printers: Schema.array(Schema.union([
        Schema.string(), // 全局打印机
        Schema.object({
            printer: Schema.string().required(),
            group: Schema.string(), // 可选；填写后只接收对应分组
        }),
    ])).default([]), // 启用的打印机列表，为空则不启用打印功能
    token: Schema.string().required().description('Token generated on server'), // 服务端 Token
    fonts: Schema.array(Schema.string()).default([]), // 额外字体路径
    localWeb: Schema.object({
        enabled: Schema.boolean().default(true),
        host: Schema.string().default('127.0.0.1'),
        port: Schema.number().default(5284),
    }), // Client 本机只读状态页
});
```

Client 启动后可在本机访问 `http://127.0.0.1:5284/`，并通过 `/#/print` 和 `/#/balloon` 查看各自的连接状态、当前任务阶段、目标打印机以及最近 100 条结果。该页面复用管理端界面并只监听 loopback；监听端口被占用时 Client 会报错并退出。

首次生成的 `config.server.yaml` 已包含一个打印客户端和一个气球客户端，并分别生成随机 `token`。启动 Client 前，将对应的 `token` 写入该客户端的 `config.client.yaml`；需要更多客户端时，再在服务端配置中追加。管理页面只展示连接状态，不再新增、删除或修改客户端。

```yaml
clients:
  - token: REPLACE_WITH_RANDOM_PRINT_TOKEN
    name: Print Room 01
    type: [printer]
  - token: REPLACE_WITH_RANDOM_BALLOON_TOKEN
    name: Balloon Desk
    type: [balloon]
  - token: REPLACE_WITH_RANDOM_COMBINED_TOKEN
    name: Venue Service
    type: [printer, balloon]
```

`token` 是客户端接口的唯一凭据，必须使用随机生成的密钥，切勿使用机房名、用途或连续编号。允许字符为字母、数字、下划线和连字符，长度为 16-128 位。每个 token 必须唯一且保持稳定；泄漏后应立即替换服务端和客户端配置。修改 `config.server.yaml` 后重启服务端即可同步打印与气球客户端清单。Webhook bot 也从该配置读取，`enabled: false` 可停用同 ID 的旧 bot。

### Bot 推送

气球事件可同时推送到 Telegram、Discord、企业微信、钉钉、Lark。Bot 同样在 `config.server.yaml` 的 `clients` 中配置，推送状态与实体气球打印状态相互独立。

```yaml
clients:
  - id: balloon-discord
    name: Balloon Discord Bot
    type: webhook
    subType: discord # telegram | discord | wxwork | dingtalk | lark
    token: your-discord-bot-token
    chatId: your-discord-channel-id
    endpoint: '' # 可选，自定义 Discord API 地址
    enabled: true
    report: false # true 时推送成功后向赛事系统回报气球已完成
    balloonTemplate: |-
      🎈 New balloon
      Team: {team}
      Location: {location}
      Problem: {problem}
      Color: {color}
      Award: {award}
      Time: {time}
```

整个配置最多允许一个 Webhook 设置 `report: true`；配置多个时服务端会在启动时报错，避免不同推送通道竞争回报同一个气球。

模板支持 `{source}`、`{id}`、`{team}`、`{location}`、`{problem}`、`{color}`、`{rgb}`、`{award}` 和 `{time}`。每个 bot 单独记录已推送状态，失败的通道会在后续同步时重试，不会阻止打印客户端领取任务。

首次启动时，系统会检测打印机并提示您填写配置文件，填写好配置文件后即可启动客户端，客户端会自动连接服务端并获取打印信息。

### 开发与验证

使用 Node.js 24、Python 3.11 和项目声明的 Yarn 4.12.0。提交依赖修改时同时提交 `yarn.lock`。

```bash
corepack enable
yarn install --immutable
yarn check                  # ESLint、三个子项目类型检查、Node 与 Python 回归测试
yarn build
yarn playwright install chromium
yarn test:e2e               # 临时服务端、模拟打印客户端与 Probe、桌面及手机页面
```

端到端测试需要空闲的本地端口 `15983`，在临时目录中创建独立数据，不调用物理打印机。Pull Request 检查和发布前检查都会执行上述验证；真实打印设备和赛事系统仍需在赛前通过 `Checks` 和测试页确认。
