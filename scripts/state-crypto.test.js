const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { encryptBuffer, decryptBuffer, runCli } = require('./state-crypto');

test('AES-256-GCM状态包可以往返加解密', () => {
  const plain = Buffer.from('secret-state');
  const password = '0123456789abcdef0123456789abcdef';
  const encrypted = encryptBuffer(plain, password);

  assert.notDeepEqual(encrypted, plain);
  assert.deepEqual(decryptBuffer(encrypted, password), plain);
});

test('错误密码不能解密状态包', () => {
  const encrypted = encryptBuffer(Buffer.from('secret-state'), 'correct-password-0123456789');

  assert.throws(() => decryptBuffer(encrypted, 'wrong-password-01234567890'));
});

test('损坏的状态包不能被接受', () => {
  const encrypted = encryptBuffer(Buffer.from('secret-state'), 'correct-password-0123456789');
  encrypted[encrypted.length - 1] ^= 1;

  assert.throws(() => decryptBuffer(encrypted, 'correct-password-0123456789'));
});

test('密码缺失时立即失败', () => {
  assert.throws(() => encryptBuffer(Buffer.from('state'), ''), /BBGU_STATE_PASSWORD/);
});

test('CLI只从环境变量读取密码并完成文件往返', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbgu-state-crypto-'));
  const plainPath = path.join(tempDir, 'plain.tar.gz');
  const encryptedPath = path.join(tempDir, 'state.enc');
  const restoredPath = path.join(tempDir, 'restored.tar.gz');
  try {
    fs.writeFileSync(plainPath, 'state-file');
    const env = { BBGU_STATE_PASSWORD: '0123456789abcdef0123456789abcdef' };

    runCli(['encrypt', plainPath, encryptedPath], env);
    runCli(['decrypt', encryptedPath, restoredPath], env);

    assert.equal(fs.readFileSync(restoredPath, 'utf8'), 'state-file');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
