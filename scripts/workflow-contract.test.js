const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'bbgu.yml');

test('Workflow保持GitHub定时并使用加密状态分支', () => {
  const yaml = fs.readFileSync(workflowPath, 'utf8');

  assert.match(yaml, /cron: ['"]7 10-22 \* \* \*['"]/);
  assert.match(yaml, /cron: ['"]37 1-23\/2 \* \* \*['"]/);
  assert.equal((yaml.match(/timezone: Asia\/Shanghai/g) || []).length, 2);
  assert.match(yaml, /options: \[watch, renew, login, watch-reset\]/);
  assert.doesNotMatch(yaml, /subscore-test/);
  assert.match(yaml, /cancel-in-progress: false/);
  assert.match(yaml, /PUSHPLUS_TOKEN: \$\{\{ secrets\.PUSHPLUS_TOKEN \}\}/);
  assert.match(yaml, /BBGU_STATE_PASSWORD: \$\{\{ secrets\.BBGU_STATE_PASSWORD \}\}/);
  assert.match(yaml, /bbgu-state\.enc/);
  assert.match(yaml, /bbgu_proxy_state\.json/);
  assert.match(yaml, /bbgu_pending_notification\.json/);
  assert.match(yaml, /git ls-remote --heads origin refs\/heads\/state/);
  assert.doesNotMatch(yaml, /git fetch origin ['"]\+refs\/heads\/state:refs\/remotes\/origin\/state['"] \|\| true/);
  assert.match(yaml, /node bbgu_grade_watch\.js renew/);
  assert.match(yaml, /github\.event\.schedule \}\}" == '37 1-23\/2 \* \* \*'/);
  assert.match(yaml, /node bbgu_grade_watch\.js login/);
  assert.match(yaml, /watch-reset\)\s+rm -f "\$BBGU_DATA_DIR\/bbgu_grade_snapshot\.json"/);
  assert.match(yaml, /echo '\[BBGU\] 已清空成绩快照，本次watch会把现有成绩视为新增。'/);
  assert.match(yaml, /node bbgu_grade_watch\.js\s+;;/);
  assert.doesNotMatch(yaml, /watch-reset[\s\S]*rm -f "\$BBGU_DATA_DIR\/bbgu_token\.env"/);
  assert.doesNotMatch(yaml, /watch-reset[\s\S]*rm -f "\$BBGU_DATA_DIR\/bbgu_storage_state\.json"/);
});

test('Workflow不持久化登录态明文', () => {
  const yaml = fs.readFileSync(workflowPath, 'utf8');

  assert.doesNotMatch(yaml, /actions\/cache/);
  assert.doesNotMatch(yaml, /git add .*bbgu_token\.env/);
  assert.match(yaml, /node scripts\/state-crypto\.js encrypt/);
  assert.match(yaml, /git -C "\$state_worktree" add bbgu-state\.enc/);
});

test('Workflow将state分支压缩为单个受保护根提交', () => {
  const yaml = fs.readFileSync(workflowPath, 'utf8');

  assert.match(yaml, /git -C "\$state_worktree" switch --orphan state-update/);
  assert.match(yaml, /--force-with-lease="\$state_lease" origin HEAD:state/);
  assert.doesNotMatch(yaml, /git worktree add -b state-update .* origin\/state/);
  assert.doesNotMatch(yaml, /git -C "\$state_worktree" push origin HEAD:state/);
});

test('Workflow使用实际恢复的state版本保护整次任务期间的并发更新', () => {
  const yaml = fs.readFileSync(workflowPath, 'utf8');

  assert.match(yaml, /- name: 恢复加密状态\s+id: restore_state/);
  assert.match(yaml, /echo "state_remote_sha=\$state_remote_sha" >> "\$GITHUB_OUTPUT"/);
  assert.match(yaml, /BBGU_STATE_BASE_SHA: \$\{\{ steps\.restore_state\.outputs\.state_remote_sha \}\}/);
  assert.match(yaml, /state_lease="refs\/heads\/state:\$\{BBGU_STATE_BASE_SHA:-\}"/);
  assert.equal((yaml.match(/git ls-remote --heads origin refs\/heads\/state/g) || []).length, 1);
});

test('Workflow失败时只上传短期登录诊断', () => {
  const yaml = fs.readFileSync(workflowPath, 'utf8');

  assert.match(yaml, /name: 上传登录诊断/);
  assert.match(yaml, /if: steps\.run_bbgu\.outcome == 'failure'/);
  assert.match(yaml, /uses: actions\/upload-artifact@v4/);
  assert.match(yaml, /name: bbgu-login-diagnostics-\$\{\{ github\.run_id \}\}/);
  assert.match(yaml, /path: \$\{\{ env\.BBGU_DATA_DIR \}\}\/bbgu_diagnostics\//);
  assert.match(yaml, /if-no-files-found: ignore/);
  assert.match(yaml, /retention-days: 1/);

  const uploadStep = yaml.match(/- name: 上传登录诊断[\s\S]*?(?=\n      - name:|$)/)?.[0] || '';
  assert.doesNotMatch(uploadStep, /bbgu_token|storage_state|bbgu-state|\.env|\.enc/);
});

test('Workflow通过Mihomo代理访问教务系统', () => {
  const yaml = fs.readFileSync(workflowPath, 'utf8');

  assert.match(yaml, /node-version: ['"]24['"]/);
  assert.match(yaml, /CLASH_SUBSCRIPTION_URL: \$\{\{ secrets\.CLASH_SUBSCRIPTION_URL \}\}/);
  assert.match(yaml, /BBGU_PROXY_FILTER: \$\{\{ secrets\.BBGU_PROXY_FILTER \}\}/);
  assert.match(yaml, /BBGU_PROXY_EXCLUDE: \$\{\{ secrets\.BBGU_PROXY_EXCLUDE \}\}/);
  assert.match(yaml, /mihomo_image="docker\.io\/metacubex\/mihomo@sha256:28ce3e89d0c9068cbd99a61d2c596db2d239b01f07135ac8b6ad81bcba307984"/);
  assert.match(yaml, /docker pull "\$mihomo_image"/);
  assert.doesNotMatch(yaml, /metacubex\/mihomo:Alpha/);
  assert.match(yaml, /proxy-providers:/);
  const providerBlock = yaml.match(/proxy-providers:[\s\S]*?(?=\n          proxy-groups:)/)?.[0] || '';
  assert.doesNotMatch(providerBlock, /health-check:/);
  assert.doesNotMatch(providerBlock, /zhjw\.bbgu\.edu\.cn/);
  assert.match(yaml, /external-controller: 127\.0\.0\.1:9090/);
  assert.match(yaml, /name: BBGU-STICKY/);
  assert.match(yaml, /type: select/);
  assert.doesNotMatch(yaml, /type: url-test/);
  assert.match(yaml, /selectedProxy/);
  assert.match(yaml, /PUT "\$mihomo_controller\/proxies\/\$proxy_group"/);
  assert.match(yaml, /沿用上次可用节点/);
  assert.match(yaml, /保存粘性节点/);
  assert.match(yaml, /proxy_filter="\$\{BBGU_PROXY_FILTER:-\(\?i\)\(\^CN-\|中国\|国内\|上海\|深圳\|浙江\|内蒙古\|云南\|山东\|河南\|成都\|广东\)\}"/);
  assert.match(yaml, /proxy_user_exclude="\$\{BBGU_PROXY_EXCLUDE:-\(\?i\)\(HK\|香港\|TW\|台湾\|JP\|日本\|US\|美国\|Netflix\)\}"/);
  assert.match(yaml, /proxy_exclude="\$proxy_noise_exclude\|\$proxy_user_exclude"/);
  assert.match(yaml, /filter: "\$proxy_filter"/);
  assert.match(yaml, /exclude-filter: "\$proxy_exclude"/);
  assert.doesNotMatch(yaml, /filter: .*香港.*HK.*台湾.*TW.*日本.*JP/);
  assert.doesNotMatch(yaml, /等待可用的HK\/TW\/JP节点/);
  assert.match(yaml, /proxy_noise_exclude="\(\?i\)\(剩余\|流量\|到期\|官网\|套餐\)"/);
  assert.match(yaml, /echo "\[BBGU\] 等待Mihomo控制接口（\$attempt\/12）\.\.\."/);
  assert.match(yaml, /mihomo_provider="\$mihomo_controller\/providers\/proxies\/airport"/);
  assert.match(yaml, /for attempt in \{1\.\.6\}/);
  assert.match(yaml, /等待机场订阅节点加载（\$attempt\/6）/);
  assert.match(yaml, /Array\.isArray\(data\.proxies\)/);
  assert.match(yaml, /data\.proxies\.map\(\(proxy\) => proxy\.name\)/);
  assert.match(yaml, /specialNames = new Set\(\["COMPATIBLE", "DIRECT", "REJECT", "PASS", "GLOBAL", "BBGU-STICKY"\]\)/);
  assert.doesNotMatch(yaml, /data\.all \|\| \[\]/);
  assert.match(yaml, /上次粘性节点已不在当前国内节点列表/);
  assert.match(yaml, /机场订阅没有返回符合过滤条件的真实节点/);
  assert.match(yaml, /bbgu_proxy_candidates\.json/);
  assert.match(yaml, /selectStartupProxy/);
  assert.match(yaml, /saveSelectedProxy/);
  assert.match(yaml, /writeFileAtomic/);
  assert.match(yaml, /不向学校发送预检请求/);
  assert.doesNotMatch(yaml, /test_bbgu_proxy\(\)/);
  assert.match(yaml, /NODE_USE_ENV_PROXY: ['"]1['"]/);
  assert.match(yaml, /BBGU_PROXY_SERVER: http:\/\/127\.0\.0\.1:7890/);
  assert.match(yaml, /NO_PROXY: .*pushplus/);
  assert.match(yaml, /docker rm -f bbgu-mihomo/);
});

test('Workflow在启动Mihomo前恢复状态以沿用上次粘性节点', () => {
  const yaml = fs.readFileSync(workflowPath, 'utf8');
  const restoreIndex = yaml.indexOf('- name: 恢复加密状态');
  const mihomoIndex = yaml.indexOf('- name: 启动并验证Mihomo代理');

  assert.notEqual(restoreIndex, -1);
  assert.notEqual(mihomoIndex, -1);
  assert.ok(restoreIndex < mihomoIndex);
});

test('Workflow不预检学校端点并在主任务失败时输出Mihomo日志', () => {
  const yaml = fs.readFileSync(workflowPath, 'utf8');
  const setProxyFunction = yaml.match(/set_group_proxy\(\) \{[\s\S]*?\n          \}/)?.[0] || '';

  assert.match(setProxyFunction, /for attempt in \{1\.\.3\}/);
  assert.match(setProxyFunction, /return 1/);
  assert.doesNotMatch(yaml, /https:\/\/zhjw\.bbgu\.edu\.cn\/workspace\/home/);
  assert.doesNotMatch(yaml, /https:\/\/zhjw\.bbgu\.edu\.cn\/api\/sam\/score\/student\/score/);
  assert.doesNotMatch(yaml, /https:\/\/authserver\.bbgu\.edu\.cn\//);
  assert.doesNotMatch(yaml, /https:\/\/open\.weixin\.qq\.com\//);
  assert.match(yaml, /BBGU_MIHOMO_CONTROLLER: http:\/\/127\.0\.0\.1:9090/);
  assert.match(yaml, /BBGU_MIHOMO_PROXY_GROUP: BBGU-STICKY/);
  assert.match(yaml, /name: Mihomo诊断日志/);
  assert.match(yaml, /if: steps\.run_bbgu\.outcome == 'failure'/);
  assert.match(yaml, /docker logs --tail 100 bbgu-mihomo/);
});

test('Workflow只在任务失败后做一次TLS诊断，不预检学校', () => {
  const yaml = fs.readFileSync(workflowPath, 'utf8');
  const diagnosticStep = yaml.match(/- name: 一次性TLS诊断[\s\S]*?(?=\n      - name:|$)/)?.[0] || '';
  assert.match(diagnosticStep, /if: steps\.run_bbgu\.outcome == 'failure'/);
  assert.match(diagnosticStep, /--proxy http:\/\/127\.0\.0\.1:7890/);
  assert.match(diagnosticStep, /--max-time 30/);
  assert.match(diagnosticStep, /--verbose/);
  assert.doesNotMatch(diagnosticStep, /--retry|retry\s*=/i);
  assert.doesNotMatch(diagnosticStep, /Authorization|PUSHPLUS_TOKEN|BBGU_ACCESS_TOKEN|BBGU_REFRESH_TOKEN/i);
  const beforeTask = yaml.slice(0, yaml.indexOf('      - name: 执行BBGU任务'));
  assert.doesNotMatch(beforeTask, /curl[^\n]*(?:zhjw|authserver)\.bbgu\.edu\.cn/i);
  assert.doesNotMatch(yaml, /health-check:[\s\S]*?bbgu\.edu\.cn/i);
  assert.doesNotMatch(yaml, /必要端点|测试候选节点/);
});
