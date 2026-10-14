// Log JSON có cấu trúc, mỗi dòng một bản ghi { ts, level, service, msg, ...fields } — cùng định dạng với
// @zma/telemetry bên platform. Ghi ra stdout và ra file logs/app-YYYY-MM-DD.log (thư mục logs/ đã được gitignore).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactValue } from './redact.js';
import { getRequestId } from './request-context.js';

const LOG_DIR = process.env.LOG_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs');

const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

// Ngày theo giờ của máy chạy tool, dạng "2026-10-07".
function localDate() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function defaultWriter(line) {
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `app-${localDate()}.log`), `${line}\n`);
  } catch (err) {
    // Không ghi được file log thì tool vẫn phải chạy tiếp.
    console.error(`Could not write log file: ${err.message}`);
  }
}

// LOG_LEVEL trong môi trường được ưu tiên hơn options.level (mặc định info).
function resolveLevel(options) {
  const fromEnv = process.env.LOG_LEVEL?.toLowerCase();
  return fromEnv in LEVEL_ORDER ? fromEnv : (options.level ?? 'info');
}

export function createLogger(service, options = {}) {
  const minLevel = resolveLevel(options);
  const writer = options.writer ?? defaultWriter;
  const bindings = { ...options.bindings };

  const emit = (level, message, fields = {}) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

    const requestId =
      (typeof bindings.requestId === 'string' ? bindings.requestId : undefined) ??
      (typeof fields.requestId === 'string' ? fields.requestId : undefined) ??
      getRequestId();

    const payload = redactValue({ ...bindings, ...fields });
    if (requestId) payload.requestId = requestId;

    writer(JSON.stringify({ ts: new Date().toISOString(), level, service, msg: message, ...payload }));
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (childBindings) => createLogger(service, { level: minLevel, writer, bindings: { ...bindings, ...childBindings } }),
  };
}
