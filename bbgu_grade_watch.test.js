const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const bbguGradeWatch = require('./bbgu_grade_watch');
const {
  normalizeGradeRows,
  diffGrades,
  formatGradeNotification,
  normalizeSubScoreList,
  mergePersistedSubScores,
  selectRowsForSubScoreFetch,
  enrichRowsWithSubScores,
  sendPushPlus,
  parseBooleanEnv,
  parsePositiveIntegerEnv,
  normalizeBbguScoreApiData,
  calculateTermArithmeticAverage,
  buildAuthorizationHeader,
  decodeJwtPayload,
  extractJwtExpiry,
  formatAuthStatusSummary,
  computeQrSchedule,
  shouldPushQrNow,
  buildCasRenewUrl,
  isRecoverableNavigationAbort,
  isAuthExpiredResponse,
  parseSavedAuthState,
  extractAuthStateFromStorageState,
  readSavedAuthState,
  saveAuthState,
  readQrReminderState,
  saveQrReminderSchedule,
  markCasExpired,
  clearQrReminderSchedule,
  clearQrReminderState,
  extractAuthStateFromPage,
  saveBrowserAuthState,
  requestRefreshedAuthState,
  refreshAndSaveAuthState,
  formatQrLoginMessage,
  buildWeixinQrConfirmUrl,
  renderTerminalQrCode,
  decodeQrPayloadFromPngFile,
  saveLoginTimeoutDiagnostics,
  shouldAbortGithubQrLogin,
  installPageRequestFailureCapture,
  selectChromiumExecutable,
  launchChromium,
  getConfig,
  isLikelyQrLoginUrl,
  extractWeixinQrInfoFromHtml,
  extractWeixinQrConnectUrlFromHtml,
  recoverDirectApiAfterAuthExpired,
  requestJsonText,
  run,
  runRenew,
  clearBrowserAccessTokens,
  navigateToLoginPage,
} = bbguGradeWatch;

function makeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

test('formatAuthStatusSummary显示三类登录态及Token到期时间且不泄露原文', () => {
  const nowMs = Date.parse('2026-07-05T17:30:00+08:00');
  const refreshToken = makeJwt({ exp: nowMs / 1000 + 12 * 3600 + 4 * 60 });
  const accessToken = makeJwt({ exp: nowMs / 1000 + 2 * 3600 });
  const text = formatAuthStatusSummary({
    casStatus: 'expired_skipped',
    refreshStatus: 'valid',
    authState: { refreshToken, accessToken },
    nowMs,
  });

  assert.match(text, /CAS：已失效，本次已跳过/);
  assert.match(text, /Refresh Token：有效，过期时间 .*，剩余12小时4分钟/);
  assert.match(text, /Access Token：有效，过期时间 .*，剩余2小时/);
  assert.equal(text.includes(refreshToken), false);
  assert.equal(text.includes(accessToken), false);
});

test('formatAuthStatusSummary在JWT没有exp时显示到期时间未知', () => {
  const text = formatAuthStatusSummary({
    casStatus: 'valid',
    refreshStatus: 'unchecked',
    authState: { refreshToken: 'opaque-refresh', accessToken: 'opaque-access' },
    nowMs: Date.parse('2026-07-05T17:30:00+08:00'),
  });

  assert.match(text, /CAS：有效/);
  assert.match(text, /Refresh Token：未检测，到期时间未知/);
  assert.match(text, /Access Token：状态未知，到期时间未知/);
});

test('白天Access过期时使用之前最后一个整点作为扫码时间', () => {
  const now = Date.parse('2026-07-04T15:30:00+08:00');
  const expiry = Date.parse('2026-07-04T17:34:00+08:00') / 1000;
  const result = computeQrSchedule(expiry, now);

  assert.equal(result.dueAt, Date.parse('2026-07-04T17:00:00+08:00'));
  assert.equal(result.firstUncoveredQueryAt, Date.parse('2026-07-04T18:00:00+08:00'));
});

test('跨夜提醒移动到次日09:30', () => {
  const now = Date.parse('2026-07-04T23:30:00+08:00');
  const expiry = Date.parse('2026-07-05T09:34:00+08:00') / 1000;
  const result = computeQrSchedule(expiry, now);

  assert.equal(result.dueAt, Date.parse('2026-07-05T09:30:00+08:00'));
  assert.equal(result.firstUncoveredQueryAt, Date.parse('2026-07-05T10:00:00+08:00'));
  assert.equal(shouldPushQrNow({ nowMs: now, dueAtMs: result.dueAt, lastPushedAtMs: 0 }), false);
});

test('Access在10:34过期时等待10:00查询完成', () => {
  const now = Date.parse('2026-07-05T09:30:00+08:00');
  const expiry = Date.parse('2026-07-05T10:34:00+08:00') / 1000;
  const result = computeQrSchedule(expiry, now);

  assert.equal(result.dueAt, Date.parse('2026-07-05T10:00:00+08:00'));
  assert.equal(result.firstUncoveredQueryAt, Date.parse('2026-07-05T11:00:00+08:00'));
});

test('允许09:30首发、10:00补发以及之后两小时冷却', () => {
  const dueAt = Date.parse('2026-07-05T09:30:00+08:00');
  const firstPush = Date.parse('2026-07-05T09:30:00+08:00');
  const tenOClock = Date.parse('2026-07-05T10:00:00+08:00');

  assert.equal(shouldPushQrNow({ nowMs: firstPush, dueAtMs: dueAt, lastPushedAtMs: 0 }), true);
  assert.equal(shouldPushQrNow({ nowMs: tenOClock, dueAtMs: dueAt, lastPushedAtMs: firstPush }), true);
  assert.equal(shouldPushQrNow({ nowMs: Date.parse('2026-07-05T11:30:00+08:00'), dueAtMs: dueAt, lastPushedAtMs: tenOClock }), false);
  assert.equal(shouldPushQrNow({ nowMs: Date.parse('2026-07-05T12:00:00+08:00'), dueAtMs: dueAt, lastPushedAtMs: tenOClock }), true);
});

test('持久化CAS失效和二维码冷却状态', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbgu-qr-state-'));
  const config = { qrReminderStatePath: path.join(tempDir, 'qr-state.json') };
  try {
    const first = {
      accessExpiryEpochSeconds: 1783253640,
      dueAt: Date.parse('2026-07-05T17:00:00+08:00'),
      firstUncoveredQueryAt: Date.parse('2026-07-05T18:00:00+08:00'),
    };
    await saveQrReminderSchedule(config, first);
    await markCasExpired(config);
    let saved = await readQrReminderState(config);
    assert.equal(saved.accessExpiryEpochSeconds, first.accessExpiryEpochSeconds);
    assert.equal(saved.lastPushedAt, 0);
    assert.equal(saved.casExpired, true);

    await saveQrReminderSchedule(config, { ...first, lastPushedAt: 12345 });
    saved = await readQrReminderState(config);
    assert.equal(saved.lastPushedAt, 12345);

    await saveQrReminderSchedule(config, {
      ...first,
      accessExpiryEpochSeconds: first.accessExpiryEpochSeconds + 7200,
    });
    saved = await readQrReminderState(config);
    assert.equal(saved.lastPushedAt, 0);
    assert.equal(saved.casExpired, true);

    await clearQrReminderSchedule(config);
    saved = await readQrReminderState(config);
    assert.deepEqual(saved, { casExpired: true });

    await clearQrReminderState(config);
    assert.equal(await readQrReminderState(config), null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('module exports only supported public helpers and no legacy browser scraping helpers', () => {
  for (const name of [
    'formatGradeNotificationHtml',
    'formatLoginExpiredMessage',
    'buildPublicQrImageUrl',
    'findGradeRowsInJson',
    'extractCurrentGrades',
    'uploadImageToPushPlus',
    'getPushPlusAccessKey',
    'imageFileToDataUrl',
    'imageUrlToDataUrl',
    'limitInlineDataUrl',
    'extractQrLoginUrlFromPage',
    'saveAccessToken',
    'readSavedAccessToken',
    'parseSavedAccessToken',
    'formatAuthExpiredMessage',
    'formatNoChangeMessage',
  ]) {
    assert.equal(Object.hasOwn(bbguGradeWatch, name), false, `${name} should not be exported`);
  }
});

test('normalizeGradeRows keeps meaningful grade fields and ignores empty rows', () => {
  const rows = normalizeGradeRows([
    { courseName: ' 高等数学 ', score: ' 95 ', credit: '4', term: '2026春' },
    { courseName: '', score: '', credit: '', term: '' },
  ]);

  assert.deepEqual(rows, [
    { key: '高等数学', courseName: '高等数学', score: '95', credit: '4', term: '2026春' },
  ]);
});

test('normalizeGradeRows builds stable keys with course code when present', () => {
  const rows = normalizeGradeRows([
    { courseCode: 'AI101', courseName: '人工智能公开课', score: '100', credit: '2', term: '2026春' },
  ]);

  assert.equal(rows[0].key, 'AI101::人工智能公开课');
});

test('diffGrades reports added and changed rows', () => {
  const previous = [
    { key: '大学英语', courseName: '大学英语', score: '88', credit: '2', term: '2026春' },
  ];
  const current = [
    { key: '大学英语', courseName: '大学英语', score: '91', credit: '2', term: '2026春' },
    { key: '人工智能', courseName: '人工智能', score: '100', credit: '2', term: '2026春' },
  ];

  assert.deepEqual(diffGrades(previous, current), {
    added: [
      { key: '人工智能', courseName: '人工智能', score: '100', credit: '2', term: '2026春' },
    ],
    changed: [
      {
        before: { key: '大学英语', courseName: '大学英语', score: '88', credit: '2', term: '2026春' },
        after: { key: '大学英语', courseName: '大学英语', score: '91', credit: '2', term: '2026春' },
      },
    ],
  });
});

test('formatGradeNotification includes added and changed grades in plain text report', () => {
  const message = formatGradeNotification({
    term: '2026春',
    currentRows: [
      { courseName: '人工智能', score: '100', credit: '2', term: '2026春' },
      { courseName: '大学英语', score: '91', credit: '2', term: '2026春' },
      { courseName: '体育', score: '优秀', credit: '1', term: '2026春' },
      { courseName: '上学期课程', score: '60', credit: '1', term: '2025秋' },
    ],
    added: [{ courseName: '人工智能', score: '100', credit: '2', term: '2026春' }],
    changed: [{
      before: { courseName: '大学英语', score: '88', credit: '2', term: '2026春' },
      after: { courseName: '大学英语', score: '91', credit: '2', term: '2026春' },
    }],
  });

  assert.match(message, /BBGU 成绩更新｜2026春/);
  assert.match(message, /人工智能/);
  assert.match(message, /88 -> 91/);
  assert.match(message, /算术平均分：95\.50（2 门）/);
  assert.doesNotMatch(message, /绩点/);
  assert.doesNotMatch(message, /说明：均分只计算/);
  assert.match(message, /本学期已出成绩/);
});

test('formatGradeNotification produces compact plain text grade report', () => {
  const message = formatGradeNotification({
    term: '2026春',
    checkedAt: '2026-07-02 18:10',
    currentRows: [
      {
        courseName: '流体力学与液压传动',
        score: '59',
        credit: '3.0',
        term: '2026春',
        subScores: [
          { name: '平时成绩', weight: '30', score: '80' },
          { name: '期末成绩', weight: '70', score: '50' },
        ],
      },
      { courseName: '中外航海文化', score: '99', credit: '1.0', term: '2026春' },
      { courseName: '上学期课程', score: '60', credit: '1.0', term: '2025秋' },
    ],
    added: [{
      courseName: '流体力学与液压传动',
      score: '59',
      credit: '3.0',
      term: '2026春',
      subScores: [{ name: '平时成绩', weight: '30', score: '80' }],
    }],
    changed: [],
  });

  assert.match(message, /^BBGU 成绩更新｜2026春/);
  assert.match(message, /检查时间：2026-07-02 18:10/);
  assert.match(message, /━━━━━━━━━━━━━━━━/);
  assert.match(message, /新增 1 门｜变更 0 门｜已出 2 门/);
  assert.match(message, /算术平均分：79\.00/);
  assert.match(message, /┌──────────────────┬────┬────┐/);
  assert.match(message, /流体力学与液压传动/);
  assert.match(message, /成绩：59｜学分：3\.0/);
  assert.doesNotMatch(message, /绩点/);
  assert.match(message, /平时分：\n   - 平时成绩\(30%\) 80/);
  assert.match(message, /期末成绩\(70%\) 50/);
  assert.doesNotMatch(message, /其他 1 门：暂无保存记录/);
  assert.doesNotMatch(message, /说明：均分只计算/);
  assert.doesNotMatch(message, /上学期课程/);
});

test('formatPushPlusGradeTextContent wraps text report and truncates oversized notifications', () => {
  const {
    formatPushPlusGradeTextContent,
  } = require('./bbgu_grade_watch');
  const rows = Array.from({ length: 500 }, (_, index) => ({
    courseName: `超长课程名称-${index}`,
    score: String(60 + (index % 40)),
    credit: '2.0',
    term: '2026春',
    subScores: [
      { name: '平时成绩', weight: '30', score: String(80 + (index % 10)) },
      { name: '期末成绩', weight: '70', score: String(50 + (index % 30)) },
    ],
  }));

  const content = formatPushPlusGradeTextContent({
    term: '2026春',
    added: rows.slice(0, 20),
    changed: [],
    currentRows: rows,
    maxChars: 1200,
  });

  assert.ok(content.length <= 1200);
  assert.match(content, /^```text\nBBGU 成绩更新/);
  assert.match(content, /内容过长，已截断/);
  assert.match(content, /完整快照/);
  assert.match(content, /```$/);
});

test('sendPushPlus sends markdown template messages', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ code: 200, msg: 'success' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await sendPushPlus({
      token: 'push-token',
      title: 'BBGU 成绩更新',
      content: '<div>ok</div>',
    });

    const body = JSON.parse(calls[0].options.body);
    assert.equal(calls[0].url, 'https://www.pushplus.plus/send');
    assert.equal(body.template, 'markdown');
    assert.equal(body.content, '<div>ok</div>');
  } finally {
    global.fetch = originalFetch;
  }
});

test('requestJsonText在GitHub代理模式下不回退到直连HTTPS', async () => {
  const originalFetch = global.fetch;
  const originalGithubActions = process.env.GITHUB_ACTIONS;
  const originalProxyServer = process.env.BBGU_PROXY_SERVER;
  global.fetch = async () => {
    throw Object.assign(new Error('proxy tunnel failed'), { cause: { code: 'ERR_TUNNEL_CONNECTION_FAILED' } });
  };
  process.env.GITHUB_ACTIONS = 'true';
  process.env.BBGU_PROXY_SERVER = 'http://127.0.0.1:7890';

  try {
    await assert.rejects(
      () => requestJsonText('https://zhjw.bbgu.edu.cn/api/sam/score/student/score', {}),
      /proxy tunnel failed|ERR_TUNNEL_CONNECTION_FAILED/
    );
  } finally {
    global.fetch = originalFetch;
    if (originalGithubActions === undefined) {
      delete process.env.GITHUB_ACTIONS;
    } else {
      process.env.GITHUB_ACTIONS = originalGithubActions;
    }
    if (originalProxyServer === undefined) {
      delete process.env.BBGU_PROXY_SERVER;
    } else {
      process.env.BBGU_PROXY_SERVER = originalProxyServer;
    }
  }
});

test('requestJsonText在代理模式下遇到fetch严格解析错误时改用代理HTTPS后备', async () => {
  const originalGithubActions = process.env.GITHUB_ACTIONS;
  const originalProxyServer = process.env.BBGU_PROXY_SERVER;
  const calls = [];
  process.env.GITHUB_ACTIONS = 'true';
  process.env.BBGU_PROXY_SERVER = 'http://127.0.0.1:7890';

  try {
    const response = await requestJsonText('https://zhjw.bbgu.edu.cn/api/sam/score/student/score', {}, {
      fetchFn: async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: new Error('Response does not match the HTTP/1.1 protocol (Missing expected CR after header value)'),
        });
      },
      proxyHttpsRequestFn: async (url, headers, proxyServer) => {
        calls.push({ url, headers, proxyServer });
        return { status: 200, text: '{"ok":true}', via: 'proxy-https' };
      },
    });

    assert.deepEqual(response, { status: 200, text: '{"ok":true}', via: 'proxy-https' });
    assert.deepEqual(calls, [{
      url: 'https://zhjw.bbgu.edu.cn/api/sam/score/student/score',
      headers: {},
      proxyServer: 'http://127.0.0.1:7890',
    }]);
  } finally {
    if (originalGithubActions === undefined) {
      delete process.env.GITHUB_ACTIONS;
    } else {
      process.env.GITHUB_ACTIONS = originalGithubActions;
    }
    if (originalProxyServer === undefined) {
      delete process.env.BBGU_PROXY_SERVER;
    } else {
      process.env.BBGU_PROXY_SERVER = originalProxyServer;
    }
  }
});

test('calculateTermArithmeticAverage only uses numeric scores from selected term', () => {
  assert.deepEqual(calculateTermArithmeticAverage([
    { courseName: 'A', score: '99', term: '2026春' },
    { courseName: 'B', score: '86.5', term: '2026春' },
    { courseName: 'C', score: '优秀', term: '2026春' },
    { courseName: 'D', score: '60', term: '2025秋' },
  ], '2026春'), {
    term: '2026春',
    count: 2,
    average: 92.75,
  });
});

test('parseBooleanEnv accepts common truthy and falsy values', () => {
  assert.equal(parseBooleanEnv(undefined, true), true);
  assert.equal(parseBooleanEnv('1', false), true);
  assert.equal(parseBooleanEnv('true', false), true);
  assert.equal(parseBooleanEnv('no', true), false);
  assert.equal(parseBooleanEnv('0', true), false);
});

test('parsePositiveIntegerEnv accepts positive integers and rejects invalid values', () => {
  assert.equal(parsePositiveIntegerEnv(undefined, 600), 600);
  assert.equal(parsePositiveIntegerEnv('900', 600), 900);
  assert.equal(parsePositiveIntegerEnv('0', 600), 600);
  assert.equal(parsePositiveIntegerEnv('-1', 600), 600);
  assert.equal(parsePositiveIntegerEnv('abc', 600), 600);
});

test('normalizeBbguScoreApiData converts real BBGU score response shape', () => {
  const rows = normalizeBbguScoreApiData({
    '2026春': {
      totalCredit: '2.0',
      gpa: '3.61',
      stuScoreHomePgVoS: [
        {
          courseName: '中外航海文化',
          scoreId: '25201881',
          courseCode: '5600214a105',
          courseCredit: '1.0',
          effectiveScoreShow: '99',
          scoreShow: '99',
          sessionName: '2026春',
        },
      ],
    },
  });

  assert.deepEqual(rows, [
    {
      key: '5600214a105::中外航海文化',
      courseName: '中外航海文化',
      scoreId: '25201881',
      score: '99',
      credit: '1.0',
      term: '2026春',
    },
  ]);
});

test('normalizeBbguScoreApiData uses BBGU row id as subscore scoreId fallback', () => {
  const rows = normalizeBbguScoreApiData({
    '2026春': {
      stuScoreHomePgVoS: [
        {
          id: 'raw-score-row-id',
          courseName: '机械制造技术基础',
          courseCode: 'M001',
          courseCredit: '4.0',
          effectiveScoreShow: '83',
          sessionName: '2026春',
        },
      ],
    },
  });

  assert.equal(rows[0].scoreId, 'raw-score-row-id');
  assert.equal(rows[0].sourceKeys, undefined);
});

test('normalizeSubScoreList extracts score form subscore rows', () => {
  assert.deepEqual(normalizeSubScoreList({
    data: {
      inputMode: '分项成绩',
      subScoreList: [
        { scoreName: '平时成绩', weight: 30, score: 80 },
        { subName: '期末成绩', percent: '70', subScore: '50' },
      ],
    },
  }), [
    { name: '平时成绩', weight: '30', score: '80' },
    { name: '期末成绩', weight: '70', score: '50' },
  ]);
});

test('mergePersistedSubScores keeps previous subscore details for unchanged courses', () => {
  const merged = mergePersistedSubScores([
    {
      key: 'A',
      courseName: 'A',
      score: '90',
      subScores: [{ name: '平时成绩', weight: '30', score: '95' }],
      subScoreFetchedAt: '2026-07-01T00:00:00.000Z',
    },
  ], [
    { key: 'A', courseName: 'A', score: '90' },
    { key: 'B', courseName: 'B', score: '99' },
  ]);

  assert.deepEqual(merged[0].subScores, [{ name: '平时成绩', weight: '30', score: '95' }]);
  assert.equal(merged[0].subScoreFetchedAt, '2026-07-01T00:00:00.000Z');
  assert.equal(merged[1].subScores, undefined);
});

test('selectRowsForSubScoreFetch only selects changed or added rows once', () => {
  const rows = selectRowsForSubScoreFetch({
    added: [
      { key: 'A', scoreId: '1', courseName: 'A' },
      { key: 'B', scoreId: '2', courseName: 'B', subScores: [{ name: '平时', score: '90' }] },
      { key: 'C', courseName: 'C' },
    ],
    changed: [
      { after: { key: 'D', scoreId: '4', courseName: 'D' } },
      { after: { key: 'A', scoreId: '1', courseName: 'A' } },
    ],
  });

  assert.deepEqual(rows.map((row) => row.key), ['A', 'D']);
});

test('enrichRowsWithSubScores logs available fields when added rows miss scoreId', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (message) => logs.push(String(message));

  try {
    const result = await enrichRowsWithSubScores({
      added: [{
        key: '机械制造技术基础',
        courseName: '机械制造技术基础',
        score: '83',
        sourceKeys: ['courseName', 'effectiveScoreShow', 'scoreFormId', 'detailId'],
      }],
      changed: [],
    }, {}, async () => {
      throw new Error('should not fetch without scoreId');
    });

    assert.deepEqual(result, { fetched: 0, failed: 0 });
    assert.match(logs.join('\n'), /Subscore skipped for 机械制造技术基础: missing scoreId/);
    assert.match(logs.join('\n'), /fields=courseName,detailId,effectiveScoreShow,scoreFormId/);
  } finally {
    console.log = originalLog;
  }
});

test('buildAuthorizationHeader accepts raw token and JSON-stringified token', () => {
  assert.equal(buildAuthorizationHeader('abc.def.ghi'), 'Bearer abc.def.ghi');
  assert.equal(buildAuthorizationHeader('"abc.def.ghi"'), 'Bearer abc.def.ghi');
});

test('extractJwtExpiry decodes JWT exp claim', () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1782914400 })).toString('base64url');
  const token = `header.${payload}.signature`;

  assert.equal(decodeJwtPayload(token).exp, 1782914400);
  assert.equal(extractJwtExpiry(token).epochSeconds, 1782914400);
  assert.equal(extractJwtExpiry(`Bearer ${token}`).epochSeconds, 1782914400);
});

test('isAuthExpiredResponse detects expired token responses', () => {
  assert.equal(isAuthExpiredResponse({ httpStatus: 401, text: '', body: null }), true);
  assert.equal(isAuthExpiredResponse({ httpStatus: 200, text: '<html>统一身份认证</html>', body: null }), true);
  assert.equal(isAuthExpiredResponse({ httpStatus: 200, text: '{"status":"fail"}', body: { status: 'fail', msg: 'token expired' } }), true);
  assert.equal(isAuthExpiredResponse({ httpStatus: 200, text: '{"status":"success"}', body: { status: 'success', ok: true } }), false);
  assert.equal(isAuthExpiredResponse({ httpStatus: 502, text: '{"ok":false,"msg":"bad gateway"}', body: { ok: false, msg: 'bad gateway' } }), false);
});

test('parseSavedAuthState reads access and refresh tokens and keeps legacy formats', () => {
  assert.deepEqual(parseSavedAuthState([
    '# generated',
    'BBGU_ACCESS_TOKEN="access.jwt"',
    'BBGU_REFRESH_TOKEN=refresh.jwt',
  ].join('\n')), {
    accessToken: 'access.jwt',
    refreshToken: 'refresh.jwt',
  });
  assert.deepEqual(parseSavedAuthState('legacy.access.jwt\n'), {
    accessToken: 'legacy.access.jwt',
    refreshToken: '',
  });
  assert.deepEqual(parseSavedAuthState('# comment\nBBGU_ACCESS_TOKEN=\"abc.def.ghi\"\n'), {
    accessToken: 'abc.def.ghi',
    refreshToken: '',
  });
});

test('extractAuthStateFromStorageState migrates BBGU browser tokens', () => {
  const result = extractAuthStateFromStorageState({
    origins: [{
      origin: 'https://zhjw.bbgu.edu.cn',
      localStorage: [
        { name: 'cqu_edu_ACCESS_TOKEN', value: '"browser.access"' },
        { name: 'cqu_edu_REFRESH_TOKEN', value: '"browser.refresh"' },
      ],
    }],
  }, 'https://zhjw.bbgu.edu.cn');

  assert.deepEqual(result, {
    accessToken: 'browser.access',
    refreshToken: 'browser.refresh',
  });
});

test('saveAuthState writes both tokens and readSavedAuthState restores them', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbgu-auth-state-'));
  const tokenPath = path.join(tempDir, 'bbgu_token.env');

  try {
    await saveAuthState(tokenPath, { accessToken: 'access.jwt', refreshToken: 'refresh.jwt' });
    assert.deepEqual(await readSavedAuthState(tokenPath), {
      accessToken: 'access.jwt',
      refreshToken: 'refresh.jwt',
    });
    const content = await fs.readFile(tokenPath, 'utf8');
    assert.match(content, /BBGU_ACCESS_TOKEN=access\.jwt/);
    assert.match(content, /BBGU_REFRESH_TOKEN=refresh\.jwt/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('renderTerminalQrCode uses qrcode-terminal compatible generator output', () => {
  const textQr = renderTerminalQrCode('https://open.weixin.qq.com/connect/confirm?uuid=abc123', {
    generate(value, options, callback) {
      callback(`QR:${value}:${options.small}`);
    },
  });

  assert.equal(textQr, 'QR:https://open.weixin.qq.com/connect/confirm?uuid=abc123:true');
});

test('decodeQrPayloadFromPngFile decodes QR payload from PNG pixels', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbgu-qr-decode-'));
  const imagePath = path.join(tempDir, 'qr.png');
  await fs.writeFile(imagePath, Buffer.from('fake png'));

  try {
    const payload = await decodeQrPayloadFromPngFile(imagePath, {
      pngReader: {
        sync: {
          read(buffer) {
            assert.equal(buffer.toString(), 'fake png');
            return {
              width: 2,
              height: 2,
              data: new Uint8ClampedArray(16),
            };
          },
        },
      },
      jsQR: (data, width, height) => {
        assert.equal(data.length, 16);
        assert.equal(width, 2);
        assert.equal(height, 2);
        return { data: 'REAL_QR_PAYLOAD' };
      },
    });

    assert.equal(payload, 'REAL_QR_PAYLOAD');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('已安装的二维码依赖可以真实解码PNG并渲染文本二维码', async () => {
  const { PNG } = require('pngjs');
  const QRCode = require('qrcode-terminal/vendor/QRCode');
  const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
  const payload = 'https://example.com/bbgu-qr-test';
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(payload);
  qr.make();

  const scale = 8;
  const border = 4;
  const moduleCount = qr.getModuleCount();
  const size = (moduleCount + border * 2) * scale;
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const row = Math.floor(y / scale) - border;
      const column = Math.floor(x / scale) - border;
      const black = row >= 0 && column >= 0
        && row < moduleCount && column < moduleCount
        && qr.modules[row][column];
      const offset = (y * size + x) * 4;
      const value = black ? 0 : 255;
      png.data[offset] = value;
      png.data[offset + 1] = value;
      png.data[offset + 2] = value;
      png.data[offset + 3] = 255;
    }
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbgu-real-qr-'));
  const imagePath = path.join(tempDir, 'qr.png');
  try {
    await fs.writeFile(imagePath, PNG.sync.write(png));
    const decoded = await decodeQrPayloadFromPngFile(imagePath);
    const textQr = renderTerminalQrCode(decoded);

    assert.equal(decoded, payload);
    assert.ok(textQr.split(/\r?\n/).length >= 5);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('formatQrLoginMessage can render text QR fallback without official QR image or failing mobile link', () => {
  const message = formatQrLoginMessage({
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    screenshotPath: '/home/runner/work/bbgu-data/qr.png',
    qrImageUrl: 'https://open.weixin.qq.com/connect/qrcode/abc123',
    textQr: '██  ██\n  ████',
    waitSeconds: 600,
  });

  assert.doesNotMatch(message, /手机打开登录链接/);
  assert.doesNotMatch(message, /connect\/qrconnect/);
  assert.doesNotMatch(message, /<img src="https:\/\/open\.weixin\.qq\.com\/connect\/qrcode\/abc123"/);
  assert.doesNotMatch(message, /<pre/i);
  assert.match(message, /<br\s*\/?>/);
  assert.match(message, /&nbsp;/);
  assert.match(message, /微信扫码识别下方文本二维码/);
  assert.match(message, /██&nbsp;&nbsp;██/);
  assert.match(message, /打开上面的截图路径/);
  assert.match(message, /access\/refresh token/);
});

test('formatQrLoginMessage在GitHub环境隐藏无用的Runner截图路径', () => {
  const message = formatQrLoginMessage({
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    screenshotPath: '/home/runner/work/bbgu-data/qr.png',
    textQr: '██  ██\n  ████',
    waitSeconds: 300,
    showScreenshotPath: false,
  });

  assert.match(message, /微信扫码识别下方文本二维码/);
  assert.doesNotMatch(message, /\/home\/runner/);
  assert.doesNotMatch(message, /二维码截图路径/);
});

test('buildWeixinQrConfirmUrl converts WeChat qrcode image URL to scan confirmation URL', () => {
  assert.equal(
    buildWeixinQrConfirmUrl('https://open.weixin.qq.com/connect/qrcode/021j3AB52fDaGa12'),
    'https://open.weixin.qq.com/connect/confirm?uuid=021j3AB52fDaGa12'
  );
  assert.equal(buildWeixinQrConfirmUrl('https://example.com/qr.png'), '');
});

test('formatQrLoginMessage falls back to screenshot path when text QR is unavailable', () => {
  const message = formatQrLoginMessage({
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    screenshotPath: '/home/runner/work/bbgu-data/qr.png',
    qrImageUrl: 'https://open.weixin.qq.com/connect/qrcode/abc123',
    waitSeconds: 600,
  });

  assert.match(message, /二维码截图路径/);
  assert.match(message, /打开上面的截图路径/);
  assert.match(message, /600 秒/);
  assert.doesNotMatch(message, /<img /);
  assert.doesNotMatch(message, /data:image/);
  assert.doesNotMatch(message, /手机打开登录链接/);
});

test('saveLoginTimeoutDiagnostics writes current login page state', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbgu-login-diag-'));
  const page = {
    url: () => 'https://authserver.bbgu.edu.cn/authserver/wechat/error',
    title: async () => '异常错误',
    locator: () => ({
      innerText: async () => '授权失败，请返回认证登录页重试！',
    }),
    screenshot: async ({ path: screenshotPath }) => {
      await fs.writeFile(screenshotPath, 'fake png');
    },
    __bbguRequestFailures: [
      {
        url: 'https://zhjw.bbgu.edu.cn/workspace/home',
        method: 'GET',
        resourceType: 'document',
        errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED',
      },
    ],
  };

  try {
    const diagnostic = await saveLoginTimeoutDiagnostics(page, { diagnosticDir: tempDir });
    const report = JSON.parse(await fs.readFile(diagnostic.reportPath, 'utf8'));

    assert.equal(report.url, 'https://authserver.bbgu.edu.cn/authserver/wechat/error');
    assert.equal(report.title, '异常错误');
    assert.match(report.bodyText, /授权失败/);
    assert.equal(report.screenshotPath, diagnostic.screenshotPath);
    assert.deepEqual(report.requestFailures, page.__bbguRequestFailures);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('installPageRequestFailureCapture records recent browser request failures', () => {
  const listeners = new Map();
  const page = {
    on: (event, handler) => listeners.set(event, handler),
  };
  installPageRequestFailureCapture(page, 2);
  const handler = listeners.get('requestfailed');

  handler({
    url: () => 'https://zhjw.bbgu.edu.cn/workspace/home',
    method: () => 'GET',
    resourceType: () => 'document',
    failure: () => ({ errorText: 'net::ERR_CONNECTION_TIMED_OUT' }),
  });
  handler({
    url: () => 'https://s4.zstatic.net/app.js',
    method: () => 'GET',
    resourceType: () => 'script',
    failure: () => ({ errorText: 'net::ERR_ABORTED' }),
  });
  handler({
    url: () => 'https://authserver.bbgu.edu.cn/authserver/login',
    method: () => 'GET',
    resourceType: () => 'document',
    failure: () => ({ errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' }),
  });

  assert.deepEqual(page.__bbguRequestFailures, [
    {
      url: 'https://s4.zstatic.net/app.js',
      method: 'GET',
      resourceType: 'script',
      errorText: 'net::ERR_ABORTED',
    },
    {
      url: 'https://authserver.bbgu.edu.cn/authserver/login',
      method: 'GET',
      resourceType: 'document',
      errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED',
    },
  ]);
});

test('GitHub环境没有可扫码二维码时立即中止登录等待', () => {
  assert.equal(shouldAbortGithubQrLogin({
    githubActions: true,
    textQr: '',
    qrImageUrl: '',
  }), true);
  assert.equal(shouldAbortGithubQrLogin({
    githubActions: true,
    textQr: 'qr text',
    qrImageUrl: '',
  }), false);
  assert.equal(shouldAbortGithubQrLogin({
    githubActions: false,
    textQr: '',
    qrImageUrl: '',
  }), false);
});

test('getConfig读取BBGU_PROXY_SERVER', () => {
  const config = getConfig({ BBGU_PROXY_SERVER: 'http://127.0.0.1:7890' });

  assert.equal(config.proxyServer, 'http://127.0.0.1:7890');
});

test('getConfig识别GitHub Actions运行环境', () => {
  const config = getConfig({ GITHUB_ACTIONS: 'true' });

  assert.equal(config.githubActions, true);
});

test('buildCasRenewUrl points CAS back to the SAM callback route', () => {
  assert.equal(
    buildCasRenewUrl({ homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home' }),
    'https://zhjw.bbgu.edu.cn/authserver/casLogin?redirect_uri=https%3A%2F%2Fzhjw.bbgu.edu.cn%2Fsam%2Fcas'
  );
});

test('isRecoverableNavigationAbort accepts CAS redirect navigation aborts only', () => {
  assert.equal(
    isRecoverableNavigationAbort(new Error('page.goto: net::ERR_ABORTED at https://zhjw.bbgu.edu.cn/authserver/casLogin')),
    true
  );
  assert.equal(isRecoverableNavigationAbort(new Error('page.goto: net::ERR_CONNECTION_TIMED_OUT')), false);
});

test('recoverDirectApiAfterAuthExpired stops after successful refresh token renewal', async () => {
  const calls = [];
  const config = {
    tokenPath: 'token.env',
  };

  const rows = await recoverDirectApiAfterAuthExpired(config, {
    refreshAndSaveAuthStateFn: async (nextConfig) => {
      calls.push('refresh');
      nextConfig.authorization = 'Bearer refreshed.access';
    },
    runSilentRenewFn: async () => calls.push('silent'),
    runLoginFn: async () => calls.push('qr'),
    fetchScoreRowsFn: async (nextConfig) => {
      calls.push(nextConfig.authorization);
      return [{ courseName: '人工智能', score: '100' }];
    },
  });

  assert.deepEqual(calls, ['refresh', 'Bearer refreshed.access']);
  assert.deepEqual(rows, [{ courseName: '人工智能', score: '100' }]);
});

test('recoverDirectApiAfterAuthExpired schedules QR from last access expiry after refresh fails', async () => {
  const calls = [];
  const nowMs = Date.parse('2026-07-04T15:30:00+08:00');
  const config = {
    tokenPath: 'token.env',
  };

  await assert.rejects(
    recoverDirectApiAfterAuthExpired(config, {
      nowFn: () => nowMs,
      refreshAndSaveAuthStateFn: async () => {
        calls.push('refresh');
        const error = new Error('refresh expired');
        error.httpStatus = 401;
        throw error;
      },
      readQrReminderStateFn: async () => null,
      readSavedAuthStateFn: async () => ({
        accessToken: makeJwt({ exp: Date.parse('2026-07-04T17:34:00+08:00') / 1000 }),
        refreshToken: '',
      }),
      saveQrReminderScheduleFn: async (_config, schedule) => {
        calls.push(`schedule:${new Date(schedule.dueAt).toISOString()}`);
        return schedule;
      },
      maybeRunScheduledQrFn: async () => {
        calls.push('scheduled-qr');
        return { status: 'qr_pending' };
      },
      runSilentRenewFn: async () => calls.push('silent'),
      runLoginFn: async () => calls.push('direct-qr'),
    }),
    /二维码提醒仍在冷却期/
  );

  assert.deepEqual(calls, ['refresh', 'schedule:2026-07-04T09:00:00.000Z', 'scheduled-qr']);
});

test('已有二维码计划时普通查询遵守二维码冷却并跳过CAS', async () => {
  const calls = [];
  const config = {
    tokenPath: 'token.env',
  };

  await assert.rejects(
    recoverDirectApiAfterAuthExpired(config, {
      refreshAndSaveAuthStateFn: async () => {
        calls.push('refresh');
        const error = new Error('Refresh已失效');
        error.httpStatus = 401;
        throw error;
      },
      readQrReminderStateFn: async () => ({
        dueAt: Date.parse('2026-07-04T17:00:00+08:00'),
        lastPushedAt: Date.parse('2026-07-04T17:00:00+08:00'),
      }),
      runSilentRenewFn: async () => calls.push('cas'),
      maybeRunScheduledQrFn: async () => {
        calls.push('scheduled-qr');
        return { status: 'qr_pending' };
      },
      runLoginFn: async () => calls.push('direct-qr'),
    }),
    /二维码提醒仍在冷却期/
  );

  assert.deepEqual(calls, ['refresh', 'scheduled-qr']);
});

test('run starts automatic login recovery when saved direct API token is expired', async () => {
  const calls = [];
  const config = {
    pushplusToken: 'push-token',
    tokenPath: 'token.env',
    authorization: 'Bearer expired-token',
    term: '2026春',
  };

  const result = await run(config, {
    fetchScoreRowsFn: async () => {
      calls.push('fetch-expired');
      const error = new Error('expired');
      error.code = 'BBGU_AUTH_EXPIRED';
      throw error;
    },
    recoverDirectApiAfterAuthExpiredFn: async (nextConfig) => {
      calls.push(`recover:${nextConfig.tokenPath}`);
      nextConfig.authorization = 'Bearer renewed-token';
      return [{ key: 'A', courseName: 'A', score: '99', term: '2026春' }];
    },
    processGradeRowsFn: async (rows, nextConfig) => {
      calls.push(`process:${nextConfig.authorization}:${rows.length}`);
      return { status: 'ok', count: rows.length };
    },
  });

  assert.deepEqual(calls, [
    'fetch-expired',
    'recover:token.env',
    'process:Bearer renewed-token:1',
  ]);
  assert.deepEqual(result, { status: 'ok', count: 1 });
});

test('run starts first QR login when no saved token exists', async () => {
  const calls = [];
  const config = {
    pushplusToken: 'push-token',
    tokenPath: 'token.env',
    term: '2026春',
  };

  const result = await run(config, {
    readSavedAuthStateFn: async () => {
      calls.push('read-auth');
      return { accessToken: '', refreshToken: '' };
    },
    recoverDirectApiAfterAuthExpiredFn: async () => calls.push('recover-expired'),
    runLoginFn: async (nextConfig, options) => {
      calls.push(`login:${Boolean(options && options.ignoreInitialAccessToken)}`);
      nextConfig.authorization = 'Bearer first-login-token';
    },
    readSavedAuthStateAfterLoginFn: async () => {
      calls.push('read-auth-after-login');
      return { accessToken: 'first-login-token', refreshToken: 'first-refresh-token' };
    },
    fetchScoreRowsFn: async (nextConfig) => {
      calls.push(`fetch:${nextConfig.authorization}`);
      return [{ key: 'A', courseName: 'A', score: '99', term: '2026春' }];
    },
    processGradeRowsFn: async (rows) => {
      calls.push(`process:${rows.length}`);
      return { status: 'ok', count: rows.length };
    },
    maybeRunScheduledQrFn: async () => calls.push('qr-check'),
  });

  assert.deepEqual(calls, [
    'read-auth',
    'login:true',
    'read-auth-after-login',
    'fetch:Bearer first-login-token',
    'process:1',
    'qr-check',
  ]);
  assert.deepEqual(result, { status: 'ok', count: 1 });
});

test('成绩处理成功后检查待处理二维码提醒', async () => {
  const calls = [];
  const config = {
    pushplusToken: 'push-token',
    tokenPath: 'token.env',
    authorization: 'Bearer current-token',
    term: '2026春',
  };

  const result = await run(config, {
    fetchScoreRowsFn: async () => [
      { key: 'A', courseName: 'A', score: '99', term: '2026春' },
    ],
    processGradeRowsFn: async () => {
      calls.push('grades');
      return { status: 'ok' };
    },
    maybeRunScheduledQrFn: async () => {
      calls.push('qr-check');
      return { status: 'qr_pending' };
    },
  });

  assert.deepEqual(calls, ['grades', 'qr-check']);
  assert.deepEqual(result, { status: 'ok' });
});

test('CAS续期成功后renew结束并清除待扫码状态', async () => {
  const calls = [];
  const logs = [];
  const nowMs = Date.parse('2026-07-05T17:30:00+08:00');
  const result = await runRenew({}, {
    nowFn: () => nowMs,
    readQrReminderStateFn: async () => null,
    runSilentRenewFn: async () => { calls.push('cas'); return { status: 'renew_ok' }; },
    refreshAndSaveAuthStateFn: async () => calls.push('refresh'),
    readSavedAuthStateFn: async () => ({
      refreshToken: makeJwt({ exp: nowMs / 1000 + 12 * 3600 }),
      accessToken: makeJwt({ exp: nowMs / 1000 + 12 * 3600 }),
    }),
    clearQrReminderStateFn: async () => calls.push('clear'),
    logFn: (message) => logs.push(message),
  });

  assert.deepEqual(calls, ['cas', 'clear']);
  assert.equal(result.status, 'renew_ok');
  assert.match(logs.join('\n'), /CAS：有效/);
  assert.match(logs.join('\n'), /Refresh Token：未检测/);
  assert.match(logs.join('\n'), /Access Token：有效/);
});

test('CAS首次失败后记录失效并使用Refresh续Access', async () => {
  const calls = [];
  const result = await runRenew({}, {
    readQrReminderStateFn: async () => null,
    runSilentRenewFn: async () => { calls.push('cas'); throw new Error('CAS已失效'); },
    markCasExpiredFn: async () => calls.push('mark-cas-expired'),
    refreshAndSaveAuthStateFn: async () => { calls.push('refresh'); return { accessToken: 'new.access' }; },
    clearQrReminderScheduleFn: async () => calls.push('clear-schedule'),
    runLoginFn: async () => calls.push('qr'),
  });

  assert.deepEqual(calls, ['cas', 'mark-cas-expired', 'refresh', 'clear-schedule']);
  assert.equal(result.status, 'refresh_ok');
});

test('CAS已记录失效后renew跳过CAS并直接使用Refresh', async () => {
  const calls = [];
  const logs = [];
  const nowMs = Date.parse('2026-07-05T17:30:00+08:00');
  const authState = {
    refreshToken: makeJwt({ exp: nowMs / 1000 + 10 * 3600 }),
    accessToken: makeJwt({ exp: nowMs / 1000 + 12 * 3600 }),
  };
  const result = await runRenew({}, {
    nowFn: () => nowMs,
    readQrReminderStateFn: async () => ({ casExpired: true }),
    runSilentRenewFn: async () => calls.push('cas'),
    refreshAndSaveAuthStateFn: async () => { calls.push('refresh'); return { status: 'refresh_ok', authState }; },
    clearQrReminderScheduleFn: async () => calls.push('clear-schedule'),
    logFn: (message) => logs.push(message),
  });

  assert.deepEqual(calls, ['refresh', 'clear-schedule']);
  assert.equal(result.status, 'refresh_ok');
  assert.match(logs.join('\n'), /CAS：已失效，本次已跳过/);
  assert.match(logs.join('\n'), /Refresh Token：有效/);
  assert.match(logs.join('\n'), /Access Token：有效/);
});

test('CAS和Refresh都失效后renew根据最后一枚Access安排扫码', async () => {
  const calls = [];
  const logs = [];
  const result = await runRenew({ tokenPath: 'token.env' }, {
    nowFn: () => Date.parse('2026-07-04T15:30:00+08:00'),
    readQrReminderStateFn: async () => ({ casExpired: true }),
    runSilentRenewFn: async () => calls.push('cas'),
    refreshAndSaveAuthStateFn: async () => {
      calls.push('refresh');
      const error = new Error('Refresh已失效');
      error.httpStatus = 401;
      throw error;
    },
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-04T17:34:00+08:00') / 1000 }),
      refreshToken: '',
    }),
    saveQrReminderScheduleFn: async (_config, schedule) => {
      calls.push(`due:${new Date(schedule.dueAt).toISOString()}`);
      return schedule;
    },
    maybeRunScheduledQrFn: async () => { calls.push('check-qr'); return { status: 'qr_pending' }; },
    logFn: (message) => logs.push(message),
  });

  assert.deepEqual(calls, ['refresh', 'due:2026-07-04T09:00:00.000Z', 'check-qr']);
  assert.equal(result.status, 'qr_pending');
  assert.match(logs.join('\n'), /CAS：已失效，本次已跳过/);
  assert.match(logs.join('\n'), /Refresh Token：已失效/);
  assert.match(logs.join('\n'), /Access Token：有效/);
});

test('renew遇到Refresh服务器故障时不安排二维码', async () => {
  const calls = [];
  const error = new Error('authserver bad gateway');
  error.httpStatus = 502;

  await assert.rejects(
    runRenew({ tokenPath: 'token.env' }, {
      readQrReminderStateFn: async () => ({ casExpired: true }),
      refreshAndSaveAuthStateFn: async () => {
        calls.push('refresh');
        throw error;
      },
      readSavedAuthStateFn: async () => {
        calls.push('read-token');
        return {
          accessToken: makeJwt({ exp: Date.parse('2026-07-04T17:34:00+08:00') / 1000 }),
          refreshToken: '',
        };
      },
      saveQrReminderScheduleFn: async () => calls.push('schedule'),
      maybeRunScheduledQrFn: async () => calls.push('check-qr'),
      logFn: () => undefined,
    }),
    /authserver bad gateway/
  );

  assert.deepEqual(calls, ['refresh']);
});

test('clearBrowserAccessTokens removes saved CQU access token keys', async () => {
  const removed = [];
  const originalLocalStorage = global.localStorage;
  global.localStorage = {
    removeItem(key) {
      removed.push(key);
    },
  };

  try {
    await clearBrowserAccessTokens({
      evaluate: async (fn) => fn(),
    });
  } finally {
    global.localStorage = originalLocalStorage;
  }

  assert.deepEqual(removed, [
    'cqu_edu_ACCESS_TOKEN',
    'cqu_edu_REFRESH_TOKEN',
    'cqu_edu_TOKEN_EXPIRE',
    'cqu_edu_CURRENT_TOKEN',
    'cqu_edu_EXPIRE_ACCESS_TOKEN',
  ]);
});

test('navigateToLoginPage等待DOM完成而不是等待网络完全空闲', async () => {
  const calls = [];
  const page = {
    async goto(url, options) {
      calls.push({ url, options });
      return { ok: true };
    },
  };

  await navigateToLoginPage(page, 'https://zhjw.bbgu.edu.cn/workspace/home');

  assert.deepEqual(calls, [{
    url: 'https://zhjw.bbgu.edu.cn/workspace/home',
    options: { waitUntil: 'domcontentloaded', timeout: 60000 },
  }]);
});

test('extractAuthStateFromPage reads access and refresh tokens', async () => {
  const values = {
    cqu_edu_ACCESS_TOKEN: '"browser.access"',
    cqu_edu_REFRESH_TOKEN: '"browser.refresh"',
  };
  const page = {
    evaluate: async (fn) => {
      const previous = global.localStorage;
      global.localStorage = { getItem: (key) => values[key] || null };
      try {
        return fn();
      } finally {
        global.localStorage = previous;
      }
    },
  };

  assert.deepEqual(await extractAuthStateFromPage(page), {
    accessToken: 'browser.access',
    refreshToken: 'browser.refresh',
  });
});

test('saveBrowserAuthState persists access and refresh tokens together', async () => {
  const saved = [];
  const result = await saveBrowserAuthState({}, { tokenPath: 'token.env' }, {
    waitForAuthStateFn: async () => ({
      accessToken: 'browser.access',
      refreshToken: 'browser.refresh',
    }),
    saveAuthStateFn: async (filePath, state) => saved.push({ filePath, state }),
  });

  assert.deepEqual(result, {
    accessToken: 'browser.access',
    refreshToken: 'browser.refresh',
  });
  assert.deepEqual(saved, [{
    filePath: 'token.env',
    state: { accessToken: 'browser.access', refreshToken: 'browser.refresh' },
  }]);
});

test('requestRefreshedAuthState posts verified form and keeps old refresh token when omitted', async () => {
  const calls = [];
  const result = await requestRefreshedAuthState(
    { homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home' },
    { accessToken: 'old.access', refreshToken: 'old.refresh' },
    {
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'new.access', expires_in: 43200 }),
        };
      },
      timeoutMs: 50,
    }
  );

  assert.deepEqual(result, { accessToken: 'new.access', refreshToken: 'old.refresh' });
  assert.equal(calls[0].url, 'https://zhjw.bbgu.edu.cn/authserver/oauth/token');
  assert.match(calls[0].options.body, /grant_type=refresh_token/);
  assert.match(calls[0].options.body, /refresh_token=old.refresh/);
  assert.equal(calls[0].options.headers['content-type'], 'application/x-www-form-urlencoded');
});

test('Refresh内置请求失败后优先通过Mihomo代理HTTPS后备路径', async () => {
  const calls = [];
  const result = await requestRefreshedAuthState(
    {
      homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
      proxyServer: 'http://127.0.0.1:7890',
    },
    { accessToken: 'access.old.token', refreshToken: 'refresh.old.token' },
    {
      fetchFn: async () => {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
        throw error;
      },
      proxyHttpsRequestFn: async (url, options, proxyServer) => {
        calls.push({ url, options, proxyServer });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            access_token: 'access.new.token',
            refresh_token: 'refresh.new.token',
          }),
        };
      },
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://zhjw.bbgu.edu.cn/authserver/oauth/token');
  assert.equal(calls[0].proxyServer, 'http://127.0.0.1:7890');
  assert.match(calls[0].options.body, /grant_type=refresh_token/);
  assert.equal(result.accessToken, 'access.new.token');
  assert.equal(result.refreshToken, 'refresh.new.token');
});

test('requestRefreshedAuthState aborts a hanging refresh request', async () => {
  await assert.rejects(
    requestRefreshedAuthState(
      { homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home' },
      { accessToken: 'old.access', refreshToken: 'old.refresh' },
      {
        timeoutMs: 5,
        fetchFn: async (_url, options) => new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
      }
    ),
    { name: 'AbortError' }
  );
});

test('refreshAndSaveAuthState retries a transient failure and saves rotated tokens', async () => {
  let requestCalls = 0;
  const saved = [];
  const config = {
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    tokenPath: 'token.env',
    storageStatePath: 'storage.json',
  };

  const result = await refreshAndSaveAuthState(config, {
    readSavedAuthStateFn: async () => ({ accessToken: 'old.access', refreshToken: 'old.refresh' }),
    requestFn: async () => {
      requestCalls += 1;
      if (requestCalls === 1) throw new Error('temporary network failure');
      return { accessToken: 'new.access', refreshToken: 'new.refresh' };
    },
    saveAuthStateFn: async (filePath, state) => saved.push({ filePath, state }),
  });

  assert.equal(requestCalls, 2);
  assert.equal(config.authorization, 'Bearer new.access');
  assert.deepEqual(result.authState, { accessToken: 'new.access', refreshToken: 'new.refresh' });
  assert.deepEqual(saved, [{
    filePath: 'token.env',
    state: { accessToken: 'new.access', refreshToken: 'new.refresh' },
  }]);
});

test('refreshAndSaveAuthState retries HTTP 5xx once', async () => {
  let requestCalls = 0;
  const error = new Error('server unavailable');
  error.httpStatus = 503;

  await refreshAndSaveAuthState({
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    tokenPath: 'token.env',
    storageStatePath: 'storage.json',
  }, {
    readSavedAuthStateFn: async () => ({ accessToken: 'old.access', refreshToken: 'old.refresh' }),
    requestFn: async () => {
      requestCalls += 1;
      if (requestCalls === 1) throw error;
      return { accessToken: 'new.access', refreshToken: 'new.refresh' };
    },
    saveAuthStateFn: async () => undefined,
  });

  assert.equal(requestCalls, 2);
});

test('refreshAndSaveAuthState does not retry explicit HTTP 4xx', async () => {
  let requestCalls = 0;
  const error = new Error('invalid refresh token');
  error.httpStatus = 400;

  await assert.rejects(refreshAndSaveAuthState({
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    tokenPath: 'token.env',
    storageStatePath: 'storage.json',
  }, {
    readSavedAuthStateFn: async () => ({ accessToken: 'old.access', refreshToken: 'old.refresh' }),
    requestFn: async () => {
      requestCalls += 1;
      throw error;
    },
    saveAuthStateFn: async () => undefined,
  }), /invalid refresh token/);

  assert.equal(requestCalls, 1);
});

test('refreshAndSaveAuthState migrates refresh token from browser storage state', async () => {
  const saved = [];
  await refreshAndSaveAuthState({
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    tokenPath: 'token.env',
    storageStatePath: 'storage.json',
  }, {
    readSavedAuthStateFn: async () => ({ accessToken: 'file.access', refreshToken: '' }),
    readStorageStateFn: async () => ({
      origins: [{
        origin: 'https://zhjw.bbgu.edu.cn',
        localStorage: [{ name: 'cqu_edu_REFRESH_TOKEN', value: '"browser.refresh"' }],
      }],
    }),
    requestFn: async (_config, current) => {
      assert.deepEqual(current, { accessToken: 'file.access', refreshToken: 'browser.refresh' });
      return { accessToken: 'new.access', refreshToken: 'new.refresh' };
    },
    saveAuthStateFn: async (filePath, state) => saved.push({ filePath, state }),
  });

  assert.deepEqual(saved, [
    {
      filePath: 'token.env',
      state: { accessToken: 'file.access', refreshToken: 'browser.refresh' },
    },
    {
      filePath: 'token.env',
      state: { accessToken: 'new.access', refreshToken: 'new.refresh' },
    },
  ]);
});

test('isLikelyQrLoginUrl rejects ordinary login page images', () => {
  assert.equal(isLikelyQrLoginUrl('https://zhjw.bbgu.edu.cn/assets/login/1.jpg'), false);
  assert.equal(isLikelyQrLoginUrl('https://zhjw.bbgu.edu.cn/static/auth-background.jpg'), false);
  assert.equal(isLikelyQrLoginUrl('https://open.weixin.qq.com/connect/confirm?uuid=abc123'), true);
  assert.equal(isLikelyQrLoginUrl('https://example.com/cas/qrcode?state=abc123'), true);
});

test('extractWeixinQrInfoFromHtml parses WeChat qrconnect HTML', () => {
  const html = '<img class="js_qrcode_img web_qrcode_img" src="/connect/qrcode/081F0Nk32c8XFa15"><script>window.wx_errcode=408; uuid=081F0Nk32c8XFa15;</script>';
  assert.deepEqual(extractWeixinQrInfoFromHtml(html, 'https://open.weixin.qq.com/connect/qrconnect?appid=wx123'), {
    uuid: '081F0Nk32c8XFa15',
    qrImageUrl: 'https://open.weixin.qq.com/connect/qrcode/081F0Nk32c8XFa15',
    qrConfirmUrl: 'https://open.weixin.qq.com/connect/confirm?uuid=081F0Nk32c8XFa15',
  });
});

test('extractWeixinQrConnectUrlFromHtml parses combined login HTML', () => {
  const html = '<script>location.href="https://open.weixin.qq.com/connect/qrconnect?appid=wx123&amp;redirect_uri=https%3A%2F%2Fauthserver.bbgu.edu.cn%2Fcallback&amp;state=abc";</script>';
  assert.equal(
    extractWeixinQrConnectUrlFromHtml(html),
    'https://open.weixin.qq.com/connect/qrconnect?appid=wx123&redirect_uri=https%3A%2F%2Fauthserver.bbgu.edu.cn%2Fcallback&state=abc'
  );
});

test('selectChromiumExecutable prefers system Chromium on Alpine over Playwright glibc build', () => {
  const selected = selectChromiumExecutable({
    osRelease: 'NAME="Alpine Linux"\nID=alpine\n',
    homeDir: '/root',
    exists: (filePath) => [
      '/usr/bin/chromium',
      '/root/.cache/ms-playwright',
      '/root/.cache/ms-playwright/chromium-1228/chrome-linux/chrome',
    ].includes(filePath),
    readdir: () => ['chromium-1228'],
  });

  assert.equal(selected, '/usr/bin/chromium');
});

test('launchChromium将代理传给Playwright', async () => {
  const calls = [];
  await launchChromium({
    async launch(options) {
      calls.push(options);
      return { ok: true };
    },
  }, {
    headless: true,
    proxyServer: 'http://127.0.0.1:7890',
  });

  assert.deepEqual(calls[0].proxy, { server: 'http://127.0.0.1:7890' });
});
