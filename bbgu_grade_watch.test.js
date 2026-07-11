const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const fsSync = require('node:fs');

const bbguGradeWatch = require('./bbgu_grade_watch');
const {
  normalizeGradeRows,
  migrateSnapshotGradeKeys,
  diffGrades,
  formatGradeNotification,
  normalizeSubScoreList,
  mergePersistedSubScores,
  selectRowsForSubScoreFetch,
  enrichRowsWithSubScores,
  fetchBbguSubScores,
  diagnoseBbguSubscore,
  runSubscoreDiagnostic,
  requestJsonTextWithHttpsProxy,
  sendPushPlus,
  fetchWithTimeout,
  parseBooleanEnv,
  parsePositiveIntegerEnv,
  normalizeBbguScoreApiData,
  fetchBbguScoreRows,
  calculateTermArithmeticAverage,
  buildAuthorizationHeader,
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
  buildCasRenewUrl,
  isRecoverableNavigationAbort,
  isAuthExpiredResponse,
  parseSavedAuthState,
  extractAuthStateFromStorageState,
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
  recoverDirectApiAfterAuthExpired,
  maybeRunScheduledQr,
  requestJsonText,
  isNetworkTransportError,
  isSafeCasFailoverError,
  isSafeApiFailoverError,
  selectStartupProxy,
  withSingleProxyFailover,
  markWatchNetworkFailure,
  markSchoolBackoff,
  consumeSchoolBackoff,
  consumeWatchNetworkCooldown,
  run,
  runRenew,
  clearBrowserAccessTokens,
  sanitizeStorageStateForAccessRenewal,
  performSilentRenew,
  processGradeRows,
  navigateToLoginPage,
  waitForAuthenticationAfterQr,
  waitForAuthState,
  collectLoginQrArtifacts,
  shouldStartQrLogin,
  finalizeLoginReminderState,
  persistBrowserLoginState,
  validateBrowserHttpResponse,
  handleChromeErrorPage,
  readRefreshResponse,
} = bbguGradeWatch;

test('GitHub Workflow不预检学校端点并向脚本保存候选节点', () => {
  const workflow = fsSync.readFileSync(path.join(__dirname, '.github', 'workflows', 'bbgu.yml'), 'utf8');
  assert.doesNotMatch(workflow, /test_bbgu_proxy\s*\(\)/);
  assert.doesNotMatch(workflow, /api\/sam\/score\/student\/score/);
  assert.doesNotMatch(workflow, /open\.weixin\.qq\.com/);
  assert.match(workflow, /bbgu_proxy_candidates\.json/);
  assert.match(workflow, /BBGU_MIHOMO_CONTROLLER/);
  assert.match(workflow, /BBGU_MIHOMO_PROXY_GROUP/);
});

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

test('自动任务时间表合并Watch和Renew并保持时间顺序', () => {
  const now = Date.parse('2026-07-11T09:00:00+08:00');
  const runs = scheduledAutomaticRunsFrom(now, 1).slice(0, 4);
  assert.deepEqual(runs.map((item) => [item.mode, item.at]), [
    ['renew', Date.parse('2026-07-11T09:37:00+08:00')],
    ['watch', Date.parse('2026-07-11T10:07:00+08:00')],
    ['watch', Date.parse('2026-07-11T11:07:00+08:00')],
    ['renew', Date.parse('2026-07-11T11:37:00+08:00')],
  ]);
});

test('firstUncoveredGradeQuery返回Access到期后第一场Watch', () => {
  const now = Date.parse('2026-07-11T09:00:00+08:00');
  const expiry = Date.parse('2026-07-11T11:08:00+08:00') / 1000;
  assert.equal(
    firstUncoveredGradeQuery(expiry, now),
    Date.parse('2026-07-11T12:07:00+08:00')
  );
});

test('CAS失效后Access仍覆盖且后面还有机会时不提前Refresh', () => {
  const now = Date.parse('2026-07-11T11:37:00+08:00');
  assert.deepEqual(planRefreshAction({
    mode: 'renew',
    nowMs: now,
    accessExpiryEpochSeconds: Date.parse('2026-07-11T18:35:00+08:00') / 1000,
    refreshExpiryEpochSeconds: Date.parse('2026-07-11T20:35:00+08:00') / 1000,
  }), { action: 'WAIT', reason: 'later-opportunity' });
});

test('Access仍有效的后续Watch不算Refresh机会', () => {
  const now = Date.parse('2026-07-11T11:37:00+08:00');
  assert.deepEqual(planRefreshAction({
    mode: 'renew',
    nowMs: now,
    accessExpiryEpochSeconds: Date.parse('2026-07-11T13:00:00+08:00') / 1000,
    refreshExpiryEpochSeconds: Date.parse('2026-07-11T12:30:00+08:00') / 1000,
  }), { action: 'REFRESH_ACCESS', reason: 'last-beneficial-opportunity' });
});

test('未来Renew距离Refresh到期不足30分钟时当前任务提前刷新', () => {
  const now = Date.parse('2026-07-11T23:37:00+08:00');
  assert.deepEqual(planRefreshAction({
    mode: 'renew',
    nowMs: now,
    accessExpiryEpochSeconds: Date.parse('2026-07-11T23:40:00+08:00') / 1000,
    refreshExpiryEpochSeconds: Date.parse('2026-07-12T01:40:00+08:00') / 1000,
  }), { action: 'REFRESH_ACCESS', reason: 'last-beneficial-opportunity' });
});

test('未来Renew距离Refresh到期恰好30分钟时仍可等待', () => {
  const now = Date.parse('2026-07-11T23:37:00+08:00');
  assert.deepEqual(planRefreshAction({
    mode: 'renew',
    nowMs: now,
    accessExpiryEpochSeconds: Date.parse('2026-07-12T00:00:00+08:00') / 1000,
    refreshExpiryEpochSeconds: Date.parse('2026-07-12T02:07:00+08:00') / 1000,
  }), { action: 'WAIT', reason: 'later-opportunity' });
});

test('Access不能覆盖当前Watch时使用仍有效的Refresh', () => {
  const now = Date.parse('2026-07-11T19:07:00+08:00');
  assert.equal(planRefreshAction({
    mode: 'watch',
    nowMs: now,
    accessExpiryEpochSeconds: Date.parse('2026-07-11T18:35:00+08:00') / 1000,
    refreshExpiryEpochSeconds: Date.parse('2026-07-11T20:35:00+08:00') / 1000,
  }).action, 'REFRESH_ACCESS');
});

test('最后机会刷新不能增加Watch覆盖时跳过', () => {
  const now = Date.parse('2026-07-11T19:37:00+08:00');
  const result = planRefreshAction({
    mode: 'renew',
    nowMs: now,
    accessExpiryEpochSeconds: Date.parse('2026-07-12T08:30:00+08:00') / 1000,
    refreshExpiryEpochSeconds: Date.parse('2026-07-11T20:00:00+08:00') / 1000,
  });
  assert.deepEqual(result, { action: 'WAIT', reason: 'no-additional-watch' });
});

test('总决策层在退避CAS成绩和Refresh等待状态中只返回一个动作', () => {
  const now = Date.parse('2026-07-11T11:37:00+08:00');
  const hour = 60 * 60 * 1000;
  assert.equal(planAutomaticAction({
    mode: 'renew', nowMs: now, schoolBackoffUntil: now + 1,
  }).action, 'SKIP_BACKOFF');
  assert.equal(planAutomaticAction({
    mode: 'renew',
    nowMs: now,
    casExpired: false,
    hasAccessToken: true,
    hasRefreshToken: true,
  }).action, 'CAS_RENEW');
  assert.equal(planAutomaticAction({
    mode: 'watch',
    nowMs: now,
    casExpired: true,
    accessExpiryEpochSeconds: (now + hour) / 1000,
    refreshExpiryEpochSeconds: (now + 3 * hour) / 1000,
  }).action, 'QUERY_SCORE');
  assert.equal(planAutomaticAction({
    mode: 'renew',
    nowMs: now,
    casExpired: true,
    accessExpiryEpochSeconds: (now + 6 * hour) / 1000,
    refreshExpiryEpochSeconds: (now + 8 * hour) / 1000,
  }).action, 'WAIT_REFRESH_WINDOW');
  assert.equal(planAutomaticAction({
    mode: 'watch',
    nowMs: now,
    hasAccessToken: false,
    hasRefreshToken: false,
  }).action, 'QR_LOGIN');
});

test('总决策层对首次登录执行二维码冷却', () => {
  const now = Date.parse('2026-07-11T11:37:00+08:00');
  assert.equal(planAutomaticAction({
    mode: 'watch',
    nowMs: now,
    hasAccessToken: false,
    hasRefreshToken: false,
    qrLastPushedAt: now - 60 * 60 * 1000,
  }).action, 'WAIT_QR_DUE');
});

test('总决策层发现Token存在但JWT缺少exp时只报告本地状态损坏', () => {
  const now = Date.parse('2026-07-11T11:37:00+08:00');
  assert.equal(planAutomaticAction({
    mode: 'watch',
    nowMs: now,
    casExpired: true,
    hasAccessToken: true,
    hasRefreshToken: true,
    accessExpiryEpochSeconds: 0,
    refreshExpiryEpochSeconds: 0,
  }).action, 'FAIL_LOCAL_STATE');
});

test('白天Access过期时使用之前最后一个实际查询时刻作为扫码时间', () => {
  const now = Date.parse('2026-07-04T15:30:00+08:00');
  const expiry = Date.parse('2026-07-04T17:34:00+08:00') / 1000;
  const result = computeQrSchedule(expiry, now);

  assert.equal(result.dueAt, Date.parse('2026-07-04T17:07:00+08:00'));
  assert.equal(result.firstUncoveredQueryAt, Date.parse('2026-07-04T18:07:00+08:00'));
});

test('跨夜提醒移动到次日09:37', () => {
  const now = Date.parse('2026-07-04T23:30:00+08:00');
  const expiry = Date.parse('2026-07-05T09:34:00+08:00') / 1000;
  const result = computeQrSchedule(expiry, now);

  assert.equal(result.dueAt, Date.parse('2026-07-05T09:37:00+08:00'));
  assert.equal(result.firstUncoveredQueryAt, Date.parse('2026-07-05T10:07:00+08:00'));
  assert.equal(shouldPushQrNow({ nowMs: now, dueAtMs: result.dueAt, lastPushedAtMs: 0 }), false);
});

test('Access在10:34过期时等待10:07查询完成', () => {
  const now = Date.parse('2026-07-05T09:30:00+08:00');
  const expiry = Date.parse('2026-07-05T10:34:00+08:00') / 1000;
  const result = computeQrSchedule(expiry, now);

  assert.equal(result.dueAt, Date.parse('2026-07-05T10:07:00+08:00'));
  assert.equal(result.firstUncoveredQueryAt, Date.parse('2026-07-05T11:07:00+08:00'));
});

test('允许09:37首发、10:07补发以及之后两小时冷却', () => {
  const dueAt = Date.parse('2026-07-05T09:37:00+08:00');
  const firstPush = Date.parse('2026-07-05T09:37:00+08:00');
  const tenOClock = Date.parse('2026-07-05T10:07:00+08:00');

  assert.equal(shouldPushQrNow({ nowMs: firstPush, dueAtMs: dueAt, lastPushedAtMs: 0 }), true);
  assert.equal(shouldPushQrNow({ nowMs: tenOClock, dueAtMs: dueAt, lastPushedAtMs: firstPush }), true);
  assert.equal(shouldPushQrNow({ nowMs: Date.parse('2026-07-05T11:30:00+08:00'), dueAtMs: dueAt, lastPushedAtMs: tenOClock }), false);
  assert.equal(shouldPushQrNow({ nowMs: Date.parse('2026-07-05T12:07:00+08:00'), dueAtMs: dueAt, lastPushedAtMs: tenOClock }), true);
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
    await markRefreshExpired(config);
    let saved = await readQrReminderState(config);
    assert.equal(saved.accessExpiryEpochSeconds, first.accessExpiryEpochSeconds);
    assert.equal(saved.lastPushedAt, 0);
    assert.equal(saved.casExpired, true);
    assert.equal(saved.refreshExpired, true);

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
    { key: '2026春::高等数学', courseName: '高等数学', score: '95', credit: '4', term: '2026春' },
  ]);
});

test('二维码生成失败前不写入冷却时间', async () => {
  const calls = [];
  const nowMs = Date.parse('2026-07-05T10:07:00+08:00');

  await assert.rejects(
    maybeRunScheduledQr({}, {
      nowFn: () => nowMs,
      readQrReminderStateFn: async () => ({ dueAt: nowMs - 1, lastPushedAt: 0 }),
      saveQrReminderScheduleFn: async () => calls.push('save-cooldown'),
      runLoginFn: async () => {
        calls.push('login');
        throw new Error('二维码提取失败');
      },
    }),
    /二维码提取失败/
  );

  assert.deepEqual(calls, ['login']);
});

test('二维码发送成功后即使等待扫码超时也保留冷却时间', async () => {
  const calls = [];
  const nowMs = Date.parse('2026-07-05T10:07:00+08:00');

  await assert.rejects(
    maybeRunScheduledQr({}, {
      nowFn: () => nowMs,
      readQrReminderStateFn: async () => ({ dueAt: nowMs - 1, lastPushedAt: 0 }),
      saveQrReminderScheduleFn: async (_config, state) => calls.push(`save:${state.lastPushedAt}`),
      runLoginFn: async (_config, options) => {
        calls.push('login');
        await options.onQrSent();
        throw new Error('扫码超时');
      },
    }),
    /扫码超时/
  );

  assert.deepEqual(calls, ['login', `save:${nowMs}`]);
});

test('二维码登录因学校退避跳过时保留完整提醒状态', async () => {
  const calls = [];
  const nowMs = Date.parse('2026-07-05T10:07:00+08:00');
  const result = await maybeRunScheduledQr({}, {
    nowFn: () => nowMs,
    readQrReminderStateFn: async () => ({
      casExpired: true,
      refreshExpired: true,
      dueAt: nowMs - 1,
      lastPushedAt: 0,
    }),
    runLoginFn: async () => ({ status: 'school_backoff_skipped' }),
    clearQrReminderStateFn: async () => calls.push('clear'),
  });

  assert.deepEqual(result, { status: 'school_backoff_skipped' });
  assert.deepEqual(calls, []);
});

test('normalizeGradeRows builds stable keys with course code when present', () => {
  const rows = normalizeGradeRows([
    { courseCode: 'AI101', courseName: '人工智能公开课', score: '100', credit: '2', term: '2026春' },
  ]);

  assert.equal(rows[0].key, '2026春::AI101::人工智能公开课');
});

test('成绩键包含学期以区分重修课程', () => {
  const rows = normalizeGradeRows([
    { courseCode: 'A001', courseName: '高等数学', score: '80', term: '2025春' },
    { courseCode: 'A001', courseName: '高等数学', score: '90', term: '2026春' },
  ]);

  assert.deepEqual(rows.map((row) => row.key), [
    '2025春::A001::高等数学',
    '2026春::A001::高等数学',
  ]);
});

test('旧快照成绩键迁移后不会把现有成绩误报为新增', () => {
  const previous = migrateSnapshotGradeKeys([
    { key: 'A001::高等数学', courseName: '高等数学', score: '90', credit: '4', term: '2026春' },
  ]);
  const current = normalizeGradeRows([
    { courseCode: 'A001', courseName: '高等数学', score: '90', credit: '4', term: '2026春' },
  ]);

  assert.equal(previous[0].key, '2026春::A001::高等数学');
  assert.deepEqual(diffGrades(previous, current), { added: [], changed: [] });
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

test('sendPushPlus只接受明确的JSON业务成功响应', async (t) => {
  const invoke = (body, status = 200) => sendPushPlus({
    token: 'push-token',
    title: 'title',
    content: 'content',
    fetchFn: async () => new Response(body, { status }),
  });

  await t.test('接受数字200', async () => {
    await assert.doesNotReject(invoke('{"code":200,"msg":"success"}'));
  });
  await t.test('接受字符串200', async () => {
    await assert.doesNotReject(invoke('{"code":"200","msg":"success"}'));
  });
  await t.test('拒绝HTML 200', async () => {
    await assert.rejects(invoke('<html>upstream error</html>'), /PushPlus send failed/);
  });
  await t.test('拒绝缺少code', async () => {
    await assert.rejects(invoke('{"msg":"success"}'), /PushPlus send failed/);
  });
  await t.test('拒绝业务失败码', async () => {
    await assert.rejects(invoke('{"code":500,"msg":"failed"}'), /PushPlus send failed/);
  });
  await t.test('拒绝HTTP失败', async () => {
    await assert.rejects(invoke('{"code":200,"msg":"success"}', 503), /PushPlus send failed/);
  });
});

test('fetchWithTimeout会中止并拒绝超时请求', async () => {
  await assert.rejects(
    fetchWithTimeout(
      async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }),
      'https://example.test/hang',
      {},
      5,
      '测试请求'
    ),
    /测试请求在5毫秒后超时/
  );
});

test('sendPushPlus使用可配置超时', async () => {
  await assert.rejects(
    sendPushPlus({
      token: 'push-token',
      title: 'title',
      content: 'content',
      timeoutMs: 5,
      fetchFn: async (_url, options) => {
        if (!options.signal) throw new Error('PushPlus请求缺少AbortSignal');
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      },
    }),
    /PushPlus请求在5毫秒后超时/
  );
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

test('requestJsonText限制首选fetch请求时间', async () => {
  const previousGithubActions = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'true';
  try {
    await assert.rejects(
      requestJsonText('https://zhjw.bbgu.edu.cn/api/sam/score/student/score', {}, {
        timeoutMs: 5,
        fetchFn: async (_url, options) => {
          if (!options.signal) throw new Error('成绩请求缺少AbortSignal');
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          });
        },
      }),
      /成绩接口请求在5毫秒后超时/
    );
  } finally {
    if (previousGithubActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previousGithubActions;
  }
});

test('同一任务仅从粘性节点A切换一个候选B且成功后保存B', async () => {
  const calls = [];
  let attempts = 0;
  const result = await withSingleProxyFailover({ proxyServer: 'http://127.0.0.1:7890' }, async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error('target-tls: TLS handshake failed');
      error.code = 'EPROTO';
      error.stage = 'target-tls';
      throw error;
    }
    return 'ok';
  }, {
    readProxyRuntimeFn: async () => ({ current: 'CN-A', candidates: ['CN-A', 'CN-B', 'CN-C'] }),
    selectProxyFn: async (name) => calls.push(`select:${name}`),
    saveProxyFn: async (name) => calls.push(`save:${name}`),
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  assert.deepEqual(calls, ['select:CN-B', 'save:CN-B']);
});

test('候选节点B也网络失败时不遍历C并记录A和B失败', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbgu-proxy-failures-'));
  const calls = [];
  let attempts = 0;
  const config = {
    proxyServer: 'http://127.0.0.1:7890',
    proxyStatePath: path.join(tempDir, 'proxy-state.json'),
    proxyCandidatesPath: path.join(tempDir, 'proxy-candidates.json'),
  };
  try {
    await fs.writeFile(config.proxyStatePath, JSON.stringify({ selectedProxy: 'CN-A' }), 'utf8');
    await fs.writeFile(config.proxyCandidatesPath, JSON.stringify({ candidates: ['CN-A', 'CN-B', 'CN-C'] }), 'utf8');
    await assert.rejects(withSingleProxyFailover(config, async () => {
      attempts += 1;
      const error = new Error('target-tls: TLS handshake failed');
      error.code = 'EPROTO';
      error.stage = 'target-tls';
      throw error;
    }, {
      selectProxyFn: async (name) => calls.push(`select:${name}`),
      nowFn: () => 1000,
    }), (error) => error && error.code === 'BBGU_PROXY_FAILOVER_EXHAUSTED');

    const state = JSON.parse(await fs.readFile(config.proxyStatePath, 'utf8'));
    assert.equal(state.failedNodes['CN-A'], 1000 + 6 * 60 * 60 * 1000);
    assert.equal(state.failedNodes['CN-B'], 1000 + 6 * 60 * 60 * 1000);
    assert.equal(selectStartupProxy(state, ['CN-A', 'CN-B', 'CN-C'], 2000), 'CN-C');
    assert.equal(attempts, 2);
    assert.deepEqual(calls, ['select:CN-B']);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('整个任务只允许使用一次节点切换额度', async () => {
  const config = { proxyServer: 'http://127.0.0.1:7890' };
  const calls = [];
  let firstAttempts = 0;
  await withSingleProxyFailover(config, async () => {
    firstAttempts += 1;
    if (firstAttempts === 1) throw Object.assign(new Error('target-tls: TLS handshake failed'), { code: 'EPROTO', stage: 'target-tls' });
    return 'ok';
  }, {
    readProxyRuntimeFn: async () => ({ current: 'CN-A', candidates: ['CN-A', 'CN-B'] }),
    selectProxyFn: async (name) => calls.push(`select:${name}`),
    saveProxyFn: async (name) => calls.push(`save:${name}`),
  });

  let secondAttempts = 0;
  await assert.rejects(withSingleProxyFailover(config, async () => {
    secondAttempts += 1;
    throw Object.assign(new Error('target-tls: TLS handshake failed'), { code: 'EPROTO', stage: 'target-tls' });
  }, {
    readProxyRuntimeFn: async () => ({ current: 'CN-B', candidates: ['CN-A', 'CN-B'] }),
    selectProxyFn: async (name) => calls.push(`select:${name}`),
    saveProxyFn: async (name) => calls.push(`save:${name}`),
  }), (error) => error && error.code === 'BBGU_PROXY_FAILOVER_EXHAUSTED');

  assert.equal(secondAttempts, 1);
  assert.deepEqual(calls, ['select:CN-B', 'save:CN-B']);
});

test('HTTP业务错误不触发节点切换', async () => {
  let selected = 0;
  const error = new Error('HTTP 503');
  error.httpStatus = 503;
  await assert.rejects(withSingleProxyFailover({ proxyServer: 'http://127.0.0.1:7890' }, async () => {
    throw error;
  }, {
    readProxyRuntimeFn: async () => ({ current: 'CN-A', candidates: ['CN-A', 'CN-B'] }),
    selectProxyFn: async () => { selected += 1; },
  }), (caught) => caught === error);
  assert.equal(selected, 0);
  assert.equal(isNetworkTransportError(error), false);
});

test('CAS只在请求确定未到后端的建连错误时切换节点', () => {
  assert.equal(isSafeCasFailoverError(Object.assign(new Error('net::ERR_PROXY_CONNECTION_FAILED'), { code: 'ERR_PROXY_CONNECTION_FAILED' })), true);
  assert.equal(isSafeCasFailoverError(Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' })), true);
  assert.equal(isSafeCasFailoverError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), false);
  assert.equal(isSafeCasFailoverError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })), false);
});

test('成绩请求只在到达学校前的网络阶段切换节点', () => {
  assert.equal(isSafeApiFailoverError(Object.assign(new Error('proxy unavailable'), { stage: 'proxy-tcp', code: 'ECONNREFUSED' })), true);
  assert.equal(isSafeApiFailoverError(Object.assign(new Error('CONNECT failed'), { stage: 'connect', code: 'ECONNRESET' })), true);
  assert.equal(isSafeApiFailoverError(Object.assign(new Error('TLS failed'), { stage: 'target-tls', code: 'EPROTO' })), true);
  assert.equal(isSafeApiFailoverError(Object.assign(new Error('request reset'), { stage: 'request', code: 'ECONNRESET' })), false);
  assert.equal(isSafeApiFailoverError(Object.assign(new Error('body aborted'), { stage: 'response-body', code: 'ERR_HTTP_RESPONSE_ABORTED' })), false);
  assert.equal(isNetworkTransportError(Object.assign(new Error('response aborted'), { stage: 'response-body', code: 'ERR_HTTP_RESPONSE_ABORTED' })), true);
  assert.equal(isNetworkTransportError(Object.assign(new Error('response incomplete'), { stage: 'response-body', code: 'ERR_HTTP_RESPONSE_INCOMPLETE' })), true);
  assert.equal(isNetworkTransportError(new Error('Proxy refresh CONNECT timeout after 15000ms')), true);
  assert.equal(isNetworkTransportError(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), true);
});

test('Watch双节点失败后仅跳过下一次Watch', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbgu-watch-network-'));
  const config = { networkStatePath: path.join(tempDir, 'network.json') };
  try {
    await markWatchNetworkFailure(config, 1000);
    assert.equal(await consumeWatchNetworkCooldown(config), true);
    assert.equal(await consumeWatchNetworkCooldown(config), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('学校429按Retry-After退避且到期后恢复Watch', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbgu-school-backoff-'));
  const config = { networkStatePath: path.join(tempDir, 'network.json') };
  const error = Object.assign(new Error('HTTP 429'), { httpStatus: 429, retryAfter: '7200' });
  try {
    await markSchoolBackoff(config, error, 1000);
    assert.equal(await consumeSchoolBackoff(config, 1000 + 60 * 60 * 1000), true);
    assert.equal(await consumeSchoolBackoff(config, 1000 + 2 * 60 * 60 * 1000 + 1), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('500和503建立一小时全局退避而502和504不写状态', async () => {
  for (const status of [500, 503]) {
    const writes = [];
    assert.equal(await markSchoolBackoff(
      { networkStatePath: 'state.json' },
      { httpStatus: status },
      1000,
      {
        readJsonFn: async () => ({}),
        writeJsonFn: async (_filePath, value) => writes.push(value),
      }
    ), true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].schoolBackoffUntil, 1000 + 60 * 60 * 1000);
    assert.equal(writes[0].schoolBackoffStatus, status);
  }

  for (const status of [502, 504]) {
    assert.equal(await markSchoolBackoff(
      { networkStatePath: 'state.json' },
      { httpStatus: status },
      1000,
      {
        readJsonFn: async () => assert.fail('502/504 must not read backoff state'),
        writeJsonFn: async () => assert.fail('502/504 must not persist backoff'),
      }
    ), false);
  }
});

test('退避期间Watch和Renew都不访问学校', async () => {
  const calls = [];
  assert.equal((await run({}, {
    consumeSchoolBackoffFn: async () => true,
    consumeWatchNetworkCooldownFn: async () => {
      calls.push('watch-network-gate');
      return false;
    },
    runCoreFn: async () => calls.push('watch-school'),
  })).status, 'school_backoff_skipped');
  assert.equal((await runRenew({}, {
    consumeSchoolBackoffFn: async () => true,
    readQrReminderStateFn: async () => calls.push('renew-school'),
  })).status, 'school_backoff_skipped');
  assert.deepEqual(calls, []);
});

test('Renew的CAS学校错误只为429和500或503写全局退避', async () => {
  for (const status of [429, 500, 503, 502, 504]) {
    const calls = [];
    const error = Object.assign(new Error(`HTTP ${status}`), { httpStatus: status });
    await assert.rejects(runRenew({}, {
      consumeSchoolBackoffFn: async () => false,
      readQrReminderStateFn: async () => null,
      runSilentRenewFn: async () => { calls.push('cas'); throw error; },
      markSchoolBackoffFn: async () => calls.push('backoff'),
    }), (caught) => caught === error);
    assert.deepEqual(calls, [
      'cas',
      ...([429, 500, 503].includes(status) ? ['backoff'] : []),
    ]);
  }
});

test('学校503写入退避且不触发节点冷却', async () => {
  const calls = [];
  const error = Object.assign(new Error('BBGU score API failed HTTP 503'), { httpStatus: 503 });
  await assert.rejects(run({
    pushplusToken: 'push-token',
    term: '2026春',
    authorization: `Bearer ${makeJwt({ exp: 4102444800 })}`,
  }, {
    fetchScoreRowsFn: async () => { calls.push('fetch'); throw error; },
    consumeSchoolBackoffFn: async () => false,
    markSchoolBackoffFn: async (_config, caught) => calls.push(`backoff:${caught.httpStatus}`),
    markWatchNetworkFailureFn: async () => calls.push('network-backoff'),
  }), (caught) => caught === error);
  assert.deepEqual(calls, ['fetch', 'backoff:503']);
});

test('成绩接口错误保留HTTP状态和Retry-After', async () => {
  await assert.rejects(fetchBbguScoreRows({
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    authorization: 'Bearer saved.access',
    proxyServer: 'http://127.0.0.1:7890',
    term: '2026春',
  }, {
    withProxyFailoverFn: async (_config, operation) => operation(),
    proxyHttpsRequestFn: async () => ({
      status: 429,
      text: JSON.stringify({ status: 'fail', ok: false, msg: 'too many requests' }),
      headers: { 'retry-after': '3600' },
    }),
  }), (error) => error && error.httpStatus === 429 && error.retryAfter === '3600');
});

test('请求已发出后的网络失败不跨IP重试但仍安排Watch冷却', async () => {
  const calls = [];
  const config = {
    pushplusToken: 'push-token',
    term: '2026春',
    authorization: `Bearer ${makeJwt({ exp: 4102444800 })}`,
  };
  await assert.rejects(run(config, {
    fetchScoreRowsFn: async () => {
      calls.push('fetch');
      const error = Object.assign(new Error('response-body aborted'), {
        code: 'BBGU_PROXY_NETWORK_FAILED',
        stage: 'response-body',
      });
      throw error;
    },
    markWatchNetworkFailureFn: async () => calls.push('cooldown'),
  }), /response-body aborted/);
  assert.deepEqual(calls, ['fetch', 'cooldown']);
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
      key: '2026春::5600214a105::中外航海文化',
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

test('普通Watch的平时分在代理模式下直接使用原生HTTPS且只请求一次', async () => {
  const originalFetch = global.fetch;
  const originalGithubActions = process.env.GITHUB_ACTIONS;
  const proxyCalls = [];
  let genericCalls = 0;
  global.fetch = async () => {
    throw Object.assign(new TypeError('legacy fetch path must not run'), {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });
  };
  process.env.GITHUB_ACTIONS = 'true';

  try {
    const subScores = await fetchBbguSubScores('score-watch', {
      homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
      authorization: 'Bearer saved.access',
      proxyServer: 'http://127.0.0.1:7890',
    }, {
      requestJsonTextFn: async () => {
        genericCalls += 1;
        throw new Error('generic request path must not run');
      },
      proxyHttpsRequestFn: async (url, headers, proxyServer) => {
        proxyCalls.push({ url, headers, proxyServer });
        return {
          status: 200,
          text: JSON.stringify({
            status: 'success',
            data: { subScoreList: [{ scoreName: '平时成绩', weight: 15, score: 85 }] },
          }),
          via: 'proxy-https',
        };
      },
    });

    assert.deepEqual(subScores, [{ name: '平时成绩', weight: '15', score: '85' }]);
    assert.equal(genericCalls, 0);
    assert.equal(proxyCalls.length, 1);
    assert.equal(proxyCalls[0].url, 'https://zhjw.bbgu.edu.cn/api/sam/scoreManage/stu-score-form?scoreId=score-watch');
    assert.equal(proxyCalls[0].proxyServer, 'http://127.0.0.1:7890');
    assert.equal(proxyCalls[0].headers.authorization, 'Bearer saved.access');
  } finally {
    global.fetch = originalFetch;
    if (originalGithubActions === undefined) {
      delete process.env.GITHUB_ACTIONS;
    } else {
      process.env.GITHUB_ACTIONS = originalGithubActions;
    }
  }
});

test('普通Watch的成绩接口在代理模式下直接使用原生HTTPS且只请求一次', async () => {
  const proxyCalls = [];
  let genericCalls = 0;

  const rows = await fetchBbguScoreRows({
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    authorization: 'Bearer saved.access',
    proxyServer: 'http://127.0.0.1:7890',
    term: '2026春',
  }, {
    requestJsonTextFn: async () => {
      genericCalls += 1;
      throw new Error('generic request path must not run');
    },
    proxyHttpsRequestFn: async (url, headers, proxyServer) => {
      proxyCalls.push({ url, headers, proxyServer });
      return {
        status: 200,
        text: JSON.stringify({
          status: 'success',
          ok: true,
          data: {
            '2026春': {
              stuScoreHomePgVoS: [{
                courseName: '测试课程',
                courseCode: 'TEST001',
                sessionName: '2026春',
                scoreShow: '95',
              }],
            },
          },
        }),
        via: 'proxy-https',
      };
    },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].courseName, '测试课程');
  assert.equal(genericCalls, 0);
  assert.equal(proxyCalls.length, 1);
  assert.equal(proxyCalls[0].url, 'https://zhjw.bbgu.edu.cn/api/sam/score/student/score');
  assert.equal(proxyCalls[0].proxyServer, 'http://127.0.0.1:7890');
  assert.equal(proxyCalls[0].headers.authorization, 'Bearer saved.access');
});

test('平时分诊断在fetch连接重置后通过同一代理原生HTTPS重试', async () => {
  const logs = [];
  const proxyCalls = [];
  const accessToken = 'secret.access.token';
  const resetCause = Object.assign(new Error('read ECONNRESET'), {
    code: 'ECONNRESET',
    errno: -4077,
    syscall: 'read',
  });

  const result = await diagnoseBbguSubscore('score-1', {
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    authorization: `Bearer ${accessToken}`,
    proxyServer: 'http://127.0.0.1:7890',
  }, {
    fetchFn: async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: resetCause });
    },
    proxyHttpsRequestFn: async (url, headers, proxyServer) => {
      proxyCalls.push({ url, headers, proxyServer });
      return {
        status: 200,
        text: JSON.stringify({
          status: 'success',
          data: { subScoreList: [{ scoreName: '平时成绩', weight: 20, score: 88 }] },
        }),
        via: 'proxy-https',
      };
    },
    logFn: (message) => logs.push(String(message)),
  });

  assert.equal(result.transport, 'proxy-https');
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.subScores, [{ name: '平时成绩', weight: '20', score: '88' }]);
  assert.equal(proxyCalls.length, 1);
  assert.equal(proxyCalls[0].url, 'https://zhjw.bbgu.edu.cn/api/sam/scoreManage/stu-score-form?scoreId=score-1');
  assert.equal(proxyCalls[0].proxyServer, 'http://127.0.0.1:7890');
  assert.equal(proxyCalls[0].headers.authorization, `Bearer ${accessToken}`);
  assert.match(logs.join('\n'), /transport=fetch.*stage=fetch.*ECONNRESET/);
  assert.match(logs.join('\n'), /transport=proxy-https.*HTTP=200/);
  assert.equal(logs.join('\n').includes(accessToken), false);
});

test('平时分诊断收到HTTP响应时不重复请求同一接口', async () => {
  let proxyCalls = 0;

  await assert.rejects(diagnoseBbguSubscore('score-2', {
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    authorization: 'Bearer expired.access',
    proxyServer: 'http://127.0.0.1:7890',
  }, {
    fetchFn: async () => new Response(JSON.stringify({ status: 'error', message: 'unauthorized' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }),
    proxyHttpsRequestFn: async () => {
      proxyCalls += 1;
      throw new Error('must not retry an HTTP response');
    },
    logFn: () => undefined,
  }), (error) => error && error.code === 'BBGU_AUTH_EXPIRED');

  assert.equal(proxyCalls, 0);
});

test('平时分诊断不把HTTP响应正文写入错误', async () => {
  const responseSecret = 'Bearer response-body-secret';
  let proxyCalls = 0;

  await assert.rejects(diagnoseBbguSubscore('score-3', {
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    authorization: 'Bearer request-secret',
    proxyServer: 'http://127.0.0.1:7890',
  }, {
    fetchFn: async () => new Response(responseSecret, { status: 502 }),
    proxyHttpsRequestFn: async () => {
      proxyCalls += 1;
      throw new Error('must not retry an HTTP response');
    },
    logFn: () => undefined,
  }), (error) => {
    assert.equal(String(error && error.message).includes(responseSecret), false);
    assert.match(String(error && error.message), /HTTP 502.*bodyLength=/);
    return true;
  });

  assert.equal(proxyCalls, 0);
});

test('代理原生HTTPS在响应体中断时报告response-body阶段', async () => {
  const socket = new EventEmitter();
  socket.setTimeout = () => undefined;
  socket.destroy = () => undefined;
  socket.unshift = () => undefined;
  socket.write = () => queueMicrotask(() => {
    socket.emit('data', Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'));
  });

  const secureSocket = new EventEmitter();
  const response = new EventEmitter();
  response.statusCode = 200;
  response.complete = false;
  response.setEncoding = () => undefined;

  const request = new EventEmitter();
  request.destroy = (error) => request.emit('error', error);
  request.end = () => queueMicrotask(() => {
    response.emit('data', 'partial');
    response.emit('aborted');
    response.emit('close');
  });

  await assert.rejects(requestJsonTextWithHttpsProxy(
    'https://zhjw.bbgu.edu.cn/api/sam/scoreManage/stu-score-form?scoreId=score-4',
    { authorization: 'Bearer secret' },
    'http://127.0.0.1:7890',
    {
      netConnectFn: (_options, onConnect) => {
        queueMicrotask(onConnect);
        return socket;
      },
      tlsConnectFn: (_options, onSecure) => {
        queueMicrotask(onSecure);
        return secureSocket;
      },
      httpsRequestFn: (_options, onResponse) => {
        queueMicrotask(() => onResponse(response));
        return request;
      },
    }
  ), (error) => error && error.stage === 'response-body' && /aborted/i.test(error.message));
});

test('subscore-test自动选择最近失败课程且不要求PushPlus', async () => {
  const logs = [];
  const calls = [];
  const config = {
    tokenPath: 'token.env',
    snapshotPath: 'snapshot.json',
    authorization: '',
    pushplusToken: '',
  };

  const result = await runSubscoreDiagnostic(config, {
    readSavedAuthStateFn: async () => ({ accessToken: 'saved.access.token', refreshToken: '' }),
    readSnapshotFn: async () => [
      {
        courseName: '较早失败课程',
        scoreId: 'old-score',
        subScoreFetchError: 'fetch failed',
        subScoreFetchedAt: '2026-07-11T01:00:00.000Z',
      },
      {
        courseName: '传感器与测试技术',
        scoreId: 'new-score',
        subScoreFetchError: 'fetch failed',
        subScoreFetchedAt: '2026-07-11T02:00:00.000Z',
      },
    ],
    diagnoseSubscoreFn: async (scoreId, nextConfig) => {
      calls.push({ scoreId, authorization: nextConfig.authorization });
      return { transport: 'proxy-https', httpStatus: 200, subScores: [] };
    },
    logFn: (message) => logs.push(String(message)),
  });

  assert.deepEqual(calls, [{ scoreId: 'new-score', authorization: 'Bearer saved.access.token' }]);
  assert.equal(result.status, 'subscore_diagnostic_ok');
  assert.equal(result.courseName, '传感器与测试技术');
  assert.equal(logs.join('\n').includes('saved.access.token'), false);
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

    assert.deepEqual(result, { fetched: 0, failed: 0, skipped: 0, globalError: null });
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

test('全局熔断未请求课程仅在后续成绩变化时允许补查', () => {
  const deferred = {
    key: 'A',
    courseName: 'A',
    score: '90',
    scoreId: '1',
    subScoreFetchError: '本次因全局异常跳过',
  };
  const [current] = mergePersistedSubScores([deferred], [{
    key: 'A', courseName: 'A', score: '91', scoreId: '1',
  }]);
  assert.equal(current.subScoreFetchError, undefined);
  assert.deepEqual(selectRowsForSubScoreFetch({
    added: [],
    changed: [{ before: deferred, after: current }],
  }), [current]);
});

test('平时分第一门429后不请求剩余课程', async () => {
  const calls = [];
  const rows = [
    { key: 'a', courseName: 'A', scoreId: '1' },
    { key: 'b', courseName: 'B', scoreId: '2' },
    { key: 'c', courseName: 'C', scoreId: '3' },
  ];
  const error = Object.assign(new Error('rate limited'), {
    httpStatus: 429,
    retryAfter: '3600',
  });
  const result = await enrichRowsWithSubScores(
    { added: rows, changed: [] },
    {},
    async (scoreId) => {
      calls.push(scoreId);
      throw error;
    }
  );
  assert.deepEqual(calls, ['1']);
  assert.equal(result.globalError, error);
  assert.equal(result.skipped, 2);
  assert.match(rows[1].subScoreFetchError, /全局异常跳过/);
  assert.equal(rows[1].subScoreFetchedAt, undefined);
});

test('平时分第一门返回非JSON 401后停止请求剩余课程', async () => {
  const calls = [];
  const rows = [
    { key: 'a', courseName: 'A', scoreId: '1' },
    { key: 'b', courseName: 'B', scoreId: '2' },
    { key: 'c', courseName: 'C', scoreId: '3' },
  ];
  const config = { homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home' };
  const result = await enrichRowsWithSubScores(
    { added: rows, changed: [] },
    config,
    async (scoreId) => {
      calls.push(scoreId);
      return fetchBbguSubScores(scoreId, config, {
        requestJsonTextFn: async () => ({
          status: 401,
          text: '<html>统一身份认证</html>',
          headers: {},
        }),
      });
    }
  );

  assert.deepEqual(calls, ['1']);
  assert.equal(result.globalError.code, 'BBGU_AUTH_EXPIRED');
  assert.equal(result.skipped, 2);
});

test('平时分HTTP 200登录页按认证失效全局熔断', async () => {
  await assert.rejects(fetchBbguSubScores('1', {
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
  }, {
    requestJsonTextFn: async () => ({
      status: 200,
      text: '<html><title>扫码登录</title></html>',
      headers: {},
    }),
  }), (error) => error && error.code === 'BBGU_AUTH_EXPIRED');
});

test('平时分非JSON响应停止请求剩余课程', async () => {
  for (const response of [
    { status: 200, text: '<html>系统维护中</html>', headers: {} },
    { status: 404, text: '<html>Not Found</html>', headers: {} },
  ]) {
    const calls = [];
    const rows = ['1', '2', '3'].map((scoreId) => ({
      key: scoreId,
      courseName: scoreId,
      scoreId,
    }));
    const config = { homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home' };
    const result = await enrichRowsWithSubScores(
      { added: rows, changed: [] },
      config,
      async (scoreId) => {
        calls.push(scoreId);
        return fetchBbguSubScores(scoreId, config, {
          requestJsonTextFn: async () => response,
        });
      }
    );
    assert.deepEqual(calls, ['1']);
    assert.equal(result.globalError.code, 'BBGU_SUBSCORE_PROTOCOL_ERROR');
    assert.equal(result.skipped, 2);
  }
});

test('平时分403权限失败停止请求剩余课程', async () => {
  const calls = [];
  const rows = ['1', '2', '3'].map((scoreId) => ({ key: scoreId, courseName: scoreId, scoreId }));
  const error = Object.assign(new Error('permission denied'), { httpStatus: 403 });
  const result = await enrichRowsWithSubScores(
    { added: rows, changed: [] },
    {},
    async (scoreId) => {
      calls.push(scoreId);
      throw error;
    }
  );
  assert.deepEqual(calls, ['1']);
  assert.equal(result.globalError, error);
  assert.equal(result.skipped, 2);
});

test('平时分课程级无明细错误继续下一门', async () => {
  const calls = [];
  const rows = [
    { key: 'a', courseName: 'A', scoreId: '1' },
    { key: 'b', courseName: 'B', scoreId: '2' },
  ];
  const result = await enrichRowsWithSubScores(
    { added: rows, changed: [] },
    {},
    async (scoreId) => {
      calls.push(scoreId);
      if (scoreId === '1') {
        throw Object.assign(new Error('no detail'), { code: 'BBGU_SUBSCORE_NOT_AVAILABLE' });
      }
      return [{ name: '平时成绩', score: '90' }];
    }
  );
  assert.deepEqual(calls, ['1', '2']);
  assert.equal(result.fetched, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.globalError, null);
});

test('平时分HTTP错误保留状态码和Retry-After', async () => {
  await assert.rejects(fetchBbguSubScores('score-429', {
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    authorization: 'Bearer saved.access',
  }, {
    requestJsonTextFn: async () => ({
      status: 429,
      text: JSON.stringify({ status: 'error', message: 'rate limited' }),
      headers: { 'retry-after': '3600' },
    }),
  }), (error) => error && error.httpStatus === 429 && error.retryAfter === '3600');
});

test('平时分全局错误先持久化成绩和通知再向顶层抛出', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbgu-subscore-fuse-'));
  const calls = [];
  const globalError = Object.assign(new Error('rate limited'), { httpStatus: 429 });
  const config = {
    snapshotPath: path.join(tempDir, 'snapshot.json'),
    pendingNotificationPath: path.join(tempDir, 'pending.json'),
    term: '2026春',
  };
  try {
    await assert.rejects(processGradeRows([
      { key: 'A', courseName: 'A', score: '99', term: '2026春', scoreId: '1' },
    ], config, {
      enrichRowsWithSubScoresFn: async (diff) => {
        calls.push('subscore');
        diff.added[0].subScores = [{ name: '平时成绩', score: '90' }];
        return { fetched: 1, failed: 0, skipped: 0, globalError };
      },
      writeSnapshotFn: async () => calls.push('snapshot'),
      sendPushPlusFn: async () => calls.push('push'),
    }), (error) => error === globalError);
    assert.deepEqual(calls, ['subscore', 'snapshot', 'push']);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('自动任务学校请求预算矩阵精确匹配', async (t) => {
  const zero = () => ({ cas: 0, refresh: 0, score: 0, subscore: 0 });
  const cases = [
    {
      name: 'CAS成功',
      expected: { cas: 1, refresh: 0, score: 0, subscore: 0 },
      execute: async (count) => runRenew({ tokenPath: 'token.env' }, {
        consumeSchoolBackoffFn: async () => false,
        readQrReminderStateFn: async () => null,
        runSilentRenewFn: async () => { count.cas += 1; return { status: 'renew_ok' }; },
        readSavedAuthStateFn: async () => ({
          accessToken: makeJwt({ exp: 4102444800 }),
          refreshToken: makeJwt({ exp: 4102452000 }),
        }),
        clearQrReminderStateFn: async () => undefined,
        logFn: () => undefined,
      }),
    },
    {
      name: 'CAS已死等待刷新窗口',
      expected: { cas: 0, refresh: 0, score: 0, subscore: 0 },
      execute: async (count) => {
        const now = Date.parse('2026-07-11T11:37:00+08:00');
        return runRenew({ tokenPath: 'token.env' }, {
          nowFn: () => now,
          consumeSchoolBackoffFn: async () => false,
          readQrReminderStateFn: async () => ({ casExpired: true }),
          readSavedAuthStateFn: async () => ({
            accessToken: makeJwt({ exp: Date.parse('2026-07-11T18:35:00+08:00') / 1000 }),
            refreshToken: makeJwt({ exp: Date.parse('2026-07-11T20:35:00+08:00') / 1000 }),
          }),
          refreshAndSaveAuthStateFn: async () => { count.refresh += 1; },
          logFn: () => undefined,
        });
      },
    },
    {
      name: 'CAS已死最后有益窗口',
      expected: { cas: 0, refresh: 1, score: 0, subscore: 0 },
      execute: async (count) => {
        const now = Date.parse('2026-07-11T23:37:00+08:00');
        return runRenew({ tokenPath: 'token.env' }, {
          nowFn: () => now,
          consumeSchoolBackoffFn: async () => false,
          readQrReminderStateFn: async () => ({ casExpired: true }),
          readSavedAuthStateFn: async () => ({
            accessToken: makeJwt({ exp: Date.parse('2026-07-11T21:50:00+08:00') / 1000 }),
            refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
          }),
          refreshAndSaveAuthStateFn: async () => {
            count.refresh += 1;
            return { authState: {
              accessToken: makeJwt({ exp: Date.parse('2026-07-12T11:37:00+08:00') / 1000 }),
              refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
            } };
          },
          clearQrReminderScheduleFn: async () => undefined,
          logFn: () => undefined,
        });
      },
    },
    {
      name: 'Watch无变化',
      expected: { cas: 0, refresh: 0, score: 1, subscore: 0 },
      execute: async (count) => run({
        pushplusToken: 'push',
        term: '2026春',
        authorization: `Bearer ${makeJwt({ exp: 4102444800 })}`,
      }, {
        consumeSchoolBackoffFn: async () => false,
        consumeWatchNetworkCooldownFn: async () => false,
        fetchScoreRowsFn: async () => { count.score += 1; return [{ key: 'A' }]; },
        processGradeRowsFn: async () => ({ status: 'ok' }),
        maybeRunScheduledQrFn: async () => undefined,
      }),
    },
    {
      name: 'Watch新增三门',
      expected: { cas: 0, refresh: 0, score: 1, subscore: 3 },
      execute: async (count) => run({
        pushplusToken: 'push',
        term: '2026春',
        authorization: `Bearer ${makeJwt({ exp: 4102444800 })}`,
      }, {
        consumeSchoolBackoffFn: async () => false,
        consumeWatchNetworkCooldownFn: async () => false,
        fetchScoreRowsFn: async () => {
          count.score += 1;
          return ['1', '2', '3'].map((scoreId) => ({ key: scoreId, courseName: scoreId, scoreId }));
        },
        processGradeRowsFn: async (rows) => enrichRowsWithSubScores(
          { added: rows, changed: [] },
          {},
          async () => { count.subscore += 1; return []; }
        ),
        maybeRunScheduledQrFn: async () => undefined,
      }),
    },
    {
      name: '第一门平时分503',
      expected: { cas: 0, refresh: 0, score: 1, subscore: 1 },
      execute: async (count) => run({
        pushplusToken: 'push',
        term: '2026春',
        authorization: `Bearer ${makeJwt({ exp: 4102444800 })}`,
      }, {
        consumeSchoolBackoffFn: async () => false,
        consumeWatchNetworkCooldownFn: async () => false,
        fetchScoreRowsFn: async () => {
          count.score += 1;
          return ['1', '2', '3'].map((scoreId) => ({ key: scoreId, courseName: scoreId, scoreId }));
        },
        processGradeRowsFn: async (rows) => enrichRowsWithSubScores(
          { added: rows, changed: [] },
          {},
          async () => {
            count.subscore += 1;
            throw Object.assign(new Error('unavailable'), { httpStatus: 503 });
          }
        ),
        maybeRunScheduledQrFn: async () => undefined,
      }),
    },
    {
      name: '退避期',
      expected: { cas: 0, refresh: 0, score: 0, subscore: 0 },
      execute: async (count) => run({}, {
        consumeSchoolBackoffFn: async () => true,
        runCoreFn: async () => { count.score += 1; },
      }),
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const actual = zero();
      await item.execute(actual);
      assert.deepEqual(actual, item.expected);
    });
  }
});

test('PushPlus失败后保存快照和待推送内容且下次不重复查询平时分', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbgu-pending-push-'));
  const config = {
    term: '2026春',
    pushplusToken: 'push-token',
    snapshotPath: path.join(tempDir, 'snapshot.json'),
    pendingNotificationPath: path.join(tempDir, 'pending.json'),
  };
  const rows = [{
    key: '2026春::TEST001::测试课程',
    courseName: '测试课程',
    scoreId: 'score-1',
    score: '95',
    credit: '1.0',
    term: '2026春',
  }];
  let subscoreFetches = 0;
  let pushAttempts = 0;

  try {
    await assert.rejects(processGradeRows(rows, config, {
      enrichRowsWithSubScoresFn: async (diff) => {
        subscoreFetches += 1;
        diff.added[0].subScores = [{ name: '平时成绩', weight: '30', score: '90' }];
      },
      sendPushPlusFn: async () => {
        pushAttempts += 1;
        throw new Error('PushPlus unavailable');
      },
    }), /PushPlus unavailable/);

    assert.equal(subscoreFetches, 1);
    assert.equal(pushAttempts, 1);
    assert.equal((await JSON.parse(await fs.readFile(config.snapshotPath, 'utf8'))).length, 1);
    assert.equal((await JSON.parse(await fs.readFile(config.pendingNotificationPath, 'utf8'))).items.length, 1);

    await processGradeRows(rows, config, {
      enrichRowsWithSubScoresFn: async () => { subscoreFetches += 1; },
      sendPushPlusFn: async () => { pushAttempts += 1; },
    });

    assert.equal(subscoreFetches, 1);
    assert.equal(pushAttempts, 2);
    await assert.rejects(fs.access(config.pendingNotificationPath), { code: 'ENOENT' });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('快照首次写入失败后复用待推送内容且不重复查询平时分', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbgu-pending-snapshot-'));
  const config = {
    term: '2026春',
    pushplusToken: 'push-token',
    snapshotPath: path.join(tempDir, 'snapshot.json'),
    pendingNotificationPath: path.join(tempDir, 'pending.json'),
  };
  const rows = [{
    key: '2026春::TEST001::测试课程',
    courseName: '测试课程',
    scoreId: 'score-1',
    score: '95',
    credit: '1.0',
    term: '2026春',
  }];
  let subscoreFetches = 0;
  let pushAttempts = 0;
  let snapshotWrites = 0;

  try {
    await assert.rejects(processGradeRows(rows, config, {
      enrichRowsWithSubScoresFn: async (diff) => {
        subscoreFetches += 1;
        diff.added[0].subScores = [{ name: '平时成绩', weight: '30', score: '90' }];
      },
      sendPushPlusFn: async () => { pushAttempts += 1; },
      writeSnapshotFn: async () => {
        snapshotWrites += 1;
        throw new Error('snapshot write failed');
      },
    }), /snapshot write failed/);

    assert.equal(subscoreFetches, 1);
    assert.equal(pushAttempts, 0);
    assert.equal((await JSON.parse(await fs.readFile(config.pendingNotificationPath, 'utf8'))).items.length, 1);

    await processGradeRows(rows, config, {
      enrichRowsWithSubScoresFn: async () => { subscoreFetches += 1; },
      sendPushPlusFn: async () => { pushAttempts += 1; },
      writeSnapshotFn: async (filePath, value) => {
        snapshotWrites += 1;
        await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      },
    });

    assert.equal(subscoreFetches, 1);
    assert.equal(pushAttempts, 1);
    assert.equal(snapshotWrites, 2);
    assert.equal((await JSON.parse(await fs.readFile(config.snapshotPath, 'utf8'))).length, 1);
    await assert.rejects(fs.access(config.pendingNotificationPath), { code: 'ENOENT' });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('扫码流程不主动补请求combinedLogin或qrconnect', () => {
  const source = fsSync.readFileSync(path.join(__dirname, 'bbgu_grade_watch.js'), 'utf8');
  assert.doesNotMatch(source, /weixinQrCapture\.wait\(5000\)\s*\|\|\s*await fetchWeixinQrInfoFromPage/);
  assert.doesNotMatch(source, /async function fetchWeixinQrInfoFromPage/);
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
  assert.equal(isAuthExpiredResponse({ httpStatus: 403, text: '{"ok":false,"msg":"forbidden"}', body: { ok: false, msg: 'forbidden' } }), false);
  assert.equal(isAuthExpiredResponse({ httpStatus: 403, text: '<html>Please login through the campus network</html>', body: null }), false);
  assert.equal(isAuthExpiredResponse({ httpStatus: 429, text: '{"ok":false,"msg":"too many requests"}', body: { ok: false, msg: 'too many requests' } }), false);
  assert.equal(isAuthExpiredResponse({ httpStatus: 403, text: '{"ok":false,"msg":"token expired"}', body: { ok: false, msg: 'token expired' } }), true);
  assert.equal(isAuthExpiredResponse({ httpStatus: 302, text: '', body: null, headers: { location: 'https://authserver.bbgu.edu.cn/login' } }), true);
  assert.equal(isAuthExpiredResponse({ httpStatus: 302, text: '', body: null, headers: { location: 'https://example.com/maintenance' } }), false);
});

test('成绩接口将明确指向CAS的重定向交给认证恢复', async () => {
  await assert.rejects(fetchBbguScoreRows({
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    authorization: 'Bearer saved.access',
    proxyServer: 'http://127.0.0.1:7890',
    term: '2026春',
  }, {
    withProxyFailoverFn: async (_config, operation) => operation(),
    proxyHttpsRequestFn: async () => ({
      status: 302,
      text: '',
      headers: { location: 'https://authserver.bbgu.edu.cn/login?service=sam' },
    }),
  }), (error) => error && error.code === 'BBGU_AUTH_EXPIRED');
});

test('原子写入失败时保留旧文件并清理临时文件', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbgu-atomic-write-'));
  const targetPath = path.join(tempDir, 'state.json');
  try {
    await fs.writeFile(targetPath, 'old', 'utf8');
    await assert.rejects(writeFileAtomic(targetPath, 'new', {
      writeFileFn: async (tempPath) => {
        await fs.writeFile(tempPath, 'partial', 'utf8');
        throw new Error('interrupted');
      },
    }), /interrupted/);
    assert.equal(await fs.readFile(targetPath, 'utf8'), 'old');
    assert.deepEqual(await fs.readdir(tempDir), ['state.json']);

    await writeFileAtomic(targetPath, 'new');
    assert.equal(await fs.readFile(targetPath, 'utf8'), 'new');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('浏览器状态写入失败时保留旧状态文件', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbgu-atomic-browser-'));
  const targetPath = path.join(tempDir, 'storage.json');
  try {
    await fs.writeFile(targetPath, '{"old":true}', 'utf8');
    await assert.rejects(saveBrowserStorageState({
      storageState: async () => ({ cookies: [], origins: [] }),
    }, targetPath, { homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home' }, {
      writeFileFn: async (tempPath) => {
        await fs.writeFile(tempPath, '{"partial":', 'utf8');
        throw new Error('browser state interrupted');
      },
    }), /browser state interrupted/);
    assert.equal(await fs.readFile(targetPath, 'utf8'), '{"old":true}');
    assert.deepEqual(await fs.readdir(tempDir), ['storage.json']);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('扫码后Access已出现时不依赖页面文字继续等待', async () => {
  let waits = 0;
  const result = await waitForAuthenticationAfterQr({
    waitForTimeout: async () => { waits += 1; },
  }, { loginWaitSeconds: 300 }, {
    extractAuthStateFn: async () => ({ accessToken: 'new.access', refreshToken: '' }),
    isAuthenticatedFn: async () => false,
    nowFn: (() => { let now = 0; return () => now += 5000; })(),
  });
  assert.equal(result, true);
  assert.equal(waits, 0);
});

test('二维码已被捕获时不固定额外等待五秒', async () => {
  let waits = 0;
  let screenshots = 0;
  const result = await collectLoginQrArtifacts({}, {}, {
    get: () => ({ qrImageUrl: 'https://open.weixin.qq.com/connect/qrcode/test' }),
    wait: async () => { waits += 1; return null; },
  }, {
    saveQrElementScreenshotFn: async () => { screenshots += 1; return 'qr.png'; },
  });
  assert.equal(waits, 0);
  assert.equal(screenshots, 1);
  assert.equal(result.qrElementScreenshotPath, 'qr.png');
  assert.equal(result.weixinQrInfo.qrImageUrl, 'https://open.weixin.qq.com/connect/qrcode/test');
});

test('Access出现后只给Refresh一个短宽限期', async () => {
  let now = 0;
  let reads = 0;
  const page = {
    evaluate: async () => {
      reads += 1;
      return { accessToken: 'new.access', refreshToken: '' };
    },
    waitForTimeout: async (milliseconds) => { now += milliseconds; },
  };
  const result = await waitForAuthState(page, 30000, {
    nowFn: () => now,
    refreshGraceMs: 2000,
  });
  assert.deepEqual(result, { accessToken: 'new.access', refreshToken: '' });
  assert.equal(reads, 2);
  assert.equal(now, 2000);
});

test('默认等待足够时间接收晚于Access写入的新Refresh', async () => {
  let now = 0;
  const page = {
    evaluate: async () => ({
      accessToken: 'new.access',
      refreshToken: now >= 6000 ? 'new.refresh' : '',
    }),
    waitForTimeout: async (milliseconds) => { now += milliseconds; },
  };

  const result = await waitForAuthState(page, 30000, { nowFn: () => now });
  assert.deepEqual(result, { accessToken: 'new.access', refreshToken: 'new.refresh' });
  assert.equal(now, 6000);
});

test('自动登录接受导航后新生成的Access而不进入二维码流程', async () => {
  const shouldStart = await shouldStartQrLogin({}, {
    extractAuthStateFn: async () => ({ accessToken: 'new.access', refreshToken: '' }),
    isAuthenticatedFn: async () => false,
  });
  assert.equal(shouldStart, false);
});

test('已确认失效的旧Refresh不会在登录后复活', async () => {
  const saved = [];
  const result = await saveBrowserAuthState({}, { tokenPath: 'token.env' }, {
    waitForAuthStateFn: async () => ({ accessToken: 'new.access', refreshToken: '' }),
    readSavedAuthStateFn: async () => ({ accessToken: 'old.access', refreshToken: 'dead.refresh' }),
    readQrReminderStateFn: async () => ({ refreshExpired: true }),
    saveAuthStateFn: async (_filePath, state) => saved.push(state),
  });
  assert.deepEqual(result, { accessToken: 'new.access', refreshToken: '' });
  assert.deepEqual(saved, [{ accessToken: 'new.access', refreshToken: '' }]);
});

test('新Access曾被拒绝时CAS不得复活产生坏Access的旧Refresh', async () => {
  const saved = [];
  const result = await saveBrowserAuthState({}, { tokenPath: 'token.env' }, {
    waitForAuthStateFn: async () => ({ accessToken: 'cas.new.access', refreshToken: '' }),
    readSavedAuthStateFn: async () => ({ accessToken: 'rejected.access', refreshToken: 'old.refresh' }),
    readQrReminderStateFn: async () => ({ accessRejectedAfterRefresh: true }),
    saveAuthStateFn: async (_filePath, state) => saved.push(state),
  });
  assert.deepEqual(result, { accessToken: 'cas.new.access', refreshToken: '' });
  assert.deepEqual(saved, [{ accessToken: 'cas.new.access', refreshToken: '' }]);
});

test('登录没有取得新Refresh时保留Refresh失效标记并清除旧二维码计划', async () => {
  const writes = [];
  await finalizeLoginReminderState({ qrReminderStatePath: 'qr.json' }, {
    accessToken: 'new.access',
    refreshToken: '',
  }, {
    clearQrReminderStateFn: async () => writes.push('clear'),
    writeJsonFn: async (_filePath, state) => writes.push(state),
  });
  assert.deepEqual(writes, [{ refreshExpired: true }]);
});

test('扫码取得新Token后先更新认证标记再保存浏览器状态', async () => {
  const calls = [];
  const storageError = new Error('storage write failed');
  assert.equal(typeof persistBrowserLoginState, 'function');
  await assert.rejects(persistBrowserLoginState({}, {}, {}, {
    saveBrowserAuthStateFn: async () => {
      calls.push('token');
      return { accessToken: 'new.access', refreshToken: 'new.refresh' };
    },
    finalizeLoginReminderStateFn: async () => calls.push('state'),
    saveBrowserStorageStateFn: async () => {
      calls.push('storage');
      throw storageError;
    },
  }), (error) => error === storageError);
  assert.deepEqual(calls, ['token', 'state', 'storage']);
});

test('计划二维码登录成功后不二次清除登录流程保留的认证标记', async () => {
  const calls = [];
  const now = Date.parse('2026-07-11T12:07:00+08:00');
  const result = await maybeRunScheduledQr({}, {
    nowFn: () => now,
    readQrReminderStateFn: async () => ({ dueAt: now - 1 }),
    runLoginFn: async () => ({ status: 'login_ok' }),
    clearQrReminderStateFn: async () => calls.push('clear'),
  });
  assert.equal(result.status, 'login_ok');
  assert.deepEqual(calls, []);
});

test('chrome-error登录页记录当前节点网络失败并终止登录', async () => {
  const calls = [];
  await assert.rejects(handleChromeErrorPage({
    url: () => 'chrome-error://chromewebdata/',
  }, {}, {
    recordCurrentProxyFailureFn: async (error) => calls.push(['proxy', error.code]),
    saveLoginTimeoutDiagnosticsFn: async () => ({ reportPath: 'report.json', screenshotPath: 'screen.png' }),
  }), (error) => {
    assert.equal(error.code, 'BBGU_PROXY_NETWORK_FAILED');
    assert.match(error.message, /report\.json/);
    return true;
  });
  assert.deepEqual(calls, [['proxy', 'BBGU_PROXY_NETWORK_FAILED']]);
});

test('静默CAS落入chrome-error时记录节点并立即停止', async () => {
  const calls = [];
  const page = {
    goto: async () => null,
    url: () => 'chrome-error://chromewebdata/',
  };
  await assert.rejects(performSilentRenew({
    route: async () => undefined,
    newPage: async () => page,
  }, {}, {
    withProxyFailoverFn: async (_config, operation) => operation(),
    handleChromeErrorPageFn: async () => {
      calls.push('chrome-error');
      throw Object.assign(new Error('network'), { code: 'BBGU_PROXY_NETWORK_FAILED' });
    },
  }), /network/);
  assert.deepEqual(calls, ['chrome-error']);
});

test('登录导航后不再固定等待三秒', () => {
  const source = fsSync.readFileSync(path.join(__dirname, 'bbgu_grade_watch.js'), 'utf8');
  const runLoginSource = source.slice(
    source.indexOf('async function runLogin('),
    source.indexOf('async function maybeRunScheduledQr(')
  );
  assert.doesNotMatch(runLoginSource, /waitForTimeout\(3000\)/);
});

test('markQrPushed合并二维码冷却而不覆盖认证状态', async () => {
  const writes = [];
  const result = await markQrPushed({ qrReminderStatePath: 'qr.json' }, 12345, {
    readQrReminderStateFn: async () => ({ casExpired: true, refreshExpired: true, dueAt: 100 }),
    writeJsonFn: async (_filePath, value) => writes.push(value),
  });
  assert.deepEqual(result, {
    casExpired: true,
    refreshExpired: true,
    dueAt: 100,
    lastPushedAt: 12345,
  });
  assert.deepEqual(writes, [result]);
});

test('完全无Token且二维码冷却未过时Watch不打开浏览器', async () => {
  const calls = [];
  const now = Date.parse('2026-07-11T12:07:00+08:00');
  const result = await run({
    pushplusToken: 'push-token',
    tokenPath: 'token.env',
    term: '2026春',
  }, {
    nowFn: () => now,
    readSavedAuthStateFn: async () => ({ accessToken: '', refreshToken: '' }),
    readQrReminderStateFn: async () => ({ lastPushedAt: now - 60 * 60 * 1000 }),
    runLoginFn: async () => calls.push('login'),
    fetchScoreRowsFn: async () => calls.push('score'),
  });
  assert.equal(result.status, 'qr_cooldown_skipped');
  assert.deepEqual(calls, []);
});

test('Refresh响应体被中断时报告response-body阶段且不返回半包', async () => {
  const response = new EventEmitter();
  response.statusCode = 200;
  response.complete = false;
  response.setEncoding = () => undefined;
  const pending = readRefreshResponse(response);
  response.emit('data', '{"access_token":"partial');
  response.emit('aborted');
  response.emit('close');
  await assert.rejects(pending, (error) => (
    error
    && error.code === 'ERR_HTTP_RESPONSE_ABORTED'
    && error.stage === 'response-body'
  ));
});

test('Refresh响应end但消息不完整时仍拒绝半包', async () => {
  const response = new EventEmitter();
  response.statusCode = 200;
  response.complete = false;
  response.setEncoding = () => undefined;
  const pending = readRefreshResponse(response);
  response.emit('data', '{"access_token":"partial"}');
  response.emit('end');
  await assert.rejects(pending, (error) => (
    error
    && error.code === 'ERR_HTTP_RESPONSE_INCOMPLETE'
    && error.stage === 'response-body'
  ));
});

test('浏览器导航429保留Retry-After并在二维码处理前终止', async () => {
  const response = {
    status: () => 429,
    headers: () => ({ 'retry-after': '900' }),
    url: () => 'https://zhjw.bbgu.edu.cn/workspace/home',
  };
  await assert.rejects(validateBrowserHttpResponse(response), (error) => {
    assert.equal(error.httpStatus, 429);
    assert.equal(error.retryAfter, '900');
    return true;
  });
});

test('浏览器导航5xx终止且健康响应正常通过', async () => {
  await assert.rejects(validateBrowserHttpResponse({
    status: () => 503,
    headers: () => ({}),
    url: () => 'https://zhjw.bbgu.edu.cn/authserver/casLogin',
  }), (error) => error && error.httpStatus === 503);
  await assert.doesNotReject(validateBrowserHttpResponse({
    status: () => 200,
    headers: () => ({}),
    url: () => 'https://zhjw.bbgu.edu.cn/workspace/home',
  }));
  await assert.doesNotReject(validateBrowserHttpResponse(null));
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
  const now = Date.parse('2026-07-11T22:07:00+08:00');
  const config = {
    tokenPath: 'token.env',
  };

  const rows = await recoverDirectApiAfterAuthExpired(config, {
    nowFn: () => now,
    readQrReminderStateFn: async () => ({ casExpired: true }),
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-11T21:50:00+08:00') / 1000 }),
      refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
    }),
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

test('Refresh成功后的成绩401不把Refresh永久标记失效', async () => {
  const calls = [];
  const now = Date.parse('2026-07-11T22:07:00+08:00');
  const scoreError = Object.assign(new Error('score rejected refreshed access'), { httpStatus: 401 });

  await assert.rejects(recoverDirectApiAfterAuthExpired({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    readQrReminderStateFn: async () => ({ casExpired: true }),
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-11T21:50:00+08:00') / 1000 }),
      refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
    }),
    refreshAndSaveAuthStateFn: async () => {
      calls.push('refresh');
      return { authState: {
        accessToken: makeJwt({ exp: Date.parse('2026-07-12T10:07:00+08:00') / 1000 }),
        refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
      } };
    },
    clearQrReminderScheduleFn: async () => calls.push('clear-schedule'),
    fetchScoreRowsFn: async () => {
      calls.push('score');
      throw scoreError;
    },
    markRefreshExpiredFn: async () => {
      calls.push('mark-refresh-expired');
      return { refreshExpired: true };
    },
    maybeRunScheduledQrFn: async () => {
      calls.push('qr');
      return { status: 'qr_pending' };
    },
  }), scoreError);

  assert.deepEqual(calls, ['refresh', 'clear-schedule', 'score']);
});

test('当前Watch的Access已过期时只Refresh一次并只查询一次成绩', async () => {
  const calls = [];
  const now = Date.parse('2026-07-11T22:07:00+08:00');
  const config = { tokenPath: 'token.env' };
  const rows = await recoverDirectApiAfterAuthExpired(config, {
    nowFn: () => now,
    readQrReminderStateFn: async () => ({ casExpired: true }),
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-11T21:50:00+08:00') / 1000 }),
      refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
    }),
    nowFn: () => now,
    readQrReminderStateFn: async () => ({ casExpired: true }),
    readSavedAuthStateFn: async () => {
      calls.push('read-auth');
      return {
        accessToken: makeJwt({ exp: Date.parse('2026-07-11T21:50:00+08:00') / 1000 }),
        refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
      };
    },
    refreshAndSaveAuthStateFn: async (nextConfig) => {
      calls.push('refresh');
      nextConfig.authorization = 'Bearer refreshed.access';
      return { authState: {
        accessToken: makeJwt({ exp: Date.parse('2026-07-12T10:07:00+08:00') / 1000 }),
        refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
      } };
    },
    clearQrReminderScheduleFn: async () => calls.push('clear-schedule'),
    fetchScoreRowsFn: async () => {
      calls.push('score');
      return [{ courseName: '测试课程', score: '99' }];
    },
  });
  assert.deepEqual(rows, [{ courseName: '测试课程', score: '99' }]);
  assert.deepEqual(calls, ['read-auth', 'refresh', 'clear-schedule', 'score']);
});

test('当前Watch发现Refresh已达到exp时不发送Refresh请求', async () => {
  const calls = [];
  const now = Date.parse('2026-07-11T22:07:00+08:00');
  await assert.rejects(recoverDirectApiAfterAuthExpired({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    readQrReminderStateFn: async () => ({ casExpired: true }),
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-11T21:50:00+08:00') / 1000 }),
      refreshToken: makeJwt({ exp: Date.parse('2026-07-11T21:55:00+08:00') / 1000 }),
    }),
    refreshAndSaveAuthStateFn: async () => {
      calls.push('refresh');
      throw new Error('expired Refresh must not be requested');
    },
    markRefreshExpiredFn: async () => {
      calls.push('mark-refresh-expired');
      return { casExpired: true, refreshExpired: true };
    },
    saveQrReminderScheduleFn: async (_config, schedule) => {
      calls.push('schedule-qr');
      return schedule;
    },
    maybeRunScheduledQrFn: async () => {
      calls.push('check-qr');
      return { status: 'qr_pending' };
    },
  }), /二维码提醒仍在冷却期/);
  assert.deepEqual(calls, ['mark-refresh-expired', 'schedule-qr', 'check-qr']);
});

test('CAS失效后的自动时序最多执行两次有益Refresh且不存在未覆盖Watch', () => {
  const refreshExpiry = Date.parse('2026-07-11T23:50:00+08:00') / 1000;
  let accessExpiry = Date.parse('2026-07-11T21:50:00+08:00') / 1000;
  let refreshCalls = 0;
  const uncoveredWatchQueries = [];
  const runs = scheduledAutomaticRunsFrom(Date.parse('2026-07-11T21:37:00+08:00'), 2)
    .filter((item) => item.at < refreshExpiry * 1000 || item.at <= Date.parse('2026-07-12T11:07:00+08:00'));

  for (const runItem of runs) {
    if (runItem.at < refreshExpiry * 1000) {
      const plan = planRefreshAction({
        mode: runItem.mode,
        nowMs: runItem.at,
        accessExpiryEpochSeconds: accessExpiry,
        refreshExpiryEpochSeconds: refreshExpiry,
      });
      if (plan.action === 'REFRESH_ACCESS') {
        refreshCalls += 1;
        accessExpiry = runItem.at / 1000 + 12 * 60 * 60;
      }
    }
    if (runItem.mode === 'watch' && runItem.at < Date.parse('2026-07-12T11:37:00+08:00')) {
      if (runItem.at >= accessExpiry * 1000) uncoveredWatchQueries.push(runItem.at);
    }
  }

  assert.equal(refreshCalls, 2);
  assert.deepEqual(uncoveredWatchQueries, []);
  assert.equal(accessExpiry, Date.parse('2026-07-12T11:37:00+08:00') / 1000);
});

test('recoverDirectApiAfterAuthExpired schedules QR from last access expiry after refresh fails', async () => {
  const calls = [];
  const nowMs = Date.parse('2026-07-04T18:07:00+08:00');
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
        refreshToken: makeJwt({ exp: Date.parse('2026-07-04T19:34:00+08:00') / 1000 }),
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

  assert.deepEqual(calls, ['refresh', 'schedule:2026-07-04T09:07:00.000Z', 'scheduled-qr']);
});

test('已有二维码计划时普通查询遵守二维码冷却并跳过CAS', async () => {
  const calls = [];
  const config = {
    tokenPath: 'token.env',
  };

  await assert.rejects(
    recoverDirectApiAfterAuthExpired(config, {
      readSavedAuthStateFn: async () => ({
        accessToken: makeJwt({ exp: Date.parse('2026-07-04T17:34:00+08:00') / 1000 }),
        refreshToken: '',
      }),
      refreshAndSaveAuthStateFn: async () => {
        calls.push('refresh');
        throw new Error('已有二维码计划时不应再次请求Refresh');
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

  assert.deepEqual(calls, ['scheduled-qr']);
});

test('服务端提前拒绝Access且Refresh已失效时立即安排二维码', async () => {
  const now = Date.parse('2026-07-11T12:07:00+08:00');
  const calls = [];
  await assert.rejects(recoverDirectApiAfterAuthExpired({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    serverAuthExpired: true,
    readQrReminderStateFn: async () => ({ casExpired: true, refreshExpired: true }),
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-11T18:00:00+08:00') / 1000 }),
      refreshToken: makeJwt({ exp: Date.parse('2026-07-11T14:00:00+08:00') / 1000 }),
    }),
    refreshAndSaveAuthStateFn: async () => calls.push('refresh'),
    saveQrReminderScheduleFn: async (_config, schedule) => {
      calls.push(`due:${schedule.dueAt}`);
      return schedule;
    },
    maybeRunScheduledQrFn: async () => {
      calls.push('qr');
      return { status: 'qr_pending' };
    },
  }), /二维码提醒仍在冷却期/);
  assert.deepEqual(calls, [`due:${now}`, 'qr']);
});

test('服务端拒绝Access但Refresh缺失时记录状态并等待CAS而不重复查询', async () => {
  const now = Date.parse('2026-07-11T12:07:00+08:00');
  const calls = [];
  await assert.rejects(recoverDirectApiAfterAuthExpired({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    serverAuthExpired: true,
    readQrReminderStateFn: async () => null,
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-11T18:00:00+08:00') / 1000 }),
      refreshToken: '',
    }),
    refreshAndSaveAuthStateFn: async () => calls.push('refresh'),
    markAccessRejectedAfterRefreshFn: async () => {
      calls.push('mark-rejected');
      return { accessRejectedAfterRefresh: true };
    },
  }), (error) => error && error.code === 'BBGU_AWAITING_CAS_RENEW');
  assert.deepEqual(calls, ['mark-rejected']);
});

test('服务端拒绝Access且Refresh本地过期时记录状态等待CAS', async () => {
  const now = Date.parse('2026-07-11T12:07:00+08:00');
  const calls = [];
  await assert.rejects(recoverDirectApiAfterAuthExpired({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    serverAuthExpired: true,
    readQrReminderStateFn: async () => null,
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-11T18:00:00+08:00') / 1000 }),
      refreshToken: makeJwt({ exp: Date.parse('2026-07-11T12:00:00+08:00') / 1000 }),
    }),
    markRefreshExpiredFn: async () => {
      calls.push('mark-refresh-expired');
      return { refreshExpired: true };
    },
    markAccessRejectedAfterRefreshFn: async () => {
      calls.push('mark-rejected');
      return { refreshExpired: true, accessRejectedAfterRefresh: true };
    },
  }), (error) => error && error.code === 'BBGU_AWAITING_CAS_RENEW');
  assert.deepEqual(calls, ['mark-refresh-expired', 'mark-rejected']);
});

test('刷新成功但新Access仍401时记录跨任务熔断并立即安排二维码', async () => {
  const now = Date.parse('2026-07-11T12:07:00+08:00');
  const calls = [];
  const scoreError = Object.assign(new Error('new access rejected'), { code: 'BBGU_AUTH_EXPIRED' });
  await assert.rejects(recoverDirectApiAfterAuthExpired({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    serverAuthExpired: true,
    readQrReminderStateFn: async () => ({ casExpired: true }),
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-11T18:00:00+08:00') / 1000 }),
      refreshToken: makeJwt({ exp: Date.parse('2026-07-11T20:00:00+08:00') / 1000 }),
    }),
    refreshAndSaveAuthStateFn: async () => {
      calls.push('refresh');
      return { authState: {
        accessToken: makeJwt({ exp: Date.parse('2026-07-12T00:07:00+08:00') / 1000 }),
        refreshToken: makeJwt({ exp: Date.parse('2026-07-11T20:00:00+08:00') / 1000 }),
      } };
    },
    clearQrReminderScheduleFn: async () => calls.push('clear-schedule'),
    fetchScoreRowsFn: async () => {
      calls.push('score');
      throw scoreError;
    },
    markAccessRejectedAfterRefreshFn: async () => {
      calls.push('mark-rejected');
      return { casExpired: true, accessRejectedAfterRefresh: true };
    },
    saveQrReminderScheduleFn: async (_config, schedule) => {
      calls.push(`due:${schedule.dueAt}`);
      return { casExpired: true, accessRejectedAfterRefresh: true, ...schedule };
    },
    maybeRunScheduledQrFn: async () => {
      calls.push('qr');
      return { status: 'qr_pending' };
    },
  }), /二维码提醒仍在冷却期/);
  assert.deepEqual(calls, [
    'refresh',
    'clear-schedule',
    'score',
    'mark-rejected',
    `due:${now}`,
    'qr',
  ]);
});

test('等待CAS恢复期间Watch不再请求成绩或Refresh', async () => {
  const calls = [];
  const result = await run({
    pushplusToken: 'push-token',
    term: '2026春',
    tokenPath: 'token.env',
    authorization: `Bearer ${makeJwt({ exp: 4102444800 })}`,
  }, {
    consumeSchoolBackoffFn: async () => false,
    consumeWatchNetworkCooldownFn: async () => false,
    readQrReminderStateFn: async () => ({ accessRejectedAfterRefresh: true, casExpired: false }),
    fetchScoreRowsFn: async () => calls.push('score'),
    recoverDirectApiAfterAuthExpiredFn: async () => calls.push('refresh'),
  });
  assert.deepEqual(result, { status: 'awaiting_cas_renew' });
  assert.deepEqual(calls, []);
});

test('拒绝标记属于旧Token时新Access照常查成绩', async () => {
  const calls = [];
  const result = await run({
    pushplusToken: 'push-token',
    term: '2026春',
    tokenPath: 'token.env',
    authorization: `Bearer ${makeJwt({ exp: 4102444800, generation: 'new' })}`,
  }, {
    consumeSchoolBackoffFn: async () => false,
    consumeWatchNetworkCooldownFn: async () => false,
    readQrReminderStateFn: async () => ({
      accessRejectedAfterRefresh: true,
      rejectedAccessFingerprint: 'old-token-fingerprint',
    }),
    clearQrReminderStateFn: async () => {
      calls.push('clear-stale-state');
      throw new Error('local cleanup failed');
    },
    fetchScoreRowsFn: async () => {
      calls.push('score');
      return [{ key: 'A' }];
    },
    processGradeRowsFn: async () => ({ status: 'ok' }),
    maybeRunScheduledQrFn: async () => undefined,
  });
  assert.deepEqual(result, { status: 'ok' });
  assert.deepEqual(calls, ['clear-stale-state', 'score']);
});

test('拒绝标记属于旧Token时Renew不得为新Access提前扫码', async () => {
  const calls = [];
  const now = Date.parse('2026-07-12T09:37:00+08:00');
  const newAccess = makeJwt({ exp: now / 1000 + 12 * 3600, generation: 'new' });
  const newRefresh = makeJwt({ exp: now / 1000 + 14 * 3600, generation: 'new' });
  const result = await runRenew({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    readQrReminderStateFn: async () => ({
      casExpired: true,
      accessRejectedAfterRefresh: true,
      rejectedAccessFingerprint: 'old-token-fingerprint',
      dueAt: 1,
      lastPushedAt: 0,
    }),
    readSavedAuthStateFn: async () => ({ accessToken: newAccess, refreshToken: newRefresh }),
    clearQrReminderStateFn: async () => calls.push('clear-state'),
    runSilentRenewFn: async () => {
      calls.push('cas');
      return { status: 'renew_ok' };
    },
    saveQrReminderScheduleFn: async () => calls.push('schedule-qr'),
    maybeRunScheduledQrFn: async () => calls.push('qr'),
    logFn: () => undefined,
  });

  assert.deepEqual(result, { status: 'renew_ok' });
  assert.deepEqual(calls, ['clear-state', 'cas', 'clear-state']);
});

test('浏览器状态删除全部BBGUToken但保留CAS Cookie', () => {
  const storage = {
    cookies: [{ name: 'CASTGC', value: 'cas-cookie', domain: 'authserver.bbgu.edu.cn' }],
    origins: [{
      origin: 'https://zhjw.bbgu.edu.cn',
      localStorage: [
        { name: 'cqu_edu_ACCESS_TOKEN', value: 'old.access' },
        { name: 'cqu_edu_CURRENT_TOKEN', value: 'old.current' },
        { name: 'cqu_edu_REFRESH_TOKEN', value: 'saved.refresh' },
        { name: 'cqu_edu_TOKEN_EXPIRE', value: 'old.expiry' },
        { name: 'cqu_edu_EXPIRE_ACCESS_TOKEN', value: 'old.access.expiry' },
        { name: 'unrelated', value: 'keep' },
      ],
    }],
  };

  const sanitized = sanitizeStorageStateForAccessRenewal(storage, 'https://zhjw.bbgu.edu.cn');
  assert.deepEqual(sanitized.cookies, storage.cookies);
  assert.deepEqual(sanitized.origins[0].localStorage, [{ name: 'unrelated', value: 'keep' }]);
  assert.equal(storage.origins[0].localStorage.length, 6);
});

test('CAS续期只导航一次续期地址并在Token出现后立即保存', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbgu-cas-storage-'));
  const calls = [];
  const page = {
    goto: async (url, options) => {
      calls.push({ type: 'goto', url, options });
      return {};
    },
    url: () => 'https://zhjw.bbgu.edu.cn/sam/cas',
  };
  let routeHandler;
  const context = {
    route: async (_pattern, handler) => { routeHandler = handler; },
    newPage: async () => page,
    storageState: async () => {
      calls.push({ type: 'storage' });
      return { cookies: [], origins: [] };
    },
  };
  const config = {
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    tokenPath: path.join(tempDir, 'token.env'),
    storageStatePath: path.join(tempDir, 'storage.json'),
  };

  const result = await performSilentRenew(context, config, {
    withProxyFailoverFn: async (_config, operation, failoverOptions) => {
      assert.equal(failoverOptions.shouldFailoverFn, isSafeCasFailoverError);
      return operation();
    },
    saveBrowserAuthStateFn: async (actualPage, actualConfig) => {
      assert.equal(actualPage, page);
      assert.equal(actualConfig, config);
      calls.push({ type: 'save-auth' });
    },
  });

  assert.equal(result.status, 'renew_ok');
  assert.deepEqual(calls.map((call) => call.type), ['goto', 'save-auth', 'storage']);
  assert.equal(calls[0].url, buildCasRenewUrl(config));
  assert.equal(typeof routeHandler, 'function');
  const blocked = [];
  await routeHandler({
    request: () => ({ resourceType: () => 'font' }),
    abort: async () => blocked.push('abort'),
    continue: async () => blocked.push('continue'),
  });
  assert.deepEqual(blocked, ['abort']);
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('CAS取得新Token后即使storage写入失败也先提交认证标记', async () => {
  const calls = [];
  const storageError = new Error('storage write failed');
  const page = {
    goto: async () => ({}),
    url: () => 'https://zhjw.bbgu.edu.cn/sam/cas',
  };
  const context = {
    route: async () => undefined,
    newPage: async () => page,
  };
  await assert.rejects(performSilentRenew(context, {
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
  }, {
    withProxyFailoverFn: async (_config, operation) => operation(),
    persistBrowserLoginStateFn: async () => {
      calls.push('persist-token-and-state');
      throw storageError;
    },
    saveBrowserAuthStateFn: async () => calls.push('legacy-save'),
  }), /storage write failed/);
  assert.deepEqual(calls, ['persist-token-and-state']);
});

test('普通查询已有Refresh失效记录时不再请求Refresh', async () => {
  const calls = [];
  const config = { tokenPath: 'token.env' };

  await assert.rejects(
    recoverDirectApiAfterAuthExpired(config, {
      readSavedAuthStateFn: async () => ({
        accessToken: makeJwt({ exp: Date.parse('2026-07-04T17:34:00+08:00') / 1000 }),
        refreshToken: '',
      }),
      readSavedAuthStateFn: async () => ({
        accessToken: makeJwt({ exp: Date.parse('2026-07-04T17:34:00+08:00') / 1000 }),
        refreshToken: '',
      }),
      refreshAndSaveAuthStateFn: async () => {
        calls.push('refresh');
        throw new Error('Refresh不应被调用');
      },
      readQrReminderStateFn: async () => ({
        refreshExpired: true,
        dueAt: Date.parse('2026-07-04T17:07:00+08:00'),
        lastPushedAt: Date.parse('2026-07-04T17:07:00+08:00'),
      }),
      maybeRunScheduledQrFn: async () => {
        calls.push('scheduled-qr');
        return { status: 'qr_pending' };
      },
    }),
    /二维码提醒仍在冷却期/
  );

  assert.deepEqual(calls, ['scheduled-qr']);
});

test('run starts automatic login recovery when saved direct API token is expired', async () => {
  const calls = [];
  const expiredToken = makeJwt({ exp: 1 });
  const config = {
    pushplusToken: 'push-token',
    tokenPath: 'token.env',
    authorization: `Bearer ${expiredToken}`,
    term: '2026春',
  };

  const result = await run(config, {
    fetchScoreRowsFn: async () => {
      calls.push('unexpected-fetch-expired');
      throw new Error('本地已知Access过期时不应先请求成绩接口');
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
    'recover:token.env',
    'process:Bearer renewed-token:1',
  ]);
  assert.deepEqual(result, { status: 'ok', count: 1 });
});

test('成绩接口提前401时恢复路径收到serverAuthExpired且只进入一次', async () => {
  const calls = [];
  const config = {
    pushplusToken: 'push-token',
    tokenPath: 'token.env',
    authorization: `Bearer ${makeJwt({ exp: 4102444800 })}`,
    term: '2026春',
  };
  const authError = Object.assign(new Error('expired'), { code: 'BBGU_AUTH_EXPIRED' });
  const result = await run(config, {
    fetchScoreRowsFn: async () => {
      calls.push('score-401');
      throw authError;
    },
    recoverDirectApiAfterAuthExpiredFn: async (_nextConfig, options) => {
      calls.push(`recover:${options.serverAuthExpired}`);
      return [{ key: 'A', courseName: 'A', score: '99', term: '2026春' }];
    },
    processGradeRowsFn: async () => ({ status: 'ok' }),
    maybeRunScheduledQrFn: async () => undefined,
  });
  assert.deepEqual(calls, ['score-401', 'recover:true']);
  assert.deepEqual(result, { status: 'ok' });
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

test('成绩处理失败时仍检查二维码并保留原始错误', async () => {
  const calls = [];
  const gradeError = new Error('成绩快照写入失败');
  const config = {
    pushplusToken: 'push-token',
    tokenPath: 'token.env',
    authorization: 'Bearer current-token',
    term: '2026春',
  };

  await assert.rejects(
    run(config, {
      fetchScoreRowsFn: async () => [
        { key: 'A', courseName: 'A', score: '99', term: '2026春' },
      ],
      processGradeRowsFn: async () => {
        calls.push('grades');
        throw gradeError;
      },
      maybeRunScheduledQrFn: async () => {
        calls.push('qr-check');
        return { status: 'qr_pending' };
      },
    }),
    (error) => error === gradeError
  );

  assert.deepEqual(calls, ['grades', 'qr-check']);
});

test('平时分全局错误后不再检查二维码学校入口', async () => {
  const calls = [];
  const globalError = Object.assign(new Error('subscore rate limited'), { httpStatus: 429 });
  await assert.rejects(run({
    pushplusToken: 'push-token',
    term: '2026春',
    authorization: `Bearer ${makeJwt({ exp: 4102444800 })}`,
  }, {
    consumeSchoolBackoffFn: async () => false,
    consumeWatchNetworkCooldownFn: async () => false,
    fetchScoreRowsFn: async () => [{ key: 'A' }],
    processGradeRowsFn: async () => {
      calls.push('grades');
      throw globalError;
    },
    maybeRunScheduledQrFn: async () => calls.push('qr-school'),
    markSchoolBackoffFn: async () => calls.push('backoff'),
  }), (error) => error === globalError);
  assert.deepEqual(calls, ['grades', 'backoff']);
});

test('成绩和二维码检查同时失败时优先抛出成绩错误并记录二维码错误', async () => {
  const calls = [];
  const logs = [];
  const gradeError = new Error('成绩快照写入失败');
  const qrError = new Error('二维码推送失败');
  const originalConsoleError = console.error;
  console.error = (message) => logs.push(String(message));

  try {
    await assert.rejects(
      run({
        pushplusToken: 'push-token',
        tokenPath: 'token.env',
        authorization: 'Bearer current-token',
        term: '2026春',
      }, {
        fetchScoreRowsFn: async () => [
          { key: 'A', courseName: 'A', score: '99', term: '2026春' },
        ],
        processGradeRowsFn: async () => {
          calls.push('grades');
          throw gradeError;
        },
        maybeRunScheduledQrFn: async () => {
          calls.push('qr-check');
          throw qrError;
        },
      }),
      (error) => error === gradeError
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(calls, ['grades', 'qr-check']);
  assert.match(logs.join('\n'), /二维码检查也失败.*二维码推送失败/);
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

test('CAS续期成功但没有Refresh时保留Refresh失效标记', async () => {
  const calls = [];
  const now = Date.parse('2026-07-11T12:37:00+08:00');
  const result = await runRenew({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    consumeSchoolBackoffFn: async () => false,
    readQrReminderStateFn: async () => null,
    runSilentRenewFn: async () => ({ status: 'renew_ok' }),
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-12T00:37:00+08:00') / 1000 }),
      refreshToken: '',
    }),
    clearQrReminderStateFn: async () => calls.push('clear'),
    finalizeLoginReminderStateFn: async (_config, authState) => {
      calls.push(`finalize:${Boolean(authState.refreshToken)}`);
    },
    logFn: () => undefined,
  });
  assert.equal(result.status, 'renew_ok');
  assert.deepEqual(calls, ['finalize:false']);
});

test('CAS成功后的本地清理失败不标记CAS失效且不调用Refresh', async () => {
  const calls = [];
  const cleanupError = new Error('local cleanup failed');

  await assert.rejects(runRenew({ tokenPath: 'token.env' }, {
    readQrReminderStateFn: async () => null,
    runSilentRenewFn: async () => { calls.push('cas'); return { status: 'renew_ok' }; },
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: 4102444800 }),
      refreshToken: makeJwt({ exp: 4102452000 }),
    }),
    clearQrReminderStateFn: async () => { calls.push('clear'); throw cleanupError; },
    markCasExpiredFn: async () => calls.push('mark-cas-expired'),
    refreshAndSaveAuthStateFn: async () => calls.push('refresh'),
  }), (error) => error === cleanupError);

  assert.deepEqual(calls, ['cas', 'clear']);
});

test('CAS本地或浏览器故障不标记失效且不调用Refresh', async () => {
  const calls = [];
  const localError = new Error('storage state write failed');

  await assert.rejects(runRenew({ tokenPath: 'token.env' }, {
    readQrReminderStateFn: async () => null,
    runSilentRenewFn: async () => { calls.push('cas'); throw localError; },
    markCasExpiredFn: async () => calls.push('mark-cas-expired'),
    refreshAndSaveAuthStateFn: async () => calls.push('refresh'),
  }), (error) => error === localError);

  assert.deepEqual(calls, ['cas']);
});

test('CAS首次失败后记录失效并使用Refresh续Access', async () => {
  const calls = [];
  const now = Date.parse('2026-07-11T23:37:00+08:00');
  const casExpiredError = new Error('CAS已失效');
  casExpiredError.code = 'BBGU_CAS_EXPIRED';
  const result = await runRenew({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    readQrReminderStateFn: async () => null,
    runSilentRenewFn: async () => { calls.push('cas'); throw casExpiredError; },
    markCasExpiredFn: async () => calls.push('mark-cas-expired'),
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-11T21:50:00+08:00') / 1000 }),
      refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
    }),
    refreshAndSaveAuthStateFn: async () => {
      calls.push('refresh');
      return { authState: {
        accessToken: makeJwt({ exp: Date.parse('2026-07-12T11:37:00+08:00') / 1000 }),
        refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
      } };
    },
    clearQrReminderScheduleFn: async () => calls.push('clear-schedule'),
    runLoginFn: async () => calls.push('qr'),
  });

  assert.deepEqual(calls, ['cas', 'mark-cas-expired', 'refresh', 'clear-schedule']);
  assert.equal(result.status, 'refresh_ok');
});

test('CAS已记录失效后renew跳过CAS并在有益窗口使用Refresh', async () => {
  const calls = [];
  const logs = [];
  const nowMs = Date.parse('2026-07-11T23:37:00+08:00');
  const authState = {
    refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
    accessToken: makeJwt({ exp: Date.parse('2026-07-11T21:50:00+08:00') / 1000 }),
  };
  const result = await runRenew({}, {
    nowFn: () => nowMs,
    readQrReminderStateFn: async () => ({ casExpired: true }),
    runSilentRenewFn: async () => calls.push('cas'),
    readSavedAuthStateFn: async () => authState,
    refreshAndSaveAuthStateFn: async () => {
      calls.push('refresh');
      return { status: 'refresh_ok', authState: {
        refreshToken: authState.refreshToken,
        accessToken: makeJwt({ exp: Date.parse('2026-07-12T11:37:00+08:00') / 1000 }),
      } };
    },
    clearQrReminderScheduleFn: async () => calls.push('clear-schedule'),
    logFn: (message) => logs.push(message),
  });

  assert.deepEqual(calls, ['refresh', 'clear-schedule']);
  assert.equal(result.status, 'refresh_ok');
  assert.match(logs.join('\n'), /CAS：已失效，本次已跳过/);
  assert.match(logs.join('\n'), /Refresh Token：有效/);
  assert.match(logs.join('\n'), /Access Token：有效/);
});

test('CAS已失效但未到有益窗口时Renew不请求Refresh', async () => {
  const calls = [];
  const now = Date.parse('2026-07-11T11:37:00+08:00');
  const result = await runRenew({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    consumeSchoolBackoffFn: async () => false,
    readQrReminderStateFn: async () => ({ casExpired: true }),
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-11T18:35:00+08:00') / 1000 }),
      refreshToken: makeJwt({ exp: Date.parse('2026-07-11T20:35:00+08:00') / 1000 }),
    }),
    refreshAndSaveAuthStateFn: async () => calls.push('refresh'),
    logFn: () => undefined,
  });
  assert.equal(result.status, 'refresh_waiting');
  assert.deepEqual(calls, []);
});

test('最后有益机会Renew只请求一次Refresh', async () => {
  const calls = [];
  const now = Date.parse('2026-07-11T23:37:00+08:00');
  const result = await runRenew({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    consumeSchoolBackoffFn: async () => false,
    readQrReminderStateFn: async () => ({ casExpired: true }),
    readSavedAuthStateFn: async () => {
      calls.push('read-auth');
      return {
        accessToken: makeJwt({ exp: Date.parse('2026-07-11T21:50:00+08:00') / 1000 }),
        refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
      };
    },
    refreshAndSaveAuthStateFn: async () => {
      calls.push('refresh');
      return { status: 'refresh_ok', authState: {
        accessToken: makeJwt({ exp: Date.parse('2026-07-12T11:37:00+08:00') / 1000 }),
        refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
      } };
    },
    clearQrReminderScheduleFn: async () => calls.push('clear-schedule'),
    logFn: () => undefined,
  });
  assert.equal(result.status, 'refresh_ok');
  assert.deepEqual(calls, ['read-auth', 'refresh', 'clear-schedule']);
});

test('Refresh已达到exp时本地判死且请求次数为零', async () => {
  const calls = [];
  const now = Date.parse('2026-07-11T20:37:00+08:00');
  const result = await runRenew({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    consumeSchoolBackoffFn: async () => false,
    readQrReminderStateFn: async () => ({ casExpired: true }),
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-12T07:37:00+08:00') / 1000 }),
      refreshToken: makeJwt({ exp: Date.parse('2026-07-11T20:00:00+08:00') / 1000 }),
    }),
    refreshAndSaveAuthStateFn: async () => calls.push('refresh'),
    markRefreshExpiredFn: async () => {
      calls.push('mark-refresh-expired');
      return { casExpired: true, refreshExpired: true };
    },
    saveQrReminderScheduleFn: async (_config, schedule) => {
      calls.push('schedule-qr');
      return schedule;
    },
    maybeRunScheduledQrFn: async () => {
      calls.push('check-qr');
      return { status: 'qr_pending' };
    },
    logFn: () => undefined,
  });
  assert.equal(result.status, 'qr_pending');
  assert.deepEqual(calls, ['mark-refresh-expired', 'schedule-qr', 'check-qr']);
});

test('刷新后Access被拒且CAS已死时Renew不再请求Refresh', async () => {
  const calls = [];
  const now = Date.parse('2026-07-11T12:37:00+08:00');
  const result = await runRenew({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    consumeSchoolBackoffFn: async () => false,
    readQrReminderStateFn: async () => ({
      casExpired: true,
      accessRejectedAfterRefresh: true,
    }),
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-12T00:07:00+08:00') / 1000 }),
      refreshToken: makeJwt({ exp: Date.parse('2026-07-11T20:00:00+08:00') / 1000 }),
    }),
    refreshAndSaveAuthStateFn: async () => calls.push('refresh'),
    saveQrReminderScheduleFn: async (_config, schedule) => {
      calls.push(`due:${schedule.dueAt}`);
      return { casExpired: true, accessRejectedAfterRefresh: true, ...schedule };
    },
    maybeRunScheduledQrFn: async () => {
      calls.push('qr');
      return { status: 'qr_pending' };
    },
    logFn: () => undefined,
  });
  assert.equal(result.status, 'qr_pending');
  assert.deepEqual(calls, [`due:${now}`, 'qr']);
});

test('Access被拒且Refresh缺失后CAS确认失效时进入二维码而非本地状态错误', async () => {
  const calls = [];
  const now = Date.parse('2026-07-11T13:37:00+08:00');
  const casError = Object.assign(new Error('CAS expired'), { code: 'BBGU_CAS_EXPIRED' });
  const result = await runRenew({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    consumeSchoolBackoffFn: async () => false,
    readQrReminderStateFn: async () => ({ accessRejectedAfterRefresh: true }),
    runSilentRenewFn: async () => {
      calls.push('cas');
      throw casError;
    },
    markCasExpiredFn: async () => ({
      casExpired: true,
      accessRejectedAfterRefresh: true,
    }),
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-11T18:00:00+08:00') / 1000 }),
      refreshToken: '',
    }),
    refreshAndSaveAuthStateFn: async () => calls.push('refresh'),
    saveQrReminderScheduleFn: async (_config, schedule) => {
      calls.push(`due:${schedule.dueAt}`);
      return { casExpired: true, accessRejectedAfterRefresh: true, ...schedule };
    },
    maybeRunScheduledQrFn: async () => {
      calls.push('qr');
      return { status: 'qr_pending' };
    },
    logFn: () => undefined,
  });
  assert.equal(result.status, 'qr_pending');
  assert.deepEqual(calls, ['cas', `due:${now}`, 'qr']);
});

test('watch缺少BBGU_TERM时在请求成绩前立即失败', async () => {
  const calls = [];
  await assert.rejects(
    run({
      pushplusToken: 'push-token',
      tokenPath: 'token.env',
      authorization: 'Bearer current-token',
      term: '',
    }, {
      fetchScoreRowsFn: async () => calls.push('fetch'),
    }),
    /Missing BBGU_TERM/
  );

  assert.deepEqual(calls, []);
});

test('CAS和Refresh均已记录失效后renew跳过两种续期请求', async () => {
  const calls = [];
  const now = Date.parse('2026-07-05T17:30:00+08:00');
  const result = await runRenew({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    readQrReminderStateFn: async () => ({
      casExpired: true,
      refreshExpired: true,
      dueAt: Date.parse('2026-07-05T17:07:00+08:00'),
    }),
    runSilentRenewFn: async () => calls.push('cas'),
    refreshAndSaveAuthStateFn: async () => calls.push('refresh'),
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-05T18:00:00+08:00') / 1000 }),
      refreshToken: makeJwt({ exp: Date.parse('2026-07-05T20:00:00+08:00') / 1000 }),
    }),
    maybeRunScheduledQrFn: async () => {
      calls.push('check-qr');
      return { status: 'qr_pending' };
    },
    logFn: () => undefined,
  });

  assert.deepEqual(calls, ['check-qr']);
  assert.equal(result.status, 'qr_pending');
});

test('CAS和Refresh都失效后renew根据最后一枚Access安排扫码', async () => {
  const calls = [];
  const logs = [];
  const now = Date.parse('2026-07-11T23:37:00+08:00');
  const result = await runRenew({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    readQrReminderStateFn: async () => ({ casExpired: true }),
    runSilentRenewFn: async () => calls.push('cas'),
    refreshAndSaveAuthStateFn: async () => {
      calls.push('refresh');
      const error = new Error('Refresh已失效');
      error.httpStatus = 401;
      throw error;
    },
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-11T21:50:00+08:00') / 1000 }),
      refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
    }),
    saveQrReminderScheduleFn: async (_config, schedule) => {
      calls.push(`due:${new Date(schedule.dueAt).toISOString()}`);
      return schedule;
    },
    maybeRunScheduledQrFn: async () => { calls.push('check-qr'); return { status: 'qr_pending' }; },
    logFn: (message) => logs.push(message),
  });

  assert.deepEqual(calls, ['refresh', 'due:2026-07-12T01:37:00.000Z', 'check-qr']);
  assert.equal(result.status, 'qr_pending');
  assert.match(logs.join('\n'), /CAS：已失效，本次已跳过/);
  assert.match(logs.join('\n'), /Refresh Token：已失效/);
  assert.match(logs.join('\n'), /Access Token：已失效/);
});

test('renew遇到Refresh服务器故障时不安排二维码', async () => {
  const calls = [];
  const now = Date.parse('2026-07-11T23:37:00+08:00');
  const error = new Error('authserver bad gateway');
  error.httpStatus = 502;

  await assert.rejects(
    runRenew({ tokenPath: 'token.env' }, {
      nowFn: () => now,
      readQrReminderStateFn: async () => ({ casExpired: true }),
      refreshAndSaveAuthStateFn: async () => {
        calls.push('refresh');
        throw error;
      },
      readSavedAuthStateFn: async () => {
        calls.push('read-token');
        return {
          accessToken: makeJwt({ exp: Date.parse('2026-07-11T21:50:00+08:00') / 1000 }),
          refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
        };
      },
      saveQrReminderScheduleFn: async () => calls.push('schedule'),
      maybeRunScheduledQrFn: async () => calls.push('check-qr'),
      logFn: () => undefined,
    }),
    /authserver bad gateway/
  );

  assert.deepEqual(calls, ['read-token', 'refresh']);
});

test('renew不会把没有明确Token失效信息的Refresh 400或403永久判死', async () => {
  const now = Date.parse('2026-07-11T23:37:00+08:00');
  for (const httpStatus of [400, 403]) {
    const calls = [];
    const error = new Error(`authserver HTTP ${httpStatus}`);
    error.httpStatus = httpStatus;

    await assert.rejects(
      runRenew({ tokenPath: 'token.env' }, {
        nowFn: () => now,
        readQrReminderStateFn: async () => ({ casExpired: true }),
        refreshAndSaveAuthStateFn: async () => {
          calls.push('refresh');
          throw error;
        },
        markRefreshExpiredFn: async () => {
          calls.push('mark-refresh-expired');
          return { casExpired: true, refreshExpired: true };
        },
        readSavedAuthStateFn: async () => {
          calls.push('read-token');
          return {
            accessToken: makeJwt({ exp: Date.parse('2026-07-11T21:50:00+08:00') / 1000 }),
            refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
          };
        },
        saveQrReminderScheduleFn: async () => calls.push('schedule'),
        maybeRunScheduledQrFn: async () => calls.push('check-qr'),
        logFn: () => undefined,
      }),
      (actual) => actual === error
    );

    assert.deepEqual(calls, ['read-token', 'refresh']);
  }
});

test('renew仍会把明确invalid_grant的Refresh 400永久判死', async () => {
  const calls = [];
  const now = Date.parse('2026-07-11T23:37:00+08:00');
  const error = new Error('refresh invalid_grant');
  error.httpStatus = 400;
  error.oauthError = 'invalid_grant';

  const result = await runRenew({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    readQrReminderStateFn: async () => ({ casExpired: true }),
    refreshAndSaveAuthStateFn: async () => {
      calls.push('refresh');
      throw error;
    },
    markRefreshExpiredFn: async () => {
      calls.push('mark-refresh-expired');
      return { casExpired: true, refreshExpired: true };
    },
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-11T21:50:00+08:00') / 1000 }),
      refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
    }),
    saveQrReminderScheduleFn: async (_config, schedule) => {
      calls.push('schedule');
      return schedule;
    },
    maybeRunScheduledQrFn: async () => {
      calls.push('check-qr');
      return { status: 'qr_pending' };
    },
    logFn: () => undefined,
  });

  assert.deepEqual(calls, ['refresh', 'mark-refresh-expired', 'schedule', 'check-qr']);
  assert.equal(result.status, 'qr_pending');
});

test('renew不会忽略OAuth描述中的明确Refresh过期信息', async () => {
  const calls = [];
  const now = Date.parse('2026-07-11T23:37:00+08:00');
  const error = new Error('refresh invalid_request');
  error.httpStatus = 400;
  error.oauthError = 'invalid_request';
  error.oauthErrorDescription = 'Refresh token expired';

  const result = await runRenew({ tokenPath: 'token.env' }, {
    nowFn: () => now,
    readQrReminderStateFn: async () => ({ casExpired: true }),
    refreshAndSaveAuthStateFn: async () => {
      calls.push('refresh');
      throw error;
    },
    markRefreshExpiredFn: async () => {
      calls.push('mark-refresh-expired');
      return {
        casExpired: true,
        refreshExpired: true,
        dueAt: now - 1,
      };
    },
    readSavedAuthStateFn: async () => ({
      accessToken: makeJwt({ exp: Date.parse('2026-07-11T21:50:00+08:00') / 1000 }),
      refreshToken: makeJwt({ exp: Date.parse('2026-07-11T23:50:00+08:00') / 1000 }),
    }),
    maybeRunScheduledQrFn: async () => {
      calls.push('check-qr');
      return { status: 'qr_pending' };
    },
    logFn: () => undefined,
  });

  assert.deepEqual(calls, ['refresh', 'mark-refresh-expired', 'check-qr']);
  assert.equal(result.status, 'qr_pending');
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

test('saveBrowserAuthState缺少新Refresh时保留旧Refresh', async () => {
  const saved = [];
  const result = await saveBrowserAuthState({}, { tokenPath: 'token.env' }, {
    waitForAuthStateFn: async () => ({ accessToken: 'browser.access', refreshToken: '' }),
    readSavedAuthStateFn: async () => ({ accessToken: 'old.access', refreshToken: 'old.refresh' }),
    saveAuthStateFn: async (filePath, state) => saved.push({ filePath, state }),
  });

  assert.deepEqual(result, { accessToken: 'browser.access', refreshToken: 'old.refresh' });
  assert.deepEqual(saved, [{
    filePath: 'token.env',
    state: { accessToken: 'browser.access', refreshToken: 'old.refresh' },
  }]);
});

test('登录页导航网络失败时记录节点但不在本次重试', async () => {
  let navigations = 0;
  const failures = [];
  const error = Object.assign(new Error('net::ERR_TIMED_OUT'), { code: 'ERR_TIMED_OUT' });
  await assert.rejects(navigateToLoginPage({
    goto: async () => {
      navigations += 1;
      throw error;
    },
  }, 'https://zhjw.bbgu.edu.cn/workspace/home', {
    onNetworkFailureFn: async (caught) => failures.push(caught.code),
  }), (caught) => caught === error);
  assert.equal(navigations, 1);
  assert.deepEqual(failures, ['ERR_TIMED_OUT']);
});

test('requestRefreshedAuthState保留OAuth错误类型供失效判断', async () => {
  await assert.rejects(
    requestRefreshedAuthState(
      { homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home' },
      { accessToken: 'old.access', refreshToken: 'old.refresh' },
      {
        fetchFn: async () => ({
          ok: false,
          status: 400,
          text: async () => JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Refresh token expired',
          }),
        }),
        timeoutMs: 50,
      }
    ),
    (error) => error.httpStatus === 400
      && error.oauthError === 'invalid_grant'
      && error.oauthErrorDescription === 'Refresh token expired'
  );
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

test('Refresh网络失败只记录当前节点且不在本次重发', async () => {
  let requests = 0;
  const recorded = [];
  await assert.rejects(requestRefreshedAuthState({
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    proxyServer: 'http://127.0.0.1:7890',
  }, {
    accessToken: 'old.access',
    refreshToken: 'old.refresh',
  }, {
    proxyHttpsRequestFn: async () => {
      requests += 1;
      throw Object.assign(new Error('response incomplete'), { code: 'ERR_HTTP_RESPONSE_INCOMPLETE' });
    },
    recordCurrentProxyFailureFn: async (error) => recorded.push(error.code),
  }), /response incomplete/);
  assert.equal(requests, 1);
  assert.deepEqual(recorded, ['ERR_HTTP_RESPONSE_INCOMPLETE']);
});

test('refreshAndSaveAuthState does not retry a transient failure', async () => {
  let requestCalls = 0;
  const config = {
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    tokenPath: 'token.env',
    storageStatePath: 'storage.json',
  };

  await assert.rejects(refreshAndSaveAuthState(config, {
    readSavedAuthStateFn: async () => ({ accessToken: 'old.access', refreshToken: 'old.refresh' }),
    requestFn: async () => {
      requestCalls += 1;
      throw new Error('temporary network failure');
    },
    saveAuthStateFn: async () => assert.fail('failed Refresh must not save state'),
  }), /temporary network failure/);

  assert.equal(requestCalls, 1);
});

test('refreshAndSaveAuthState保存失败时不再次请求Refresh', async () => {
  let requestCalls = 0;
  let saveCalls = 0;
  const saveError = new Error('disk write failed');

  await assert.rejects(refreshAndSaveAuthState({
    homeUrl: 'https://zhjw.bbgu.edu.cn/workspace/home',
    tokenPath: 'token.env',
    storageStatePath: 'storage.json',
  }, {
    readSavedAuthStateFn: async () => ({ accessToken: 'old.access', refreshToken: 'old.refresh' }),
    requestFn: async () => {
      requestCalls += 1;
      return { accessToken: 'new.access', refreshToken: 'new.refresh' };
    },
    saveAuthStateFn: async () => {
      saveCalls += 1;
      throw saveError;
    },
  }), (error) => error === saveError);

  assert.equal(requestCalls, 1);
  assert.equal(saveCalls, 1);
});

test('refreshAndSaveAuthState does not retry HTTP 5xx', async () => {
  let requestCalls = 0;
  const error = new Error('server unavailable');
  error.httpStatus = 503;

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
  }), /server unavailable/);

  assert.equal(requestCalls, 1);
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

test('Refresh缺失时不得从storageState迁移旧Token', async () => {
  let requests = 0;
  await assert.rejects(refreshAndSaveAuthState({
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
    requestFn: async () => {
      requests += 1;
      return { accessToken: 'new.access', refreshToken: 'new.refresh' };
    },
  }), (error) => error && error.code === 'BBGU_REFRESH_UNAVAILABLE');
  assert.equal(requests, 0);
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
