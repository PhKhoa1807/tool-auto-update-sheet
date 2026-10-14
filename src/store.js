// Lưu job, lịch sử chạy và cài đặt vào data/db.json (thư mục data/ đã được gitignore vì chứa token và client secret).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_RUNS = 200;

const db = load();

function load() {
  const empty = {
    jobs: [],
    runs: [],
    settings: {
      google: { clientId: '', clientSecret: '', refreshToken: '', email: '' },
      webhook: { token: '' },
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
      google: { ...empty.settings.google, ...saved.settings?.google },
      webhook: { ...empty.settings.webhook, ...saved.settings?.webhook },
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

// Không trả secret về trình duyệt, chỉ báo là đã lưu hay chưa.
export function getPublicSettings() {
  const { google, webhook } = db.settings;
  return {
    google: { clientId: google.clientId, hasClientSecret: Boolean(google.clientSecret), connected: Boolean(google.refreshToken), email: google.email },
    webhook: { hasToken: Boolean(webhook.token) },
  };
}

export function updateSettings({ google, webhook }) {
  if (google) {
    const current = db.settings.google;
    const clientId = typeof google.clientId === 'string' ? google.clientId.trim() : current.clientId;
    const clientSecret = google.clientSecret ? String(google.clientSecret).trim() : current.clientSecret;
    // Refresh token gắn với đúng một OAuth client; đổi client thì phải đăng nhập lại.
    if (clientId !== current.clientId || clientSecret !== current.clientSecret) Object.assign(current, { refreshToken: '', email: '' });
    Object.assign(current, { clientId, clientSecret });
  }
  if (webhook?.token) db.settings.webhook.token = String(webhook.token).trim();
  save();
  return getPublicSettings();
}

export function setGoogleSession({ refreshToken, email }) {
  Object.assign(db.settings.google, { refreshToken, email });
  save();
}
