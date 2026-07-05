# BBGU Mihomo Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 GitHub 托管 Runner 通过机场的 Mihomo 节点访问 BBGU 教务系统，同时保持订阅、Token 与 Cookie 不进入仓库或日志。

**Architecture:** Workflow 在 Runner 内使用官方 Mihomo 容器建立 `127.0.0.1:7890` mixed-port，代理提供者从 GitHub Secret 加载 Clash 订阅并用教务首页做健康检查。Node.js 24 通过环境代理访问接口，Playwright 通过 `proxy.server` 访问登录页；GitHub、localhost 与 PushPlus 保持直连。

**Tech Stack:** Node.js 24、Playwright 1.61.1、Node `node:test`、GitHub Actions、Mihomo Docker、YAML、Bash

---

### Task 1: 脚本读取并传递浏览器代理

**Files:**
- Modify: `bbgu_grade_watch.test.js`
- Modify: `bbgu_grade_watch.js`

- [ ] **Step 1: 写失败测试**

在测试文件中增加：

```js
test('getConfig读取BBGU_PROXY_SERVER', () => {
  const config = getConfig({ BBGU_PROXY_SERVER: 'http://127.0.0.1:7890' });
  assert.equal(config.proxyServer, 'http://127.0.0.1:7890');
});

test('launchChromium将代理传给Playwright', async () => {
  const calls = [];
  await launchChromium({ launch: async (options) => { calls.push(options); return { ok: true }; } }, {
    headless: true,
    proxyServer: 'http://127.0.0.1:7890',
  });
  assert.deepEqual(calls[0].proxy, { server: 'http://127.0.0.1:7890' });
});
```

- [ ] **Step 2: 验证 RED**

Run: `node --test --test-name-pattern="BBGU_PROXY_SERVER|代理传给Playwright" bbgu_grade_watch.test.js`

Expected: 两个测试因配置字段和 launch proxy 尚不存在而失败。

- [ ] **Step 3: 最小实现**

`getConfig` 增加：

```js
proxyServer: clean(env.BBGU_PROXY_SERVER),
```

`launchChromium` 的选项增加：

```js
...(config.proxyServer ? { proxy: { server: config.proxyServer } } : {}),
```

重试系统 Chromium 时复用同一 `launchOptions`，保证代理不会丢失。

- [ ] **Step 4: 验证 GREEN**

Run: `node --test --test-name-pattern="BBGU_PROXY_SERVER|代理传给Playwright" bbgu_grade_watch.test.js`

Expected: 2 tests PASS。

### Task 2: Workflow 启动 Mihomo 并验证代理

**Files:**
- Modify: `scripts/workflow-contract.test.js`
- Modify: `.github/workflows/bbgu.yml`

- [ ] **Step 1: 写失败契约测试**

删除已完成使命的“直连 DNS/IPv4/IPv6”契约测试，增加：

```js
test('Workflow通过Mihomo代理访问教务系统', () => {
  const yaml = fs.readFileSync(workflowPath, 'utf8');
  assert.match(yaml, /node-version: ['"]24['"]/);
  assert.match(yaml, /CLASH_SUBSCRIPTION_URL: \$\{\{ secrets\.CLASH_SUBSCRIPTION_URL \}\}/);
  assert.match(yaml, /docker\.io\/metacubex\/mihomo:Alpha/);
  assert.match(yaml, /proxy-providers:/);
  assert.match(yaml, /type: url-test/);
  assert.match(yaml, /--proxy http:\/\/127\.0\.0\.1:7890/);
  assert.match(yaml, /NODE_USE_ENV_PROXY: ['"]1['"]/);
  assert.match(yaml, /BBGU_PROXY_SERVER: http:\/\/127\.0\.0\.1:7890/);
  assert.match(yaml, /NO_PROXY: .*pushplus/);
  assert.match(yaml, /docker rm -f bbgu-mihomo/);
});
```

- [ ] **Step 2: 验证 RED**

Run: `node --test --test-name-pattern="Mihomo代理" scripts/workflow-contract.test.js`

Expected: FAIL，因为 Workflow 尚未引用 Secret 或启动 Mihomo。

- [ ] **Step 3: 修改 Workflow**

将 Node 版本改为 24，删除旧直连诊断步骤。Chromium 安装完成后增加 Mihomo 启动步骤，其环境只包含：

```yaml
env:
  CLASH_SUBSCRIPTION_URL: ${{ secrets.CLASH_SUBSCRIPTION_URL }}
```

步骤必须：

1. 检查 Secret 非空。
2. 使用 Node `JSON.stringify` 将订阅 URL 安全写入临时 YAML。
3. 配置 `mixed-port: 7890`、`allow-lan: false`、`ipv6: false`。
4. 创建 `airport` HTTP provider，过滤 HK/TW/JP 节点，使用教务首页健康检查。
5. 创建 `BBGU-AUTO` url-test 组和 `MATCH,BBGU-AUTO` 规则。
6. 以 host network 启动 `docker.io/metacubex/mihomo:Alpha`。
7. 最多测试代理约两分钟；成功输出 HTTP 和耗时，失败立即退出。

`执行BBGU任务` 增加：

```yaml
NODE_USE_ENV_PROXY: '1'
HTTP_PROXY: http://127.0.0.1:7890
HTTPS_PROXY: http://127.0.0.1:7890
BBGU_PROXY_SERVER: http://127.0.0.1:7890
NO_PROXY: 127.0.0.1,localhost,github.com,api.github.com,www.pushplus.plus
```

结尾增加 `if: always()` 的容器清理步骤：

```yaml
- name: 停止Mihomo
  if: always()
  run: docker rm -f bbgu-mihomo >/dev/null 2>&1 || true
```

- [ ] **Step 4: 验证 GREEN**

Run: `node --test --test-name-pattern="Mihomo代理" scripts/workflow-contract.test.js`

Expected: PASS。

### Task 3: 更新部署说明

**Files:**
- Modify: `GITHUB_ACTIONS_README.md`

- [ ] **Step 1: 增加第三个 Secret**

文档增加 `CLASH_SUBSCRIPTION_URL`，说明只粘贴 Clash/Mihomo 订阅链接，不要截图、提交或发给他人。

- [ ] **Step 2: 增加代理运行说明**

说明 Workflow 会自动从 HK/TW/JP 节点中测试教务首页，机场只能看到连接元数据；不关闭证书校验；节点全部失败时任务会在进入扫码前停止。

### Task 4: 完整验证与本地提交

**Files:**
- Verify: `bbgu_grade_watch.js`
- Verify: `bbgu_grade_watch.test.js`
- Verify: `.github/workflows/bbgu.yml`
- Verify: `scripts/workflow-contract.test.js`
- Verify: `GITHUB_ACTIONS_README.md`

- [ ] **Step 1: 语法与 YAML 检查**

Run: `node --check bbgu_grade_watch.js && node --check scripts/workflow-contract.test.js`

再使用 PyYAML 加载 `.github/workflows/bbgu.yml`，确认 `jobs.bbgu` 存在。

- [ ] **Step 2: 完整测试**

Run: `npm test`

Expected: 原有79项加新增2项，共81项测试全部通过。

- [ ] **Step 3: 敏感信息扫描**

确认仓库中不存在订阅 URL、真实 Token、Cookie 或临时 Mihomo 配置；Workflow 只能通过 `${{ secrets.CLASH_SUBSCRIPTION_URL }}` 引用订阅。

- [ ] **Step 4: 本地提交**

只提交计划、脚本、测试、Workflow 与部署说明，不提交现有未跟踪预览文件：

```bash
git add docs/superpowers/plans/2026-07-05-bbgu-mihomo-proxy.md bbgu_grade_watch.js bbgu_grade_watch.test.js scripts/workflow-contract.test.js .github/workflows/bbgu.yml GITHUB_ACTIONS_README.md
git commit -m "feat: route BBGU workflow through Mihomo"
```

不自动推送，由用户确认后执行 `git push`。
