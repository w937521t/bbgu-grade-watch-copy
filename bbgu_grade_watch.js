#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');
const util = require('node:util');

const DEFAULT_HOME_URL = 'https://zhjw.bbgu.edu.cn/workspace/home';
const PUSHPLUS_SEND_URL = 'https://www.pushplus.plus/send';
const BBGU_SCORE_API_URL = 'https://zhjw.bbgu.edu.cn/api/sam/score/student/score';
const BBGU_SUBSCORE_API_PATH = '/api/sam/scoreManage/stu-score-form';
const BBGU_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145 Safari/537.36 Edg/145';
const BBGU_OAUTH_CLIENT_ID = 'sam-prd';
const BBGU_OAUTH_CLIENT_SECRET = 'app-a-1234';
const BBGU_REFRESH_TIMEOUT_MS = 15000;
const PUSHPLUS_CONTENT_MAX_CHARS = 19000;
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

function buildAuthorizationHeader(authorization, accessToken) {
  const fullHeader = clean(authorization);
  if (fullHeader) return /^Bearer\s+/i.test(fullHeader) ? fullHeader : `Bearer ${unquoteToken(fullHeader)}`;
  const token = unquoteToken(accessToken);
  return token ? `Bearer ${token}` : '';
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

function parseSavedAccessToken(content) {
  return parseSavedAuthState(content).accessToken;
}

function extractAuthStateFromStorageState(storageState, origin) {
  const selected = ((storageState && storageState.origins) || [])
    .find((item) => item.origin === origin);
  const values = new Map(((selected && selected.localStorage) || [])
    .map((item) => [item.name, item.value]));
  return {
    accessToken: unquoteToken(values.get('cqu_edu_ACCESS_TOKEN') || values.get('cqu_edu_CURRENT_TOKEN') || ''),
    refreshToken: unquoteToken(values.get('cqu_edu_REFRESH_TOKEN') || ''),
  };
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
        hour
      );
      if (epoch >= nowMs) result.push(epoch);
    }
  }
  return result;
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

function summarizeCasCookies(storageState) {
  return ((storageState && storageState.cookies) || [])
    .filter((cookie) => {
      const domain = String(cookie.domain || '').toLowerCase();
      const name = String(cookie.name || '').toLowerCase();
      const bbguDomain = /bbgu\.edu\.cn$/.test(domain.replace(/^\./, ''));
      const authCookie = name === 'session' || /cas|tgc|ticket|authserver/i.test(`${name} ${domain}`);
      return bbguDomain && authCookie;
    })
    .map((cookie) => {
      const epochSeconds = Number(cookie.expires);
      const sessionCookie = !Number.isFinite(epochSeconds) || epochSeconds <= 0;
      return {
        name: cookie.name || '',
        domain: cookie.domain || '',
        path: cookie.path || '',
        epochSeconds: sessionCookie ? null : epochSeconds,
        iso: sessionCookie ? '' : new Date(epochSeconds * 1000).toISOString(),
        text: sessionCookie ? 'Session cookie' : formatEpochSeconds(epochSeconds),
        sessionCookie,
      };
    })
    .sort((a, b) => `${a.domain} ${a.name}`.localeCompare(`${b.domain} ${b.name}`));
}

function formatCasDiagnostics({ before, after, renewResult }) {
  function formatToken(label, tokenExpiry) {
    return `- ${label} access token exp: ${(tokenExpiry && tokenExpiry.text) || '未检测到'}`;
  }

  function formatCookies(label, cookies) {
    if (!cookies || !cookies.length) return [`- ${label} CAS cookies: 未检测到`];
    return [
      `- ${label} CAS cookies:`,
      ...cookies.map((cookie) => `  - ${cookie.name}@${cookie.domain}${cookie.path || ''}: ${cookie.text}`),
    ];
  }

  return [
    '# BBGU CAS 续期诊断',
    '',
    `检查时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
    `Silent renew: ${(renewResult && renewResult.status) || 'unknown'}`,
    '',
    formatToken('renew 前', before && before.tokenExpiry),
    formatToken('renew 后', after && after.tokenExpiry),
    '',
    ...formatCookies('renew 前', before && before.casCookies),
    '',
    ...formatCookies('renew 后', after && after.casCookies),
  ].join('\n');
}

function normalizeGradeRows(rows) {
  const normalized = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const courseCode = firstNonEmpty(row.courseCode, row.code, row.kch, row.KCH, row.courseNo, row.kcdm);
    const courseName = firstNonEmpty(row.courseName, row.name, row.kcmc, row.KCMC, row.course, row['课程名称'], row['课程']);
    const scoreId = firstNonEmpty(row.scoreId, row.score_id, row.id);
    const score = firstNonEmpty(row.scoreShow, row.effectiveScoreShow, row.score, row.effectiveScore, row.grade, row.cj, row.CJ, row.zcj, row.finalScore, row['成绩'], row['总成绩']);
    const credit = firstNonEmpty(row.credit, row.credits, row.courseCredit, row.xf, row.XF, row['学分']);
    const gpa = firstNonEmpty(row.gpa, row.jd, row.JD, row.gradePoint, row['绩点']);
    const term = firstNonEmpty(row.term, row.sessionName, row.semester, row.xq, row.xnxq, row.academicTerm, row['学期'], row['学年学期']);

    if (!courseName && !courseCode) continue;
    if (!score && !credit && !gpa && !term) continue;

    normalized.push({
      key: courseCode ? `${courseCode}::${courseName || courseCode}` : courseName,
      courseName: courseName || courseCode,
      ...(scoreId ? { scoreId } : {}),
      ...(!scoreId && Array.isArray(row.__bbguSourceKeys) ? { sourceKeys: row.__bbguSourceKeys.map(clean).filter(Boolean).sort() } : {}),
      score,
      credit,
      gpa,
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
        gpa: item.gpa,
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
    gpa: row.gpa || '',
    term: row.term || '',
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
  const subScores = Array.isArray(row && row.subScores) ? row.subScores : [];
  if (!subScores.length) return row && row.subScoreFetchError ? '读取失败' : '暂无保存记录';
  return subScores
    .map((item) => {
      const name = clean(item.name) || '未命名项目';
      const score = clean(item.score) || '-';
      const weight = clean(item.weight);
      return `${name}${weight ? `(${weight}%)` : ''} ${score}`;
    })
    .join('；');
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
  const widths = { course: 22, score: 6, credit: 6 };
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
    '本次变化',
    `新增 ${(added || []).length} 门｜变更 ${(changed || []).length} 门｜本学期已出 ${rows.length} 门`,
  ];

  if (average) {
    lines.push(`本学期算术平均分：${average.average.toFixed(2)}（${average.count} 门）`);
  }

  if (added?.length) {
    lines.push('', '新增成绩');
    added.forEach((row, index) => {
      lines.push(`${index + 1}. ${row.courseName || row.key || '未知课程'}`);
      lines.push(`   成绩：${row.score || '-'}｜学分：${row.credit || '-'}｜绩点：${row.gpa || '-'}`);
      lines.push(`   平时分：${formatSubScoreText(row)}`);
    });
  }

  if (changed?.length) {
    lines.push('', '变更成绩');
    changed.forEach((item, index) => {
      const before = item.before || {};
      const after = item.after || {};
      lines.push(`${index + 1}. ${after.courseName || after.key || '未知课程'}`);
      lines.push(`   成绩：${before.score || '空'} -> ${after.score || '空'}｜绩点：${before.gpa || '空'} -> ${after.gpa || '空'}`);
      lines.push(`   平时分：${formatSubScoreText(after)}`);
    });
  }

  lines.push('', '本学期已出成绩');
  lines.push(rows.length ? formatPlainGradeTable(rows) : '暂无已发布成绩');

  lines.push('', '平时分记录');
  const rowsWithSubScores = rows.filter((row) => Array.isArray(row.subScores) && row.subScores.length);
  const rowsWithSubScoreErrors = rows.filter((row) => row.subScoreFetchError && !(Array.isArray(row.subScores) && row.subScores.length));
  if (rowsWithSubScores.length || rowsWithSubScoreErrors.length) {
    for (const row of rowsWithSubScores) {
      lines.push(`- ${row.courseName || row.key || '未知课程'}：${formatSubScoreText(row)}`);
    }
    for (const row of rowsWithSubScoreErrors) {
      lines.push(`- ${row.courseName || row.key || '未知课程'}：读取失败`);
    }
    const emptyCount = rows.length - rowsWithSubScores.length - rowsWithSubScoreErrors.length;
    if (emptyCount > 0) lines.push(`- 其他 ${emptyCount} 门：暂无保存记录`);
  } else {
    lines.push('- 暂无保存记录');
  }

  lines.push('', '说明：均分只计算本学期数字成绩，文字成绩只展示不计入。');

  return lines.join('\n');
}

function truncateTextForPushPlus(rawText, maxChars) {
  const suffix = '\n\n...内容过长，已截断；完整快照：/ql/data/scripts/bbgu_grade_snapshot.json';
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

function formatAuthExpiredMessage({ homeUrl }) {
  return [
    '# BBGU 登录态已过期',
    '',
    `检查时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    '',
    '成绩接口返回登录失效，当前 `BBGU_ACCESS_TOKEN` 已不能继续使用。',
    '',
    `登录地址：${homeUrl}`,
    '',
    '更新方法：',
    '1. 在本机浏览器重新打开教务系统并完成 CAS/微信扫码登录。',
    '2. 打开 DevTools 的 `Application -> Local Storage -> https://zhjw.bbgu.edu.cn`。',
    '3. 复制 `cqu_edu_ACCESS_TOKEN` 的值。',
    '4. 更新青龙环境变量 `BBGU_ACCESS_TOKEN`。',
    '',
    '更新后下一次定时任务会继续检查成绩。',
  ].join('\n');
}

function extractWeixinQrInfoFromHtml(html, responseUrl = '') {
  const text = String(html || '');
  const uuid = clean(
    (text.match(/\/connect\/qrcode\/([A-Za-z0-9_-]+)/) || [])[1]
    || (text.match(/(?:^|[?&\\s;])uuid\s*=\s*([A-Za-z0-9_-]+)/) || [])[1]
  );
  if (!uuid) return null;
  return {
    uuid,
    qrImageUrl: `https://open.weixin.qq.com/connect/qrcode/${uuid}`,
    qrConfirmUrl: buildWeixinQrConfirmUrl(uuid),
  };
}

function buildWeixinQrConfirmUrl(value) {
  const text = clean(value);
  const uuid = clean(
    (text.match(/\/connect\/qrcode\/([A-Za-z0-9_-]+)/) || [])[1]
    || (text.match(/(?:^|[?&])uuid=([A-Za-z0-9_-]+)/) || [])[1]
    || (/^[A-Za-z0-9_-]{8,}$/.test(text) ? text : '')
  );
  return uuid ? `https://open.weixin.qq.com/connect/confirm?uuid=${encodeURIComponent(uuid)}` : '';
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractWeixinQrConnectUrlFromHtml(html) {
  const text = decodeHtmlEntities(html);
  const match = text.match(/https:\/\/open\.weixin\.qq\.com\/connect\/qrconnect[^"'<>\\\s]+/i);
  return match ? clean(match[0]) : '';
}

function isLoginDebugUrl(value) {
  const text = clean(value);
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    const parsed = new URL(text);
    const host = parsed.hostname.toLowerCase();
    const pathAndQuery = `${parsed.pathname}${parsed.search}${parsed.hash}`.toLowerCase();
    const combined = `${host}${pathAndQuery}`;
    if (/weixin|wechat/.test(host)) return true;
    if (/bbgu\.edu\.cn|authserver|cas/.test(host)) {
      return /weixin|wechat|oauth|qrconnect|qrcode|scan|authserver|cas|login|combinedlogin/.test(pathAndQuery);
    }
    return /weixin|wechat|oauth|qrconnect|qrcode/.test(combined);
  } catch {
    return false;
  }
}

function extractLoginDebugUrlsFromHtml(html, baseUrl) {
  const text = decodeHtmlEntities(html);
  const urls = new Set();
  const addUrl = (value) => {
    const candidate = decodeHtmlEntities(value).trim();
    if (!candidate) return;
    try {
      const resolved = new URL(candidate, baseUrl).toString();
      if (isLoginDebugUrl(resolved)) urls.add(resolved);
    } catch {
      // Ignore malformed strings.
    }
  };

  for (const match of text.matchAll(/https?:\/\/[^"'<>\\\s]+/gi)) {
    addUrl(match[0]);
  }
  for (const match of text.matchAll(/\b(?:href|src|action|data-url|data-src|url)\s*=\s*["']([^"']+)["']/gi)) {
    addUrl(match[1]);
  }
  for (const match of text.matchAll(/["'](\/[^"']*(?:weixin|wechat|oauth|qrconnect|qrcode|scan|authserver|cas|login)[^"']*)["']/gi)) {
    addUrl(match[1]);
  }

  return [...urls].sort();
}

function classifyLoginDebugUrls(urls) {
  const unique = [...new Set((urls || []).map((url) => clean(url)).filter(Boolean))].sort();
  const mobileOauthCandidates = [];
  const qrConnectUrls = [];
  const otherLoginUrls = [];

  for (const url of unique) {
    const lower = url.toLowerCase();
    if (lower.includes('/connect/oauth2/authorize')) {
      mobileOauthCandidates.push(url);
    } else if (lower.includes('/connect/qrconnect') || lower.includes('/connect/qrcode/')) {
      qrConnectUrls.push(url);
    } else {
      otherLoginUrls.push(url);
    }
  }

  return { mobileOauthCandidates, qrConnectUrls, otherLoginUrls };
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      ...options.headers,
    },
  });
  const text = await response.text();
  return { url: response.url || url, status: response.status, text };
}

async function fetchWeixinQrInfoFromPage(page) {
  const urls = await page.evaluate(() => {
    const values = [];
    for (const element of Array.from(document.querySelectorAll('iframe[src], a[href]'))) {
      const value = element.src || element.href || '';
      if (/combinedLogin\.do|open\.weixin\.qq\.com\/connect\/qrconnect/i.test(value)) values.push(value);
    }
    return values;
  }).catch(() => []);

  for (const url of urls) {
    try {
      let qrConnectUrl = /^https:\/\/open\.weixin\.qq\.com\/connect\/qrconnect/i.test(url) ? url : '';
      if (!qrConnectUrl && /combinedLogin\.do/i.test(url)) {
        const combined = await page.evaluate(async (targetUrl) => {
          const response = await fetch(targetUrl, { credentials: 'include', redirect: 'follow' });
          return { url: response.url, text: await response.text() };
        }, url).catch(async () => fetchText(url));
        qrConnectUrl = extractWeixinQrConnectUrlFromHtml(combined.text);
        if (!qrConnectUrl && /^https:\/\/open\.weixin\.qq\.com\/connect\/qrconnect/i.test(combined.url)) {
          qrConnectUrl = combined.url;
        }
      }
      if (!qrConnectUrl) continue;

      const qrPage = await fetchText(qrConnectUrl);
      const info = extractWeixinQrInfoFromHtml(qrPage.text, qrConnectUrl);
      if (info) return info;
    } catch {
      // Try the next candidate URL.
    }
  }

  return null;
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
      finish(extractWeixinQrInfoFromHtml(html, url));
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

function isLikelyQrLoginUrl(value) {
  const text = clean(value);
  if (!/^https?:\/\//i.test(text)) return false;

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  const pathAndQuery = `${parsed.pathname}${parsed.search}`.toLowerCase();
  if (host.includes('weixin') || host.includes('wechat')) return true;
  return /(?:^|[/?&=_-])(?:qrcode|qrconnect|scanlogin|scan_login|scanqr|qr_login|qrlogin)(?:$|[/?&=_-])/.test(pathAndQuery);
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
        ? `脚本会等待 ${waitSeconds} 秒。请优先用微信扫描文本二维码；如果不能识别，到青龙文件管理打开上面的截图路径并扫码。`
        : `脚本会等待 ${waitSeconds} 秒。请用微信扫描上方文本二维码。`
      : showScreenshotPath
        ? `脚本会等待 ${waitSeconds} 秒。请立刻到青龙文件管理或服务器路径查看截图并扫码。`
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

function formatNoChangeMessage({ term, count }) {
  return [
    '# BBGU 成绩检查',
    '',
    `检查时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    term ? `学期：${term}` : '',
    `当前识别到成绩条数：${count}`,
    '',
    '本次没有发现新增或变更成绩。',
  ].filter(Boolean).join('\n');
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readQrReminderState(config) {
  if (!config || !config.qrReminderStatePath) return null;
  return readJson(config.qrReminderStatePath, null);
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

async function sendPushPlus({ token, title, content, template = 'markdown' }) {
  const response = await fetch(PUSHPLUS_SEND_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token,
      title,
      content,
      template,
    }),
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  if (!response.ok || (body.code !== undefined && body.code !== 200)) {
    throw new Error(`PushPlus send failed: HTTP ${response.status} ${text}`);
  }

  return body;
}

function getConfig(env = process.env) {
  const dataDir = path.resolve(env.BBGU_DATA_DIR || __dirname);
  return {
    pushplusToken: clean(env.PUSHPLUS_TOKEN),
    homeUrl: clean(env.BBGU_HOME_URL) || DEFAULT_HOME_URL,
    term: clean(env.BBGU_TERM),
    proxyServer: clean(env.BBGU_PROXY_SERVER),
    githubActions: parseBooleanEnv(env.GITHUB_ACTIONS, false),
    dataDir,
    cookie: clean(env.BBGU_COOKIE),
    authorization: buildAuthorizationHeader(env.BBGU_AUTHORIZATION, env.BBGU_ACCESS_TOKEN),
    tokenPath: path.resolve(env.BBGU_TOKEN_PATH || path.join(dataDir, 'bbgu_token.env')),
    storageStatePath: path.join(dataDir, 'bbgu_storage_state.json'),
    snapshotPath: path.join(dataDir, 'bbgu_grade_snapshot.json'),
    authExpiredStatePath: path.join(dataDir, 'bbgu_auth_expired_state.json'),
    qrReminderStatePath: path.join(dataDir, 'bbgu_qr_reminder_state.json'),
    diagnosticDir: path.join(dataDir, 'bbgu_diagnostics'),
    headless: parseBooleanEnv(env.BBGU_HEADLESS, true),
    notifyNoChange: parseBooleanEnv(env.BBGU_NOTIFY_NO_CHANGE, false),
    notifyLoginUpdated: parseBooleanEnv(env.BBGU_NOTIFY_LOGIN_UPDATED, false),
    autoLoginOnExpired: parseBooleanEnv(env.BBGU_AUTO_LOGIN_ON_EXPIRED, true),
    silentRenewOnExpired: parseBooleanEnv(env.BBGU_SILENT_RENEW_ON_EXPIRED, true),
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
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const lines = [
    '# Generated by bbgu_grade_watch.js. Do not share this file.',
    `BBGU_ACCESS_TOKEN=${accessToken}`,
    ...(refreshToken ? [`BBGU_REFRESH_TOKEN=${refreshToken}`] : []),
    '',
  ];
  await fsp.writeFile(filePath, lines.join('\n'), 'utf8');
}

async function readSavedAccessToken(filePath) {
  return (await readSavedAuthState(filePath)).accessToken;
}

async function saveAccessToken(filePath, token) {
  const current = await readSavedAuthState(filePath);
  return saveAuthState(filePath, {
    accessToken: token,
    refreshToken: current.refreshToken,
  });
}

async function readStorageState(filePath) {
  return readJson(filePath, { cookies: [], origins: [] });
}

function requestRefreshWithHttps(url, options) {
  return new Promise((resolve, reject) => {
    const body = options.body || '';
    const request = https.request(url, {
      method: 'POST',
      headers: {
        ...options.headers,
        'content-length': Buffer.byteLength(body),
      },
      timeout: options.timeoutMs,
      family: 4,
      insecureHTTPParser: true,
    }, (response) => {
      const chunks = [];
      response.setEncoding('utf8');
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const status = response.statusCode || 0;
        const text = chunks.join('');
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => text,
        });
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error(`Refresh原生HTTPS请求在${options.timeoutMs}毫秒后超时。`));
    });
    request.on('error', (error) => reject(error));
    request.write(body);
    request.end();
  });
}

async function requestRefreshedAuthState(config, current, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const httpsRequestFn = deps.httpsRequestFn || (!deps.fetchFn ? requestRefreshWithHttps : null);
  const timeoutMs = deps.timeoutMs || BBGU_REFRESH_TIMEOUT_MS;
  if (!current || !current.refreshToken) {
    const error = new Error('No saved BBGU refresh token.');
    error.code = 'BBGU_REFRESH_UNAVAILABLE';
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const origin = new URL((config && config.homeUrl) || DEFAULT_HOME_URL).origin;
    const body = new URLSearchParams({
      client_id: BBGU_OAUTH_CLIENT_ID,
      client_secret: BBGU_OAUTH_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
    }).toString();
    const url = `${origin}/authserver/oauth/token`;
    const options = {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    };
    let response;
    try {
      response = await fetchFn(url, options);
    } catch (error) {
      if (!httpsRequestFn) throw error;
      const cause = error && error.cause ? error.cause : error;
      console.log(`[BBGU] Refresh内置请求失败，改用原生HTTPS。原因：${cause && (cause.code || cause.message)}`);
      response = await httpsRequestFn(url, {
        method: options.method,
        headers: options.headers,
        body,
        timeoutMs,
      });
    }
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!response.ok || !payload || !payload.access_token) {
      const error = new Error(`BBGU refresh failed: HTTP ${response.status}`);
      error.httpStatus = response.status;
      throw error;
    }
    return {
      accessToken: unquoteToken(payload.access_token),
      refreshToken: unquoteToken(payload.refresh_token) || current.refreshToken,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function refreshAndSaveAuthState(config, deps = {}) {
  const readSavedAuthStateFn = deps.readSavedAuthStateFn || readSavedAuthState;
  const readStorageStateFn = deps.readStorageStateFn || readStorageState;
  const saveAuthStateFn = deps.saveAuthStateFn || saveAuthState;
  const requestFn = deps.requestFn || requestRefreshedAuthState;
  let current = await readSavedAuthStateFn(config.tokenPath);

  if (!current.refreshToken) {
    const storage = await readStorageStateFn(config.storageStatePath);
    const migrated = extractAuthStateFromStorageState(storage, getBbguOrigin(config));
    current = {
      accessToken: current.accessToken || migrated.accessToken,
      refreshToken: migrated.refreshToken,
    };
    if (current.accessToken && current.refreshToken) {
      await saveAuthStateFn(config.tokenPath, current);
    }
  }

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const refreshed = await requestFn(config, current, deps);
      await saveAuthStateFn(config.tokenPath, refreshed);
      config.authorization = buildAuthorizationHeader('', refreshed.accessToken);
      return { status: 'refresh_ok', authState: refreshed };
    } catch (error) {
      lastError = error;
      const retryable = !error.httpStatus || error.httpStatus >= 500;
      if (!retryable || attempt === 2 || error.code === 'BBGU_REFRESH_UNAVAILABLE') break;
      console.log(`[BBGU] Refresh request failed; retrying once. reason=${error.message || error}`);
    }
  }
  throw lastError;
}

async function collectCasDiagnosticSnapshot(config) {
  const [token, storageState] = await Promise.all([
    readSavedAccessToken(config.tokenPath),
    readStorageState(config.storageStatePath),
  ]);
  return {
    tokenExpiry: extractJwtExpiry(token),
    casCookies: summarizeCasCookies(storageState),
  };
}

function isAuthExpiredResponse({ httpStatus, text, body }) {
  if (httpStatus === 401 || httpStatus === 403) return true;
  if (/统一身份认证|扫码登录|cas|login/i.test(text || '')) return true;
  if (!body || typeof body !== 'object') return false;
  const status = clean(body.status).toLowerCase();
  const msg = clean(body.msg || body.message || body.error);
  if (status && status !== 'success') {
    return /token|auth|login|登录|认证|过期|失效|未授权|unauthorized|expired/i.test(`${status} ${msg}`);
  }
  if (body.ok === false) {
    return /token|auth|login|登录|认证|过期|失效|未授权|unauthorized|expired/i.test(msg) || httpStatus !== 200;
  }
  return false;
}

async function notifyAuthExpiredOnce(config, reason) {
  const previous = await readJson(config.authExpiredStatePath, null);
  if (previous && previous.active) {
    console.log(`[BBGU] Auth expired notification already sent at ${previous.notifiedAt}. reason=${reason}`);
    return;
  }

  await sendPushPlus({
    token: config.pushplusToken,
    title: 'BBGU 登录态已过期',
    content: formatAuthExpiredMessage({ homeUrl: config.homeUrl }),
  });
  await writeJson(config.authExpiredStatePath, {
    active: true,
    notifiedAt: new Date().toISOString(),
    reason,
  });
  console.log('[BBGU] Auth expired notification sent.');
}

async function clearAuthExpiredState(config) {
  const previous = await readJson(config.authExpiredStatePath, null);
  if (previous && previous.active) {
    await writeJson(config.authExpiredStatePath, {
      active: false,
      clearedAt: new Date().toISOString(),
    });
    console.log('[BBGU] Auth expired state cleared.');
  }
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
  if (config.cookie) headers.cookie = config.cookie;
  return headers;
}

async function fetchBbguScoreRowsWithCookie(config) {
  const response = await requestJsonText(BBGU_SCORE_API_URL, buildBbguApiHeaders(config));

  const text = response.text;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    if (isAuthExpiredResponse({ httpStatus: response.status, text, body: null })) {
      if (!config.autoLoginOnExpired) {
        await notifyAuthExpiredOnce(config, `HTTP ${response.status} non-json auth page`);
      }
      const error = new Error('BBGU login state expired. Update BBGU_ACCESS_TOKEN in QingLong.');
      error.code = 'BBGU_AUTH_EXPIRED';
      throw error;
    }
    throw new Error(`BBGU score API returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  if (isAuthExpiredResponse({ httpStatus: response.status, text, body })) {
    if (!config.autoLoginOnExpired) {
      await notifyAuthExpiredOnce(config, `HTTP ${response.status} ${body.status || ''} ${body.msg || ''}`);
    }
    const error = new Error('BBGU login state expired. Update BBGU_ACCESS_TOKEN in QingLong.');
    error.code = 'BBGU_AUTH_EXPIRED';
    throw error;
  }

  if (response.status < 200 || response.status >= 300 || body.status !== 'success' || !body.ok) {
    throw new Error(`BBGU score API failed HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  await clearAuthExpiredState(config);
  return normalizeBbguScoreApiData(body.data, config.term);
}

async function fetchBbguSubScores(scoreId, config) {
  const origin = getBbguOrigin(config);
  const url = `${origin}${BBGU_SUBSCORE_API_PATH}?scoreId=${encodeURIComponent(scoreId)}`;
  const response = await requestJsonText(url, buildBbguApiHeaders(config, '/sam/home'));
  let body;
  try {
    body = JSON.parse(response.text);
  } catch {
    throw new Error(`BBGU subscore API returned non-JSON HTTP ${response.status}: ${response.text.slice(0, 300)}`);
  }

  if (isAuthExpiredResponse({ httpStatus: response.status, text: response.text, body })) {
    const error = new Error('BBGU login state expired while fetching subscore.');
    error.code = 'BBGU_AUTH_EXPIRED';
    throw error;
  }

  if (response.status < 200 || response.status >= 300 || body.status !== 'success') {
    throw new Error(`BBGU subscore API failed HTTP ${response.status}: ${response.text.slice(0, 500)}`);
  }

  return normalizeSubScoreList(body);
}

async function enrichRowsWithSubScores(diff, config, fetcher = fetchBbguSubScores) {
  const rowsToFetch = selectRowsForSubScoreFetch(diff);
  const rowsMissingScoreId = selectRowsMissingSubScoreIdForSubScoreFetch(diff);
  for (const row of rowsMissingScoreId) {
    console.log(`[BBGU] Subscore skipped for ${row.courseName || row.key || 'unknown course'}: missing scoreId. fields=${formatSubScoreSourceKeys(row) || 'unknown'}`);
  }
  if (!rowsToFetch.length) return { fetched: 0, failed: 0 };

  let fetched = 0;
  let failed = 0;
  for (const row of rowsToFetch) {
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
    }
  }

  return { fetched, failed };
}

async function requestJsonText(url, headers, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const httpsRequestFn = deps.httpsRequestFn || requestJsonTextWithHttps;
  const proxyHttpsRequestFn = deps.proxyHttpsRequestFn || requestJsonTextWithHttpsProxy;
  const proxyServer = clean(deps.proxyServer || process.env.BBGU_PROXY_SERVER || '');
  try {
    const response = await fetchFn(url, { method: 'GET', headers });
    return {
      status: response.status,
      text: await response.text(),
      via: 'fetch',
    };
  } catch (error) {
    const cause = error && error.cause ? error.cause : error;
    if (process.env.GITHUB_ACTIONS || process.env.BBGU_PROXY_SERVER) {
      if (proxyServer && isHttpParserFetchFailure(error)) {
        console.log(`[BBGU] fetch failed in proxy mode due to strict HTTP parsing; retrying through proxy with native https. reason=${cause && (cause.code || cause.message)}`);
        return proxyHttpsRequestFn(url, headers, proxyServer);
      }
      console.log(`[BBGU] fetch failed in proxy mode; native https fallback disabled. reason=${cause && (cause.code || cause.message)}`);
      throw error;
    }
    console.log(`[BBGU] fetch failed, retrying with native https. reason=${cause && (cause.code || cause.message)}`);
    return httpsRequestFn(url, headers);
  }
}

function isHttpParserFetchFailure(error) {
  const messages = [];
  let current = error;
  while (current) {
    if (current.code) messages.push(String(current.code));
    if (current.message) messages.push(String(current.message));
    current = current.cause;
  }
  return /HTTP\/1\.1 protocol|Missing expected CR after header value|HPE_/i.test(messages.join('\n'));
}

function requestJsonTextWithHttps(url, headers) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET',
      headers,
      timeout: 30000,
      family: 4,
      insecureHTTPParser: true,
    }, (response) => {
      const chunks = [];
      response.setEncoding('utf8');
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode || 0,
          text: chunks.join(''),
          via: 'https',
        });
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('HTTPS request timeout after 30000ms'));
    });
    request.on('error', (error) => {
      const message = error && error.code ? `${error.code}: ${error.message}` : String(error && error.message ? error.message : error);
      reject(new Error(`BBGU score API network error: ${message}`));
    });
    request.end();
  });
}

function requestJsonTextWithHttpsProxy(url, headers, proxyServer) {
  const target = new URL(url);
  const proxy = new URL(proxyServer);
  if (target.protocol !== 'https:') {
    return Promise.reject(new Error(`Proxy HTTPS fallback only supports https URLs: ${target.protocol}`));
  }
  if (proxy.protocol !== 'http:') {
    return Promise.reject(new Error(`Proxy HTTPS fallback only supports http proxy URLs: ${proxy.protocol}`));
  }

  return new Promise((resolve, reject) => {
    const proxyPort = Number(proxy.port || 80);
    const targetPort = Number(target.port || 443);
    const targetHostPort = `${target.hostname}:${targetPort}`;
    const proxyHost = proxy.hostname;
    const proxyHeaders = [
      `CONNECT ${targetHostPort} HTTP/1.1`,
      `Host: ${targetHostPort}`,
      'Proxy-Connection: keep-alive',
    ];
    if (proxy.username || proxy.password) {
      const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
      proxyHeaders.push(`Proxy-Authorization: Basic ${auth}`);
    }

    let settled = false;
    let socket;
    let connectBuffer = Buffer.alloc(0);
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      if (socket) socket.destroy();
      reject(error);
    };

    socket = net.connect({ host: proxyHost, port: proxyPort }, () => {
      socket.write(`${proxyHeaders.join('\r\n')}\r\n\r\n`);
    });
    socket.setTimeout(30000, () => {
      finishReject(new Error('Proxy CONNECT timeout after 30000ms'));
    });
    socket.on('error', (error) => {
      finishReject(error);
    });
    socket.on('data', function onConnectData(chunk) {
      connectBuffer = Buffer.concat([connectBuffer, chunk]);
      const headerEnd = connectBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      socket.off('data', onConnectData);
      const headerText = connectBuffer.slice(0, headerEnd).toString('latin1');
      const leftover = connectBuffer.slice(headerEnd + 4);
      const statusMatch = headerText.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i);
      const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
      if (statusCode !== 200) {
        finishReject(new Error(`Proxy CONNECT failed with status ${statusCode || 'unknown'}`));
        return;
      }
      if (leftover.length) socket.unshift(leftover);

      const secureSocket = tls.connect({
        socket,
        servername: target.hostname,
        ALPNProtocols: ['http/1.1'],
      }, () => {
        const request = https.request({
          protocol: 'https:',
          hostname: target.hostname,
          port: targetPort,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers,
          timeout: 30000,
          agent: false,
          createConnection: () => secureSocket,
          insecureHTTPParser: true,
        }, (response) => {
          const chunks = [];
          response.setEncoding('utf8');
          response.on('data', (responseChunk) => chunks.push(responseChunk));
          response.on('end', () => {
            if (settled) return;
            settled = true;
            resolve({
              status: response.statusCode || 0,
              text: chunks.join(''),
              via: 'proxy-https',
            });
          });
        });

        request.on('timeout', () => {
          request.destroy(new Error('Proxy HTTPS request timeout after 30000ms'));
        });
        request.on('error', (error) => {
          finishReject(error);
        });
        request.end();
      });
      secureSocket.on('error', (error) => {
        finishReject(error);
      });
    });
  });
}

async function processGradeRows(currentRows, config) {
  if (!currentRows.length) {
    throw new Error('No grade rows were extracted from BBGU score API/page.');
  }

  const previousRows = await readJson(config.snapshotPath, []);
  const rowsWithSavedSubScores = mergePersistedSubScores(previousRows, currentRows);
  const diff = diffGrades(previousRows, rowsWithSavedSubScores);

  if (diff.added.length || diff.changed.length) {
    await enrichRowsWithSubScores(diff, config);
    await sendPushPlus({
      token: config.pushplusToken,
      title: `BBGU 成绩更新：新增 ${diff.added.length}，变更 ${diff.changed.length}`,
      content: formatPushPlusGradeTextContent({ term: config.term, added: diff.added, changed: diff.changed, currentRows: rowsWithSavedSubScores }),
    });
    console.log(`[BBGU] Grade changes sent. added=${diff.added.length}, changed=${diff.changed.length}`);
  } else if (config.notifyNoChange) {
    await sendPushPlus({
      token: config.pushplusToken,
      title: 'BBGU 成绩检查：无变化',
      content: formatNoChangeMessage({ term: config.term, count: rowsWithSavedSubScores.length }),
    });
    console.log(`[BBGU] No changes. count=${rowsWithSavedSubScores.length}`);
  } else {
    console.log(`[BBGU] No grade changes. count=${rowsWithSavedSubScores.length}`);
  }

  await writeJson(config.snapshotPath, rowsWithSavedSubScores);
  console.log(`[BBGU] Snapshot saved: ${config.snapshotPath}`);
  return { status: 'ok', count: rowsWithSavedSubScores.length, ...diff };
}

function looksLikeLoginPage(url, text) {
  const lowerUrl = String(url || '').toLowerCase();
  if (lowerUrl.includes('/cas/') || lowerUrl.includes('login')) return true;
  return /统一身份认证|扫码登录|微信扫码|二维码|cas/i.test(text || '');
}

async function isAuthenticated(page) {
  const text = clean(await page.locator('body').innerText({ timeout: 5000 }).catch(() => ''));
  if (/成绩查询|我的课表|我的考试|我的课程|学籍信息/.test(text)) return true;
  if (looksLikeLoginPage(page.url(), text)) return false;
  return false;
}

async function createContext(browser, config) {
  const options = {
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  };

  if (fs.existsSync(config.storageStatePath)) {
    options.storageState = config.storageStatePath;
  }

  return browser.newContext(options);
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

async function collectLoginDebugInfo(page) {
  const frames = typeof page.frames === 'function' ? page.frames() : [page];
  const frameReports = [];
  const allUrls = new Set();

  for (const frame of frames) {
    const frameUrl = typeof frame.url === 'function' ? frame.url() : '';
    let title = '';
    let html = '';
    let text = '';

    try {
      title = clean(await frame.evaluate(() => document.title));
    } catch {
      title = '';
    }
    try {
      html = typeof frame.content === 'function' ? await frame.content() : '';
    } catch {
      html = '';
    }
    try {
      text = clean(await frame.locator('body').innerText({ timeout: 2000 }));
    } catch {
      text = '';
    }

    const urls = extractLoginDebugUrlsFromHtml(html, frameUrl || configSafeBaseUrl(page));
    for (const url of urls) allUrls.add(url);
    if (frameUrl && isLoginDebugUrl(frameUrl)) allUrls.add(frameUrl);

    frameReports.push({
      url: frameUrl,
      title,
      textPreview: text.slice(0, 1000),
      urls,
    });
  }

  const urls = [...allUrls].sort();
  return {
    createdAt: new Date().toISOString(),
    pageUrl: typeof page.url === 'function' ? page.url() : '',
    urls,
    classified: classifyLoginDebugUrls(urls),
    frames: frameReports,
  };
}

function configSafeBaseUrl(page) {
  try {
    return typeof page.url === 'function' ? page.url() : DEFAULT_HOME_URL;
  } catch {
    return DEFAULT_HOME_URL;
  }
}

async function saveLoginDebugReport(page, config) {
  await fsp.mkdir(config.diagnosticDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshotPath = await saveScreenshot(page, config, 'login-debug');
  const reportPath = path.join(config.diagnosticDir, `${timestamp}-login-debug.json`);
  const report = await collectLoginDebugInfo(page);
  report.screenshotPath = screenshotPath;
  await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { reportPath, screenshotPath, report };
}

async function waitForAuthenticationAfterQr(page, config) {
  const deadline = Date.now() + config.loginWaitSeconds * 1000;
  console.log(`[BBGU] Waiting up to ${config.loginWaitSeconds}s for QR login...`);

  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    if (await isAuthenticated(page)) return true;
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

async function extractAccessTokenFromPage(page) {
  return (await extractAuthStateFromPage(page)).accessToken;
}

async function waitForAuthState(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = emptyAuthState();
  while (Date.now() < deadline) {
    latest = await extractAuthStateFromPage(page);
    if (latest.accessToken && latest.refreshToken) return latest;
    await page.waitForTimeout(2000);
  }
  return latest;
}

async function saveBrowserAuthState(page, config, deps = {}) {
  const waitForAuthStateFn = deps.waitForAuthStateFn || waitForAuthState;
  const saveAuthStateFn = deps.saveAuthStateFn || saveAuthState;
  const authState = await waitForAuthStateFn(page, 30000);
  if (!authState.accessToken) {
    throw new Error('Login succeeded but cqu_edu_ACCESS_TOKEN was not found in localStorage.');
  }
  await saveAuthStateFn(config.tokenPath, authState);
  if (!authState.refreshToken) {
    console.log('[BBGU] Warning: login succeeded without a refresh token; next recovery will use CAS.');
  }
  return authState;
}

async function waitForAccessToken(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const token = await extractAccessTokenFromPage(page);
    if (token) return token;
    await page.waitForTimeout(2000);
  }
  return '';
}

function selectChromiumExecutable({ configured, osRelease, homeDir, exists, readdir }) {
  const configuredPath = clean(configured);
  if (configuredPath && exists(configuredPath)) return configuredPath;

  const systemCandidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  if (/ID=alpine|Alpine Linux/i.test(osRelease || '')) {
    const systemMatch = systemCandidates.find((candidate) => exists(candidate));
    if (systemMatch) return systemMatch;
  }

  const roots = [
    '/root/.cache/ms-playwright',
    path.join(homeDir || '', '.cache', 'ms-playwright'),
  ].filter(Boolean);

  const candidates = [];
  for (const root of roots) {
    if (!exists(root)) continue;
    for (const entry of readdir(root)) {
      if (!entry.startsWith('chromium-')) continue;
      candidates.push(path.join(root, entry, 'chrome-linux', 'chrome'));
    }
  }

  const playwrightMatch = candidates.find((candidate) => exists(candidate));
  if (playwrightMatch) return playwrightMatch;

  return systemCandidates.find((candidate) => exists(candidate)) || '';
}

function findChromiumExecutable() {
  let osRelease = '';
  try {
    osRelease = fs.readFileSync('/etc/os-release', 'utf8');
  } catch {
    osRelease = '';
  }
  return selectChromiumExecutable({
    configured: process.env.BBGU_CHROMIUM_EXECUTABLE,
    osRelease,
    homeDir: process.env.HOME || '',
    exists: (filePath) => fs.existsSync(filePath),
    readdir: (dirPath) => fs.readdirSync(dirPath),
  });
}

async function launchChromium(chromium, config) {
  const launchOptions = {
    headless: config.headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(config.proxyServer ? { proxy: { server: config.proxyServer } } : {}),
  };

  try {
    return await chromium.launch(launchOptions);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (!/headless_shell|ENOENT|executable/i.test(message)) throw error;

    const executablePath = findChromiumExecutable();
    if (!executablePath) throw error;

    console.log(`[BBGU] Default Chromium launch failed; retrying with executablePath=${executablePath}`);
    return chromium.launch({
      ...launchOptions,
      executablePath,
    });
  }
}

async function clearBrowserAccessTokens(page) {
  await page.evaluate(() => {
    [
      'cqu_edu_ACCESS_TOKEN',
      'cqu_edu_REFRESH_TOKEN',
      'cqu_edu_TOKEN_EXPIRE',
      'cqu_edu_CURRENT_TOKEN',
      'cqu_edu_EXPIRE_ACCESS_TOKEN',
    ].forEach((key) => localStorage.removeItem(key));
  }).catch(() => undefined);
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

async function runSilentRenew(config = getConfig()) {
  return withBrowserContext(config, createContext, async (context) => {
    const page = await context.newPage();
    const origin = new URL(config.homeUrl).origin;

    await page.goto(`${origin}/sam/home`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
    await clearBrowserAccessTokens(page);

    const renewUrl = buildCasRenewUrl(config);
    console.log(`[BBGU] Opening ${renewUrl} for silent CAS renew.`);
    try {
      await page.goto(renewUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    } catch (error) {
      if (!isRecoverableNavigationAbort(error)) throw error;
      console.log(`[BBGU] Silent CAS renew navigation was aborted by redirect; continuing token check. url=${page.url()}`);
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    }
    await page.waitForTimeout(3000);

    try {
      await saveBrowserAuthState(page, config);
    } catch (error) {
      const screenshotPath = await saveScreenshot(page, config, 'silent-renew-failed');
      throw new Error(`Silent CAS renew did not obtain complete browser auth state. url=${page.url()}; screenshot=${screenshotPath}; reason=${error.message || error}`);
    }

    await context.storageState({ path: config.storageStatePath });
    await clearAuthExpiredState(config);
    console.log(`[BBGU] Silent CAS renew completed. Access token saved: ${config.tokenPath}`);
    console.log(`[BBGU] Storage state saved: ${config.storageStatePath}`);
    return { status: 'renew_ok', tokenPath: config.tokenPath };
  });
}

async function recoverDirectApiAfterAuthExpired(config, deps = {}) {
  const {
    nowFn = Date.now,
    refreshAndSaveAuthStateFn = refreshAndSaveAuthState,
    runSilentRenewFn = runSilentRenew,
    runLoginFn = runLogin,
    readQrReminderStateFn = readQrReminderState,
    readSavedAuthStateFn = readSavedAuthState,
    saveQrReminderScheduleFn = saveQrReminderSchedule,
    clearQrReminderScheduleFn = clearQrReminderSchedule,
    maybeRunScheduledQrFn = maybeRunScheduledQr,
    readSavedAccessTokenFn = readSavedAccessToken,
    fetchScoreRowsFn = fetchBbguScoreRowsWithCookie,
  } = deps;

  try {
    console.log('[BBGU] Access token expired; trying refresh token first.');
    await refreshAndSaveAuthStateFn(config);
    await clearQrReminderScheduleFn(config);
    console.log('[BBGU] Refresh token renewal completed; retrying score API.');
    return fetchScoreRowsFn(config);
  } catch (error) {
    console.log(`[BBGU] Refresh Token续Access失败。原因：${error.message || error}`);
  }

  let renewalState = await readQrReminderStateFn(config);
  if (renewalState && (renewalState.casExpired || Number.isFinite(renewalState.dueAt))) {
    if (!Number.isFinite(renewalState.dueAt)) {
      const auth = await readSavedAuthStateFn(config.tokenPath);
      const expiry = extractJwtExpiry(auth.accessToken);
      if (!expiry) throw new Error('保存的Access Token没有过期时间，无法安排二维码。');
      renewalState = await saveQrReminderScheduleFn(
        config,
        computeQrSchedule(expiry.epochSeconds, nowFn())
      );
    }
    const qrResult = await maybeRunScheduledQrFn(config, { nowFn, runLoginFn });
    if (!qrResult || qrResult.status !== 'login_ok') {
      throw new Error('二维码提醒仍在冷却期，本次成绩查询无法登录。');
    }
    const savedToken = await readSavedAccessTokenFn(config.tokenPath);
    if (!savedToken) throw new Error(`扫码登录完成，但没有在 ${config.tokenPath} 保存Access Token。`);
    config.authorization = buildAuthorizationHeader('', savedToken);
    return fetchScoreRowsFn(config);
  }

  if (config.silentRenewOnExpired) {
    try {
      console.log('[BBGU] Refresh不可用，尝试CAS静默续期。');
      await runSilentRenewFn(config);
      const savedToken = await readSavedAccessTokenFn(config.tokenPath);
      if (!savedToken) {
        throw new Error(`Silent CAS renew completed but no token was saved at ${config.tokenPath}.`);
      }
      config.authorization = buildAuthorizationHeader('', savedToken);
      console.log('[BBGU] Silent CAS renewal completed; retrying score API.');
      return fetchScoreRowsFn(config);
    } catch (error) {
      console.log(`[BBGU] Silent CAS renewal failed; falling back to QR login. reason=${error.message || error}`);
    }
  }

  console.log('[BBGU] Starting automatic QR login renewal.');
  await runLoginFn(config, { ignoreInitialAccessToken: true });
  const savedToken = await readSavedAccessTokenFn(config.tokenPath);
  if (!savedToken) {
    throw new Error(`Automatic login completed but no token was saved at ${config.tokenPath}.`);
  }
  config.authorization = buildAuthorizationHeader('', savedToken);
  console.log('[BBGU] Automatic login renewal completed; retrying score API.');
  return fetchScoreRowsFn(config);
}

async function run(config = getConfig(), deps = {}) {
  const {
    readSavedAccessTokenFn = readSavedAccessToken,
    fetchScoreRowsFn = fetchBbguScoreRowsWithCookie,
    recoverDirectApiAfterAuthExpiredFn = recoverDirectApiAfterAuthExpired,
    processGradeRowsFn = processGradeRows,
    maybeRunScheduledQrFn = maybeRunScheduledQr,
  } = deps;

  if (!config.pushplusToken) {
    throw new Error('Missing PUSHPLUS_TOKEN. Set it in QingLong environment variables.');
  }

  if (!config.authorization) {
    const savedToken = await readSavedAccessTokenFn(config.tokenPath);
    if (savedToken) {
      config.authorization = buildAuthorizationHeader('', savedToken);
      console.log(`[BBGU] Loaded saved access token from ${config.tokenPath}`);
    }
  }

  const finishGradeRun = async (rows) => {
    const result = await processGradeRowsFn(rows, config);
    await maybeRunScheduledQrFn(config);
    return result;
  };

  if (config.authorization || config.cookie) {
    console.log(`[BBGU] Using direct score API mode with ${config.authorization ? 'BBGU_AUTHORIZATION/BBGU_ACCESS_TOKEN' : 'BBGU_COOKIE'}.`);
    let currentRows;
    try {
      currentRows = await fetchScoreRowsFn(config);
    } catch (error) {
      if (error && error.code === 'BBGU_AUTH_EXPIRED' && config.autoLoginOnExpired) {
        currentRows = await recoverDirectApiAfterAuthExpiredFn(config, { fetchScoreRowsFn });
      } else {
        throw error;
      }
    }
    return finishGradeRun(currentRows);
  }

  if (!config.autoLoginOnExpired) {
    throw new Error(`No BBGU direct API login state found. Set BBGU_ACCESS_TOKEN/BBGU_COOKIE or enable BBGU_AUTO_LOGIN_ON_EXPIRED and run again.`);
  }

  console.log('[BBGU] No saved direct API token found; starting automatic QR login renewal.');
  const currentRows = await recoverDirectApiAfterAuthExpiredFn(config, { fetchScoreRowsFn });
  return finishGradeRun(currentRows);
}

async function runLogin(config = getConfig(), options = {}) {
  if (!config.pushplusToken) {
    throw new Error('Missing PUSHPLUS_TOKEN. Set it in QingLong environment variables.');
  }

  return withBrowserContext(config, createContext, async (context) => {
    const page = await context.newPage();
    installPageRequestFailureCapture(page);
    const weixinQrCapture = createWeixinQrCapture(page);
    const ignoreInitialAccessToken = Boolean(options.ignoreInitialAccessToken);
    if (ignoreInitialAccessToken) {
      const origin = new URL(config.homeUrl).origin;
      await page.goto(`${origin}/sam/home`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
      await clearBrowserAccessTokens(page);
      console.log('[BBGU] Cleared saved browser access token before login fallback.');
    }
    console.log(`[BBGU] Opening ${config.homeUrl} for login.`);
    await navigateToLoginPage(page, config.homeUrl);
    await page.waitForTimeout(3000);
    if (/^chrome-error:\/\//i.test(page.url())) {
      const diagnostic = await saveLoginTimeoutDiagnostics(page, config);
      throw new Error(`BBGU login page failed to load in Chromium. Diagnostic report: ${diagnostic.reportPath}; screenshot: ${diagnostic.screenshotPath}`);
    }

    let token = ignoreInitialAccessToken ? '' : await extractAccessTokenFromPage(page);
    if (!token && !(await isAuthenticated(page))) {
      const pageScreenshotPath = await saveScreenshot(page, config, 'qr-login');
      const weixinQrInfo = await weixinQrCapture.wait(5000) || await fetchWeixinQrInfoFromPage(page);
      const qrImageUrl = weixinQrInfo?.qrImageUrl || '';
      const qrElementScreenshotPath = await saveQrElementScreenshot(page, config);
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
      console.log(`[BBGU] QR login screenshot saved: ${screenshotPath}`);
      const loggedIn = await waitForAuthenticationAfterQr(page, config);
      if (!loggedIn) {
        const diagnostic = await saveLoginTimeoutDiagnostics(page, config);
        throw new Error(`QR login timed out after ${config.loginWaitSeconds}s. Diagnostic report: ${diagnostic.reportPath}; screenshot: ${diagnostic.screenshotPath}`);
      }
    }

    weixinQrCapture.stop();
    await saveBrowserAuthState(page, config);
    await context.storageState({ path: config.storageStatePath });
    await clearAuthExpiredState(config);
    await clearQrReminderState(config);
    if (config.notifyLoginUpdated) {
      await sendPushPlus({
        token: config.pushplusToken,
        title: 'BBGU 登录态已更新',
        content: [
          '# BBGU 登录态已更新',
          '',
          `Token 已保存到：\`${config.tokenPath}\``,
          '',
          '后续成绩监控任务会自动读取这个 token。',
        ].join('\n'),
      });
    }
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
    clearQrReminderScheduleFn = clearQrReminderSchedule,
    clearQrReminderStateFn = clearQrReminderState,
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
  if (!config.autoLoginOnExpired) return { status: 'qr_pending', ...state };
  await saveQrReminderScheduleFn(config, { ...state, lastPushedAt: nowMs });
  const result = await runLoginFn(config, { ignoreInitialAccessToken: true });
  await clearQrReminderStateFn(config);
  return result;
}

async function navigateToLoginPage(page, homeUrl) {
  return page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
}

async function runRenew(config = getConfig(), deps = {}) {
  const {
    nowFn = Date.now,
    logFn = console.log,
    readQrReminderStateFn = readQrReminderState,
    runSilentRenewFn = runSilentRenew,
    markCasExpiredFn = markCasExpired,
    refreshAndSaveAuthStateFn = refreshAndSaveAuthState,
    readSavedAuthStateFn = readSavedAuthState,
    saveQrReminderScheduleFn = saveQrReminderSchedule,
    clearQrReminderScheduleFn = clearQrReminderSchedule,
    clearQrReminderStateFn = clearQrReminderState,
    maybeRunScheduledQrFn = maybeRunScheduledQr,
  } = deps;

  const renewalState = await readQrReminderStateFn(config);
  let casStatus = renewalState && renewalState.casExpired ? 'expired_skipped' : 'unchecked';
  if (!renewalState || !renewalState.casExpired) {
    try {
      const result = await runSilentRenewFn(config);
      await clearQrReminderStateFn(config);
      const authState = await readSavedAuthStateFn(config.tokenPath);
      logFn(formatAuthStatusSummary({
        casStatus: 'valid',
        refreshStatus: 'unchecked',
        authState,
        nowMs: nowFn(),
      }));
      return result;
    } catch (casError) {
      await markCasExpiredFn(config);
      casStatus = 'expired';
      console.log(`[BBGU] CAS静默续期失败，后续改用Refresh Token续Access。原因：${casError.message || casError}`);
    }
  }

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
    console.log(`[BBGU] Refresh Token失效，根据最后一枚Access的过期时间安排二维码。原因：${refreshError.message || refreshError}`);
  }

  const auth = await readSavedAuthStateFn(config.tokenPath);
  logFn(formatAuthStatusSummary({
    casStatus,
    refreshStatus: 'expired',
    authState: auth,
    nowMs: nowFn(),
  }));
  const expiry = extractJwtExpiry(auth.accessToken);
  if (!expiry) throw new Error('保存的Access Token没有过期时间，无法安排二维码。');
  const schedule = computeQrSchedule(expiry.epochSeconds, nowFn());
  await saveQrReminderScheduleFn(config, schedule);
  return maybeRunScheduledQrFn(config, { nowFn });
}

async function runCasDiagnose(config = getConfig()) {
  const before = await collectCasDiagnosticSnapshot(config);
  let renewResult;
  try {
    renewResult = await runSilentRenew(config);
  } catch (error) {
    renewResult = { status: 'renew_failed', error: error && error.message ? error.message : String(error) };
  }
  const after = await collectCasDiagnosticSnapshot(config);
  console.log(formatCasDiagnostics({ before, after, renewResult }));
  if (renewResult.status === 'renew_failed') {
    console.log(`\nSilent renew error: ${renewResult.error}`);
  }
  return { status: 'cas_diagnose_ok', before, after, renewResult };
}

async function runLoginDebug(config = getConfig()) {
  const createDebugContext = (browser) => browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });

  return withBrowserContext(config, createDebugContext, async (context) => {
    const page = await context.newPage();
    console.log(`[BBGU] Opening ${config.homeUrl} for login debug without saved storage state.`);
    await navigateToLoginPage(page, config.homeUrl);
    await page.waitForTimeout(5000);

    const diagnostic = await saveLoginDebugReport(page, config);
    const classified = diagnostic.report.classified;
    console.log(`[BBGU] Login debug report saved: ${diagnostic.reportPath}`);
    console.log(`[BBGU] Login debug screenshot saved: ${diagnostic.screenshotPath}`);
    console.log(`[BBGU] mobile OAuth candidates: ${classified.mobileOauthCandidates.length}`);
    for (const url of classified.mobileOauthCandidates) {
      console.log(`[BBGU] MOBILE_OAUTH ${url}`);
    }
    console.log(`[BBGU] QRConnect URLs: ${classified.qrConnectUrls.length}`);
    for (const url of classified.qrConnectUrls.slice(0, 5)) {
      console.log(`[BBGU] QRCONNECT ${url}`);
    }
    console.log(`[BBGU] other login URLs: ${classified.otherLoginUrls.length}`);
    return { status: 'login_debug_ok', reportPath: diagnostic.reportPath, screenshotPath: diagnostic.screenshotPath };
  });
}

if (require.main === module) {
  const mode = process.argv[2] || 'run';
  const entry = mode === 'login'
    ? runLogin
    : mode === 'login-debug'
      ? runLoginDebug
      : mode === 'renew'
        ? runRenew
        : mode === 'cas-diagnose'
          ? runCasDiagnose
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
  parseSavedAccessToken,
  extractAuthStateFromStorageState,
  decodeJwtPayload,
  extractJwtExpiry,
  formatAuthStatusSummary,
  computeQrSchedule,
  shouldPushQrNow,
  summarizeCasCookies,
  formatCasDiagnostics,
  normalizeGradeRows,
  diffGrades,
  normalizeSubScoreList,
  mergePersistedSubScores,
  selectRowsForSubScoreFetch,
  enrichRowsWithSubScores,
  fetchBbguSubScores,
  formatGradeNotification,
  formatPushPlusGradeTextContent,
  calculateTermArithmeticAverage,
  formatAuthExpiredMessage,
  buildWeixinQrConfirmUrl,
  renderTerminalQrCode,
  decodeQrPayloadFromPngFile,
  formatQrLoginMessage,
  shouldAbortGithubQrLogin,
  installPageRequestFailureCapture,
  saveLoginTimeoutDiagnostics,
  saveQrElementScreenshot,
  isLikelyQrLoginUrl,
  extractLoginDebugUrlsFromHtml,
  classifyLoginDebugUrls,
  formatNoChangeMessage,
  sendPushPlus,
  parseBooleanEnv,
  parsePositiveIntegerEnv,
  buildCasRenewUrl,
  isRecoverableNavigationAbort,
  isAuthExpiredResponse,
  normalizeBbguScoreApiData,
  getConfig,
  readSavedAuthState,
  readSavedAccessToken,
  saveAuthState,
  saveAccessToken,
  readQrReminderState,
  saveQrReminderSchedule,
  markCasExpired,
  clearQrReminderSchedule,
  clearQrReminderState,
  requestRefreshedAuthState,
  refreshAndSaveAuthState,
  extractWeixinQrInfoFromHtml,
  extractWeixinQrConnectUrlFromHtml,
  collectLoginDebugInfo,
  saveLoginDebugReport,
  fetchWeixinQrInfoFromPage,
  extractAuthStateFromPage,
  saveBrowserAuthState,
  clearBrowserAccessTokens,
  navigateToLoginPage,
  createWeixinQrCapture,
  selectChromiumExecutable,
  findChromiumExecutable,
  launchChromium,
  runSilentRenew,
  maybeRunScheduledQr,
  runRenew,
  runCasDiagnose,
  recoverDirectApiAfterAuthExpired,
  fetchBbguScoreRowsWithCookie,
  requestJsonText,
  run,
  runLogin,
  runLoginDebug,
};
