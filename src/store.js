// Lưu job, lịch sử chạy và cài đặt vào data/db.json (thư mục data/ đã được gitignore vì chứa API key).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_RUNS = 200;

const db = load();

function load() {
  const empty = {
    jobs: [],
    runs: [],
    settings: {
      pango: { baseUrl: 'https://svc.mydatalakes.com/datahub/api', apiKey: '', token: '' },
      google: { clientId: '', clientSecret: '', refreshToken: '', email: '' },
    },
  };
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Không đọc được ${DB_FILE}: ${err.message}`);
    return empty;
  }
  const loaded = {
    jobs: saved.jobs ?? [],
    runs: saved.runs ?? [],
    settings: {
      pango: { ...empty.settings.pango, ...saved.settings?.pango },
      google: { ...empty.settings.google, ...saved.settings?.google },
    },
  };
  // Lần chạy dở dang khi server tắt thì không bao giờ xong được nữa.
  for (const run of loaded.runs) {
    if (run.status === 'running') Object.assign(run, { status: 'failed', error: 'Server khởi động lại khi job đang chạy.', finishedAt: run.startedAt });
  }
  return loaded;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export function listJobs() {
  return db.jobs.map((job) => ({
    ...job,
    running: db.runs.some((r) => r.jobId === job.id && r.status === 'running'),
    lastRun: db.runs.find((r) => r.jobId === job.id) ?? null,
  }));
}

export function getJob(id) {
  return db.jobs.find((j) => j.id === id);
}

export function createJob(data) {
  const job = { id: randomUUID(), ...data };
  db.jobs.push(job);
  save();
  return job;
}

export function updateJob(id, data) {
  const job = getJob(id);
  if (!job) return null;
  Object.assign(job, data, { id });
  save();
  return job;
}

export function deleteJob(id) {
  const index = db.jobs.findIndex((j) => j.id === id);
  if (index === -1) return false;
  db.jobs.splice(index, 1);
  save();
  return true;
}

export function listRuns() {
  return db.runs;
}

export function createRun({ jobId, jobName, trigger }) {
  const run = { id: randomUUID(), jobId, jobName, trigger, status: 'running', rows: 0, startedAt: Date.now(), finishedAt: null, error: '' };
  db.runs.unshift(run);
  if (db.runs.length > MAX_RUNS) db.runs.length = MAX_RUNS;
  save();
  return run;
}

export function finishRun(id, patch) {
  const run = db.runs.find((r) => r.id === id);
  if (run) Object.assign(run, patch, { finishedAt: Date.now() });
  save();
  return run;
}

export function getSettings() {
  return db.settings;
}

// TOKEN của Pango là JWT; đọc hạn dùng để cảnh báo trước khi nó hết hạn.
function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// Không trả secret về trình duyệt, chỉ báo là đã lưu hay chưa.
export function getPublicSettings() {
  const { pango, google } = db.settings;
  return {
    pango: {
      baseUrl: pango.baseUrl,
      hasApiKey: Boolean(pango.apiKey),
      hasToken: Boolean(pango.token),
      tokenExpiresAt: pango.token ? tokenExpiry(pango.token) : null,
    },
    google: { clientId: google.clientId, hasClientSecret: Boolean(google.clientSecret), connected: Boolean(google.refreshToken), email: google.email },
  };
}

export function updateSettings({ pango, google }) {
  if (pango) {
    if (typeof pango.baseUrl === 'string') db.settings.pango.baseUrl = pango.baseUrl.trim();
    if (pango.apiKey) db.settings.pango.apiKey = String(pango.apiKey).trim();
    if (pango.token) db.settings.pango.token = String(pango.token).trim();
    if (pango.clearToken) db.settings.pango.token = '';
  }
  if (google) {
    const current = db.settings.google;
    const clientId = typeof google.clientId === 'string' ? google.clientId.trim() : current.clientId;
    const clientSecret = google.clientSecret ? String(google.clientSecret).trim() : current.clientSecret;
    // Refresh token gắn với đúng một OAuth client; đổi client thì phải đăng nhập lại.
    if (clientId !== current.clientId || clientSecret !== current.clientSecret) Object.assign(current, { refreshToken: '', email: '' });
    Object.assign(current, { clientId, clientSecret });
  }
  save();
  return getPublicSettings();
}

export function setGoogleSession({ refreshToken, email }) {
  Object.assign(db.settings.google, { refreshToken, email });
  save();
}
