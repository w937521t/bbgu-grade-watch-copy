# 北部湾大学成绩监控：GitHub Actions 部署

本方案用于 GitHub 私有仓库。成绩查询保持北京时间每天 10:07—22:07 执行，登录态续期保持全天奇数点 37 分执行。

## 一、创建私有仓库

1. 在 GitHub 创建一个 Private repository。
2. 将本目录作为仓库根目录上传，至少包含：
   - `.github/workflows/bbgu.yml`
   - `bbgu_grade_watch.js`
   - `bbgu_grade_watch.test.js`
   - `scripts/state-crypto.js`
   - `scripts/state-crypto.test.js`
   - `scripts/workflow-contract.test.js`
   - `package.json`
   - `package-lock.json`
   - `.gitignore`
3. 不要上传 Token、Cookie、`bbgu-data`、二维码图片或 Actions 运行状态文件。

## 二、配置 Secrets

进入仓库：

`Settings → Secrets and variables → Actions → Secrets → New repository secret`

添加三个 Repository Secret：

### `PUSHPLUS_TOKEN`

填写你的 PushPlus Token，用于成绩通知和扫码提醒。

### `BBGU_STATE_PASSWORD`

填写你自己生成的状态加密密码。它不是学校密码，也不是 GitHub 密码。建议使用至少 32 位随机字符。

PowerShell 生成示例：

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | ForEach-Object {[char]$_})
```

请自行保存该密码，不要提交到仓库、日志或截图中。

### `CLASH_SUBSCRIPTION_URL`

填写机场后台提供的 Clash 或 Mihomo 订阅链接。该链接本身相当于账号凭据：

- 不要发送给他人。
- 不要提交到仓库。
- 不要放入普通 Variable。
- 不要在截图中显示。

Workflow 只会在临时 Runner 内使用此链接启动 Mihomo，任务结束后临时配置自动销毁。

### 可选：`BBGU_PROXY_FILTER`

默认只选择国内节点，匹配规则为：

```text
(?i)(^CN-|中国|国内|上海|深圳|浙江|内蒙古|云南|山东|河南|成都|广东)
```

如果你的订阅节点命名不同，可以添加这个 Secret 覆盖默认规则。例如：

```text
CN-|国内|中国|电信|移动|联通
```

### 可选：`BBGU_PROXY_EXCLUDE`

默认排除境外和流媒体节点：

```text
(?i)(HK|香港|TW|台湾|JP|日本|US|美国|Netflix)
```

Workflow 还会始终排除“剩余、流量、到期、官网、套餐”等订阅说明类节点。

## 三、配置学期变量

进入：

`Settings → Secrets and variables → Actions → Variables → New repository variable`

必须添加：

```text
名称：BBGU_TERM
值：2026春
```

新学期开始后只需修改这个变量。`watch` 缺少该变量时会在请求成绩前直接失败，避免把多个学期混在同一份快照中。脚本升级后会自动迁移旧快照的课程键，不会因此把已有成绩重新通知一遍。

## 四、允许 Workflow 更新状态分支

进入：

`Settings → Actions → General → Workflow permissions`

选择：

```text
Read and write permissions
```

保存设置。Workflow 需要该权限创建和更新 `state` 分支。

## 五、首次扫码登录

1. 打开仓库的 `Actions` 页面。
2. 选择“北部湾大学成绩监控”。
3. 点击 `Run workflow`。
4. 模式选择 `login`。
5. 点击运行。
6. 收到 PushPlus 二维码后，在约 5 分钟内扫码。
7. 等待 Workflow 完成。

首次成功后，仓库会自动出现 `state` 分支，其中只有：

```text
bbgu-state.enc
```

这是 AES-256-GCM 加密后的登录状态，不是 Token 明文。`state` 分支每次更新都会替换为一个新的根提交，只保留最新状态；更新使用 `force-with-lease` 防止覆盖并发变化。远程状态读取失败时任务会停止，不会按“首次运行”继续并覆盖原状态。

## 六、手动验证

首次登录成功后，依次手动运行：

1. `renew`：确认日志显示 CAS、Refresh Token、Access Token 状态。
2. `watch`：确认能够查询成绩，并生成或更新成绩快照。

两次运行结束后都应看到加密状态成功推送到 `state` 分支。

如需临时验证已出成绩是否能触发新增通知和平时分明细查询，可手动运行 `watch-reset`。该模式只删除本次 Runner 恢复出的 `bbgu_grade_snapshot.json`，不会删除 Token、Cookie 或浏览器登录态；随后按 `watch` 执行一次，并把现有成绩视为新增。

如日志出现 `Subscore fetch failed`，可手动运行 `subscore-test`。该模式会从成绩快照中自动选择最近一次平时分读取失败且带有 `scoreId` 的课程：先使用 Node.js `fetch`，仅在连接或解析阶段失败时，再通过同一个 Mihomo 节点使用原生 HTTPS 重试一次。它不会切换节点、发送 PushPlus、修改成绩快照或更新 `state` 分支；运行日志会显示两种传输结果和本次 Mihomo 日志，但不会输出 Access Token。

普通 `watch` 在配置 `BBGU_PROXY_SERVER` 时，成绩和平时分接口会直接通过当前 Mihomo 粘性节点使用原生 HTTPS，请求不会先经过必然失败的严格 HTTP 解析路径。正常情况下每个接口只请求一次；整次任务共用一次节点切换额度，不会让成绩、平时分和认证请求各自切换一次。

请求前会先读取 Access Token 的 JWT `exp`。本地已经确定过期时，脚本直接进入 Refresh Token 或二维码恢复，不会先向成绩接口发送一次必然失败的旧 Token 请求。学校返回明确指向统一认证、CAS 或登录页的 HTTP 重定向时，也会进入同一恢复逻辑；其他重定向不会被误判为认证失效。

发现新增或变更成绩后，脚本会先查询本次涉及课程的平时分并把通知写入待推送队列，再保存成绩快照，最后发送 PushPlus。PushPlus 失败时，下次任务只重试已经保存的通知，不会再次查询平时分；快照首次写入失败时也会复用同一条待推送内容，避免重复查询和重复生成通知。

## 七、定时规则

成绩查询：

```cron
7 10-22 * * *
```

北京时间每天 `10:07、11:07……22:07` 执行。

登录态续期：

```cron
37 1-23/2 * * *
```

北京时间每天 `01:37、03:37……23:37` 执行。

GitHub Actions 的定时任务可能发生延迟；上述分钟数用于避开整点和半点的调度高峰，但仍不保证准点执行。

## 八、什么时候需要重新扫码

不会每次扫码。每次运行都会从 `state` 分支恢复 CAS、Refresh Token 和 Access Token：

- CAS 有效：静默续期，同时取得新的 Refresh Token（有效期 14 小时）和 Access Token（有效期 12 小时）。
- CAS 失效后不会立刻或每次 `renew` 都使用 Refresh。只有当前 `watch` 已不能被 Access 覆盖，或已经到 Refresh 到期前最后一次安全机会且本次刷新确实能多覆盖至少一场 `watch` 时，才发送一次 Refresh 请求。未来任务距离 Refresh `exp` 不足 30 分钟时不再视为可靠机会，改由当前任务提前刷新，以容忍 GitHub Actions 排队延迟。
- Refresh Token 的 JWT `exp` 始终先在本地解析；已经到达 `exp` 时直接标记失效，绝不再向学校发送必然失败的 Refresh POST。
- CAS 和 Refresh Token 都失效：根据 Access Token 能否覆盖下一次成绩查询决定扫码时间。
- 只有页面明确返回统一认证或扫码登录状态时才永久记录 CAS 失效；浏览器、本地文件、代理控制和状态保存错误只终止本次任务。
- CAS 或扫码登录取得新 Access 但暂时没有新 Refresh 时，只会沿用尚未被接口明确判死的旧 Refresh；已记录失效的旧 Refresh 不会复活。
- Refresh Token 一旦被接口明确判定失效，会写入加密状态；后续任务直接跳过无意义的重复刷新，直到 CAS 续期或扫码登录取得新状态。
- Refresh Token 请求属于非幂等操作，只发送一次；网络错误或服务端错误都不会自动重发。
- 只有现有登录状态无法继续覆盖成绩查询时，才通过 PushPlus 推送二维码。
- 二维码只有在 PushPlus 确认发送成功后才进入两小时冷却；发送前失败不会阻止下一次任务重试。
- 扫码页只被动监听浏览器已经收到的微信响应，并尝试从页面二维码元素或截图解码；不会为补取二维码而主动请求 `combinedLogin.do` 或微信 `qrconnect` 页面。
- 自动登录导航和扫码后都会先检查 localStorage；只要新 Access Token 已出现就不依赖首页文字及时刷新。Access 出现后最多额外等待 10 秒获取稍晚写入的新 Refresh Token；仍未出现时仅沿用未被判死的旧 Refresh，避免登录页面继续运行 30 秒。
- 登录页打开后会立即检查已经被动捕获的微信响应和二维码元素；二维码已经存在时不会固定再等待 5 秒。只有两种来源都没有时才被动等待，期间不主动补请求二维码接口。

## 九、Mihomo代理规则

GitHub 托管 Runner 与教务系统之间的 TLS 链路不可用，因此 Workflow 会：

1. 从 `CLASH_SUBSCRIPTION_URL` 临时加载机场节点。
2. 默认只选择名称匹配 `CN-`、中国、国内或常见国内省市关键词的节点。
3. 默认排除 HK、TW、JP、US、Netflix 等境外或流媒体节点。
4. 启动时直接沿用上次粘性节点，不向学校主页、认证页、成绩接口或微信发送预检请求。
5. 成绩和平时分 GET 只有在代理 TCP、CONNECT 或目标 TLS 阶段失败时，才允许整次任务最多切换一个国内候选节点。请求已经发出、响应已经开始或响应体中断后都不会跨 IP 重发，但当前节点仍会记入失败冷却。
6. 发生网络失败的节点会进入 6 小时冷却。A、B 都失败时立即结束，不在同一任务遍历 C；下一次 `watch` 跳过一次，后续任务跳过仍在冷却的 A、B 并从 C 开始。Refresh POST 和二维码登录导航发生网络失败时也只记录当前节点，绝不在本次重发；成功节点继续作为粘性节点使用。
7. 让 Playwright、成绩接口和 Token 刷新请求通过本地 Mihomo 代理。

GitHub状态提交和PushPlus保持直连。Workflow不会关闭HTTPS证书验证，也不会安装机场提供的CA。机场可以看到访问目标和流量元数据，但在正常TLS连接下不能读取Token或Cookie内容。

成绩接口和 PushPlus 请求最长等待 30 秒。扫码流程等待浏览器被动捕获微信二维码信息，不再发起二维码辅助请求。Mihomo 使用固定镜像摘要，避免上游 `Alpha` 标签变化导致脚本在没有代码更新时突然改变行为。

如果粘性节点和本次唯一候选节点都发生网络错误，任务会失败并保存一次 Watch 冷却状态。HTTP 业务响应不会触发节点切换：普通 `400/403` 直接报错；`429` 按 `Retry-After` 建立全局退避（缺失或无效时默认两小时）；`500/503` 建立一小时全局退避。退避期间自动 `watch`、`renew` 和二维码登录都不会访问学校。`502/504` 只终止当前任务，不切换节点、不重试，也不写跨任务退避状态。

CAS 静默续期只打开一次 CAS 续期地址；字体、图片、媒体和样式表资源不会加载，检测到新 Token 后立即保存。浏览器 storage state 仅用于保留 CAS Cookie，所有 BBGU Access、Refresh 和 Token 过期字段都会在落盘前删除。

`bbgu_token.env` 是 Access Token 和 Refresh Token 的唯一可信来源。脚本不会从浏览器 storage state 迁移或复活旧 Refresh Token。

学校请求预算固定如下：

- 正常 `watch`：总成绩接口一次；没有新增或变更时平时分接口零次。
- 有新增或变更：每门相关课程的平时分接口最多一次。
- 第一门平时分出现 `401`、`429`、任意 `5xx`、网络中断或响应半包时，立即停止后续课程；不会因此重查总成绩。
- CAS 静默续期：一次导航；Refresh：单次任务最多一次 POST；服务端提前返回认证 `401` 时，最多一次 Refresh 和一次总成绩重试。
- 已到达学校的失败不会跨 IP 重发；只有可证明请求尚未到达学校的连接阶段错误，整次任务才允许切换一个国内节点。

Token、成绩快照、待推送通知、二维码状态、节点状态和浏览器 storage state 都先写入同目录临时文件，再原子替换正式文件。Runner 中断时旧状态仍保持完整，避免损坏快照导致后续任务反复查询学校接口。

## 十、密码或状态损坏后的恢复

如果 `BBGU_STATE_PASSWORD` 丢失或被更换，旧状态无法解密。处理方法：

1. 删除远端 `state` 分支。
2. 在 Secrets 中设置新的 `BBGU_STATE_PASSWORD`。
3. 手动运行 `login` 并重新扫码。

如果状态包损坏或密码错误，Workflow 会在恢复阶段直接失败，不会带着空状态覆盖原来的 `state` 分支。

## 安全规则

- 仓库必须保持 Private。
- 不要把 `bbgu_token.env`、`bbgu_storage_state.json`、Access Token、Refresh Token 或 CAS Cookie 提交到 Git。
- 不要把运行状态上传为 Artifact 或放入 Actions Cache。
- 不要在日志中打印 Secrets。
- `state` 分支只允许存在 `bbgu-state.enc`。
