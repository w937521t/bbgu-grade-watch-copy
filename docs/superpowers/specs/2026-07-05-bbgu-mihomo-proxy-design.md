# BBGU GitHub Actions Mihomo 代理设计

## 目标

解决 GitHub 托管 Runner 可以连接教务系统 IPv4 地址、但 TLS 握手持续超时的问题。Workflow 在 Runner 内临时启动 Mihomo，使用用户机场的 Clash/Mihomo 订阅自动选择能够访问教务系统的 HK、TW 或 JP 节点，再让 Playwright 与 Node.js 请求统一通过本地代理。

## 已确认的故障边界

- 教务域名在 GitHub Runner 正确解析到 `116.13.193.218`。
- GitHub Runner 的 IPv4 TCP 连接可以建立，但 TLS 握手超时。
- 教务域名没有 IPv6 记录。
- 同一地址从用户本机访问返回 HTTP 200，TLS 约 0.3 秒完成。
- 将 Playwright 从 `networkidle` 改为 `domcontentloaded` 后仍然超时，因此根因不是页面等待条件。

## 方案

### Mihomo 运行方式

Workflow 使用官方 `docker.io/metacubex/mihomo:Alpha` 镜像，以 host network 启动本地 mixed-port `127.0.0.1:7890`。不使用 TUN，不修改 Runner 的系统路由，也不让 Git、依赖下载或状态分支提交经过机场。

Mihomo 配置在 `$RUNNER_TEMP` 中临时生成：

- 订阅地址来自 GitHub Repository Secret `CLASH_SUBSCRIPTION_URL`。
- 通过 `proxy-providers` 加载订阅节点。
- 自动选择组使用 `url-test`。
- 健康检查目标为 `https://zhjw.bbgu.edu.cn/workspace/home`。
- 只保留 HK、Hong Kong、香港、TW、Taiwan、台湾、JP、Japan、日本名称匹配的节点；如果一个都无法匹配，则明确提示节点命名不兼容并停止。
- Runner 结束后临时配置和订阅缓存自动销毁。

### 程序代理

- Node.js 从 22 升级到 24。
- 执行 BBGU 脚本时设置 `NODE_USE_ENV_PROXY=1`、`HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`，使用 Node.js 24 原生环境代理支持。
- `NO_PROXY` 包含 `127.0.0.1`、`localhost`、`github.com`、`api.github.com` 与 `www.pushplus.plus`，PushPlus 和 GitHub 操作保持直连。
- 新增 `BBGU_PROXY_SERVER=http://127.0.0.1:7890`。
- `getConfig` 读取 `BBGU_PROXY_SERVER`，`launchChromium` 将其传给 Playwright `proxy.server`。
- 现有成绩查询、Refresh Token、CAS 和扫码逻辑保持不变。

## Workflow 流程

1. 检出代码并安装 Node.js、Playwright、Chromium。
2. 检查 `CLASH_SUBSCRIPTION_URL` 是否存在；缺失时立即失败，不打印 Secret。
3. 生成临时 Mihomo 配置并启动容器。
4. 等待 mixed-port 可用。
5. 使用 `curl --proxy http://127.0.0.1:7890` 请求教务首页：
   - 成功时输出 HTTP 状态和耗时，不输出节点凭据。
   - 所有节点均失败时立即终止，明确显示代理不可用。
6. 恢复加密登录状态。
7. 使用代理执行 `watch`、`renew` 或 `login`。
8. 按现有机制加密并保存状态。
9. 无论成功失败都停止并删除 Mihomo 容器。

## Secrets 与安全

新增 Repository Secret：

```text
CLASH_SUBSCRIPTION_URL
```

安全规则：

- 订阅链接不写入仓库、状态分支、Artifact、Cache 或日志。
- 不打印临时 Mihomo 配置。
- 不使用免费代理。
- HTTPS 证书验证保持开启，不安装机场提供的 CA，不设置 `skip-cert-verify`。
- 代理服务商可以看到目标域名和流量元数据，但在正常 TLS 下不能读取 Token 或 Cookie 内容。
- `state` 分支仍然只保存 AES-256-GCM 加密的 `bbgu-state.enc`。

## 失败处理

- 订阅下载失败：停止任务，提示检查 Secret 或机场可用性。
- Mihomo 配置无节点：停止任务，提示订阅不兼容。
- 所有节点访问教务系统失败：停止任务，不进入 Playwright 的60秒等待。
- Mihomo 容器异常退出：停止任务并输出容器最后的非敏感日志。
- 代理运行后 BBGU 主任务失败：仍按现有流程保存已经更新的加密状态，再恢复失败结论。

## 测试

- `getConfig` 正确读取 `BBGU_PROXY_SERVER`。
- `launchChromium` 在配置代理时向 Playwright 传递 `proxy.server`，未配置时保持现状。
- Workflow 契约测试覆盖 `CLASH_SUBSCRIPTION_URL` Secret、Mihomo 容器、本地代理连通性、Node.js 24代理环境变量、`NO_PROXY` 和清理步骤。
- 完整测试必须覆盖现有成绩查询、续期、扫码、加密状态与 Workflow 契约。
