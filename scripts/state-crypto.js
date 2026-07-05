const crypto = require('node:crypto');
const fs = require('node:fs');

const MAGIC = Buffer.from('BBGUST01');
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + SALT_LENGTH + IV_LENGTH + TAG_LENGTH;

function requirePassword(password) {
  if (!password) throw new Error('缺少 BBGU_STATE_PASSWORD。');
}

function encryptBuffer(plain, password) {
  requirePassword(password);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ciphertext]);
}

function decryptBuffer(payload, password) {
  requirePassword(password);
  const input = Buffer.from(payload);
  if (input.length < HEADER_LENGTH || !input.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('无效的 BBGU 状态包。');
  }

  let offset = MAGIC.length;
  const salt = input.subarray(offset, offset += SALT_LENGTH);
  const iv = input.subarray(offset, offset += IV_LENGTH);
  const tag = input.subarray(offset, offset += TAG_LENGTH);
  const key = crypto.scryptSync(password, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(input.subarray(offset)), decipher.final()]);
}

function runCli(argv = process.argv.slice(2), env = process.env) {
  const [mode, inputPath, outputPath] = argv;
  if (!['encrypt', 'decrypt'].includes(mode) || !inputPath || !outputPath) {
    throw new Error('用法：node state-crypto.js <encrypt|decrypt> <输入文件> <输出文件>');
  }

  const input = fs.readFileSync(inputPath);
  const output = mode === 'encrypt'
    ? encryptBuffer(input, env.BBGU_STATE_PASSWORD)
    : decryptBuffer(input, env.BBGU_STATE_PASSWORD);
  fs.writeFileSync(outputPath, output);
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    console.error(`[BBGU] 状态加解密失败：${error.message || error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  encryptBuffer,
  decryptBuffer,
  runCli,
};
