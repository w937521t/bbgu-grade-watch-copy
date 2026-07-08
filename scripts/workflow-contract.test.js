const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'bbgu.yml');

test('Workflow保持青龙定时并使用加密状态分支', () => {
  const yaml = fs.readFileSync(workflowPath, 'utf8');

  assert.match(yaml, /cron: ['"]0 10-22 \* \* \*['"]/);
  assert.match(yaml, /cron: ['"]30 1-23\/2 \* \* \*['"]/);
  assert.equal((yaml.match(/timezone: Asia\/Shanghai/g) || []).length, 2);
  assert.match(yaml, /options: \[watch, renew, login, watch-reset\]/);
  assert.match(yaml, /cancel-in-progress: false/);
  assert.match(yaml, /PUSHPLUS_TOKEN: \$\{\{ secrets\.PUSHPLUS_TOKEN \}\}/);
  assert.match(yaml, /BBGU_STATE_PASSWORD: \$\{\{ secrets\.BBGU_STATE_PASSWORD \}\}/);
  assert.match(yaml, /bbgu-state\.enc/);
  assert.match(yaml, /node bbgu_grade_watch\.js renew/);
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
  assert.match(yaml, /docker\.io\/metacubex\/mihomo:Alpha/);
  assert.match(yaml, /proxy-providers:/);
  assert.match(yaml, /type: url-test/);
  assert.match(yaml, /proxy_filter="\$\{BBGU_PROXY_FILTER:-\(\?i\)\(\^CN-\|中国\|国内\|上海\|深圳\|浙江\|内蒙古\|云南\|山东\|河南\|成都\|广东\)\}"/);
  assert.match(yaml, /proxy_user_exclude="\$\{BBGU_PROXY_EXCLUDE:-\(\?i\)\(HK\|香港\|TW\|台湾\|JP\|日本\|US\|美国\|Netflix\)\}"/);
  assert.match(yaml, /proxy_exclude="\$proxy_noise_exclude\|\$proxy_user_exclude"/);
  assert.match(yaml, /filter: "\$proxy_filter"/);
  assert.match(yaml, /exclude-filter: "\$proxy_exclude"/);
  assert.doesNotMatch(yaml, /filter: .*香港.*HK.*台湾.*TW.*日本.*JP/);
  assert.doesNotMatch(yaml, /等待可用的HK\/TW\/JP节点/);
  assert.match(yaml, /proxy_noise_exclude="\(\?i\)\(剩余\|流量\|到期\|官网\|套餐\)"/);
  assert.match(yaml, /echo "\[BBGU\] 等待可用代理节点（\$attempt\/12）\.\.\."/);
  assert.match(yaml, /--proxy http:\/\/127\.0\.0\.1:7890/);
  assert.match(yaml, /NODE_USE_ENV_PROXY: ['"]1['"]/);
  assert.match(yaml, /BBGU_PROXY_SERVER: http:\/\/127\.0\.0\.1:7890/);
  assert.match(yaml, /NO_PROXY: .*pushplus/);
  assert.match(yaml, /docker rm -f bbgu-mihomo/);
});

test('Workflow用浏览器式GET验证代理并在主任务失败时输出Mihomo日志', () => {
  const yaml = fs.readFileSync(workflowPath, 'utf8');

  assert.doesNotMatch(yaml, /curl -f -I -L --proxy/);
  assert.match(yaml, /curl -f -L --proxy[\s\S]*?-A ['"]Mozilla\/5\.0/);
  assert.match(yaml, /name: Mihomo诊断日志/);
  assert.match(yaml, /if: steps\.run_bbgu\.outcome == 'failure'/);
  assert.match(yaml, /docker logs --tail 100 bbgu-mihomo/);
});
