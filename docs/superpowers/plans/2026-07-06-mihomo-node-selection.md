# Mihomo Node Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除工作流对 HK/TW/JP 节点的硬编码限制，让 Mihomo 从订阅中的正常代理节点里按教务系统可用性自动选择。

**Architecture:** 只修改 GitHub Actions 的 Mihomo 配置和对应契约测试。保留 `url-test`、教务系统健康检查和非代理条目排除规则，不触碰登录及 Token 逻辑。

**Tech Stack:** GitHub Actions YAML、Mihomo、Node.js `node:test`

---

### Task 1: 修正节点筛选

**Files:**
- Modify: `scripts/workflow-contract.test.js`
- Modify: `.github/workflows/bbgu.yml`

- [x] **Step 1: 写入失败契约测试**

在 `Workflow通过Mihomo代理访问教务系统` 中加入：

```js
assert.doesNotMatch(yaml, /filter: .*香港.*HK.*台湾.*TW.*日本.*JP/);
assert.doesNotMatch(yaml, /等待可用的HK\/TW\/JP节点/);
assert.match(yaml, /exclude-filter: .*剩余.*流量.*到期.*官网.*套餐/);
assert.match(yaml, /echo "\[BBGU\] 等待可用代理节点（\$attempt\/12）\.\.\."/);
```

- [x] **Step 2: 验证测试因旧筛选规则而失败**

Run: `node --test scripts/workflow-contract.test.js`

Expected: `Workflow通过Mihomo代理访问教务系统` FAIL，命中旧 `filter` 或旧日志文案。

- [x] **Step 3: 实施最小工作流修改**

从 `.github/workflows/bbgu.yml` 删除：

```yaml
filter: "(?i)(香港|港|HK|Hong Kong|台湾|台|TW|Taiwan|日本|JP|Japan)"
```

并把等待日志改为：

```bash
echo "[BBGU] 等待可用代理节点（$attempt/12）..."
```

- [x] **Step 4: 验证契约和完整测试**

Run: `node --test scripts/workflow-contract.test.js`

Expected: 5 tests PASS。

Run: `npm test`

Expected: 全部测试 PASS。

Run: `python -c "import pathlib,yaml; assert isinstance(yaml.safe_load(pathlib.Path('.github/workflows/bbgu.yml').read_text(encoding='utf-8')), dict); print('YAML parse OK')"`

Expected: 输出 `YAML parse OK`。

- [x] **Step 5: 提交修改**

```bash
git add .github/workflows/bbgu.yml scripts/workflow-contract.test.js
git commit -m "fix: select Mihomo nodes by BBGU availability"
```
