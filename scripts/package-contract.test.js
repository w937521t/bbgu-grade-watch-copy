const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packageJson = require('../package.json');

test('GitHub运行环境安装二维码截图解码和文本渲染依赖', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'bbgu_grade_watch.js'), 'utf8');
  const required = new Set([
    ...Array.from(source.matchAll(/require\('([^']+)'\)/g), (match) => match[1]),
    ...Array.from(source.matchAll(/loadOptionalModule\('([^']+)'\)/g), (match) => match[1]),
  ].filter((name) => !name.startsWith('node:')));

  assert.deepEqual([...required].sort(), ['jsqr', 'playwright', 'pngjs', 'qrcode-terminal']);
  for (const name of required) {
    assert.ok(packageJson.dependencies[name], `package.json缺少依赖：${name}`);
  }
});
