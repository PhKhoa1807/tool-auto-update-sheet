import express from 'express';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as store from './src/store.js';
import * as pango from './src/pango.js';
import * as inbox from './src/inbox.js';
import * as sheets from './src/sheets.js';
import { createLogger } from './src/logger.js';
import { generateRequestId, runWithRequestId } from './src/request-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const log = createLogger(process.env.SERVICE_NAME ?? 'tool-update-sheet');

process.on('unhandledRejection', (reason) => log.error('unhandled_rejection', { err: reason }));
process.on('uncaughtException', (err) => {
  log.error('uncaught_exception', { err });
  process.exit(1);
});

const app = express();

// Ghi lại mọi request API và webhook, trừ các GET thành công (giao diện tự gọi lại mỗi vài giây).
// Không ghi body vì có thể chứa client secret, token hoặc dữ liệu người chơi.
const LOGGED_PATHS = ['/api', '/webhook'];

app.use(LOGGED_PATHS, (req, res, next) => {
  const startedAt = Date.now();
  const requestId = generateRequestId();
  res.locals.requestId = requestId;
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    res.locals.errorMessage = body?.error;
    return sendJson(body);
  };
  res.on('finish', () => {
    const failed = res.statusCode >= 400;
    if (req.method === 'GET' && !failed) return;
    const level = res.statusCode >= 500 ? 'error' : failed ? 'warn' : 'info';
    log[level]('request', {
      requestId,
      method: req.method,
      path: `${req.baseUrl}${req.path}`,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      error: res.locals.errorMessage,
    });
  });
  next();
});

app.use(express.json({ limit: '1mb' }));
// Đặt sau express.json: đọc body xong mới vào ngữ cảnh request id thì các handler phía sau không bị mất ngữ cảnh.
app.use(LOGGED_PATHS, (req, res, next) => runWithRequestId(res.locals.requestId, next));
app.use(express.static(path.join(__dirname, 'public')));

const MODES = ['overwrite', 'upsert'];
const SCHEDULES = ['manual', 'every15m', 'hourly', 'daily'];
const DATE_RANGES = ['all', 'today', 'yesterday', 'last7days', 'last30days', 'thisMonth'];

// Nhận mã model hoặc cả URL của Pango (…/custom-models/<mã>/search).
function parseModelId(value) {
  const text = String(value ?? '').trim();
  return text.match(/custom-models\/([^/?#]+)/)?.[1] ?? text;
}

function parseColumns(columns) {
  if (!Array.isArray(columns)) return [];
  return columns
    .map((column) => ({ field: String(column?.field ?? '').trim(), header: String(column?.header ?? '').trim() }))
    .filter((column) => column.field)
    .map((column) => ({ field: column.field, header: column.header || column.field }));
}

// Áp cấu hình cột của job lên dữ liệu Pango; không cấu hình cột thì lấy mọi trường.
function buildTable(rows, columns) {
  const cols = columns.length ? columns : [...new Set(rows.flatMap(Object.keys))].map((field) => ({ field, header: field }));
  return {
    fields: cols.map((column) => column.field),
    headers: cols.map((column) => column.header),
    values: rows.map((row) => cols.map((column) => row[column.field] ?? '')),
  };
}

function parseJob(body) {
  const source = body.source ?? {};
  const target = body.target ?? {};
  const schedule = body.schedule ?? {};
  const job = {
    name: String(body.name ?? '').trim(),
    enabled: body.enabled !== false,
    source: {
      modelId: parseModelId(source.modelId),
      dateRange: DATE_RANGES.includes(source.dateRange) ? source.dateRange : 'all',
    },
    columns: parseColumns(body.columns),
    target: {
      spreadsheetId: String(target.spreadsheetId ?? '').trim(),
      sheetName: String(target.sheetName ?? '').trim(),
      startCell: String(target.startCell ?? '').trim() || 'A1',
      mode: MODES.includes(target.mode) ? target.mode : 'overwrite',
      keyColumn: String(target.keyColumn ?? '').trim(),
      includeHeader: target.includeHeader !== false,
    },
    schedule: {
      type: SCHEDULES.includes(schedule.type) ? schedule.type : 'manual',
      time: String(schedule.time ?? ''),
    },
  };
  if (!job.name) return { error: 'Thiếu tên job' };
  if (!job.source.modelId) return { error: 'Thiếu mã model Pango' };
  if (!job.target.spreadsheetId) return { error: 'Thiếu Google Sheet' };
  if (!job.target.sheetName) return { error: 'Thiếu tên tab' };
  // Không tự đổi sang ghi đè: job cũ chế độ “append” mở ra sửa sẽ có ô Cách ghi trống, phải chọn lại.
  if (!MODES.includes(target.mode)) return { error: 'Chọn cách ghi vào sheet' };
  if (job.target.mode === 'upsert' && !job.target.keyColumn) return { error: 'Chế độ cập nhật theo khoá cần cột khoá' };
  return { job };
}

// Dữ liệu của model là những bản ghi Pango đã đẩy sang qua webhook.
function loadRows(source, { limit } = {}) {
  const records = inbox.getRecords(source.modelId);
  if (!records) throw new Error(`Model ${source.modelId} chưa nhận bản ghi nào qua webhook. Tạo Webhook Event cho model này trên Pango rồi bấm Sync.`);
  return pango.toRows(records, source).slice(0, limit);
}

function startRun(job, trigger) {
  const run = store.createRun({ jobId: job.id, jobName: job.name, trigger });
  const settings = store.getSettings();
  const jobLog = log.child({ jobId: job.id, jobName: job.name, runId: run.id });
  const elapsed = () => Date.now() - run.startedAt;
  jobLog.info('job_started', { trigger, source: job.source, target: job.target });
  Promise.resolve()
    .then(() => {
      const rows = loadRows(job.source);
      jobLog.info('job_loaded', { rows: rows.length });
      return sheets.writeRows(job.target, buildTable(rows, job.columns ?? []), settings.google);
    })
    .then((result) => {
      store.finishRun(run.id, { status: 'success', rows: result.rowsWritten });
      jobLog.info('job_succeeded', { rows: result.rowsWritten, durationMs: elapsed() });
    })
    .catch((err) => {
      jobLog.error('job_failed', { durationMs: elapsed(), err });
      store.finishRun(run.id, { status: 'failed', error: err.message });
    });
  return run;
}

app.get('/api/status', (req, res) => {
  const settings = store.getPublicSettings();
  const jobs = store.listJobs();
  const startOfDay = new Date().setHours(0, 0, 0, 0);
  const todayRuns = store.listRuns().filter((r) => r.startedAt >= startOfDay && r.status === 'success');
  const models = inbox.listModels();
  res.json({
    webhook: { ok: settings.webhook.hasToken, receivedAt: Math.max(0, ...models.map((model) => model.receivedAt)) || null, models },
    google: { ok: settings.google.connected, detail: settings.google.email },
    totalJobs: jobs.length,
    activeJobs: jobs.filter((j) => j.enabled).length,
    rowsToday: todayRuns.reduce((sum, r) => sum + r.rows, 0),
  });
});

app.get('/api/jobs', (req, res) => res.json(store.listJobs()));

app.post('/api/jobs', (req, res) => {
  const { job, error } = parseJob(req.body);
  if (error) return res.status(400).json({ error });
  res.status(201).json(store.createJob(job));
});

app.put('/api/jobs/:id', (req, res) => {
  const { job, error } = parseJob(req.body);
  if (error) return res.status(400).json({ error });
  const updated = store.updateJob(req.params.id, job);
  if (!updated) return res.status(404).json({ error: 'Không tìm thấy job' });
  res.json(updated);
});

app.patch('/api/jobs/:id/enabled', (req, res) => {
  const updated = store.updateJob(req.params.id, { enabled: Boolean(req.body.enabled) });
  if (!updated) return res.status(404).json({ error: 'Không tìm thấy job' });
  res.json(updated);
});

app.delete('/api/jobs/:id', (req, res) => {
  if (!store.deleteJob(req.params.id)) return res.status(404).json({ error: 'Không tìm thấy job' });
  res.status(204).end();
});

app.post('/api/jobs/:id/run', (req, res) => {
  const job = store.listJobs().find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Không tìm thấy job' });
  if (job.running) return res.status(409).json({ error: 'Job này đang chạy' });
  res.status(202).json(startRun(job, 'manual'));
});

app.post('/api/preview', (req, res) => {
  try {
    const source = req.body.source ?? {};
    const rows = loadRows({ ...source, modelId: parseModelId(source.modelId) }, { limit: 20 });
    const fields = [...new Set(rows.flatMap(Object.keys))].map((field) => ({
      field,
      sample: rows.map((row) => row[field]).find((value) => value !== '' && value !== undefined) ?? '',
    }));
    res.json({ fields, rows });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get('/api/runs', (req, res) => res.json(store.listRuns()));

app.get('/api/settings', (req, res) => res.json(store.getPublicSettings()));

app.put('/api/settings', (req, res) => res.json(store.updateSettings(req.body ?? {})));

app.post('/api/settings/test/:target', async (req, res) => {
  const settings = store.getSettings();
  try {
    if (req.params.target === 'google') {
      await sheets.testConnection(settings.google);
      return res.json({ ok: true, message: `Google kết nối được${settings.google.email ? ` bằng ${settings.google.email}` : ''}` });
    }
    res.status(404).json({ error: 'Không rõ kết nối cần kiểm tra' });
  } catch (err) {
    log.error('connection_test_failed', { target: req.params.target, err });
    res.status(502).json({ error: err.message });
  }
});

/* ---------- Đăng nhập Google (OAuth) ---------- */

// Phải trùng khớp với "Authorized redirect URI" khai báo trong Google Cloud Console.
const googleRedirectUri = (req) => `${req.protocol}://${req.get('host')}/api/google/callback`;
const backToSettings = (res, params) => res.redirect(`/?${new URLSearchParams({ view: 'settings', ...params })}`);

// Mã chống giả mạo cho lần đăng nhập đang dở; chỉ dùng được một lần.
let pendingOAuthState = null;

app.get('/api/google/login', (req, res) => {
  try {
    pendingOAuthState = randomBytes(16).toString('hex');
    res.redirect(sheets.buildAuthUrl(store.getSettings().google, googleRedirectUri(req), pendingOAuthState));
  } catch (err) {
    log.error('google_login_url_failed', { err });
    backToSettings(res, { googleError: err.message });
  }
});

app.get('/api/google/callback', async (req, res) => {
  const expectedState = pendingOAuthState;
  pendingOAuthState = null;
  if (req.query.error) {
    log.warn('google_login_denied', { reason: String(req.query.error) });
    return backToSettings(res, { googleError: `Google báo: ${req.query.error}` });
  }
  if (!expectedState || req.query.state !== expectedState || !req.query.code) {
    log.warn('google_login_rejected', { reason: 'state_mismatch_or_missing_code' });
    return backToSettings(res, { googleError: 'Phiên đăng nhập không hợp lệ, hãy bấm “Đăng nhập Google” lại.' });
  }
  try {
    store.setGoogleSession(await sheets.exchangeCode(store.getSettings().google, googleRedirectUri(req), String(req.query.code)));
    log.info('google_login_succeeded');
    backToSettings(res, { google: 'ok' });
  } catch (err) {
    log.error('google_login_failed', { err });
    backToSettings(res, { googleError: err.message });
  }
});

app.post('/api/google/logout', (req, res) => {
  store.setGoogleSession({ refreshToken: '', email: '' });
  res.json(store.getPublicSettings());
});

/* ---------- Webhook: Pango đẩy bản ghi sang ---------- */

// Phải trùng với "Token Field" khai trong Webhook connection trên Pango.
const WEBHOOK_HEADER = 'X-Webhook-Token';
const SYNC_DELAY_MS = 5000;
const pendingSyncs = new Map();

const digest = (text) => createHash('sha256').update(String(text ?? '')).digest();

// Container "List" gửi mảng (bọc trong Entries Key nếu có khai), container "Object" gửi từng bản ghi.
function webhookRecords(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (body.objectModel) return [body];
  return Object.values(body).find(Array.isArray) ?? [];
}

// Pango đẩy nhiều lô liên tiếp; chờ lặng vài giây rồi mới ghi sheet một lần để không vượt hạn mức Sheets API.
function scheduleSync(modelId) {
  clearTimeout(pendingSyncs.get(modelId));
  pendingSyncs.set(
    modelId,
    setTimeout(() => {
      pendingSyncs.delete(modelId);
      const jobs = store.listJobs().filter((job) => job.enabled && job.source.modelId === modelId);
      if (!jobs.length) return log.info('webhook_no_job', { modelId });
      if (jobs.some((job) => job.running)) {
        log.info('webhook_sync_deferred', { modelId, reason: 'job_running' });
        return scheduleSync(modelId);
      }
      for (const job of jobs) startRun(job, 'webhook');
    }, SYNC_DELAY_MS),
  );
}

app.post('/webhook/pango', (req, res) => {
  const { token } = store.getSettings().webhook;
  if (!token) return res.status(503).json({ success: false, error: 'Chưa đặt token webhook (vào Cài đặt)' });
  if (!timingSafeEqual(digest(req.get(WEBHOOK_HEADER)), digest(token))) {
    log.warn('webhook_rejected', { ip: req.ip });
    return res.status(401).json({ success: false, error: 'Sai token webhook' });
  }

  const received = webhookRecords(req.body);
  const byModel = new Map();
  for (const record of received) {
    if (!inbox.isModelId(record?.objectModel) || record.id === undefined || record.id === null || record.id === '') continue;
    if (!byModel.has(record.objectModel)) byModel.set(record.objectModel, []);
    byModel.get(record.objectModel).push(record);
  }
  // Không ghi nội dung bản ghi vào log vì có số điện thoại, email; chỉ ghi tên trường để dò cấu trúc.
  if (received.length && !byModel.size) {
    log.warn('webhook_unrecognized', { records: received.length, fields: Object.keys(received[0] ?? {}) });
    return res.status(422).json({ success: false, error: 'Bản ghi thiếu objectModel hoặc id' });
  }

  const models = {};
  let accepted = 0;
  for (const [modelId, records] of byModel) {
    models[modelId] = inbox.saveRecords(modelId, records);
    accepted += records.length;
    scheduleSync(modelId);
  }
  log.info('webhook_received', { records: received.length, skipped: received.length - accepted, models });
  res.json({ success: true });
});

// Lỗi không route nào tự bắt (JSON gửi lên sai, không ghi được data/db.json, …).
app.use((err, req, res, next) => {
  log.error('unhandled_exception', { requestId: res.locals.requestId, method: req.method, path: req.originalUrl.split('?')[0], err });
  if (res.headersSent) return next(err);
  res.status(err.status ?? 500).json({ error: err.message });
});

app.listen(PORT, () => {
  log.info('listening', { port: Number(PORT), url: `http://localhost:${PORT}` });
});
