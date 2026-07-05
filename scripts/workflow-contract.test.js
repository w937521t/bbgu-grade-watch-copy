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
  assert.match(yaml, /options: \[watch, renew, login\]/);
  assert.match(yaml, /cancel-in-progress: false/);
  assert.match(yaml, /PUSHPLUS_TOKEN: \$\{\{ secrets\.PUSHPLUS_TOKEN \}\}/);
  assert.match(yaml, /BBGU_STATE_PASSWORD: \$\{\{ secrets\.BBGU_STATE_PASSWORD \}\}/);
  assert.match(yaml, /bbgu-state\.enc/);
  assert.match(yaml, /node bbgu_grade_watch\.js renew/);
  assert.match(yaml, /node bbgu_grade_watch\.js login/);
});

test('Workflow不持久化登录态明文', () => {
  const yaml = fs.readFileSync(workflowPath, 'utf8');

  assert.doesNotMatch(yaml, /upload-artifact|actions\/cache/);
  assert.doesNotMatch(yaml, /git add .*bbgu_token\.env/);
  assert.match(yaml, /node scripts\/state-crypto\.js encrypt/);
  assert.match(yaml, /git -C "\$state_worktree" add bbgu-state\.enc/);
});
