#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const util = require('node:util');

const DEFAULT_HOME_URL = 'https://zhjw.bbgu.edu.cn/workspace/home';
const PUSHPLUS_SEND_URL = 'https://www.pushplus.plus/send';
const BBGU_SCORE_API_URL = 'https://zhjw.bbgu.edu.cn/api/sam/score/student/score';
const BBGU_SUBSCORE_API_PATH = '/api/sam/scoreManage/stu-score-form';
const BBGU_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145 Safari/537.36 Edg/145';
const BBGU_OAUTH_CLIENT_ID = 'sam-prd';
const BBGU_OAUTH_CLIENT_SECRET = 'app-a-1234';
const BBGU_REFRESH_TIMEOUT_MS = 15000;
const BBGU_API_TIMEOUT_MS = 30000;
const PUSHPLUS_TIMEOUT_MS = 30000;
const PUSHPLUS_CONTENT_MAX_CHARS = 19000;
const PROXY_FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const SUBSCORE_LIST_KEYS = ['subScoreList', 'detailScoreList', 'scoreItemList'];
const SUBSCORE_NAME_FIELDS = ['subName', 'scoreName', 'itemName', 'name', 'componentName', 'partName', 'assessmentName', 'subScoreName', '项目', '名称'];
const SUBSCORE_WEIGHT_FIELDS = ['weight', 'ratio', 'percent', 'proportion', 'scorePercent', 'percentage', 'scale', '占比', '权重'];
const SUBSCORE_SCORE_FIELDS = ['score', 'subScore', 'realScore', 'resultScore', 'achievementScore', 'value', '成绩', '分数'];

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return '';
}

function firstField(source, fields) {
  if (!source || typeof source !== 'object') return '';
  return firstNonEmpty(...fields.map((field) => source[field]));
}

function parseBooleanEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parsePositiveIntegerEnv(value, defaultValue) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

function unquoteToken(value) {
  const text = clean(value);
  if (!text) return '';
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return clean(JSON.parse(text));
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}

function buildAuthorizationHeader(accessToken) {
  const token = unquoteToken(accessToken);
  return token ? `Bearer ${token}` : '';
}

function quoteCurlConfigValue(value) {
  const text = String(value ?? '');
  if (/[\r\n]/.test(text)) throw new Error('curl配置值不能包含换行。');
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseCurlResponseHeaders(headerText) {
  const blocks = String(headerText || '').split(/\r?\n\r?\n/)
    .filter((block) => /^HTTP\/\d(?:\.\d)?\s+\d+/i.test(block.trim()));
  const lines = (blocks.at(-1) || '').split(/\r?\n/).slice(1);
  const headers = {};
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return headers;
}

function executeCurl(invocation, deps = {}) {
  const spawnFn = deps.spawnFn || spawn;
  return new Promise((resolve, reject) => {
    const child = spawnFn('curl', invocation.args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({
      exitCode: Number(exitCode),
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    child.stdin.end(invocation.stdinText);
  });
}

async function requestWithCurl(url, options = {}, deps = {}) {
  const randomUUIDFn = deps.randomUUIDFn || randomUUID;
  const executeCurlFn = deps.executeCurlFn || ((invocation) => executeCurl(invocation, deps));
  const readFileFn = deps.readFileFn || fsp.readFile;
  const rmFn = deps.rmFn || fsp.rm;
  const requestId = randomUUIDFn();
  const marker = `__BBGU_CURL_${requestId}__`;
  const headerPath = path.join(os.tmpdir(), `bbgu-curl-${process.pid}-${requestId}.headers`);
  const timeoutMs = Number(options.timeoutMs) || BBGU_API_TIMEOUT_MS;
  const configLines = [
    'silent',
    'show-error',
    'http1.1',
    'retry = "0"',
    `request = ${quoteCurlConfigValue(options.method || 'GET')}`,
    `url = ${quoteCurlConfigValue(url)}`,
    `connect-timeout = ${quoteCurlConfigValue(Math.max(1, Math.ceil(timeoutMs / 2000)))}`,
    `max-time = ${quoteCurlConfigValue(Math.max(1, Math.ceil(timeoutMs / 1000)))}`,
    `dump-header = ${quoteCurlConfigValue(headerPath.replace(/\\/g, '/'))}`,
    'output = "-"',
    `write-out = ${quoteCurlConfigValue(`${marker}%{http_code}`)}`,
  ];
  if (options.proxyServer) {
    configLines.push(`proxy = ${quoteCurlConfigValue(options.proxyServer)}`, 'noproxy = ""');
  }
  for (const [name, value] of Object.entries(options.headers || {})) {
    configLines.push(`header = ${quoteCurlConfigValue(`${name}: ${value}`)}`);
  }
  if (options.body !== undefined && options.body !== null) {
    configLines.push(`data-raw = ${quoteCurlConfigValue(options.body)}`);
  }

  const invocation = {
    args: ['--config', '-'],
    stdinText: `${configLines.join('\n')}\n`,
    headerPath,
  };
  try {
    const result = await executeCurlFn(invocation);
    if (result.exitCode !== 0) {
      const exitCode = Number(result.exitCode);
      const stage = [5, 6, 7].includes(exitCode)
        ? 'proxy-tcp'
        : exitCode === 35 ? 'target-tls' : 'curl';
      const details = clean(result.stderr || `curl exited with code ${exitCode}`)
        .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
        .replace(/\beyJ[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]*){1,2}\b/g, '[JWT REDACTED]');
      const error = createStagedNetworkError(stage, new Error(`curl退出码${exitCode}: ${details}`));
      error.code = `BBGU_CURL_${exitCode}`;
      error.curlExitCode = exitCode;
      throw error;
    }
    const stdout = String(result.stdout || '');
    const markerIndex = stdout.lastIndexOf(marker);
    if (markerIndex < 0) throw new Error('curl响应缺少HTTP状态标记。');
    const status = Number.parseInt(stdout.slice(markerIndex + marker.length).trim(), 10);
    if (!Number.isFinite(status)) throw new Error('curl返回了无效HTTP状态码。');
    const headersText = Object.hasOwn(result, 'headersText')
      ? result.headersText
      : await readFileFn(headerPath, 'utf8');
    return {
      status,
      text: stdout.slice(0, markerIndex),
      headers: parseCurlResponseHeaders(headersText),
    };
  } finally {
    await rmFn(headerPath, { force: true }).catch(() => undefined);
  }
}

function fingerprintToken(token) {
  const normalized = unquoteToken(String(token || '').replace(/^Bearer\s+/i, ''));
  return normalized ? createHash('sha256').update(normalized).digest('hex') : '';
}

async function fetchWithTimeout(fetchFn, url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timeoutError = new Error(`${label}在${timeoutMs}毫秒后超时。`);
  timeoutError.code = 'BBGU_REQUEST_TIMEOUT';
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => fetchFn(url, { ...options, signal: controller.signal })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function emptyAuthState() {
  return { accessToken: '', refreshToken: '' };
}

function parseSavedAuthState(content) {
  const state = emptyAuthState();
  for (const line of String(content || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0) {
      if (!state.accessToken) state.accessToken = unquoteToken(trimmed);
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = unquoteToken(trimmed.slice(separator + 1));
    if (key === 'BBGU_ACCESS_TOKEN') state.accessToken = value;
    if (key === 'BBGU_REFRESH_TOKEN') state.refreshToken = value;
  }
  return state;
}

function decodeJwtPayload(token) {
  const text = unquoteToken(String(token || '').replace(/^Bearer\s+/i, ''));
  const payload = text.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function formatEpochSeconds(epochSeconds) {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return '';
  return new Date(epochSeconds * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function extractJwtExpiry(token) {
  const payload = decodeJwtPayload(token);
  const epochSeconds = Number(payload && payload.exp);
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
  return {
    epochSeconds,
    iso: new Date(epochSeconds * 1000).toISOString(),
    text: formatEpochSeconds(epochSeconds),
  };
}

function formatRemainingDuration(expiryEpochSeconds, nowMs) {
  const deltaMs = expiryEpochSeconds * 1000 - nowMs;
  const totalMinutes = Math.floor(Math.abs(deltaMs) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts = [
    hours ? `${hours}小时` : '',
    minutes ? `${minutes}分钟` : '',
  ].filter(Boolean).join('');
  if (deltaMs > 0 && totalMinutes === 0) return '剩余不足1分钟';
  if (deltaMs <= 0 && totalMinutes === 0) return '刚刚过期';
  return deltaMs > 0 ? `剩余${parts}` : `已过期${parts}`;
}

function formatTokenExpiry(token, nowMs) {
  const expiry = extractJwtExpiry(token);
  if (!expiry) return '到期时间未知';
  return `过期时间 ${expiry.text}，${formatRemainingDuration(expiry.epochSeconds, nowMs)}`;
}

function formatAuthStatusSummary({ casStatus, refreshStatus, authState = {}, nowMs = Date.now() }) {
  const casText = {
    valid: '有效',
    expired: '已失效',
    expired_skipped: '已失效，本次已跳过',
    unchecked: '未检测',
  }[casStatus] || '未检测';
  const refreshText = {
    valid: '有效',
    expired: '已失效',
    expired_skipped: '已失效，本次已跳过',
    unchecked: '未检测',
  }[refreshStatus] || '未检测';

  const accessExpiry = extractJwtExpiry(authState.accessToken);
  const accessText = !authState.accessToken
    ? '不存在'
    : !accessExpiry
      ? '状态未知'
      : accessExpiry.epochSeconds * 1000 > nowMs ? '有效' : '已失效';

  return [
    '[BBGU] 登录态汇总',
    `[BBGU] CAS：${casText}`,
    `[BBGU] Refresh Token：${refreshText}，${formatTokenExpiry(authState.refreshToken, nowMs)}`,
    `[BBGU] Access Token：${accessText}，${formatTokenExpiry(authState.accessToken, nowMs)}`,
  ].join('\n');
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const QR_REMINDER_COOLDOWN_MS = 2 * HOUR_MS;
const REFRESH_EXPIRY_SAFETY_MS = 60 * 60 * 1000;
const GRADE_QUERY_MINUTE = 7;
const ACCESS_LIFETIME_SECONDS = 12 * 60 * 60;

function beijingTimeParts(epochMs) {
  const shifted = new Date(epochMs + BEIJING_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function beijingEpochMs(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0);
}

function beijingDayKey(epochMs) {
  const parts = beijingTimeParts(epochMs);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function scheduledGradeQueriesFrom(nowMs, dayCount = 3) {
  const start = beijingTimeParts(nowMs);
  const localDay = Date.UTC(start.year, start.month - 1, start.day);
  const result = [];
  for (let offset = 0; offset < dayCount; offset += 1) {
    const date = new Date(localDay + offset * DAY_MS);
    for (let hour = 10; hour <= 22; hour += 1) {
      const epoch = beijingEpochMs(
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        hour,
        GRADE_QUERY_MINUTE
      );
      if (epoch >= nowMs) result.push(epoch);
    }
  }
  return result;
}

function scheduledAutomaticRunsFrom(nowMs, dayCount = 3) {
  const start = beijingTimeParts(nowMs);
  const localDay = Date.UTC(start.year, start.month - 1, start.day);
  const runs = [];
  for (let offset = 0; offset < dayCount; offset += 1) {
    const date = new Date(localDay + offset * DAY_MS);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    for (let hour = 1; hour <= 23; hour += 2) {
      runs.push({ mode: 'renew', at: beijingEpochMs(year, month, day, hour, 37) });
    }
    for (let hour = 10; hour <= 22; hour += 1) {
      runs.push({ mode: 'watch', at: beijingEpochMs(year, month, day, hour, GRADE_QUERY_MINUTE) });
    }
  }
  return runs
    .filter((item) => item.at >= nowMs)
    .sort((left, right) => left.at - right.at);
}

function firstUncoveredGradeQuery(accessExpiryEpochSeconds, nowMs) {
  const expiryMs = accessExpiryEpochSeconds * 1000;
  return scheduledGradeQueriesFrom(nowMs).find((queryAt) => queryAt >= expiryMs) || null;
}

function planRefreshAction({
  mode,
  nowMs,
  accessExpiryEpochSeconds,
  refreshExpiryEpochSeconds,
}) {
  const refreshExpiryMs = refreshExpiryEpochSeconds * 1000;
  if (nowMs >= refreshExpiryMs) return { action: 'REFRESH_EXPIRED', reason: 'jwt-exp' };
  if (mode === 'watch' && nowMs >= accessExpiryEpochSeconds * 1000) {
    return { action: 'REFRESH_ACCESS', reason: 'current-watch-uncovered' };
  }

  const accessExpiryMs = accessExpiryEpochSeconds * 1000;
  const laterOpportunity = scheduledAutomaticRunsFrom(nowMs + 1)
    .find((item) => (
      item.at <= refreshExpiryMs - REFRESH_EXPIRY_SAFETY_MS
      && (item.mode === 'renew' || (item.mode === 'watch' && item.at >= accessExpiryMs))
    ));
  if (laterOpportunity) return { action: 'WAIT', reason: 'later-opportunity' };

  const currentUncovered = firstUncoveredGradeQuery(accessExpiryEpochSeconds, nowMs);
  const predictedUncovered = firstUncoveredGradeQuery(
    nowMs / 1000 + ACCESS_LIFETIME_SECONDS,
    nowMs
  );
  if (currentUncovered && predictedUncovered && predictedUncovered > currentUncovered) {
    return { action: 'REFRESH_ACCESS', reason: 'last-beneficial-opportunity' };
  }
  return { action: 'WAIT', reason: 'no-additional-watch' };
}

function planAutomaticAction(state) {
  const {
    mode,
    nowMs,
    schoolBackoffUntil = 0,
    casExpired = false,
    refreshExpired = false,
    accessExpiryEpochSeconds = 0,
    refreshExpiryEpochSeconds = 0,
    qrDueAt = 0,
    qrLastPushedAt = 0,
    hasAccessToken = accessExpiryEpochSeconds > 0,
    hasRefreshToken = refreshExpiryEpochSeconds > 0,
  } = state;

  if (nowMs < schoolBackoffUntil) return { action: 'SKIP_BACKOFF' };
  if (!hasAccessToken && !hasRefreshToken) {
    return shouldPushQrNow({ nowMs, dueAtMs: 0, lastPushedAtMs: qrLastPushedAt })
      ? { action: 'QR_LOGIN', reason: 'initial-login' }
      : { action: 'WAIT_QR_DUE', reason: 'qr-cooldown' };
  }
  if (mode === 'renew' && !casExpired) return { action: 'CAS_RENEW' };
  if (mode === 'watch' && nowMs < accessExpiryEpochSeconds * 1000) {
    return { action: 'QUERY_SCORE' };
  }
  if (!accessExpiryEpochSeconds) {
    return { action: 'FAIL_LOCAL_STATE', reason: 'missing-access-exp' };
  }
  if (!refreshExpired && !refreshExpiryEpochSeconds) {
    return { action: 'FAIL_LOCAL_STATE', reason: 'missing-refresh-exp' };
  }
  if (!refreshExpired) {
    const refreshPlan = planRefreshAction({
      mode,
      nowMs,
      accessExpiryEpochSeconds,
      refreshExpiryEpochSeconds,
    });
    if (refreshPlan.action === 'REFRESH_ACCESS') return refreshPlan;
    if (refreshPlan.action === 'REFRESH_EXPIRED') {
      return { action: 'MARK_REFRESH_EXPIRED', reason: refreshPlan.reason };
    }
    return { action: 'WAIT_REFRESH_WINDOW', reason: refreshPlan.reason };
  }
  if (!qrDueAt) return { action: 'SCHEDULE_QR' };
  if (shouldPushQrNow({ nowMs, dueAtMs: qrDueAt, lastPushedAtMs: qrLastPushedAt })) {
    return { action: 'QR_LOGIN' };
  }
  return { action: 'WAIT_QR_DUE' };
}

function computeQrSchedule(accessExpiryEpochSeconds, nowMs = Date.now()) {
  const expiryMs = Number(accessExpiryEpochSeconds) * 1000;
  const firstUncoveredQueryAt = scheduledGradeQueriesFrom(nowMs)
    .find((queryAt) => queryAt >= expiryMs);
  if (!firstUncoveredQueryAt) {
    throw new Error('无法计算第一次不能覆盖的成绩查询时间。');
  }
  const firstUncovered = beijingTimeParts(firstUncoveredQueryAt);
  const dueAt = firstUncovered.hour === 10
    ? firstUncoveredQueryAt - 30 * 60 * 1000
    : firstUncoveredQueryAt - HOUR_MS;
  return { accessExpiryEpochSeconds, dueAt, firstUncoveredQueryAt };
}

function computeImmediateQrSchedule(accessExpiryEpochSeconds, nowMs = Date.now()) {
  return {
    ...computeQrSchedule(accessExpiryEpochSeconds, nowMs),
    firstUncoveredQueryAt: nowMs,
    dueAt: nowMs,
  };
}

function shouldPushQrNow({ nowMs, dueAtMs, lastPushedAtMs = 0 }) {
  if (nowMs < dueAtMs) return false;
  if (!lastPushedAtMs) return true;
  const now = beijingTimeParts(nowMs);
  const last = beijingTimeParts(lastPushedAtMs);
  const isTenOClockRetry = beijingDayKey(nowMs) === beijingDayKey(lastPushedAtMs)
    && now.hour === 10
    && last.hour === 9
    && last.minute >= 30;
  if (isTenOClockRetry) return true;
  return nowMs - lastPushedAtMs >= QR_REMINDER_COOLDOWN_MS;
}

function normalizeGradeRows(rows) {
  const normalized = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const courseCode = firstNonEmpty(row.courseCode, row.code, row.kch, row.KCH, row.courseNo, row.kcdm);
    const courseName = firstNonEmpty(row.courseName, row.name, row.kcmc, row.KCMC, row.course, row['课程名称'], row['课程']);
    const scoreId = firstNonEmpty(row.scoreId, row.score_id, row.id);
    const score = firstNonEmpty(row.scoreShow, row.effectiveScoreShow, row.score, row.effectiveScore, row.grade, row.cj, row.CJ, row.zcj, row.finalScore, row['成绩'], row['总成绩']);
    const credit = firstNonEmpty(row.credit, row.credits, row.courseCredit, row.xf, row.XF, row['学分']);
    const term = firstNonEmpty(row.term, row.sessionName, row.semester, row.xq, row.xnxq, row.academicTerm, row['学期'], row['学年学期']);

    if (!courseName && !courseCode) continue;
    if (!score && !credit && !term) continue;

    const baseKey = courseCode ? `${courseCode}::${courseName || courseCode}` : courseName;
    normalized.push({
      key: term ? `${term}::${baseKey}` : baseKey,
      courseName: courseName || courseCode,
      ...(scoreId ? { scoreId } : {}),
      ...(!scoreId && Array.isArray(row.__bbguSourceKeys) ? { sourceKeys: row.__bbguSourceKeys.map(clean).filter(Boolean).sort() } : {}),
      score,
      credit,
      term,
    });
  }

  const seen = new Set();
  return normalized.filter((row) => {
    const signature = JSON.stringify(row);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function normalizeBbguScoreApiData(data, preferredTerm = '') {
  const rows = [];
  if (!data || typeof data !== 'object') return rows;

  const entries = Object.entries(data);
  for (const [termName, termData] of entries) {
    if (preferredTerm && termName !== preferredTerm) continue;
    const list = termData && Array.isArray(termData.stuScoreHomePgVoS) ? termData.stuScoreHomePgVoS : [];
    for (const item of list) {
      rows.push({
        courseCode: item.courseCode,
        courseName: item.courseName,
        scoreId: firstNonEmpty(item.scoreId, item.score_id, item.id),
        score: firstNonEmpty(item.effectiveScoreShow, item.scoreShow, item.effectiveScore, item.score),
        credit: item.courseCredit,
        term: firstNonEmpty(item.sessionName, termName),
        __bbguSourceKeys: Object.keys(item || {}),
      });
    }
  }

  return normalizeGradeRows(rows);
}

function gradeSignature(row) {
  return JSON.stringify({
    courseName: row.courseName || '',
    score: row.score || '',
    credit: row.credit || '',
    term: row.term || '',
  });
}

function migrateSnapshotGradeKeys(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const key = clean(row && row.key);
    const term = clean(row && row.term);
    if (!key || !term || key.startsWith(`${term}::`)) return row;
    return { ...row, key: `${term}::${key}` };
  });
}

function diffGrades(previousRows, currentRows) {
  const previousByKey = new Map((previousRows || []).map((row) => [row.key, row]));
  const added = [];
  const changed = [];

  for (const row of currentRows || []) {
    const previous = previousByKey.get(row.key);
    if (!previous) {
      added.push(row);
      continue;
    }
    if (gradeSignature(previous) !== gradeSignature(row)) {
      changed.push({ before: previous, after: row });
    }
  }

  return { added, changed };
}

function parseNumericScore(value) {
  const text = clean(value);
  if (!text) return null;
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const score = Number.parseFloat(text);
  if (!Number.isFinite(score)) return null;
  return score;
}

function inferCurrentTerm(rows, preferredTerm = '') {
  const explicit = clean(preferredTerm);
  if (explicit) return explicit;
  const counts = new Map();
  for (const row of rows || []) {
    const term = clean(row.term);
    if (!term) continue;
    counts.set(term, (counts.get(term) || 0) + 1);
  }
  let selected = '';
  let selectedCount = 0;
  for (const [term, count] of counts) {
    if (count > selectedCount) {
      selected = term;
      selectedCount = count;
    }
  }
  return selected;
}

function calculateTermArithmeticAverage(rows, preferredTerm = '') {
  const targetTerm = inferCurrentTerm(rows, preferredTerm);
  const scores = [];
  for (const row of rows || []) {
    if (targetTerm && clean(row.term) !== targetTerm) continue;
    const score = parseNumericScore(row.score);
    if (score === null) continue;
    scores.push(score);
  }
  if (!scores.length) return null;
  const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  return {
    term: targetTerm,
    count: scores.length,
    average: Number(average.toFixed(2)),
  };
}

function rowsForTerm(rows, preferredTerm = '') {
  const targetTerm = inferCurrentTerm(rows, preferredTerm);
  if (!targetTerm) return Array.isArray(rows) ? rows : [];
  return (rows || []).filter((row) => clean(row.term) === targetTerm);
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function findArrayByKey(value, keyName, depth = 0) {
  if (!value || depth > 10) return null;
  if (Array.isArray(value)) return null;
  if (!isPlainObject(value)) return null;
  if (Array.isArray(value[keyName])) return value[keyName];
  for (const child of Object.values(value)) {
    const found = findArrayByKey(child, keyName, depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizeSubScoreList(payload) {
  const list = Array.isArray(payload)
    ? payload
    : SUBSCORE_LIST_KEYS.map((key) => findArrayByKey(payload, key)).find(Boolean) || [];

  return list
    .map((item) => ({
      name: firstField(item, SUBSCORE_NAME_FIELDS),
      weight: firstField(item, SUBSCORE_WEIGHT_FIELDS),
      score: firstField(item, SUBSCORE_SCORE_FIELDS),
    }))
    .filter((item) => item.name || item.weight || item.score);
}

function hasSubScoreFetchRecord(row) {
  if (row && row.subScoreFetchError === '本次因全局异常跳过'
    && !row.subScoreFetchedAt
    && !Array.isArray(row.subScores)) {
    return false;
  }
  return Array.isArray(row && row.subScores) || !!(row && (row.subScoreFetchedAt || row.subScoreFetchError));
}

function mergePersistedSubScores(previousRows, currentRows) {
  const previousByKey = new Map((previousRows || []).map((row) => [row.key, row]));
  return (currentRows || []).map((row) => {
    const previous = previousByKey.get(row.key);
    if (!previous || !hasSubScoreFetchRecord(previous) || hasSubScoreFetchRecord(row)) return row;
    return {
      ...row,
      ...(Array.isArray(previous.subScores) ? { subScores: previous.subScores } : {}),
      ...(previous.subScoreFetchedAt ? { subScoreFetchedAt: previous.subScoreFetchedAt } : {}),
      ...(previous.subScoreFetchError ? { subScoreFetchError: previous.subScoreFetchError } : {}),
    };
  });
}

function selectRowsForSubScoreFetch(diff) {
  const selected = [];
  const seen = new Set();
  const candidates = [
    ...((diff && diff.added) || []),
    ...(((diff && diff.changed) || []).map((item) => item.after)),
  ];

  for (const row of candidates) {
    if (!row || !row.scoreId || hasSubScoreFetchRecord(row) || seen.has(row.key)) continue;
    seen.add(row.key);
    selected.push(row);
  }

  return selected;
}

function selectRowsMissingSubScoreIdForSubScoreFetch(diff) {
  const selected = [];
  const seen = new Set();
  const candidates = [
    ...((diff && diff.added) || []),
    ...(((diff && diff.changed) || []).map((item) => item.after)),
  ];

  for (const row of candidates) {
    if (!row || row.scoreId || hasSubScoreFetchRecord(row) || seen.has(row.key)) continue;
    seen.add(row.key);
    selected.push(row);
  }

  return selected;
}

function formatSubScoreSourceKeys(row) {
  const keys = Array.isArray(row && row.sourceKeys) && row.sourceKeys.length
    ? row.sourceKeys
    : Object.keys(row || {}).filter((key) => !['subScores', 'subScoreFetchedAt', 'subScoreFetchError'].includes(key));
  return keys.map(clean).filter(Boolean).sort().join(',');
}

function formatSubScoreText(row) {
  const items = formatSubScoreItems(row);
  return items.length
    ? items.join('；')
    : row && row.subScoreFetchError ? '读取失败' : '暂无保存记录';
}

function formatSubScoreItems(row) {
  const subScores = Array.isArray(row && row.subScores) ? row.subScores : [];
  return subScores.map((item) => {
    const name = clean(item.name) || '未命名项目';
    const score = clean(item.score) || '-';
    const weight = clean(item.weight);
    return `${name}${weight ? `(${weight}%)` : ''} ${score}`;
  });
}

function textDisplayWidth(value) {
  let width = 0;
  for (const char of String(value ?? '')) {
    width += /[^\x00-\xff]/.test(char) ? 2 : 1;
  }
  return width;
}

function clipTextForWidth(value, width) {
  const text = String(value ?? '');
  if (textDisplayWidth(text) <= width) return text;
  let result = '';
  let used = 0;
  for (const char of text) {
    const charWidth = /[^\x00-\xff]/.test(char) ? 2 : 1;
    if (used + charWidth > width - 1) break;
    result += char;
    used += charWidth;
  }
  return `${result}…`;
}

function padTextRight(value, width) {
  const text = clipTextForWidth(value, width);
  return text + ' '.repeat(Math.max(0, width - textDisplayWidth(text)));
}

function formatPlainGradeTable(rows) {
  const widths = { course: 18, score: 4, credit: 4 };
  const borderTop = `┌${'─'.repeat(widths.course)}┬${'─'.repeat(widths.score)}┬${'─'.repeat(widths.credit)}┐`;
  const borderMid = `├${'─'.repeat(widths.course)}┼${'─'.repeat(widths.score)}┼${'─'.repeat(widths.credit)}┤`;
  const borderBottom = `└${'─'.repeat(widths.course)}┴${'─'.repeat(widths.score)}┴${'─'.repeat(widths.credit)}┘`;
  const rowLine = (course, score, credit) => `│${padTextRight(course, widths.course)}│${padTextRight(score, widths.score)}│${padTextRight(credit, widths.credit)}│`;
  return [
    borderTop,
    rowLine('课程', '成绩', '学分'),
    borderMid,
    ...rows.map((row) => rowLine(row.courseName || row.key || '未知课程', row.score || '-', row.credit || '-')),
    borderBottom,
  ].join('\n');
}

function formatGradeNotification({ term, added, changed, currentRows, checkedAt }) {
  const rows = rowsForTerm(currentRows || [], term);
  const selectedTerm = inferCurrentTerm(currentRows || [], term);
  const average = calculateTermArithmeticAverage(currentRows || [], selectedTerm);
  const checkedText = checkedAt || new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const lines = [
    `BBGU 成绩更新${selectedTerm ? `｜${selectedTerm}` : ''}`,
    `检查时间：${checkedText}`,
    '',
    '━━━━━━━━━━━━━━━━',
    `新增 ${(added || []).length} 门｜变更 ${(changed || []).length} 门｜已出 ${rows.length} 门`,
  ];

  if (average) {
    lines.push(`算术平均分：${average.average.toFixed(2)}（${average.count} 门）`);
  }
  lines.push('━━━━━━━━━━━━━━━━');

  if (added?.length) {
    lines.push('', '新增成绩');
    added.forEach((row, index) => {
      if (index > 0) lines.push('');
      lines.push(`${index + 1}. ${row.courseName || row.key || '未知课程'}`);
      lines.push(`   成绩：${row.score || '-'}｜学分：${row.credit || '-'}`);
      const subScoreItems = formatSubScoreItems(row);
      if (subScoreItems.length) {
        lines.push('   平时分：');
        lines.push(...subScoreItems.map((item) => `   - ${item}`));
      } else {
        lines.push(`   平时分：${formatSubScoreText(row)}`);
      }
    });
  }

  if (changed?.length) {
    lines.push('', '变更成绩');
    changed.forEach((item, index) => {
      const before = item.before || {};
      const after = item.after || {};
      if (index > 0) lines.push('');
      lines.push(`${index + 1}. ${after.courseName || after.key || '未知课程'}`);
      lines.push(`   成绩：${before.score || '空'} -> ${after.score || '空'}`);
      const subScoreItems = formatSubScoreItems(after);
      if (subScoreItems.length) {
        lines.push('   平时分：');
        lines.push(...subScoreItems.map((subScore) => `   - ${subScore}`));
      } else {
        lines.push(`   平时分：${formatSubScoreText(after)}`);
      }
    });
  }

  lines.push('', '本学期已出成绩');
  lines.push(rows.length ? formatPlainGradeTable(rows) : '暂无已发布成绩');

  lines.push('', '平时分记录');
  const rowsWithSubScores = rows.filter((row) => Array.isArray(row.subScores) && row.subScores.length);
  const rowsWithSubScoreErrors = rows.filter((row) => row.subScoreFetchError && !(Array.isArray(row.subScores) && row.subScores.length));
  if (rowsWithSubScores.length || rowsWithSubScoreErrors.length) {
    for (const row of rowsWithSubScores) {
      lines.push(`- ${row.courseName || row.key || '未知课程'}`);
      lines.push(...formatSubScoreItems(row).map((item) => `  - ${item}`));
    }
    for (const row of rowsWithSubScoreErrors) {
      lines.push(`- ${row.courseName || row.key || '未知课程'}：读取失败`);
    }
  } else {
    lines.push('- 暂无保存记录');
  }

  return lines.join('\n');
}

function truncateTextForPushPlus(rawText, maxChars) {
  const suffix = '\n\n...内容过长，已截断；完整快照保存在 GitHub Actions state 分支的加密状态包中。';
  if (rawText.length <= maxChars) return rawText;
  const budget = Math.max(0, maxChars - suffix.length);
  return `${Array.from(rawText).slice(0, budget).join('')}${suffix}`;
}

function formatPushPlusGradeTextContent({ maxChars = PUSHPLUS_CONTENT_MAX_CHARS, ...args }) {
  const fenceStart = '```text\n';
  const fenceEnd = '\n```';
  const rawMaxChars = Math.max(0, maxChars - fenceStart.length - fenceEnd.length);
  const rawText = truncateTextForPushPlus(formatGradeNotification(args), rawMaxChars);
  return `${fenceStart}${rawText}${fenceEnd}`;
}

function extractWeixinQrInfoFromHtml(html) {
  const text = String(html || '');
  const uuid = clean(
    (text.match(/\/connect\/qrcode\/([A-Za-z0-9_-]+)/) || [])[1]
    || (text.match(/(?:^|[?&\\s;])uuid\s*=\s*([A-Za-z0-9_-]+)/) || [])[1]
  );
  if (!uuid) return null;
  return {
    uuid,
    qrImageUrl: `https://open.weixin.qq.com/connect/qrcode/${uuid}`,
  };
}

function createWeixinQrCapture(page) {
  let captured = null;
  const waiters = [];

  const finish = (info) => {
    if (!info || captured) return;
    captured = info;
    while (waiters.length) waiters.shift()(captured);
  };

  const onResponse = async (response) => {
    const url = response.url();
    if (!/^https:\/\/open\.weixin\.qq\.com\/connect\/qrconnect/i.test(url)) return;
    try {
      const html = await response.text();
      finish(extractWeixinQrInfoFromHtml(html));
    } catch {
      // The page still stays open for scanning; failure here only disables QR metadata logging.
    }
  };

  page.on('response', onResponse);

  return {
    get: () => captured,
    wait: async (timeoutMs = 5000) => {
      if (captured) return captured;
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(captured), timeoutMs);
        waiters.push((info) => {
          clearTimeout(timer);
          resolve(info);
        });
      });
    },
    stop: () => page.off('response', onResponse),
  };
}

function loadOptionalModule(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}

function renderTerminalQrCode(value, qrcodeTerminal = loadOptionalModule('qrcode-terminal')) {
  const text = clean(value);
  if (!text || !qrcodeTerminal || typeof qrcodeTerminal.generate !== 'function') return '';
  let output = '';
  qrcodeTerminal.generate(text, { small: true }, (qrText) => {
    output = String(qrText || '').trimEnd();
  });
  return output;
}

async function decodeQrPayloadFromPngFile(filePath, deps = {}) {
  const cleanPath = clean(filePath);
  if (!cleanPath) return '';
  const pngReader = deps.pngReader || loadOptionalModule('pngjs')?.PNG;
  const jsQR = deps.jsQR || loadOptionalModule('jsqr');
  if (!pngReader || !pngReader.sync || typeof pngReader.sync.read !== 'function' || typeof jsQR !== 'function') return '';
  const buffer = await fsp.readFile(cleanPath);
  const png = pngReader.sync.read(buffer);
  const data = png.data instanceof Uint8ClampedArray ? png.data : new Uint8ClampedArray(png.data);
  const result = jsQR(data, png.width, png.height);
  return clean(result && result.data);
}

function renderQrCodeHtml(textQr) {
  const lines = String(textQr || '').split(/\r?\n/);
  const htmlLines = lines.map((line) => (
    line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/ /g, '&nbsp;')
  ));
  return `<div style="font-family:Consolas,'Courier New',monospace;font-size:8px;line-height:8px;letter-spacing:0;background:#fff;color:#000;padding:8px;display:inline-block;white-space:nowrap;">${htmlLines.join('<br>')}</div>`;
}

function formatQrLoginMessage({
  homeUrl,
  screenshotPath,
  qrImageUrl,
  textQr,
  waitSeconds,
  showScreenshotPath = true,
}) {
  return [
    '# BBGU 教务系统扫码登录',
    '',
    `登录地址：${homeUrl}`,
    textQr ? '微信扫码识别下方文本二维码：' : '',
    textQr ? renderQrCodeHtml(textQr) : '',
    showScreenshotPath && screenshotPath ? `二维码截图路径：\`${screenshotPath}\`` : '',
    qrImageUrl ? `微信二维码图片源：\`${qrImageUrl}\`（不直接展示，避免 PushPlus 缓存旧二维码）` : '',
    '',
    textQr
      ? showScreenshotPath
        ? `脚本会等待 ${waitSeconds} 秒。请优先用微信扫描文本二维码；如果不能识别，请打开上面的截图路径并扫码。`
        : `脚本会等待 ${waitSeconds} 秒。请用微信扫描上方文本二维码。`
      : showScreenshotPath
        ? `脚本会等待 ${waitSeconds} 秒。请立刻打开上面的截图路径并扫码。`
        : qrImageUrl
          ? `脚本会等待 ${waitSeconds} 秒。请打开上面的微信二维码图片源并扫码。`
          : '文本二维码生成失败，本次无法从GitHub完成扫码，请查看Actions日志。',
    '',
    '扫码成功后脚本会自动保存 access/refresh token，后续定时任务会自动读取保存的认证状态。',
  ].filter(Boolean).join('\n');
}

function shouldAbortGithubQrLogin({ githubActions, textQr, qrImageUrl }) {
  return Boolean(githubActions && !clean(textQr) && !clean(qrImageUrl));
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeFileAtomic(filePath, content, deps = {}) {
  const mkdirFn = deps.mkdirFn || fsp.mkdir;
  const writeFileFn = deps.writeFileFn || fsp.writeFile;
  const renameFn = deps.renameFn || fsp.rename;
  const rmFn = deps.rmFn || fsp.rm;
  await mkdirFn(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFileFn(tempPath, content, 'utf8');
    await renameFn(tempPath, filePath);
  } catch (error) {
    await rmFn(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeJson(filePath, value) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readQrReminderState(config) {
  if (!config || !config.qrReminderStatePath) return null;
  const state = await readJson(config.qrReminderStatePath, null);
  if (state && !state.casExpired && Number.isFinite(state.dueAt)) {
    const migrated = { ...state, casExpired: true };
    await writeJson(config.qrReminderStatePath, migrated);
    return migrated;
  }
  return state;
}

async function saveQrReminderSchedule(config, schedule) {
  if (!config || !config.qrReminderStatePath) {
    return { ...schedule, lastPushedAt: schedule.lastPushedAt || 0 };
  }
  const previous = await readQrReminderState(config);
  const sameExpiry = previous
    && previous.accessExpiryEpochSeconds === schedule.accessExpiryEpochSeconds;
  const next = {
    casExpired: Boolean(previous && previous.casExpired),
    refreshExpired: Object.hasOwn(schedule, 'refreshExpired')
      ? Boolean(schedule.refreshExpired)
      : Boolean(previous && previous.refreshExpired),
    accessRejectedAfterRefresh: Object.hasOwn(schedule, 'accessRejectedAfterRefresh')
      ? Boolean(schedule.accessRejectedAfterRefresh)
      : Boolean(previous && previous.accessRejectedAfterRefresh),
    rejectedAccessFingerprint: Object.hasOwn(schedule, 'rejectedAccessFingerprint')
      ? schedule.rejectedAccessFingerprint
      : (previous && previous.rejectedAccessFingerprint) || '',
    accessExpiryEpochSeconds: schedule.accessExpiryEpochSeconds,
    dueAt: schedule.dueAt,
    firstUncoveredQueryAt: schedule.firstUncoveredQueryAt,
    lastPushedAt: Object.hasOwn(schedule, 'lastPushedAt')
      ? schedule.lastPushedAt
      : (sameExpiry ? previous.lastPushedAt || 0 : 0),
  };
  await writeJson(config.qrReminderStatePath, next);
  return next;
}

async function markCasExpired(config) {
  if (!config || !config.qrReminderStatePath) return { casExpired: true };
  const previous = await readQrReminderState(config) || {};
  const next = { ...previous, casExpired: true };
  await writeJson(config.qrReminderStatePath, next);
  return next;
}

async function markQrPushed(config, nowMs = Date.now(), deps = {}) {
  if (!config.qrReminderStatePath) return { lastPushedAt: nowMs };
  const readQrReminderStateFn = deps.readQrReminderStateFn || readQrReminderState;
  const writeJsonFn = deps.writeJsonFn || writeJson;
  const previous = await readQrReminderStateFn(config) || {};
  const next = { ...previous, lastPushedAt: nowMs };
  await writeJsonFn(config.qrReminderStatePath, next);
  return next;
}

async function markRefreshExpired(config) {
  if (!config || !config.qrReminderStatePath) {
    return { casExpired: true, refreshExpired: true };
  }
  const previous = await readQrReminderState(config) || {};
  const next = { ...previous, casExpired: true, refreshExpired: true };
  await writeJson(config.qrReminderStatePath, next);
  return next;
}

async function markAccessRejectedAfterRefresh(config, accessToken) {
  const rejectedAccessFingerprint = fingerprintToken(accessToken);
  const marker = { accessRejectedAfterRefresh: true, rejectedAccessFingerprint };
  if (!config || !config.qrReminderStatePath) return marker;
  const previous = await readQrReminderState(config) || {};
  const next = { ...previous, ...marker };
  await writeJson(config.qrReminderStatePath, next);
  return next;
}

async function clearQrReminderSchedule(config) {
  if (!config || !config.qrReminderStatePath) return;
  const previous = await readQrReminderState(config);
  if (!previous) return;
  if (previous.casExpired) {
    await writeJson(config.qrReminderStatePath, { casExpired: true });
    return;
  }
  await fsp.rm(config.qrReminderStatePath, { force: true });
}

async function clearQrReminderState(config) {
  if (!config || !config.qrReminderStatePath) return;
  await fsp.rm(config.qrReminderStatePath, { force: true });
}

async function sendPushPlus({
  token,
  title,
  content,
  fetchFn = fetch,
  timeoutMs = PUSHPLUS_TIMEOUT_MS,
}) {
  const { response, text } = await fetchWithTimeout(
    async (url, options) => {
      const response = await fetchFn(url, options);
      return { response, text: await response.text() };
    },
    PUSHPLUS_SEND_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        title,
        content,
        template: 'markdown',
      }),
    },
    timeoutMs,
    'PushPlus请求'
  );
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`PushPlus send failed: HTTP ${response.status} invalid JSON response`);
  }

  if (!response.ok || !body || typeof body !== 'object' || Number(body.code) !== 200) {
    throw new Error(`PushPlus send failed: HTTP ${response.status} ${text}`);
  }

  return body;
}

function getConfig(env = process.env) {
  const dataDir = path.resolve(env.BBGU_DATA_DIR || __dirname);
  return {
    pushplusToken: clean(env.PUSHPLUS_TOKEN),
    homeUrl: DEFAULT_HOME_URL,
    term: clean(env.BBGU_TERM),
    proxyServer: clean(env.BBGU_PROXY_SERVER),
    githubActions: parseBooleanEnv(env.GITHUB_ACTIONS, false),
    dataDir,
    authorization: '',
    tokenPath: path.resolve(path.join(dataDir, 'bbgu_token.env')),
    storageStatePath: path.join(dataDir, 'bbgu_storage_state.json'),
    snapshotPath: path.join(dataDir, 'bbgu_grade_snapshot.json'),
    pendingNotificationPath: path.join(dataDir, 'bbgu_pending_notification.json'),
    qrReminderStatePath: path.join(dataDir, 'bbgu_qr_reminder_state.json'),
    proxyStatePath: path.join(dataDir, 'bbgu_proxy_state.json'),
    proxyCandidatesPath: path.join(dataDir, 'bbgu_proxy_candidates.json'),
    networkStatePath: path.join(dataDir, 'bbgu_network_state.json'),
    mihomoController: clean(env.BBGU_MIHOMO_CONTROLLER || 'http://127.0.0.1:9090'),
    mihomoProxyGroup: clean(env.BBGU_MIHOMO_PROXY_GROUP || 'BBGU-STICKY'),
    diagnosticDir: path.join(dataDir, 'bbgu_diagnostics'),
    headless: true,
    loginWaitSeconds: parsePositiveIntegerEnv(env.BBGU_LOGIN_WAIT_SECONDS, 600),
  };
}

function buildCasRenewUrl(config) {
  const origin = new URL((config && config.homeUrl) || DEFAULT_HOME_URL).origin;
  return `${origin}/authserver/casLogin?redirect_uri=${encodeURIComponent(`${origin}/sam/cas`)}`;
}

function isRecoverableNavigationAbort(error) {
  const message = error && error.message ? error.message : String(error || '');
  return /net::ERR_ABORTED/i.test(message);
}

async function readSavedAuthState(filePath) {
  try {
    return parseSavedAuthState(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyAuthState();
    throw error;
  }
}

async function saveAuthState(filePath, state) {
  const accessToken = unquoteToken(state && state.accessToken);
  const refreshToken = unquoteToken(state && state.refreshToken);
  if (!accessToken) throw new Error('Cannot save empty BBGU access token.');
  const lines = [
    '# Generated by bbgu_grade_watch.js. Do not share this file.',
    `BBGU_ACCESS_TOKEN=${accessToken}`,
    ...(refreshToken ? [`BBGU_REFRESH_TOKEN=${refreshToken}`] : []),
    '',
  ];
  await writeFileAtomic(filePath, lines.join('\n'));
}

async function readStorageState(filePath) {
  return readJson(filePath, { cookies: [], origins: [] });
}

function isNetworkTransportError(error) {
  if (!error || error.httpStatus) return false;
  const details = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current.name) details.push(String(current.name));
    if (current.code) details.push(String(current.code));
    if (current.message) details.push(String(current.message));
    current = current.cause;
  }
  return /BBGU_CURL_\d+|ECONN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ERR_HTTP_RESPONSE_(?:ABORTED|INCOMPLETE)|AbortError|\btimeout\b|timed out|TLS|socket|network|fetch failed|net::ERR_(?:CONNECTION|TIMED_OUT|TUNNEL|PROXY)/i.test(details.join('\n'));
}

function isSafeCasFailoverError(error) {
  if (!error || error.httpStatus) return false;
  const details = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current.code) details.push(String(current.code));
    if (current.message) details.push(String(current.message));
    current = current.cause;
  }
  return /EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|EPROTO|ERR_(?:PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|CONNECTION_REFUSED|SSL_PROTOCOL_ERROR|CERT_)|TLS handshake/i.test(details.join('\n'));
}

function isSafeApiFailoverError(error) {
  if (!error || error.httpStatus) return false;
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current.stage) {
      return ['proxy-tcp', 'connect', 'target-tls'].includes(clean(current.stage));
    }
    current = current.cause;
  }
  const details = [];
  current = error;
  seen.clear();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current.code) details.push(String(current.code));
    if (current.message) details.push(String(current.message));
    current = current.cause;
  }
  return /EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ERR_(?:PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|CONNECTION_REFUSED)|TLS handshake/i.test(details.join('\n'));
}

function activeFailedNodes(proxyState, nowMs = Date.now()) {
  const failedNodes = isPlainObject(proxyState && proxyState.failedNodes) ? proxyState.failedNodes : {};
  return Object.fromEntries(Object.entries(failedNodes)
    .map(([name, failedUntil]) => [clean(name), Number(failedUntil)])
    .filter(([name, failedUntil]) => name && Number.isFinite(failedUntil) && failedUntil > nowMs));
}

function selectStartupProxy(proxyState, candidates, nowMs = Date.now()) {
  const names = (Array.isArray(candidates) ? candidates : []).map(clean).filter(Boolean);
  const failedNodes = activeFailedNodes(proxyState, nowMs);
  const selected = clean(proxyState && proxyState.selectedProxy);
  if (selected && names.includes(selected) && !failedNodes[selected]) return selected;
  return names.find((name) => !failedNodes[name]) || '';
}

async function readProxyRuntime(config, nowMs = Date.now()) {
  const proxyState = await readJson(config.proxyStatePath, {});
  const candidateState = await readJson(config.proxyCandidatesPath, []);
  const candidates = Array.isArray(candidateState)
    ? candidateState
    : Array.isArray(candidateState.candidates) ? candidateState.candidates : [];
  const failedNodes = activeFailedNodes(proxyState, nowMs);
  return {
    current: clean(proxyState.selectedProxy),
    candidates: candidates.map(clean).filter((name) => name && !failedNodes[name]),
  };
}

async function selectMihomoProxy(config, name, fetchFn = fetch) {
  const controller = clean(config.mihomoController);
  const group = clean(config.mihomoProxyGroup);
  if (!controller || !group) throw new Error('Mihomo controller configuration is incomplete.');
  const response = await fetchFn(`${controller}/proxies/${encodeURIComponent(group)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    const error = new Error(`Mihomo node switch failed: HTTP ${response.status}`);
    error.httpStatus = response.status;
    throw error;
  }
}

async function saveSelectedProxy(config, name) {
  if (!config.proxyStatePath) return;
  const previous = await readJson(config.proxyStatePath, {});
  const failedNodes = activeFailedNodes(previous);
  delete failedNodes[name];
  await writeJson(config.proxyStatePath, {
    selectedProxy: name,
    failedNodes,
    updatedAt: new Date().toISOString(),
  });
}

async function markProxyFailed(config, name, nowMs = Date.now()) {
  if (!config.proxyStatePath || !clean(name)) return;
  const previous = await readJson(config.proxyStatePath, {});
  const failedNodes = activeFailedNodes(previous, nowMs);
  failedNodes[clean(name)] = nowMs + PROXY_FAILURE_COOLDOWN_MS;
  await writeJson(config.proxyStatePath, {
    ...previous,
    failedNodes,
    updatedAt: new Date(nowMs).toISOString(),
  });
}

async function recordCurrentProxyFailure(config, error, deps = {}) {
  if (!isNetworkTransportError(error) || !config || !config.proxyStatePath) return false;
  const nowFn = deps.nowFn || Date.now;
  const readProxyRuntimeFn = deps.readProxyRuntimeFn || readProxyRuntime;
  const markProxyFailedFn = deps.markProxyFailedFn || ((name, nowMs) => markProxyFailed(config, name, nowMs));
  const runtime = await readProxyRuntimeFn(config, nowFn());
  if (!runtime.current) return false;
  await markProxyFailedFn(runtime.current, nowFn());
  return true;
}

const proxyFailoverStateByConfig = new WeakMap();

async function withSingleProxyFailover(config, operation, deps = {}) {
  const readProxyRuntimeFn = deps.readProxyRuntimeFn || readProxyRuntime;
  const selectProxyFn = deps.selectProxyFn || ((name) => selectMihomoProxy(config, name));
  const saveProxyFn = deps.saveProxyFn || ((name) => saveSelectedProxy(config, name));
  const markProxyFailedFn = deps.markProxyFailedFn || ((name, nowMs) => markProxyFailed(config, name, nowMs));
  const shouldFailoverFn = deps.shouldFailoverFn || isSafeApiFailoverError;
  const nowFn = deps.nowFn || Date.now;
  let taskState = proxyFailoverStateByConfig.get(config);
  if (!taskState) {
    taskState = { used: false };
    proxyFailoverStateByConfig.set(config, taskState);
  }
  try {
    return await operation();
  } catch (firstError) {
    if (!isNetworkTransportError(firstError)) throw firstError;
    const runtime = await readProxyRuntimeFn(config, nowFn());
    await markProxyFailedFn(runtime.current, nowFn());
    if (!shouldFailoverFn(firstError)) {
      firstError.code = 'BBGU_PROXY_NETWORK_FAILED';
      throw firstError;
    }
    if (taskState.used) {
      firstError.code = 'BBGU_PROXY_FAILOVER_EXHAUSTED';
      throw firstError;
    }
    const replacement = runtime.candidates.find((name) => name !== runtime.current);
    if (!replacement) {
      firstError.code = 'BBGU_PROXY_FAILOVER_EXHAUSTED';
      throw firstError;
    }

    console.log(`[BBGU] 粘性节点网络失败，本次仅切换一个候选节点重试：${runtime.current || 'unknown'} -> ${replacement}`);
    taskState.used = true;
    await selectProxyFn(replacement);
    try {
      const result = await operation();
      await saveProxyFn(replacement);
      return result;
    } catch (secondError) {
      if (!isNetworkTransportError(secondError)) {
        await saveProxyFn(replacement);
        throw secondError;
      }
      await markProxyFailedFn(replacement, nowFn());
      secondError.code = 'BBGU_PROXY_FAILOVER_EXHAUSTED';
      throw secondError;
    }
  }
}

function retryAfterDeadline(value, nowMs) {
  const text = clean(value);
  if (/^\d+$/.test(text)) return nowMs + Number(text) * 1000;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > nowMs ? parsed : nowMs + 2 * HOUR_MS;
}

async function markSchoolBackoff(config, error, nowMs = Date.now(), deps = {}) {
  if (!config.networkStatePath) return false;
  const httpStatus = Number(error && error.httpStatus);
  if (![429, 500, 503].includes(httpStatus)) return false;
  const readJsonFn = deps.readJsonFn || readJson;
  const writeJsonFn = deps.writeJsonFn || writeJson;
  const previous = await readJsonFn(config.networkStatePath, {});
  await writeJsonFn(config.networkStatePath, {
    ...previous,
    schoolBackoffUntil: httpStatus === 429
      ? retryAfterDeadline(error && error.retryAfter, nowMs)
      : nowMs + HOUR_MS,
    schoolBackoffStatus: httpStatus,
    failedAt: nowMs,
  });
  return true;
}

async function consumeSchoolBackoff(config, nowMs = Date.now(), deps = {}) {
  if (!config.networkStatePath) return false;
  const readJsonFn = deps.readJsonFn || readJson;
  const writeJsonFn = deps.writeJsonFn || writeJson;
  const rmFn = deps.rmFn || fsp.rm;
  const state = await readJsonFn(config.networkStatePath, null);
  if (!state) return false;
  if (!Number.isFinite(state.schoolBackoffUntil)) {
    await rmFn(config.networkStatePath, { force: true });
    return false;
  }
  if (nowMs < state.schoolBackoffUntil) return true;
  delete state.schoolBackoffUntil;
  delete state.schoolBackoffStatus;
  if (Object.keys(state).some((key) => key !== 'failedAt')) {
    await writeJsonFn(config.networkStatePath, state);
  } else {
    await rmFn(config.networkStatePath, { force: true });
  }
  return false;
}

async function requestRefreshedAuthState(config, current, deps = {}) {
  const curlRequestFn = deps.curlRequestFn || requestWithCurl;
  const withProxyFailoverFn = deps.withProxyFailoverFn || withSingleProxyFailover;
  const proxyServer = clean(deps.proxyServer || (config && config.proxyServer) || process.env.BBGU_PROXY_SERVER || '');
  const timeoutMs = deps.timeoutMs || BBGU_REFRESH_TIMEOUT_MS;
  const recordCurrentProxyFailureFn = deps.recordCurrentProxyFailureFn || ((error) => recordCurrentProxyFailure(config, error));
  if (!current || !current.refreshToken) {
    const error = new Error('No saved BBGU refresh token.');
    error.code = 'BBGU_REFRESH_UNAVAILABLE';
    throw error;
  }

  try {
    const origin = new URL((config && config.homeUrl) || DEFAULT_HOME_URL).origin;
    const body = new URLSearchParams({
      client_id: BBGU_OAUTH_CLIENT_ID,
      client_secret: BBGU_OAUTH_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
    }).toString();
    const url = `${origin}/authserver/oauth/token`;
    const request = () => curlRequestFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      timeoutMs,
      ...(proxyServer ? { proxyServer } : {}),
    });
    const response = proxyServer
      ? await withProxyFailoverFn(config, request, { shouldFailoverFn: isSafeApiFailoverError })
      : await request();
    const text = String(response.text || '');
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (response.status < 200 || response.status >= 300 || !payload || !payload.access_token) {
      const oauthError = clean(payload && payload.error).toLowerCase();
      const oauthErrorDescription = firstNonEmpty(
        payload && payload.error_description,
        payload && payload.message,
        payload && payload.msg
      );
      const error = new Error(`BBGU refresh failed: HTTP ${response.status}${oauthError ? ` (${oauthError})` : ''}`);
      error.httpStatus = response.status;
      if (oauthError) error.oauthError = oauthError;
      if (oauthErrorDescription) error.oauthErrorDescription = oauthErrorDescription;
      throw error;
    }
    return {
      accessToken: unquoteToken(payload.access_token),
      refreshToken: unquoteToken(payload.refresh_token) || current.refreshToken,
    };
  } catch (error) {
    if (isNetworkTransportError(error)) await recordCurrentProxyFailureFn(error);
    throw error;
  }
}

async function refreshAndSaveAuthState(config, deps = {}) {
  const readSavedAuthStateFn = deps.readSavedAuthStateFn || readSavedAuthState;
  const saveAuthStateFn = deps.saveAuthStateFn || saveAuthState;
  const requestFn = deps.requestFn || requestRefreshedAuthState;
  const current = await readSavedAuthStateFn(config.tokenPath);

  if (!current.refreshToken) {
    const error = new Error('No saved BBGU refresh token is available.');
    error.code = 'BBGU_REFRESH_UNAVAILABLE';
    throw error;
  }

  const refreshed = await requestFn(config, current, deps);
  await saveAuthStateFn(config.tokenPath, refreshed);
  config.authorization = buildAuthorizationHeader(refreshed.accessToken);
  return { status: 'refresh_ok', authState: refreshed };
}

function responseHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return clean(headers.get(name));
  const target = String(name).toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === target);
  return key ? clean(headers[key]) : '';
}

function isAuthExpiredResponse({ httpStatus, text, body, headers }) {
  if (httpStatus === 401) return true;
  if (httpStatus >= 500) return false;
  if ([301, 302, 303, 307, 308].includes(httpStatus)) {
    const location = responseHeader(headers, 'location');
    return /authserver\.bbgu\.edu\.cn|\/authserver\/|(?:^|\/)cas(?:[/?]|$)|(?:^|\/)login(?:[/?]|$)/i.test(location);
  }
  if (httpStatus >= 200 && httpStatus < 300 && /统一身份认证|扫码登录|cas|login/i.test(text || '')) return true;
  if (!body || typeof body !== 'object') return false;
  const status = clean(body.status).toLowerCase();
  const msg = clean(body.msg || body.message || body.error);
  if (status && status !== 'success') {
    return /token|auth|login|登录|认证|过期|失效|未授权|unauthorized|expired/i.test(`${status} ${msg}`);
  }
  if (body.ok === false) return /token|auth|login|登录|认证|过期|失效|未授权|unauthorized|expired/i.test(msg);
  return false;
}

function isTerminalRefreshAuthFailure(error) {
  if (error && error.code === 'BBGU_REFRESH_UNAVAILABLE') return true;
  const httpStatus = Number(error && error.httpStatus);
  if (httpStatus === 401) return true;
  const details = [error && error.oauthError, error && error.oauthErrorDescription]
    .map(clean)
    .filter(Boolean)
    .join(' ');
  if (/^invalid_(?:grant|token)$/i.test(clean(error && error.oauthError))) return true;
  return /(?:refresh\s*token|刷新令牌).*(?:expired|invalid|revoked|过期|失效|无效)|(?:expired|invalid|revoked|过期|失效|无效).*(?:refresh\s*token|刷新令牌)/i.test(details);
}

function getBbguOrigin(config) {
  return new URL((config && config.homeUrl) || DEFAULT_HOME_URL).origin;
}

function buildBbguApiHeaders(config, refererPath = '/workspace/home') {
  const origin = getBbguOrigin(config);
  const headers = {
    accept: 'application/json, text/plain, */*',
    referer: `${origin}${refererPath}`,
    'user-agent': BBGU_BROWSER_USER_AGENT,
  };
  if (config.authorization) headers.authorization = config.authorization;
  return headers;
}

function createScoreApiError(message, response) {
  const error = new Error(message);
  error.httpStatus = Number(response && response.status) || 0;
  const retryAfter = responseHeader(response && response.headers, 'retry-after');
  if (retryAfter) error.retryAfter = retryAfter;
  return error;
}

async function fetchBbguScoreRows(config, deps = {}) {
  const curlRequestFn = deps.curlRequestFn || requestWithCurl;
  const withProxyFailoverFn = deps.withProxyFailoverFn || withSingleProxyFailover;
  const headers = buildBbguApiHeaders(config);
  const proxyServer = clean((config && config.proxyServer) || process.env.BBGU_PROXY_SERVER || '');
  const request = () => curlRequestFn(BBGU_SCORE_API_URL, {
    method: 'GET', headers, timeoutMs: BBGU_API_TIMEOUT_MS,
    ...(proxyServer ? { proxyServer } : {}),
  });
  const response = proxyServer
    ? await withProxyFailoverFn(config, request)
    : await request();

  const text = response.text;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    if (isAuthExpiredResponse({ httpStatus: response.status, text, body: null, headers: response.headers })) {
      const error = new Error('BBGU login state expired. GitHub Actions will try refresh token or QR login.');
      error.code = 'BBGU_AUTH_EXPIRED';
      throw error;
    }
    throw createScoreApiError(`BBGU score API returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`, response);
  }

  if (isAuthExpiredResponse({ httpStatus: response.status, text, body, headers: response.headers })) {
    const error = new Error('BBGU login state expired. GitHub Actions will try refresh token or QR login.');
    error.code = 'BBGU_AUTH_EXPIRED';
    throw error;
  }

  if (response.status < 200 || response.status >= 300 || body.status !== 'success' || !body.ok) {
    throw createScoreApiError(`BBGU score API failed HTTP ${response.status}: ${text.slice(0, 500)}`, response);
  }

  return normalizeBbguScoreApiData(body.data, config.term);
}

async function fetchBbguSubScores(scoreId, config, deps = {}) {
  const curlRequestFn = deps.curlRequestFn || requestWithCurl;
  const withProxyFailoverFn = deps.withProxyFailoverFn || withSingleProxyFailover;
  const origin = getBbguOrigin(config);
  const url = `${origin}${BBGU_SUBSCORE_API_PATH}?scoreId=${encodeURIComponent(scoreId)}`;
  const headers = buildBbguApiHeaders(config, '/sam/home');
  const proxyServer = clean((config && config.proxyServer) || process.env.BBGU_PROXY_SERVER || '');
  const request = () => curlRequestFn(url, {
    method: 'GET', headers, timeoutMs: BBGU_API_TIMEOUT_MS,
    ...(proxyServer ? { proxyServer } : {}),
  });
  const response = proxyServer
    ? await withProxyFailoverFn(config, request)
    : await request();
  return parseBbguSubscoreResponse(response);
}

function parseBbguSubscoreResponse(response) {
  const responseText = String(response.text || '');
  const errorDetails = (limit) => responseText.slice(0, limit);
  let body;
  try {
    body = JSON.parse(responseText);
  } catch {
    if (isAuthExpiredResponse({
      httpStatus: response.status,
      text: responseText,
      body: null,
      headers: response.headers,
    })) {
      const error = new Error('BBGU login state expired while fetching subscore.');
      error.code = 'BBGU_AUTH_EXPIRED';
      throw error;
    }
    const error = createScoreApiError(
      `BBGU subscore API returned non-JSON HTTP ${response.status}: ${errorDetails(300)}`,
      response
    );
    error.code = 'BBGU_SUBSCORE_PROTOCOL_ERROR';
    throw error;
  }

  if (isAuthExpiredResponse({ httpStatus: response.status, text: responseText, body, headers: response.headers })) {
    const error = new Error('BBGU login state expired while fetching subscore.');
    error.code = 'BBGU_AUTH_EXPIRED';
    throw error;
  }

  if (response.status < 200 || response.status >= 300 || body.status !== 'success') {
    throw createScoreApiError(
      `BBGU subscore API failed HTTP ${response.status}: ${errorDetails(500)}`,
      response
    );
  }

  return normalizeSubScoreList(body);
}

function createStagedNetworkError(stage, error) {
  if (error && error.stage) return error;
  const message = clean(error && error.message ? error.message : error) || 'Unknown network error';
  const stagedError = new Error(`${stage}: ${message}`, error instanceof Error ? { cause: error } : undefined);
  stagedError.stage = stage;
  if (error && error.code) stagedError.code = error.code;
  if (error && error.errno !== undefined) stagedError.errno = error.errno;
  if (error && error.syscall) stagedError.syscall = error.syscall;
  return stagedError;
}

async function enrichRowsWithSubScores(diff, config, fetcher = fetchBbguSubScores) {
  const rowsToFetch = selectRowsForSubScoreFetch(diff);
  const rowsMissingScoreId = selectRowsMissingSubScoreIdForSubScoreFetch(diff);
  for (const row of rowsMissingScoreId) {
    console.log(`[BBGU] Subscore skipped for ${row.courseName || row.key || 'unknown course'}: missing scoreId. fields=${formatSubScoreSourceKeys(row) || 'unknown'}`);
  }
  if (!rowsToFetch.length) return { fetched: 0, failed: 0, skipped: 0, globalError: null };

  let fetched = 0;
  let failed = 0;
  let skipped = 0;
  let globalError = null;
  for (let index = 0; index < rowsToFetch.length; index += 1) {
    const row = rowsToFetch[index];
    try {
      row.subScores = await fetcher(row.scoreId, config);
      row.subScoreFetchedAt = new Date().toISOString();
      delete row.subScoreFetchError;
      fetched += 1;
      console.log(`[BBGU] Subscores saved for ${row.courseName || row.key}. count=${row.subScores.length}`);
    } catch (error) {
      row.subScores = [];
      row.subScoreFetchedAt = new Date().toISOString();
      row.subScoreFetchError = error && error.message ? error.message : String(error);
      failed += 1;
      console.log(`[BBGU] Subscore fetch failed for ${row.courseName || row.key}: ${row.subScoreFetchError}`);
      if (isGlobalSubscoreFailure(error)) {
        globalError = error;
        for (const untouched of rowsToFetch.slice(index + 1)) {
          untouched.subScoreFetchError = '本次因全局异常跳过';
          delete untouched.subScoreFetchedAt;
          skipped += 1;
        }
        break;
      }
    }
  }

  return { fetched, failed, skipped, globalError };
}

function isGlobalSubscoreFailure(error) {
  const status = Number(error && error.httpStatus);
  return Boolean(error && (
    error.code === 'BBGU_AUTH_EXPIRED'
    || error.code === 'BBGU_SUBSCORE_PROTOCOL_ERROR'
    || ['BBGU_PROXY_NETWORK_FAILED', 'BBGU_PROXY_FAILOVER_EXHAUSTED'].includes(error.code)
    || isNetworkTransportError(error)
    || status === 401
    || status === 403
    || status === 404
    || status === 429
    || (status >= 500 && status <= 599)
  ));
}

function buildGradeNotificationId(term, diff) {
  const identity = {
    term,
    added: diff.added.map((row) => [row.key, row.score]),
    changed: diff.changed.map((item) => [item.after && item.after.key, item.before && item.before.score, item.after && item.after.score]),
  };
  return Buffer.from(JSON.stringify(identity), 'utf8').toString('base64url');
}

async function readPendingNotifications(config) {
  if (!config.pendingNotificationPath) return { items: [] };
  const state = await readJson(config.pendingNotificationPath, { items: [] });
  return { items: Array.isArray(state && state.items) ? state.items : [] };
}

async function writePendingNotifications(config, state) {
  if (!config.pendingNotificationPath) return;
  if (!state.items.length) {
    await fsp.rm(config.pendingNotificationPath, { force: true });
    return;
  }
  await writeJson(config.pendingNotificationPath, state);
}

async function enqueuePendingNotification(config, notification) {
  const state = await readPendingNotifications(config);
  if (!state.items.some((item) => item.id === notification.id)) {
    state.items.push(notification);
    await writePendingNotifications(config, state);
  }
  return state;
}

async function flushPendingNotifications(config, deps = {}) {
  const sendPushPlusFn = deps.sendPushPlusFn || sendPushPlus;
  const state = await readPendingNotifications(config);
  let sent = 0;
  while (state.items.length) {
    const item = state.items[0];
    await sendPushPlusFn({
      token: config.pushplusToken,
      title: item.title,
      content: item.content,
    });
    state.items.shift();
    sent += 1;
    await writePendingNotifications(config, state);
  }
  return sent;
}

async function processGradeRows(currentRows, config, deps = {}) {
  const enrichRowsWithSubScoresFn = deps.enrichRowsWithSubScoresFn || enrichRowsWithSubScores;
  const writeSnapshotFn = deps.writeSnapshotFn || writeJson;
  if (!currentRows.length) {
    throw new Error('No grade rows were extracted from BBGU score API/page.');
  }

  const previousRows = migrateSnapshotGradeKeys(await readJson(config.snapshotPath, []));
  const rowsWithSavedSubScores = mergePersistedSubScores(previousRows, currentRows);
  const diff = diffGrades(previousRows, rowsWithSavedSubScores);
  let subscoreGlobalError = null;

  if (diff.added.length || diff.changed.length) {
    const notificationId = buildGradeNotificationId(config.term, diff);
    const pending = await readPendingNotifications(config);
    if (!pending.items.some((item) => item.id === notificationId)) {
      const subscoreResult = await enrichRowsWithSubScoresFn(diff, config);
      subscoreGlobalError = subscoreResult && subscoreResult.globalError;
      await enqueuePendingNotification(config, {
        id: notificationId,
        title: `BBGU 成绩更新：新增 ${diff.added.length}，变更 ${diff.changed.length}`,
        content: formatPushPlusGradeTextContent({ term: config.term, added: diff.added, changed: diff.changed, currentRows: rowsWithSavedSubScores }),
        createdAt: new Date().toISOString(),
      });
    } else {
      console.log('[BBGU] Reusing pending grade notification after an earlier snapshot failure.');
    }
  } else {
    console.log(`[BBGU] No grade changes. count=${rowsWithSavedSubScores.length}`);
  }

  await writeSnapshotFn(config.snapshotPath, rowsWithSavedSubScores);
  console.log(`[BBGU] Snapshot saved: ${config.snapshotPath}`);
  const sent = await flushPendingNotifications(config, deps);
  if (diff.added.length || diff.changed.length) {
    console.log(`[BBGU] Grade changes queued and sent. added=${diff.added.length}, changed=${diff.changed.length}`);
  } else if (sent) {
    console.log(`[BBGU] Pending grade notifications sent. count=${sent}`);
  }
  if (subscoreGlobalError) throw subscoreGlobalError;
  return { status: 'ok', count: rowsWithSavedSubScores.length, ...diff };
}

async function isAuthenticated(page) {
  const text = clean(await page.locator('body').innerText({ timeout: 5000 }).catch(() => ''));
  return /成绩查询|我的课表|我的考试|我的课程|学籍信息/.test(text);
}

const BBGU_BROWSER_TOKEN_KEYS = new Set([
  'cqu_edu_ACCESS_TOKEN',
  'cqu_edu_CURRENT_TOKEN',
  'cqu_edu_REFRESH_TOKEN',
  'cqu_edu_TOKEN_EXPIRE',
  'cqu_edu_EXPIRE_ACCESS_TOKEN',
]);

function sanitizeStorageStateForAccessRenewal(storageState, origin) {
  const cloned = JSON.parse(JSON.stringify(storageState || { cookies: [], origins: [] }));
  for (const entry of Array.isArray(cloned.origins) ? cloned.origins : []) {
    if (clean(entry.origin) !== clean(origin) || !Array.isArray(entry.localStorage)) continue;
    entry.localStorage = entry.localStorage
      .filter((item) => !BBGU_BROWSER_TOKEN_KEYS.has(clean(item && item.name)));
  }
  return cloned;
}

async function isExplicitCasLoginPage(page) {
  let text = '';
  try {
    text = clean(await page.locator('body').innerText({ timeout: 3000 }));
  } catch {
    text = '';
  }
  if (/统一身份认证|扫码登录|微信扫码|二维码/.test(text)) return true;
  try {
    const currentUrl = new URL(page.url());
    return currentUrl.hostname.toLowerCase() === 'authserver.bbgu.edu.cn'
      && /(?:^|\/)login(?:[/?]|$)/i.test(`${currentUrl.pathname}${currentUrl.search}`);
  } catch {
    return false;
  }
}

function createCasExpiredError(message, cause) {
  const error = new Error(message, cause instanceof Error ? { cause } : undefined);
  error.code = 'BBGU_CAS_EXPIRED';
  return error;
}

async function createContext(browser, config, overrides = {}) {
  const contextOptions = {
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  };

  if (Object.hasOwn(overrides, 'storageState')) {
    contextOptions.storageState = overrides.storageState;
  } else if (fs.existsSync(config.storageStatePath)) {
    contextOptions.storageState = config.storageStatePath;
  }

  return browser.newContext(contextOptions);
}

async function createAccessRenewalContext(browser, config, deps = {}) {
  const readStorageStateFn = deps.readStorageStateFn || readStorageState;
  const storageState = await readStorageStateFn(config.storageStatePath);
  const sanitized = sanitizeStorageStateForAccessRenewal(storageState, getBbguOrigin(config));
  return createContext(browser, config, { storageState: sanitized });
}

async function saveScreenshot(page, config, label) {
  await fsp.mkdir(config.diagnosticDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshotPath = path.join(config.diagnosticDir, `${timestamp}-${label}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return screenshotPath;
}

async function saveQrElementScreenshot(page, config) {
  await fsp.mkdir(config.diagnosticDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshotPath = path.join(config.diagnosticDir, `${timestamp}-qr-code.png`);
  const selectors = [
    'img[src*="/connect/qrcode/"]',
    'img.js_qrcode_img',
    '.web_qrcode_img',
    'iframe[src*="open.weixin.qq.com/connect/qrconnect"]',
    'iframe[src*="combinedLogin.do"]',
  ];

  for (const frame of page.frames()) {
    for (const selector of selectors) {
      try {
        const locator = frame.locator(selector).first();
        if (!(await locator.count())) continue;
        await locator.waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined);
        await locator.screenshot({ path: screenshotPath, timeout: 5000 });
        return screenshotPath;
      } catch {
        // Try the next frame/selector. Cross-origin frames can be timing-sensitive.
      }
    }
  }

  return '';
}

function installPageRequestFailureCapture(page, limit = 20) {
  if (!page || typeof page.on !== 'function' || page.__bbguRequestFailureCaptureInstalled) return;
  page.__bbguRequestFailures = page.__bbguRequestFailures || [];
  page.__bbguRequestFailureCaptureInstalled = true;
  page.on('requestfailed', (request) => {
    const failure = typeof request.failure === 'function' ? request.failure() : null;
    const record = {
      url: typeof request.url === 'function' ? request.url() : '',
      method: typeof request.method === 'function' ? request.method() : '',
      resourceType: typeof request.resourceType === 'function' ? request.resourceType() : '',
      errorText: failure ? clean(failure.errorText) : '',
    };
    page.__bbguRequestFailures.push(record);
    if (page.__bbguRequestFailures.length > limit) {
      page.__bbguRequestFailures.splice(0, page.__bbguRequestFailures.length - limit);
    }
  });
}

async function saveLoginTimeoutDiagnostics(page, config) {
  await fsp.mkdir(config.diagnosticDir, { recursive: true });
  const screenshotPath = await saveScreenshot(page, config, 'qr-login-timeout');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(config.diagnosticDir, `${timestamp}-qr-login-timeout.json`);
  let title = '';
  let bodyText = '';

  try {
    title = clean(await page.title());
  } catch {
    title = '';
  }

  try {
    bodyText = String(await page.locator('body').innerText({ timeout: 3000 })).slice(0, 5000);
  } catch {
    bodyText = '';
  }

  const report = {
    createdAt: new Date().toISOString(),
    url: typeof page.url === 'function' ? page.url() : '',
    title,
    bodyText,
    screenshotPath,
    requestFailures: Array.isArray(page.__bbguRequestFailures)
      ? page.__bbguRequestFailures.slice(-20)
      : [],
  };
  await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { reportPath, screenshotPath };
}

async function waitForAuthenticationAfterQr(page, config, deps = {}) {
  const nowFn = deps.nowFn || Date.now;
  const extractAuthStateFn = deps.extractAuthStateFn || extractAuthStateFromPage;
  const isAuthenticatedFn = deps.isAuthenticatedFn || isAuthenticated;
  const deadline = nowFn() + config.loginWaitSeconds * 1000;
  console.log(`[BBGU] Waiting up to ${config.loginWaitSeconds}s for QR login...`);

  while (nowFn() < deadline) {
    const authState = await extractAuthStateFn(page);
    if (authState.accessToken || await isAuthenticatedFn(page)) return true;
    await page.waitForTimeout(5000);
  }

  return false;
}

async function extractAuthStateFromPage(page) {
  const raw = await page.evaluate(() => (
    {
      accessToken: localStorage.getItem('cqu_edu_ACCESS_TOKEN')
        || localStorage.getItem('cqu_edu_CURRENT_TOKEN')
        || '',
      refreshToken: localStorage.getItem('cqu_edu_REFRESH_TOKEN') || '',
    }
  )).catch(() => emptyAuthState());
  return {
    accessToken: unquoteToken(raw.accessToken),
    refreshToken: unquoteToken(raw.refreshToken),
  };
}

async function shouldStartQrLogin(page, deps = {}) {
  const extractAuthStateFn = deps.extractAuthStateFn || extractAuthStateFromPage;
  const isAuthenticatedFn = deps.isAuthenticatedFn || isAuthenticated;
  const authState = await extractAuthStateFn(page);
  if (authState.accessToken) return false;
  return !(await isAuthenticatedFn(page));
}

async function waitForAuthState(page, timeoutMs, deps = {}) {
  const nowFn = deps.nowFn || Date.now;
  const refreshGraceMs = deps.refreshGraceMs ?? 10000;
  const deadline = nowFn() + timeoutMs;
  let latest = emptyAuthState();
  let accessSeenAt = null;
  while (nowFn() < deadline) {
    latest = await extractAuthStateFromPage(page);
    if (latest.accessToken && latest.refreshToken) return latest;
    if (latest.accessToken) {
      if (accessSeenAt === null) accessSeenAt = nowFn();
      if (nowFn() - accessSeenAt >= refreshGraceMs) return latest;
    }
    await page.waitForTimeout(2000);
  }
  return latest;
}

async function saveBrowserAuthState(page, config, deps = {}) {
  const waitForAuthStateFn = deps.waitForAuthStateFn || waitForAuthState;
  const saveAuthStateFn = deps.saveAuthStateFn || saveAuthState;
  const readSavedAuthStateFn = deps.readSavedAuthStateFn || readSavedAuthState;
  const readQrReminderStateFn = deps.readQrReminderStateFn || readQrReminderState;
  let authState = await waitForAuthStateFn(page, 30000);
  if (!authState.accessToken) {
    throw new Error('Login succeeded but cqu_edu_ACCESS_TOKEN was not found in localStorage.');
  }
  if (!authState.refreshToken) {
    const previous = await readSavedAuthStateFn(config.tokenPath);
    const reminderState = await readQrReminderStateFn(config);
    if (previous.refreshToken && !(reminderState && (
      reminderState.refreshExpired || reminderState.accessRejectedAfterRefresh
    ))) {
      authState = { ...authState, refreshToken: previous.refreshToken };
      console.log('[BBGU] Warning: login produced no new refresh token; preserving the previously saved refresh token.');
    } else {
      console.log('[BBGU] Warning: login succeeded without a refresh token; next recovery will use CAS.');
    }
  }
  await saveAuthStateFn(config.tokenPath, authState);
  return authState;
}

async function finalizeLoginReminderState(config, authState, deps = {}) {
  const clearQrReminderStateFn = deps.clearQrReminderStateFn || clearQrReminderState;
  const writeJsonFn = deps.writeJsonFn || writeJson;
  if (authState && authState.refreshToken) {
    await clearQrReminderStateFn(config);
    return;
  }
  if (config && config.qrReminderStatePath) {
    await writeJsonFn(config.qrReminderStatePath, { refreshExpired: true });
  }
}

async function persistBrowserLoginState(page, context, config, deps = {}) {
  const saveBrowserAuthStateFn = deps.saveBrowserAuthStateFn || saveBrowserAuthState;
  const finalizeLoginReminderStateFn = deps.finalizeLoginReminderStateFn || finalizeLoginReminderState;
  const saveBrowserStorageStateFn = deps.saveBrowserStorageStateFn || saveBrowserStorageState;
  const authState = await saveBrowserAuthStateFn(page, config);
  await finalizeLoginReminderStateFn(config, authState);
  await saveBrowserStorageStateFn(context, config.storageStatePath, config);
  return authState;
}

async function collectLoginQrArtifacts(page, config, weixinQrCapture, deps = {}) {
  const saveQrElementScreenshotFn = deps.saveQrElementScreenshotFn || saveQrElementScreenshot;
  let weixinQrInfo = typeof weixinQrCapture.get === 'function' ? weixinQrCapture.get() : null;
  let qrElementScreenshotPath = await saveQrElementScreenshotFn(page, config);
  if (!weixinQrInfo && !qrElementScreenshotPath) {
    weixinQrInfo = await weixinQrCapture.wait(5000);
    qrElementScreenshotPath = await saveQrElementScreenshotFn(page, config);
  }
  return { weixinQrInfo, qrElementScreenshotPath };
}

async function saveBrowserStorageState(context, filePath, config, deps = {}) {
  const storageState = await context.storageState();
  const sanitized = sanitizeStorageStateForAccessRenewal(storageState, getBbguOrigin(config));
  await writeFileAtomic(filePath, `${JSON.stringify(sanitized, null, 2)}\n`, deps);
}

async function launchChromium(chromium, config) {
  const launchOptions = {
    headless: config.headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(config.proxyServer ? { proxy: { server: config.proxyServer } } : {}),
  };
  return chromium.launch(launchOptions);
}

async function withBrowserContext(config, createContextFn, callback) {
  const { chromium } = require('playwright');
  await fsp.mkdir(config.dataDir, { recursive: true });

  const browser = await launchChromium(chromium, config);
  let context;
  try {
    context = await createContextFn(browser, config);
    return await callback(context, browser);
  } finally {
    if (context) await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

async function performSilentRenew(context, config, deps = {}) {
  const withProxyFailoverFn = deps.withProxyFailoverFn || withSingleProxyFailover;
  const persistBrowserLoginStateFn = deps.persistBrowserLoginStateFn || persistBrowserLoginState;
  const handleChromeErrorPageFn = deps.handleChromeErrorPageFn || handleChromeErrorPage;
  await context.route('**/*', async (route) => {
    const resourceType = route.request().resourceType();
    if (['font', 'image', 'media', 'stylesheet'].includes(resourceType)) {
      await route.abort();
      return;
    }
    await route.continue();
  });

  const page = await context.newPage();
  const renewUrl = buildCasRenewUrl(config);
  console.log(`[BBGU] Opening ${renewUrl} for silent CAS renew.`);
  try {
    await withProxyFailoverFn(
      config,
      async () => {
        const response = await page.goto(renewUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await validateBrowserHttpResponse(response);
        return response;
      },
      { shouldFailoverFn: isSafeCasFailoverError }
    );
  } catch (error) {
    if (!isRecoverableNavigationAbort(error)) throw error;
    console.log(`[BBGU] Silent CAS renew navigation was aborted by redirect; continuing token check. url=${page.url()}`);
  }

  await handleChromeErrorPageFn(page, config);

  if (await isExplicitCasLoginPage(page)) {
    throw createCasExpiredError(`Silent CAS renew reached the login page. url=${page.url()}`);
  }

  try {
    await persistBrowserLoginStateFn(page, context, config, {
      saveBrowserAuthStateFn: deps.saveBrowserAuthStateFn || saveBrowserAuthState,
      finalizeLoginReminderStateFn: deps.finalizeLoginReminderStateFn || finalizeLoginReminderState,
      saveBrowserStorageStateFn: deps.saveBrowserStorageStateFn || saveBrowserStorageState,
    });
  } catch (error) {
    const screenshotPath = await saveScreenshot(page, config, 'silent-renew-failed').catch(() => 'unavailable');
    if (await isExplicitCasLoginPage(page)) {
      throw createCasExpiredError(`Silent CAS renew reached the login page. url=${page.url()}; screenshot=${screenshotPath}`, error);
    }
    throw new Error(`Silent CAS renew did not obtain complete browser auth state. url=${page.url()}; screenshot=${screenshotPath}; reason=${error.message || error}`);
  }

  console.log(`[BBGU] Silent CAS renew completed. Access token saved: ${config.tokenPath}`);
  console.log(`[BBGU] Storage state saved: ${config.storageStatePath}`);
  return { status: 'renew_ok', tokenPath: config.tokenPath };
}

async function runSilentRenew(config = getConfig(), deps = {}) {
  const withBrowserContextFn = deps.withBrowserContextFn || withBrowserContext;
  const createAccessRenewalContextFn = deps.createAccessRenewalContextFn || createAccessRenewalContext;
  return withBrowserContextFn(
    config,
    (browser, nextConfig) => createAccessRenewalContextFn(browser, nextConfig),
    (context) => performSilentRenew(context, config, deps)
  );
}

async function recoverDirectApiAfterAuthExpired(config, deps = {}) {
  const {
    nowFn = Date.now,
    refreshAndSaveAuthStateFn = refreshAndSaveAuthState,
    runLoginFn = runLogin,
    readQrReminderStateFn = readQrReminderState,
    readSavedAuthStateFn = readSavedAuthState,
    saveQrReminderScheduleFn = saveQrReminderSchedule,
    markRefreshExpiredFn = markRefreshExpired,
    markAccessRejectedAfterRefreshFn = markAccessRejectedAfterRefresh,
    clearQrReminderScheduleFn = clearQrReminderSchedule,
    maybeRunScheduledQrFn = maybeRunScheduledQr,
    fetchScoreRowsFn = fetchBbguScoreRows,
    serverAuthExpired: initialServerAuthExpired = false,
  } = deps;

  let serverAuthExpired = initialServerAuthExpired;
  let renewalState = await readQrReminderStateFn(config);
  let refreshKnownExpired = Boolean(renewalState && (
    renewalState.refreshExpired
    || renewalState.accessRejectedAfterRefresh
    || Number.isFinite(renewalState.dueAt)
  ));
  const auth = await readSavedAuthStateFn(config.tokenPath);
  const accessExpiry = extractJwtExpiry(auth.accessToken);
  const refreshExpiry = extractJwtExpiry(auth.refreshToken);
  if (serverAuthExpired && !refreshExpiry && !refreshKnownExpired) {
    renewalState = {
      ...(renewalState || {}),
      ...((await markAccessRejectedAfterRefreshFn(config, auth.accessToken)) || {}),
      accessRejectedAfterRefresh: true,
    };
    refreshKnownExpired = true;
  }
  if (!accessExpiry || (!refreshKnownExpired && !refreshExpiry)) {
    const error = new Error('保存的BBGU Token缺少有效JWT exp。');
    error.code = 'BBGU_LOCAL_AUTH_STATE_INVALID';
    throw error;
  }

  if (!refreshKnownExpired && refreshExpiry.epochSeconds * 1000 <= nowFn()) {
    renewalState = {
      ...(renewalState || {}),
      ...((await markRefreshExpiredFn(config)) || {}),
      casExpired: true,
      refreshExpired: true,
    };
    refreshKnownExpired = true;
  }

  if (!refreshKnownExpired) {
    const plan = serverAuthExpired
      ? { action: 'REFRESH_ACCESS', reason: 'server-auth-expired' }
      : planAutomaticAction({
        mode: 'watch',
        nowMs: nowFn(),
        casExpired: true,
        refreshExpired: false,
        accessExpiryEpochSeconds: accessExpiry.epochSeconds,
        refreshExpiryEpochSeconds: refreshExpiry.epochSeconds,
        hasAccessToken: true,
        hasRefreshToken: true,
      });
    if (plan.action !== 'REFRESH_ACCESS') {
      const error = new Error(`Watch认证恢复决策器返回无法执行的动作：${plan.action}`);
      error.code = 'BBGU_AUTOMATIC_ACTION_INVALID';
      throw error;
    }
    let refreshed = false;
    let refreshedAccessToken = '';
    try {
      console.log('[BBGU] Access token expired; trying refresh token first.');
      const refreshResult = await refreshAndSaveAuthStateFn(config);
      await clearQrReminderScheduleFn(config);
      const refreshedAuth = refreshResult && refreshResult.authState
        ? refreshResult.authState
        : refreshResult;
      if (refreshedAuth && refreshedAuth.accessToken) {
        refreshedAccessToken = refreshedAuth.accessToken;
        config.authorization = buildAuthorizationHeader(refreshedAuth.accessToken);
      }
      refreshed = true;
    } catch (error) {
      console.log(`[BBGU] Refresh Token续Access失败。原因：${error.message || error}`);
      if (!isTerminalRefreshAuthFailure(error)) {
        throw error;
      }
      renewalState = {
        ...(renewalState || {}),
        ...((await markRefreshExpiredFn(config)) || {}),
        casExpired: true,
        refreshExpired: true,
      };
      refreshKnownExpired = true;
    }
    if (refreshed) {
      console.log('[BBGU] Refresh token renewal completed; retrying score API.');
      try {
        return await fetchScoreRowsFn(config);
      } catch (error) {
        if (!error || error.code !== 'BBGU_AUTH_EXPIRED') throw error;
        renewalState = {
          ...(renewalState || {}),
          ...((await markAccessRejectedAfterRefreshFn(config, refreshedAccessToken)) || {}),
          accessRejectedAfterRefresh: true,
        };
        refreshKnownExpired = true;
        serverAuthExpired = true;
      }
    }
  } else {
    console.log('[BBGU] Refresh Token已记录失效，本次跳过续期请求。');
  }

  const needsImmediateQr = Boolean(
    serverAuthExpired
    && refreshKnownExpired
    && renewalState
    && renewalState.casExpired
  );
  if (serverAuthExpired && refreshKnownExpired && !needsImmediateQr) {
    if (!renewalState || !renewalState.accessRejectedAfterRefresh) {
      renewalState = {
        ...(renewalState || {}),
        ...((await markAccessRejectedAfterRefreshFn(config, auth.accessToken)) || {}),
        accessRejectedAfterRefresh: true,
      };
    }
    const error = new Error('新Access已被服务端拒绝，等待下一次Renew尝试CAS恢复。');
    error.code = 'BBGU_AWAITING_CAS_RENEW';
    throw error;
  }
  if (needsImmediateQr) {
    const savedSchedule = await saveQrReminderScheduleFn(
      config,
      computeImmediateQrSchedule(accessExpiry.epochSeconds, nowFn())
    );
    renewalState = { ...(renewalState || {}), ...(savedSchedule || {}) };
  } else if (!renewalState || !Number.isFinite(renewalState.dueAt)) {
    const savedSchedule = await saveQrReminderScheduleFn(
      config,
      computeQrSchedule(accessExpiry.epochSeconds, nowFn())
    );
    renewalState = { ...(renewalState || {}), ...(savedSchedule || {}) };
  }

  const qrResult = await maybeRunScheduledQrFn(config, { nowFn, runLoginFn });
  if (!qrResult || qrResult.status !== 'login_ok') {
    throw new Error('二维码提醒仍在冷却期，本次成绩查询无法登录。');
  }
  const loggedInAuth = await readSavedAuthStateFn(config.tokenPath);
  if (!loggedInAuth.accessToken) throw new Error(`扫码登录完成，但没有在 ${config.tokenPath} 保存Access Token。`);
  config.authorization = buildAuthorizationHeader(loggedInAuth.accessToken);
  return fetchScoreRowsFn(config);
}

async function runCore(config = getConfig(), deps = {}) {
  const {
    readSavedAuthStateFn = readSavedAuthState,
    fetchScoreRowsFn = fetchBbguScoreRows,
    recoverDirectApiAfterAuthExpiredFn = recoverDirectApiAfterAuthExpired,
    runLoginFn = runLogin,
    readSavedAuthStateAfterLoginFn = readSavedAuthStateFn,
    readQrReminderStateFn = readQrReminderState,
    markRefreshExpiredFn = markRefreshExpired,
    clearQrReminderStateFn = clearQrReminderState,
    processGradeRowsFn = processGradeRows,
    maybeRunScheduledQrFn = maybeRunScheduledQr,
    nowFn = Date.now,
  } = deps;

  if (!config.pushplusToken) {
    throw new Error('Missing PUSHPLUS_TOKEN. Set it in GitHub repository secrets.');
  }
  if (!config.term) {
    throw new Error('Missing BBGU_TERM. Set it in GitHub repository variables.');
  }

  if (!config.authorization) {
    const auth = await readSavedAuthStateFn(config.tokenPath);
    if (auth.accessToken) {
      config.authorization = buildAuthorizationHeader(auth.accessToken);
      console.log(`[BBGU] Loaded saved access token from ${config.tokenPath}`);
    }
  }

  const finishGradeRun = async (rows) => {
    let result;
    let gradeError;
    try {
      result = await processGradeRowsFn(rows, config);
    } catch (error) {
      gradeError = error;
    }

    if (gradeError && isGlobalSubscoreFailure(gradeError)) throw gradeError;

    try {
      await maybeRunScheduledQrFn(config);
    } catch (qrError) {
      if (!gradeError) throw qrError;
      console.error(`[BBGU] 成绩处理失败后，二维码检查也失败：${qrError.message || qrError}`);
    }

    if (gradeError) throw gradeError;
    return result;
  };

  if (config.authorization) {
    console.log('[BBGU] Using direct score API mode with current access token.');
    let currentRows;
    let authRecoveryState = await readQrReminderStateFn(config);
    const savedAuth = config.tokenPath
      ? await readSavedAuthStateFn(config.tokenPath)
      : emptyAuthState();
    const savedRefreshExpiry = extractJwtExpiry(savedAuth.refreshToken);
    if (savedRefreshExpiry && savedRefreshExpiry.epochSeconds * 1000 <= nowFn()
      && !(authRecoveryState && authRecoveryState.casExpired && authRecoveryState.refreshExpired)) {
      const markedState = await markRefreshExpiredFn(config);
      authRecoveryState = {
        ...(authRecoveryState || {}),
        ...(markedState || {}),
        casExpired: true,
        refreshExpired: true,
      };
    }
    if (authRecoveryState && authRecoveryState.accessRejectedAfterRefresh) {
      const rejectedFingerprint = authRecoveryState.rejectedAccessFingerprint;
      const currentFingerprint = fingerprintToken(config.authorization);
      const markerMatchesCurrentAccess = !rejectedFingerprint
        || rejectedFingerprint === currentFingerprint;
      if (!markerMatchesCurrentAccess) {
        try {
          await clearQrReminderStateFn(config);
        } catch (error) {
          console.error(`[BBGU] 清理旧Access拒绝标记失败，本次仍使用新Access查询：${error.message || error}`);
        }
        authRecoveryState = null;
      } else {
        if (!authRecoveryState.casExpired) {
          console.log('[BBGU] 新Access已被服务端拒绝，本次Watch等待Renew尝试CAS恢复。');
          return { status: 'awaiting_cas_renew' };
        }
        currentRows = await recoverDirectApiAfterAuthExpiredFn(config, {
          fetchScoreRowsFn,
          nowFn,
          serverAuthExpired: true,
        });
        return finishGradeRun(currentRows);
      }
    }
    const localExpiry = extractJwtExpiry(config.authorization);
    if (localExpiry && localExpiry.epochSeconds * 1000 <= nowFn()) {
      console.log('[BBGU] Access token is locally known to be expired; skipping the avoidable score API request.');
      currentRows = await recoverDirectApiAfterAuthExpiredFn(config, { fetchScoreRowsFn, nowFn });
    } else {
      try {
        currentRows = await fetchScoreRowsFn(config);
      } catch (error) {
        if (error && error.code === 'BBGU_AUTH_EXPIRED') {
          currentRows = await recoverDirectApiAfterAuthExpiredFn(config, {
            fetchScoreRowsFn,
            nowFn,
            serverAuthExpired: true,
          });
        } else {
          throw error;
        }
      }
    }
    return finishGradeRun(currentRows);
  }

  const qrState = await readQrReminderStateFn(config);
  const loginPlan = planAutomaticAction({
    mode: 'watch',
    nowMs: nowFn(),
    hasAccessToken: false,
    hasRefreshToken: false,
    qrLastPushedAt: Number(qrState && qrState.lastPushedAt) || 0,
  });
  if (loginPlan.action === 'WAIT_QR_DUE') {
    console.log('[BBGU] 二维码仍在冷却期，本次Watch不重复生成。');
    return { status: 'qr_cooldown_skipped' };
  }

  console.log('[BBGU] No saved direct API token found; starting automatic QR login renewal.');
  await runLoginFn(config, { ignoreInitialAccessToken: true });
  const auth = await readSavedAuthStateAfterLoginFn(config.tokenPath);
  if (!auth.accessToken) {
    throw new Error(`Automatic login completed but no token was saved at ${config.tokenPath}.`);
  }
  config.authorization = buildAuthorizationHeader(auth.accessToken);
  const currentRows = await fetchScoreRowsFn(config);
  return finishGradeRun(currentRows);
}

async function run(config = getConfig(), deps = {}) {
  const consumeSchoolBackoffFn = deps.consumeSchoolBackoffFn || consumeSchoolBackoff;
  const markSchoolBackoffFn = deps.markSchoolBackoffFn || markSchoolBackoff;
  const runCoreFn = deps.runCoreFn || runCore;
  if (await consumeSchoolBackoffFn(config)) {
    console.log('[BBGU] 当前处于学校服务退避期，本次Watch不访问学校。');
    return { status: 'school_backoff_skipped' };
  }
  try {
    return await runCoreFn(config, deps);
  } catch (error) {
    if (error && [429, 500, 503].includes(Number(error.httpStatus))) {
      await markSchoolBackoffFn(config, error);
    }
    throw error;
  }
}

async function runLogin(config = getConfig(), options = {}) {
  if (!config.pushplusToken) {
    throw new Error('Missing PUSHPLUS_TOKEN. Set it in GitHub repository secrets.');
  }

  const nowFn = options.nowFn || Date.now;
  const consumeSchoolBackoffFn = options.consumeSchoolBackoffFn || consumeSchoolBackoff;
  const markQrPushedFn = options.markQrPushedFn || markQrPushed;
  const withBrowserContextFn = options.withBrowserContextFn || withBrowserContext;
  if (await consumeSchoolBackoffFn(config, nowFn())) {
    console.log('[BBGU] 当前处于学校服务退避期，本次二维码登录不访问学校。');
    return { status: 'school_backoff_skipped' };
  }

  const ignoreInitialAccessToken = Boolean(options.ignoreInitialAccessToken);
  const loginContextFactory = ignoreInitialAccessToken
    ? (browser, nextConfig) => createAccessRenewalContext(browser, nextConfig)
    : createContext;
  return withBrowserContextFn(config, loginContextFactory, async (context) => {
    const page = await context.newPage();
    installPageRequestFailureCapture(page);
    const weixinQrCapture = createWeixinQrCapture(page);
    const onQrSent = typeof options.onQrSent === 'function'
      ? options.onQrSent
      : async () => markQrPushedFn(config, nowFn());
    if (ignoreInitialAccessToken) console.log('[BBGU] Cleared saved browser access token locally before login fallback.');
    console.log(`[BBGU] Opening ${config.homeUrl} for login.`);
    try {
      await navigateToLoginPage(page, config.homeUrl, {
        onNetworkFailureFn: async (error) => {
          await recordCurrentProxyFailure(config, error);
          error.code = 'BBGU_PROXY_NETWORK_FAILED';
        },
      });
    } catch (error) {
      if (error && [429, 500, 503].includes(Number(error.httpStatus))) {
        await markSchoolBackoff(config, error);
      }
      throw error;
    }
    await handleChromeErrorPage(page, config);

    if (await shouldStartQrLogin(page)) {
      const pageScreenshotPath = await saveScreenshot(page, config, 'qr-login');
      const { weixinQrInfo, qrElementScreenshotPath } = await collectLoginQrArtifacts(page, config, weixinQrCapture);
      const qrImageUrl = weixinQrInfo?.qrImageUrl || '';
      const screenshotPath = qrElementScreenshotPath || pageScreenshotPath;
      let textQr = '';
      const decodedQrPayload = await decodeQrPayloadFromPngFile(screenshotPath).catch((error) => {
        console.log(`[BBGU] QR screenshot decode failed; falling back to screenshot path. ${error.message || error}`);
        return '';
      });
      if (decodedQrPayload) {
        textQr = renderTerminalQrCode(decodedQrPayload);
        if (textQr) {
          console.log('[BBGU] QR screenshot decoded and rendered as terminal text via qrcode-terminal.');
        } else {
          console.log('[BBGU] qrcode-terminal is not available or failed; falling back to screenshot path.');
        }
      } else {
        console.log('[BBGU] QR screenshot was not decoded; falling back to screenshot path.');
      }
      if (qrImageUrl) {
        console.log(`[BBGU] WeChat QR image captured: ${qrImageUrl}`);
      }
      if (qrElementScreenshotPath) {
        console.log(`[BBGU] QR element screenshot saved: ${qrElementScreenshotPath}`);
      }
      if (!textQr) {
        console.log(config.githubActions
          ? '[BBGU] Text QR is unavailable in GitHub Actions; local screenshot path will not be pushed.'
          : '[BBGU] PushPlus will send screenshot path only because text QR is unavailable.');
      }
      if (shouldAbortGithubQrLogin({ githubActions: config.githubActions, textQr, qrImageUrl })) {
        const diagnostic = await saveLoginTimeoutDiagnostics(page, config);
        throw new Error(`GitHub Actions could not extract a scannable QR code. Diagnostic report: ${diagnostic.reportPath}; screenshot: ${diagnostic.screenshotPath}`);
      }
      await sendPushPlus({
        token: config.pushplusToken,
        title: 'BBGU 教务系统扫码登录',
        content: formatQrLoginMessage({
          homeUrl: config.homeUrl,
          screenshotPath,
          qrImageUrl,
          textQr,
          waitSeconds: config.loginWaitSeconds,
          showScreenshotPath: !config.githubActions,
        }),
      });
      await onQrSent();
      console.log(`[BBGU] QR login screenshot saved: ${screenshotPath}`);
      const loggedIn = await waitForAuthenticationAfterQr(page, config);
      if (!loggedIn) {
        const diagnostic = await saveLoginTimeoutDiagnostics(page, config);
        throw new Error(`QR login timed out after ${config.loginWaitSeconds}s. Diagnostic report: ${diagnostic.reportPath}; screenshot: ${diagnostic.screenshotPath}`);
      }
    }

    weixinQrCapture.stop();
    await persistBrowserLoginState(page, context, config);
    console.log(`[BBGU] Access token saved: ${config.tokenPath}`);
    console.log(`[BBGU] Storage state saved: ${config.storageStatePath}`);
    return { status: 'login_ok', tokenPath: config.tokenPath };
  });
}

async function maybeRunScheduledQr(config, deps = {}) {
  const {
    nowFn = Date.now,
    readQrReminderStateFn = readQrReminderState,
    saveQrReminderScheduleFn = saveQrReminderSchedule,
    runLoginFn = runLogin,
  } = deps;
  const state = await readQrReminderStateFn(config);
  if (!state || !Number.isFinite(state.dueAt)) return { status: 'no_qr_pending' };
  const nowMs = nowFn();
  if (!shouldPushQrNow({
    nowMs,
    dueAtMs: state.dueAt,
    lastPushedAtMs: state.lastPushedAt || 0,
  })) {
    return { status: 'qr_pending', ...state };
  }
  const result = await runLoginFn(config, {
    ignoreInitialAccessToken: true,
    onQrSent: async () => {
      await saveQrReminderScheduleFn(config, { ...state, lastPushedAt: nowFn() });
    },
  });
  return result;
}

async function validateBrowserHttpResponse(response) {
  if (!response) return response;
  const status = Number(typeof response.status === 'function' ? response.status() : response.status);
  if (status !== 429 && !(status >= 500 && status <= 599)) return response;
  const headers = typeof response.headers === 'function' ? await response.headers() : response.headers;
  const url = typeof response.url === 'function' ? response.url() : response.url;
  const error = new Error(`BBGU browser navigation failed: HTTP ${status}${url ? ` url=${url}` : ''}`);
  error.httpStatus = status;
  if (status === 429) error.retryAfter = responseHeader(headers, 'retry-after');
  throw error;
}

async function handleChromeErrorPage(page, config, deps = {}) {
  if (!/^chrome-error:\/\//i.test(page.url())) return false;
  const recordCurrentProxyFailureFn = deps.recordCurrentProxyFailureFn || ((error) => recordCurrentProxyFailure(config, error));
  const saveLoginTimeoutDiagnosticsFn = deps.saveLoginTimeoutDiagnosticsFn || saveLoginTimeoutDiagnostics;
  const error = new Error('BBGU login page failed to load in Chromium.');
  error.code = 'BBGU_PROXY_NETWORK_FAILED';
  await recordCurrentProxyFailureFn(error);
  const diagnostic = await saveLoginTimeoutDiagnosticsFn(page, config);
  error.message = `BBGU login page failed to load in Chromium. Diagnostic report: ${diagnostic.reportPath}; screenshot: ${diagnostic.screenshotPath}`;
  throw error;
}

async function navigateToLoginPage(page, homeUrl, deps = {}) {
  try {
    const response = await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await validateBrowserHttpResponse(response);
    return response;
  } catch (error) {
    if (isNetworkTransportError(error) && typeof deps.onNetworkFailureFn === 'function') {
      await deps.onNetworkFailureFn(error);
    }
    throw error;
  }
}

async function runRenew(config = getConfig(), deps = {}) {
  const {
    nowFn = Date.now,
    logFn = console.log,
    consumeSchoolBackoffFn = consumeSchoolBackoff,
    markSchoolBackoffFn = markSchoolBackoff,
    readQrReminderStateFn = readQrReminderState,
    runSilentRenewFn = runSilentRenew,
    markCasExpiredFn = markCasExpired,
    markRefreshExpiredFn = markRefreshExpired,
    runLoginFn = runLogin,
    refreshAndSaveAuthStateFn = refreshAndSaveAuthState,
    readSavedAuthStateFn = readSavedAuthState,
    saveQrReminderScheduleFn = saveQrReminderSchedule,
    clearQrReminderScheduleFn = clearQrReminderSchedule,
    clearQrReminderStateFn = clearQrReminderState,
    finalizeLoginReminderStateFn = finalizeLoginReminderState,
    maybeRunScheduledQrFn = maybeRunScheduledQr,
  } = deps;

  if (await consumeSchoolBackoffFn(config, nowFn())) {
    logFn('[BBGU] 当前处于学校服务退避期，本次Renew不访问学校。');
    return { status: 'school_backoff_skipped' };
  }

  let renewalState = await readQrReminderStateFn(config);
  let auth = config.tokenPath
    ? await readSavedAuthStateFn(config.tokenPath)
    : null;
  if (config.tokenPath && !auth.accessToken) {
    const qrDueAt = Number(renewalState && renewalState.dueAt) || 0;
    const qrLastPushedAt = Number(renewalState && renewalState.lastPushedAt) || 0;
    if (!shouldPushQrNow({
      nowMs: nowFn(),
      dueAtMs: qrDueAt,
      lastPushedAtMs: qrLastPushedAt,
    })) {
      logFn('[BBGU] 没有保存的Access Token，但二维码仍在冷却期，本次Renew不重复登录。');
      return { status: 'qr_cooldown_skipped' };
    }
    logFn('[BBGU] 没有保存的Access Token，Renew改走首次登录流程。');
    return runLoginFn(config, { ignoreInitialAccessToken: true });
  }
  const savedRefreshExpiry = extractJwtExpiry(auth && auth.refreshToken);
  if (savedRefreshExpiry && savedRefreshExpiry.epochSeconds * 1000 <= nowFn()
    && !(renewalState && renewalState.casExpired && renewalState.refreshExpired)) {
    const markedState = await markRefreshExpiredFn(config);
    renewalState = {
      ...(renewalState || {}),
      ...(markedState || {}),
      casExpired: true,
      refreshExpired: true,
    };
  }
  if (renewalState && renewalState.accessRejectedAfterRefresh
    && renewalState.rejectedAccessFingerprint) {
    const currentFingerprint = fingerprintToken(auth && auth.accessToken);
    if (currentFingerprint && currentFingerprint !== renewalState.rejectedAccessFingerprint) {
      try {
        await clearQrReminderStateFn(config);
      } catch (error) {
        logFn(`[BBGU] 清理旧Access拒绝标记失败，本次仍按新Token续期：${error.message || error}`);
      }
      renewalState = null;
    }
  }
  let casStatus = renewalState && renewalState.casExpired ? 'expired_skipped' : 'unchecked';
  if (!renewalState || !renewalState.casExpired) {
    let result;
    try {
      result = await runSilentRenewFn(config);
    } catch (casError) {
      if (!casError || casError.code !== 'BBGU_CAS_EXPIRED') {
        if (casError && [429, 500, 503].includes(Number(casError.httpStatus))) {
          await markSchoolBackoffFn(config, casError, nowFn());
        }
        console.log(`[BBGU] CAS静默续期发生本地或网络故障，本次不判定Session失效。原因：${casError && (casError.message || casError)}`);
        throw casError;
      }
      renewalState = await markCasExpiredFn(config)
        || { ...(renewalState || {}), casExpired: true };
      casStatus = 'expired';
      console.log(`[BBGU] CAS静默续期失败，后续改用Refresh Token续Access。原因：${casError.message || casError}`);
    }

    if (casStatus !== 'expired') {
      const authState = await readSavedAuthStateFn(config.tokenPath);
      if (authState.refreshToken) {
        await clearQrReminderStateFn(config);
      } else {
        await finalizeLoginReminderStateFn(config, authState);
      }
      logFn(formatAuthStatusSummary({
        casStatus: 'valid',
        refreshStatus: 'unchecked',
        authState,
        nowMs: nowFn(),
      }));
      return result;
    }
  }

  auth = auth || await readSavedAuthStateFn(config.tokenPath);
  const accessExpiry = extractJwtExpiry(auth.accessToken);
  const refreshExpiry = extractJwtExpiry(auth.refreshToken);
  const refreshUnavailableKnown = Boolean(renewalState && (
    renewalState.refreshExpired || renewalState.accessRejectedAfterRefresh
  ));
  if (!accessExpiry || (!refreshUnavailableKnown && !refreshExpiry)) {
    const error = new Error('保存的BBGU Token缺少有效JWT exp。');
    error.code = 'BBGU_LOCAL_AUTH_STATE_INVALID';
    throw error;
  }

  if (renewalState && renewalState.accessRejectedAfterRefresh) {
    const savedSchedule = await saveQrReminderScheduleFn(
      config,
      computeImmediateQrSchedule(accessExpiry.epochSeconds, nowFn())
    );
    renewalState = { ...renewalState, ...(savedSchedule || {}) };
    logFn(formatAuthStatusSummary({
      casStatus,
      refreshStatus: 'valid',
      authState: auth,
      nowMs: nowFn(),
    }));
    return maybeRunScheduledQrFn(config, { nowFn });
  }

  for (;;) {
    const plan = planAutomaticAction({
      mode: 'renew',
      nowMs: nowFn(),
      casExpired: true,
      refreshExpired: Boolean(renewalState && renewalState.refreshExpired),
      accessExpiryEpochSeconds: accessExpiry.epochSeconds,
      refreshExpiryEpochSeconds: refreshExpiry ? refreshExpiry.epochSeconds : 0,
      qrDueAt: Number(renewalState && renewalState.dueAt) || 0,
      qrLastPushedAt: Number(renewalState && renewalState.lastPushedAt) || 0,
      hasAccessToken: Boolean(auth.accessToken),
      hasRefreshToken: Boolean(auth.refreshToken),
    });

    if (plan.action === 'WAIT_REFRESH_WINDOW') {
      logFn(formatAuthStatusSummary({
        casStatus,
        refreshStatus: 'valid',
        authState: auth,
        nowMs: nowFn(),
      }));
      return { status: 'refresh_waiting', reason: plan.reason };
    }

    if (plan.action === 'REFRESH_ACCESS') {
      try {
        const refreshResult = await refreshAndSaveAuthStateFn(config);
        await clearQrReminderScheduleFn(config);
        const authState = refreshResult && refreshResult.authState
          ? refreshResult.authState
          : refreshResult && (refreshResult.accessToken || refreshResult.refreshToken)
            ? refreshResult
            : await readSavedAuthStateFn(config.tokenPath);
        logFn(formatAuthStatusSummary({
          casStatus,
          refreshStatus: 'valid',
          authState,
          nowMs: nowFn(),
        }));
        return { status: 'refresh_ok' };
      } catch (refreshError) {
        if (!isTerminalRefreshAuthFailure(refreshError)) {
          if ([429, 500, 503].includes(Number(refreshError && refreshError.httpStatus))) {
            await markSchoolBackoffFn(config, refreshError, nowFn());
          }
          console.log(`[BBGU] Refresh Token续Access临时失败，本次不安排二维码。原因：${refreshError.message || refreshError}`);
          throw refreshError;
        }
        console.log(`[BBGU] Refresh Token失效，根据最后一枚Access的过期时间安排二维码。原因：${refreshError.message || refreshError}`);
        renewalState = {
          ...(renewalState || {}),
          ...((await markRefreshExpiredFn(config)) || {}),
          casExpired: true,
          refreshExpired: true,
        };
        continue;
      }
    }

    if (plan.action === 'MARK_REFRESH_EXPIRED') {
      renewalState = {
        ...(renewalState || {}),
        ...((await markRefreshExpiredFn(config)) || {}),
        casExpired: true,
        refreshExpired: true,
      };
      continue;
    }

    if (plan.action === 'SCHEDULE_QR') {
      const savedSchedule = await saveQrReminderScheduleFn(
        config,
        computeQrSchedule(accessExpiry.epochSeconds, nowFn())
      );
      renewalState = { ...(renewalState || {}), ...(savedSchedule || {}) };
      continue;
    }

    if (plan.action === 'QR_LOGIN' || plan.action === 'WAIT_QR_DUE') {
      logFn(formatAuthStatusSummary({
        casStatus,
        refreshStatus: 'expired_skipped',
        authState: auth,
        nowMs: nowFn(),
      }));
      return maybeRunScheduledQrFn(config, { nowFn });
    }

    const error = new Error(`Renew决策器返回无法执行的动作：${plan.action}`);
    error.code = 'BBGU_AUTOMATIC_ACTION_INVALID';
    throw error;
  }
}

if (require.main === module) {
  const mode = process.argv[2] || 'run';
  const entry = mode === 'login'
    ? runLogin
    : mode === 'renew'
      ? runRenew
      : run;
  entry().catch((error) => {
    console.error('[BBGU] Script failed:', error && error.stack ? error.stack : util.inspect(error));
    process.exitCode = 1;
  });
}

module.exports = {
  clean,
  buildAuthorizationHeader,
  parseSavedAuthState,
  sanitizeStorageStateForAccessRenewal,
  decodeJwtPayload,
  extractJwtExpiry,
  formatAuthStatusSummary,
  scheduledAutomaticRunsFrom,
  firstUncoveredGradeQuery,
  planRefreshAction,
  planAutomaticAction,
  computeQrSchedule,
  shouldPushQrNow,
  markQrPushed,
  normalizeGradeRows,
  migrateSnapshotGradeKeys,
  diffGrades,
  normalizeSubScoreList,
  mergePersistedSubScores,
  selectRowsForSubScoreFetch,
  enrichRowsWithSubScores,
  processGradeRows,
  fetchBbguSubScores,
  formatGradeNotification,
  formatPushPlusGradeTextContent,
  calculateTermArithmeticAverage,
  renderTerminalQrCode,
  decodeQrPayloadFromPngFile,
  formatQrLoginMessage,
  shouldAbortGithubQrLogin,
  installPageRequestFailureCapture,
  saveLoginTimeoutDiagnostics,
  saveQrElementScreenshot,
  sendPushPlus,
  fetchWithTimeout,
  parseBooleanEnv,
  parsePositiveIntegerEnv,
  buildCasRenewUrl,
  isRecoverableNavigationAbort,
  isAuthExpiredResponse,
  normalizeBbguScoreApiData,
  getConfig,
  isNetworkTransportError,
  isSafeCasFailoverError,
  isSafeApiFailoverError,
  selectStartupProxy,
  saveSelectedProxy,
  recordCurrentProxyFailure,
  withSingleProxyFailover,
  markSchoolBackoff,
  consumeSchoolBackoff,
  readSavedAuthState,
  saveAuthState,
  writeFileAtomic,
  saveBrowserStorageState,
  readQrReminderState,
  saveQrReminderSchedule,
  markCasExpired,
  markRefreshExpired,
  clearQrReminderSchedule,
  clearQrReminderState,
  requestRefreshedAuthState,
  refreshAndSaveAuthState,
  extractWeixinQrInfoFromHtml,
  extractAuthStateFromPage,
  shouldStartQrLogin,
  saveBrowserAuthState,
  finalizeLoginReminderState,
  persistBrowserLoginState,
  validateBrowserHttpResponse,
  handleChromeErrorPage,
  navigateToLoginPage,
  waitForAuthenticationAfterQr,
  waitForAuthState,
  collectLoginQrArtifacts,
  createWeixinQrCapture,
  launchChromium,
  runSilentRenew,
  performSilentRenew,
  maybeRunScheduledQr,
  runRenew,
  recoverDirectApiAfterAuthExpired,
  fetchBbguScoreRows,
  requestWithCurl,
  run,
  runLogin,
};
