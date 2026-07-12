# BBGU Grade Watch

[![北部湾大学成绩监控](https://github.com/w937521t/bbgu-grade-watch/actions/workflows/bbgu.yml/badge.svg)](https://github.com/w937521t/bbgu-grade-watch/actions/workflows/bbgu.yml)

基于 GitHub Actions 的北部湾大学成绩监控脚本。它会定时维护登录状态、查询本学期成绩，并在成绩新增或变更时通过 PushPlus 发送通知。

本项目只面向 GitHub Actions，不包含青龙、油猴或本地常驻运行方案。

> 仅用于查询本人账号和本人有权访问的数据。仓库必须设为 Private，不要公开 Token、Cookie、机场订阅或状态加密密码。

## 功能

- 每天北京时间 10:07 至 22:07，每小时查询一次成绩。
- 每天奇数小时 01:37 至 23:37，每两小时维护一次登录状态。
- 只有成绩新增或变更时才查询相关课程的平时分。
- 没有成绩变化时不推送，也不查询平时分。
- 通过 CAS、Refresh Token、Access Token 三层状态尽量延长免扫码时间。
- 使用 Mihomo 国内粘性节点，节点正常时长期保持同一出口。
- 登录状态、成绩快照和运行状态经 AES-256-GCM 加密后保存到独立 state 分支。
- PushPlus 失败后保留待发送通知，下次任务继续发送，不重复查询平时分。
- 临时网络故障只跳过本次脚本任务，不误判 CAS 或 Token 失效。

## 快速部署

### 1. 创建私有仓库

将本项目上传到 GitHub Private repository。仓库根目录至少需要：

~~~text
.github/workflows/bbgu.yml
scripts/state-crypto.js
scripts/state-crypto.test.js
scripts/workflow-contract.test.js
bbgu_grade_watch.js
bbgu_grade_watch.test.js
package.json
package-lock.json
.gitignore
README.md
~~~

不要上传 bbgu-data、Token、Cookie、二维码截图或机场订阅。

### 2. 配置 Repository Secrets

进入：

~~~text
Settings -> Secrets and variables -> Actions -> Secrets
~~~

添加：

| Secret | 必填 | 用途 |
| --- | --- | --- |
| PUSHPLUS_TOKEN | 是 | 发送成绩通知和扫码提醒 |
| BBGU_STATE_PASSWORD | 是 | 加密和解密 state 分支中的运行状态 |
| CLASH_SUBSCRIPTION_URL | 是 | 在 GitHub Runner 中临时启动 Mihomo |
| BBGU_PROXY_FILTER | 否 | 覆盖默认国内节点筛选正则 |
| BBGU_PROXY_EXCLUDE | 否 | 覆盖默认境外节点排除正则 |

BBGU_STATE_PASSWORD 不是学校密码。建议生成至少 32 位随机字符串，并单独保存：

~~~powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | ForEach-Object {[char]$_})
~~~

默认国内节点筛选：

~~~text
(?i)(^CN-|中国|国内|上海|深圳|浙江|内蒙古|云南|山东|河南|成都|广东)
~~~

默认境外节点排除：

~~~text
(?i)(HK|香港|TW|台湾|JP|日本|US|美国|Netflix)
~~~

脚本还会排除名称中包含“剩余、流量、到期、官网、套餐”的订阅说明项。

### 3. 配置学期变量

进入：

~~~text
Settings -> Secrets and variables -> Actions -> Variables
~~~

添加：

~~~text
名称：BBGU_TERM
示例值：2026春
~~~

新学期开始时只需修改该变量。缺少 BBGU_TERM 时，watch 会在访问成绩接口前停止，防止不同学期混入同一快照。

### 4. 开启 Workflow 写权限

进入：

~~~text
Settings -> Actions -> General -> Workflow permissions
~~~

选择 Read and write permissions。该权限用于创建和更新加密状态分支。

### 5. 首次扫码

1. 打开仓库的 Actions 页面。
2. 选择“北部湾大学成绩监控”。
3. 点击 Run workflow。
4. 模式选择 login。
5. 收到 PushPlus 二维码后，在 300 秒内扫码。
6. 等待任务完成。

成功后，仓库会出现 state 分支，其中只有：

~~~text
bbgu-state.enc
~~~

这是加密状态包，不是 Token 明文。

### 6. 验证

首次登录后建议手动运行：

1. renew：检查 CAS、Refresh Token、Access Token 状态。
2. watch：确认能够查询成绩并保存快照。

正常情况下，两次运行结束后都会更新加密状态。

## 整体运行流程

~~~mermaid
flowchart LR
    A["GitHub 定时器"] --> B["恢复加密状态"]
    B --> C["启动 Mihomo 粘性节点"]
    C --> D{"运行模式"}
    D -->|"watch"| E["查询总成绩"]
    D -->|"renew"| F["维护登录状态"]
    D -->|"login"| G["扫码登录"]
    E --> H["对比成绩快照"]
    H -->|"无变化"| I["不推送"]
    H -->|"新增或变更"| J["查询相关课程平时分"]
    J --> K["加入 PushPlus 队列并发送"]
    F --> L["更新认证状态"]
    G --> L
    I --> M["加密并保存状态"]
    K --> M
    L --> M
~~~

每次 GitHub Actions 都运行在一台全新的临时 Ubuntu Runner 上，因此脚本必须在开始时恢复状态，在结束时重新保存状态。

## 四种运行模式

| 模式 | 用途 | 是否查成绩 |
| --- | --- | --- |
| watch | 查询成绩、对比快照、必要时查询平时分并推送 | 是 |
| renew | 维护 CAS、Refresh 和 Access，安排扫码时间 | 否 |
| login | 首次登录或手动重新扫码 | 否 |
| watch-reset | 删除旧快照，再执行一次 watch | 是 |

watch-reset 会把当前所有成绩视为“新增”，因此会产生一次测试通知，并尝试查询这些课程的平时分。不要把它当作日常模式。

## 定时安排

| 模式 | 北京时间 | 每日次数 |
| --- | --- | ---: |
| watch | 10:07、11:07……22:07 | 13 |
| renew | 01:37、03:37……23:37 | 12 |

GitHub Actions 的定时任务可能延迟。脚本依据 Token 的实际 JWT exp 和后续自动任务时间重新计算，不依赖任务绝对准点。

## 三层登录状态

| 状态 | 保存位置 | 能做什么 | 失效后的结果 |
| --- | --- | --- | --- |
| CAS Session | bbgu_storage_state.json 中的 Cookie | 重新取得 Refresh 和 Access | 改用最后的 Refresh |
| Refresh Token | bbgu_token.env | 向认证服务器申请新 Access | 继续使用最后的 Access |
| Access Token | bbgu_token.env | 调用成绩和平时分接口 | 必须重新扫码 |

关系可以简化为：

~~~text
扫码登录
  -> 得到 CAS Session
  -> 得到 Refresh Token
  -> 得到 Access Token

CAS 有效
  -> 静默续期
  -> 重新取得 Refresh + Access

CAS 失效
  -> 使用最后的 Refresh 申请新 Access

Refresh 失效
  -> 使用最后的 Access 完成它还能覆盖的 watch

Access 也无法覆盖下一次 watch
  -> 推送二维码
~~~

脚本会解析 Access 和 Refresh 的 JWT exp。Refresh 的寿命不在代码中写死，以学校签发的实际 exp 为准；新 Access 的覆盖预测按 12 小时计算。

Refresh 接口如果返回新的 Refresh，脚本会保存新值；如果没有返回，则保留原 Refresh。脚本不会假设 Refresh 一定能够刷新自己。

CAS 没有可直接读取的 JWT 到期时间。只有浏览器明确落到统一认证登录页时，脚本才记录 casExpired。普通超时、TLS 失败或断线不会把 CAS 判死。

## watch：成绩查询逻辑

watch 的执行顺序如下：

1. 检查 PUSHPLUS_TOKEN 和 BBGU_TERM。
2. 从加密状态中读取 Access Token。
3. 解析 Access 的本地 exp。
4. Access 未过期时，只请求一次总成绩接口。
5. Access 已过期时，跳过这次必然失败的成绩请求，直接进入认证恢复。
6. 如果服务器提前返回 401 或登录页，也进入认证恢复。
7. 规范化课程名称、课程代码、成绩、学分、学期和 scoreId。
8. 与 bbgu_grade_snapshot.json 对比。
9. 只有新增或变更课程才查询平时分。
10. 保存通知、成绩快照并发送 PushPlus。

总成绩接口：

~~~text
GET /api/sam/score/student/score
~~~

课程唯一键包含学期、课程代码和课程名称，避免重修或跨学期课程互相覆盖。

### 成绩变化的定义

- 本次课程唯一键在旧快照中不存在：新增。
- 同一课程唯一键仍存在，但成绩或学分等展示内容不同：变更。
- 完全一致：无变化。

没有变化时不查询平时分、不生成新通知，但仍会保存最新快照，并补发以前发送失败的通知。

### 平时分查询

平时分接口：

~~~text
GET /api/sam/scoreManage/stu-score-form?scoreId=...
~~~

规则：

- 只查询本次新增或变更的课程。
- 每门相关课程最多请求一次。
- 没有 scoreId 时跳过并记录可用字段。
- 课程自身没有明细时，继续查询下一门。
- 发生认证、权限、限流、服务器、协议或全局网络错误时，停止查询后续课程。
- 已经保存的平时分会合并回新快照，后续无变化时不会重复查询。

## renew：登录续期逻辑

renew 不查询成绩，只维护登录能力。

### 第一阶段：CAS 静默续期

CAS 尚未记录失效时：

1. 读取保存的浏览器 Cookie。
2. 从浏览器 localStorage 副本中删除旧 Access、Refresh 和 Token 过期字段。
3. 保留 CAS Cookie。
4. 打开一次 CAS 续期地址。
5. 拦截图片、字体、媒体和样式表，减少无关资源请求。
6. 等待页面写入新的 Access 和 Refresh。
7. 原子保存 Token 和新的浏览器状态。

结果处理：

- 明确进入统一认证登录页：CAS 永久标记失效。
- 临时网络或浏览器故障：本次结束，不标记 CAS 失效。
- CAS 成功：清理旧二维码和失效标记，本次 renew 结束。

### 第二阶段：Refresh 最后覆盖

CAS 已确认失效后，脚本不会每次 renew 都调用 Refresh。

它会结合当前 Access 的 exp、Refresh 的 exp、未来 watch 和 renew 时间、Refresh 到期前 60 分钟安全余量，以及新 Access 能覆盖的 watch 进行计算。

只有以下情况才使用 Refresh：

- 当前 watch 已经不被 Access 覆盖。
- 当前任务是最后一个仍有价值的刷新机会，而且刷新后能够覆盖更多 watch。

如果后面仍有安全的自动任务机会，当前 renew 会等待。这样尽量晚用最后的 Refresh，把最后一个 Access 的到期时间向后推。

每次任务最多发送一次 Refresh POST，不对同一次失败重复提交。

### 第三阶段：二维码计划

当 Refresh 到达 JWT exp，或认证服务器明确返回 401、invalid_grant、invalid_token、已过期、已撤销等信息时，脚本将其永久标记为失效。

随后根据最后一枚 Access 的到期时间，寻找第一场无法覆盖的 watch：

- 普通时段：提前约 1 小时安排二维码。
- 下一场是当天 10:07：安排在 09:37。
- 09:37 已提醒但未扫码：允许 10:07 再提醒一次。
- 其他重复提醒遵守 2 小时冷却。

二维码只有在 PushPlus 明确发送成功后才写入冷却时间。发送前失败不会阻止下一次任务重试。

## login：扫码逻辑

login 会：

1. 启动无头 Chromium。
2. 通过 Mihomo 打开教务系统主页。
3. 如果保存的 CAS 仍能自动登录，直接取得新 Token。
4. 否则被动捕获页面已有的微信二维码。
5. 优先截图二维码元素并尝试解码为终端文本二维码。
6. 通过 PushPlus 发送扫码提醒。
7. 最多等待 300 秒。
8. 每 5 秒检查一次 Access 是否已经写入。
9. Access 出现后最多额外等待 10 秒获取稍晚写入的 Refresh。
10. 保存 Token、Cookie 和提醒状态。

脚本不会为了补取二维码主动调用 combinedLogin.do 或微信 qrconnect。GitHub 环境下如果无法取得可扫码内容，会立即结束并上传短期诊断，而不是空等 300 秒。

## 最小化学校请求

| 场景 | 学校侧主要请求 |
| --- | --- |
| 正常 watch，无变化 | 1 次总成绩 GET，0 次平时分 |
| watch 新增或变更 N 门 | 1 次总成绩 GET，最多 N 次平时分 GET |
| Access 本地过期、Refresh 成功 | 1 次 Refresh POST，1 次总成绩 GET |
| CAS 静默续期 | 1 次浏览器导航，并拦截非必要静态资源 |
| Refresh 续 Access | 单次任务最多 1 次 POST |
| 代理连接阶段失败 | 整个任务最多更换 1 个节点并重试一次 |
| 已进入学校响应阶段后失败 | 不跨 IP 重发 |

额外约束：

- Workflow 启动代理时不访问学校做预检。
- BBGU API 统一使用 curl 的 HTTP/1.1 模式。
- curl 自动重试次数为 0。
- Token 通过 curl 标准输入配置传递，不出现在命令行参数中。
- PushPlus、GitHub API 和本地 Mihomo 控制器保持直连。

## Mihomo 粘性节点

代理目标是“长期使用一个节点，确认连接阶段失败后才换一个”。

启动时优先读取上次保存的节点。该节点仍在订阅中且不在失败冷却期时继续使用，否则选择第一个可用国内候选节点。启动后不向学校发送健康检查。

运行规则：

- 只有代理 TCP、CONNECT 或目标 TLS 阶段失败，才允许换节点。
- 单次任务最多从 A 换到 B，不继续遍历 C、D。
- B 成功后保存 B，下一次继续使用 B。
- A 或 B 连接失败后进入 6 小时冷却。
- HTTP 业务响应不会触发节点切换。
- 请求已经到达学校、响应已经开始或响应体中断后，不跨 IP 重发。

Mihomo 镜像固定到摘要，避免上游 Alpha 标签变化导致运行行为突然改变。TLS 证书验证保持开启，不安装机场提供的 CA。

## 学校退避

| HTTP 状态 | 处理 |
| --- | --- |
| 429 | 按 Retry-After 退避；缺失或无效时默认 2 小时 |
| 500 | 全局退避 1 小时 |
| 503 | 全局退避 1 小时 |
| 502/504 | 只结束当前任务，不写跨任务退避 |

退避期间，自动 watch、renew 和二维码登录都不会访问学校。

Node 脚本阶段的超时、连接关闭、TLS 握手失败等临时网络故障会以“本次任务正常跳过”结束，不会把 GitHub Actions 标记为脚本逻辑失败。代理容器无法启动、订阅无节点等 Workflow 准备阶段错误仍会正常标红。

## 成绩通知可靠性

发生成绩变化时，顺序是：

1. 查询必要的平时分。
2. 将完整通知写入 bbgu_pending_notification.json。
3. 原子保存成绩快照。
4. 调用 PushPlus。
5. PushPlus 成功后删除待发送通知。

这样可以保证 PushPlus 暂时失败时不丢通知，下次运行继续发送，并且不会重复查询平时分。相同成绩变化还会通过通知 ID 去重。

## 状态文件

| 文件 | 内容 |
| --- | --- |
| bbgu_token.env | Access Token 和 Refresh Token |
| bbgu_storage_state.json | CAS Cookie；落盘前删除 BBGU Token localStorage 项 |
| bbgu_grade_snapshot.json | 上次成绩和平时分记录 |
| bbgu_pending_notification.json | 等待补发的 PushPlus 通知 |
| bbgu_qr_reminder_state.json | CAS、Refresh 失效标记和二维码计划 |
| bbgu_proxy_state.json | 粘性节点和失败冷却 |
| bbgu_network_state.json | 学校退避状态 |

所有 JSON 和 Token 文件都通过“临时文件写入后原子重命名”更新。写入中断时保留旧文件，避免损坏状态。

## 加密状态分支

任务结束时，Workflow 会：

1. 将存在的状态文件打包为 tar.gz。
2. 使用 BBGU_STATE_PASSWORD 通过 scrypt 派生 256 位密钥。
3. 使用 AES-256-GCM 加密。
4. 将结果保存为 bbgu-state.enc。
5. 用新的孤立根提交替换远端 state 分支。

state 分支不保存明文 Token，也不保留历史明文文件。更新使用 force-with-lease；如果任务运行期间远端状态已经变化，本次提交会停止，防止覆盖新状态。

Workflow 的并发组还会保证同一仓库的登录状态任务依次执行，不会主动取消前一个任务。

## 常见日志

### No grade changes

本次成绩与快照一致。不会推送，也不会查询平时分。

### Access token is locally known to be expired

脚本从 JWT exp 确认 Access 已过期，因此跳过一次必然失败的成绩请求，直接尝试认证恢复。

### Access token expired; trying refresh token first

Access 无法覆盖当前成绩查询，Refresh 仍有效，正在申请新 Access。

### CAS：已失效，本次已跳过

以前的任务已经明确进入统一认证登录页，因此后续任务不再重复访问 CAS。

### Refresh Token 已记录失效，本次跳过续期请求

Refresh 已到 exp，或认证服务器明确判定其失效。脚本不会重复发送无效 Refresh。

### 二维码仍在冷却期

扫码提醒已经发送过，当前未达到再次提醒时间。不是脚本卡住。

### 当前处于学校服务退避期

学校此前返回 429、500 或 503，本次任务主动不访问学校。

### 本次任务因临时网络故障正常结束

代理线路、TLS 或网络临时失败。本次不查询，下一次自动任务照常运行。

### Subscore skipped：missing scoreId

总成绩返回的数据中没有平时分接口所需的 scoreId。总成绩仍会正常保存和通知。

### Subscore fetch failed

总成绩已经取得，但该课程平时分查询失败。全局错误会停止后续平时分请求，减少额外访问。

## 状态损坏或密码丢失

BBGU_STATE_PASSWORD 丢失或更换后，旧状态无法解密。

恢复方法：

1. 删除远端 state 分支。
2. 设置新的 BBGU_STATE_PASSWORD。
3. 手动运行 login。
4. 重新扫码。

状态包损坏或密码错误时，Workflow 会在恢复阶段停止，不会用空状态覆盖原 state 分支。

## 新学期

1. 将仓库 Variable BBGU_TERM 改为新学期，例如 2026秋。
2. 手动运行一次 watch。
3. 如果需要把当前成绩全部作为测试新增，手动运行 watch-reset。

课程键包含学期，旧学期和新学期不会互相覆盖。

## 本地测试

需要 Node.js 24：

~~~bash
npm ci
npm test
~~~

测试覆盖状态机、Token 到期时间、二维码计划、代理切换、学校退避、成绩差异、平时分熔断、通知补发、状态加密和 Workflow 合同。

## 项目结构

~~~text
.
├── .github/workflows/bbgu.yml
├── bbgu_grade_watch.js
├── bbgu_grade_watch.test.js
├── scripts
│   ├── state-crypto.js
│   ├── state-crypto.test.js
│   └── workflow-contract.test.js
├── package.json
├── package-lock.json
├── .gitignore
└── README.md
~~~

## 安全要求

- 仓库必须保持 Private。
- 不要提交 bbgu-data、Token、Cookie、二维码或机场订阅。
- 不要把运行状态放入 Artifact 或 Actions Cache。
- 不要在日志、Issues、截图或聊天中公开 Secret。
- state 分支应只包含 bbgu-state.enc。
- 机场订阅链接本身属于敏感凭据。
- 只查询本人账号和本人有权访问的数据。

## 限制

- GitHub Actions 定时任务不保证绝对准点。
- 查询成功依赖学校服务、认证服务、机场线路和 PushPlus。
- 学校前端或接口结构变化后，脚本可能需要更新。
- 本项目尽量减少学校请求和重复请求，但不能保证外部服务永远稳定。

## 免责声明

本项目仅用于个人学习和本人信息提醒。使用者应遵守学校系统规则、GitHub 服务条款及当地法律法规，并自行承担账号、网络和通知服务相关风险。
