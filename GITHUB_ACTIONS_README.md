# 北部湾大学成绩监控：GitHub Actions 部署

本方案用于 GitHub 私有仓库。成绩查询保持北京时间每天 10:00—22:00 整点执行，登录态续期保持全天奇数点 30 分执行。

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
3. 不要上传 Token、Cookie、`bbgu-data`、二维码图片或青龙运行状态文件。

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

## 三、配置学期变量

进入：

`Settings → Secrets and variables → Actions → Variables → New repository variable`

建议添加：

```text
名称：BBGU_TERM
值：2026春
```

新学期开始后只需修改这个变量。

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

这是 AES-256-GCM 加密后的登录状态，不是 Token 明文。

## 六、手动验证

首次登录成功后，依次手动运行：

1. `renew`：确认日志显示 CAS、Refresh Token、Access Token 状态。
2. `watch`：确认能够查询成绩，并生成或更新成绩快照。

两次运行结束后都应看到加密状态成功推送到 `state` 分支。

## 七、定时规则

成绩查询：

```cron
0 10-22 * * *
```

北京时间每天 `10:00、11:00……22:00` 执行。

登录态续期：

```cron
30 1-23/2 * * *
```

北京时间每天 `01:30、03:30……23:30` 执行。

GitHub Actions 的定时任务可能发生延迟；Workflow 保持上述整点配置，不改为其他分钟。

## 八、什么时候需要重新扫码

不会每次扫码。每次运行都会从 `state` 分支恢复 CAS、Refresh Token 和 Access Token：

- CAS 有效：静默续期。
- CAS 失效、Refresh Token 有效：自动刷新 Access Token。
- CAS 和 Refresh Token 都失效：根据 Access Token 能否覆盖下一次成绩查询决定扫码时间。
- 只有现有登录状态无法继续覆盖成绩查询时，才通过 PushPlus 推送二维码。

## 九、Mihomo代理规则

GitHub 托管 Runner 与教务系统之间的 TLS 链路不可用，因此 Workflow 会：

1. 从 `CLASH_SUBSCRIPTION_URL` 临时加载机场节点。
2. 只选择名称匹配香港、台湾或日本的节点。
3. 自动测试节点能否访问教务系统。
4. 选择可用且响应较快的节点。
5. 让 Playwright、成绩接口和 Token 刷新请求通过本地 Mihomo 代理。

GitHub状态提交和PushPlus保持直连。Workflow不会关闭HTTPS证书验证，也不会安装机场提供的CA。机场可以看到访问目标和流量元数据，但在正常TLS连接下不能读取Token或Cookie内容。

如果全部候选节点都不能访问教务系统，任务会显示：

```text
[BBGU] 所有候选代理节点均无法访问教务系统。
```

此时需要更换机场节点或改用国内自托管Runner。

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
