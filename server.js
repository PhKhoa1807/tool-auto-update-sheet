import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './src/store.js';
import * as pango from './src/pango.js';
import * as sheets from './src/sheets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const MODES = ['overwrite', 'append', 'upsert'];
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
  if (job.target.mode === 'upsert' && !job.target.keyColumn) return { error: 'Chế độ cập nhật theo khoá cần cột khoá' };
  return { job };
}

function startRun(job, trigger) {
  const run = store.createRun({ jobId: job.id, jobName: job.name, trigger });
  const settings = store.getSettings();
  pango
    .fetchData(job.source, settings.pango)
    .then((rows) => sheets.writeRows(job.target, buildTable(rows, job.columns ?? []), settings.google))
    .then((result) => store.finishRun(run.id, { status: 'success', rows: result.rowsWritten }))
    .catch((err) => store.finishRun(run.id, { status: 'failed', error: err.message }));
  return run;
}

app.get('/api/status', (req, res) => {
  const settings = store.getPublicSettings();
  const jobs = store.listJobs();
  const startOfDay = new Date().setHours(0, 0, 0, 0);
  const todayRuns = store.listRuns().filter((r) => r.startedAt >= startOfDay && r.status === 'success');
  res.json({
    pango: { ok: Boolean(settings.pango.baseUrl && settings.pango.hasApiKey), detail: settings.pango.baseUrl },
    google: { ok: settings.google.hasPrivateKey, detail: settings.google.clientEmail },
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

app.post('/api/preview', async (req, res) => {
  try {
    const source = req.body.source ?? {};
    const rows = await pango.fetchData({ ...source, modelId: parseModelId(source.modelId) }, store.getSettings().pango, { limit: 20 });
    const fields = [...new Set(rows.flatMap(Object.keys))].map((field) => ({
      field,
      sample: rows.map((row) => row[field]).find((value) => value !== '' && value !== undefined) ?? '',
    }));
    res.json({ fields, rows });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/runs', (req, res) => res.json(store.listRuns()));

app.get('/api/settings', (req, res) => res.json(store.getPublicSettings()));

app.put('/api/settings', (req, res) => res.json(store.updateSettings(req.body ?? {})));

app.post('/api/settings/test/:target', async (req, res) => {
  const settings = store.getSettings();
  try {
    if (req.params.target === 'pango') {
      // Pango không có endpoint "ping" riêng, nên thử đọc 1 bản ghi của job đầu tiên.
      const job = store.listJobs()[0];
      pango.assertConfigured(settings.pango);
      if (!job) return res.json({ ok: true, message: 'Đã có API key. Tạo job rồi bấm “Xem trước” để thử với dữ liệu thật.' });
      await pango.fetchData(job.source, settings.pango, { limit: 1 });
      return res.json({ ok: true, message: `Pango kết nối được (model ${job.source.modelId})` });
    }
    if (req.params.target === 'google') {
      await sheets.testConnection(settings.google);
      return res.json({ ok: true, message: 'Google Sheets: cấu hình hợp lệ' });
    }
    res.status(404).json({ error: 'Không rõ kết nối cần kiểm tra' });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Tool update sheet đang chạy tại http://localhost:${PORT}`);
});
