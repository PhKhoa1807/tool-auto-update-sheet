const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const MODE_LABELS = { overwrite: 'Ghi đè', append: 'Nối thêm', upsert: 'Cập nhật theo khoá' };
const RANGE_LABELS = { all: 'Tất cả', today: 'Hôm nay', yesterday: 'Hôm qua', last7days: '7 ngày', last30days: '30 ngày', thisMonth: 'Tháng này' };
const STATUS_LABELS = { success: 'Thành công', failed: 'Lỗi', running: 'Đang chạy' };
const TRIGGER_LABELS = { manual: 'Chạy tay', schedule: 'Theo lịch' };

// Trường được tick sẵn khi tải cột lần đầu: các custom field và thời điểm tạo bản ghi.
const DEFAULT_FIELD = /^customField|^modelCreatedAt$/;

// columns: [{ field, header, sample, checked }] — trạng thái bảng chọn cột trong form job.
const state = { jobs: [], runs: [], status: null, view: 'sync', editingId: null, columns: [] };

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Lỗi ${response.status}`);
  return data;
}

function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

function timeAgo(timestamp) {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return 'Vừa xong';
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.round(hours / 24)} ngày trước`;
}

const fullTime = (timestamp) => new Date(timestamp).toLocaleString('vi-VN');

function scheduleLabel({ type, time }) {
  if (type === 'every15m') return 'Mỗi 15 phút';
  if (type === 'hourly') return 'Mỗi giờ';
  if (type === 'daily') return `Hằng ngày lúc ${time || '00:00'}`;
  return 'Chỉ chạy tay';
}

const statusBadge = (status) => `<span class="badge ${esc(status)}">${STATUS_LABELS[status] ?? 'Chưa chạy'}</span>`;

const sheetUrl = (id) => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}`;

/* ---------- Render ---------- */

function renderConnections() {
  const { pango, google } = state.status;
  $('#connections').innerHTML = [
    ['Pango API', pango],
    ['Google Sheets', google],
  ]
    .map(([name, conn]) => `<div class="conn"><span class="dot ${conn.ok ? 'ok' : ''}"></span>${name}</div>`)
    .join('');
}

function renderStats() {
  const { pango, google, activeJobs, totalJobs, rowsToday } = state.status;
  const connCard = (label, conn) => `
    <div class="card stat">
      <div class="stat-label">${label}</div>
      <div class="stat-value"><span class="dot ${conn.ok ? 'ok' : ''}"></span>${conn.ok ? 'Đã kết nối' : 'Chưa cấu hình'}</div>
      <div class="stat-detail" title="${esc(conn.detail)}">${esc(conn.detail) || 'Vào Cài đặt để thiết lập'}</div>
    </div>`;
  $('#stats').innerHTML = `
    ${connCard('Pango API', pango)}
    ${connCard('Google Sheets', google)}
    <div class="card stat">
      <div class="stat-label">Job đang bật</div>
      <div class="stat-value">${activeJobs} / ${totalJobs}</div>
    </div>
    <div class="card stat">
      <div class="stat-label">Dòng đã đồng bộ hôm nay</div>
      <div class="stat-value">${rowsToday.toLocaleString('vi-VN')}</div>
    </div>`;
}

function renderJobs() {
  const body = $('#jobs-body');
  if (!state.jobs.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Chưa có job nào. Bấm “+ Tạo job” để bắt đầu.</td></tr>';
    return;
  }
  body.innerHTML = state.jobs
    .map((job) => {
      const last = job.lastRun;
      const lastCell = last
        ? `${statusBadge(last.status)}
           <div class="sub" title="${esc(fullTime(last.startedAt))}">${timeAgo(last.startedAt)}${last.status === 'success' ? ` · ${last.rows.toLocaleString('vi-VN')} dòng` : ''}</div>`
        : statusBadge('');
      return `
        <tr data-id="${esc(job.id)}">
          <td><strong>${esc(job.name)}</strong></td>
          <td>
            <code>${esc(job.source.modelId)}</code>
            <div class="sub">${RANGE_LABELS[job.source.dateRange] ?? ''} · ${job.columns?.length ? `${job.columns.length} cột` : 'mọi trường'}</div>
          </td>
          <td>
            <a href="${sheetUrl(job.target.spreadsheetId)}" target="_blank" rel="noopener">${esc(job.target.sheetName)}!${esc(job.target.startCell)}</a>
            <div class="sub">${MODE_LABELS[job.target.mode]}</div>
          </td>
          <td>${scheduleLabel(job.schedule)}</td>
          <td>${lastCell}</td>
          <td>
            <label class="switch" title="Bật/tắt chạy theo lịch">
              <input type="checkbox" data-action="toggle" ${job.enabled ? 'checked' : ''} aria-label="Bật job ${esc(job.name)}"><span></span>
            </label>
          </td>
          <td>
            <div class="row-actions">
              <button class="btn small primary" data-action="run" ${job.running ? 'disabled' : ''}>Chạy</button>
              <button class="btn small" data-action="preview">Xem trước</button>
              <button class="btn small" data-action="edit">Sửa</button>
              <button class="btn small danger" data-action="delete">Xoá</button>
            </div>
          </td>
        </tr>`;
    })
    .join('');
}

function renderJobFilter() {
  const select = $('#filter-job');
  const current = select.value;
  select.innerHTML =
    '<option value="">Mọi job</option>' +
    state.jobs.map((job) => `<option value="${esc(job.id)}">${esc(job.name)}</option>`).join('');
  select.value = current;
}

function renderRuns() {
  const jobId = $('#filter-job').value;
  const status = $('#filter-status').value;
  const runs = state.runs.filter((run) => (!jobId || run.jobId === jobId) && (!status || run.status === status));
  const body = $('#runs-body');
  if (!runs.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Không có lần chạy nào khớp bộ lọc.</td></tr>';
    return;
  }
  body.innerHTML = runs
    .map((run) => {
      const duration = run.finishedAt ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s` : '—';
      return `
        <tr>
          <td title="${esc(timeAgo(run.startedAt))}">${esc(fullTime(run.startedAt))}</td>
          <td>${esc(run.jobName)}</td>
          <td>${TRIGGER_LABELS[run.trigger] ?? esc(run.trigger)}</td>
          <td>${statusBadge(run.status)}</td>
          <td class="num">${run.status === 'success' ? run.rows.toLocaleString('vi-VN') : '—'}</td>
          <td class="num">${duration}</td>
          <td class="error-text">${esc(run.error)}</td>
        </tr>`;
    })
    .join('');
}

function render() {
  renderConnections();
  renderStats();
  renderJobs();
  renderJobFilter();
  renderRuns();
}

/* ---------- Data ---------- */

let lastSnapshot = '';

async function refresh() {
  const [status, jobs, runs] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/jobs'), api('GET', '/api/runs')]);
  const snapshot = JSON.stringify([status, jobs, runs]);
  if (snapshot === lastSnapshot) return;
  lastSnapshot = snapshot;
  Object.assign(state, { status, jobs, runs });
  render();
}

async function runJob(id) {
  try {
    await api('POST', `/api/jobs/${id}/run`);
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- Điều hướng ---------- */

function showView(view) {
  state.view = view;
  $$('.view').forEach((section) => (section.hidden = section.id !== `view-${view}`));
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  if (view === 'settings') loadSettings();
}

$$('.nav-item').forEach((item) => item.addEventListener('click', () => showView(item.dataset.view)));

/* ---------- Bảng job ---------- */

$('#jobs-body').addEventListener('click', async (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  const id = event.target.closest('tr')?.dataset.id;
  const job = state.jobs.find((j) => j.id === id);
  if (!action || !job) return;

  if (action === 'run') runJob(id);
  if (action === 'edit') openJobDialog(job);
  if (action === 'preview') openPreview(job.source, job.columns ?? []);
  if (action === 'delete' && confirm(`Xoá job “${job.name}”? Dữ liệu đã ghi trên Google Sheet vẫn giữ nguyên.`)) {
    try {
      await api('DELETE', `/api/jobs/${id}`);
      toast('Đã xoá job');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
});

$('#jobs-body').addEventListener('change', async (event) => {
  if (event.target.dataset.action !== 'toggle') return;
  const id = event.target.closest('tr').dataset.id;
  try {
    await api('PATCH', `/api/jobs/${id}/enabled`, { enabled: event.target.checked });
    await refresh();
  } catch (err) {
    event.target.checked = !event.target.checked;
    toast(err.message, 'error');
  }
});

$('#run-all').addEventListener('click', async () => {
  const jobs = state.jobs.filter((job) => job.enabled && !job.running);
  if (!jobs.length) return toast('Không có job đang bật nào để chạy');
  await Promise.all(jobs.map((job) => api('POST', `/api/jobs/${job.id}/run`).catch((err) => toast(err.message, 'error'))));
  await refresh();
});

$('#filter-job').addEventListener('change', renderRuns);
$('#filter-status').addEventListener('change', renderRuns);

/* ---------- Dialog job ---------- */

const jobDialog = $('#job-dialog');
const jobForm = $('#job-form');

function syncConditionalFields() {
  $('#key-column-field').hidden = jobForm.mode.value !== 'upsert';
  $('#schedule-time-field').hidden = jobForm.scheduleType.value !== 'daily';
}

function openJobDialog(job) {
  state.editingId = job?.id ?? null;
  $('#job-dialog-title').textContent = job ? 'Sửa job' : 'Tạo job';
  $('#job-error').hidden = true;
  jobForm.reset();
  state.columns = (job?.columns ?? []).map((column) => ({ ...column, sample: '', checked: true }));
  renderColumns();
  if (job) {
    jobForm.elements.name.value = job.name;
    jobForm.modelId.value = job.source.modelId;
    jobForm.dateRange.value = job.source.dateRange;
    jobForm.spreadsheet.value = job.target.spreadsheetId;
    jobForm.sheetName.value = job.target.sheetName;
    jobForm.startCell.value = job.target.startCell;
    jobForm.mode.value = job.target.mode;
    jobForm.keyColumn.value = job.target.keyColumn;
    jobForm.includeHeader.checked = job.target.includeHeader;
    jobForm.scheduleType.value = job.schedule.type;
    if (job.schedule.time) jobForm.scheduleTime.value = job.schedule.time;
  }
  syncConditionalFields();
  jobDialog.showModal();
}

// Đọc phần "Lấy từ Pango" của form; ném lỗi nếu chưa nhập model.
function readSource() {
  const modelId = jobForm.modelId.value.trim();
  if (!modelId) throw new Error('Nhập mã model Pango trước');
  return { modelId, dateRange: jobForm.dateRange.value };
}

const selectedColumns = () =>
  state.columns.filter((column) => column.checked).map(({ field, header }) => ({ field, header: header.trim() || field }));

function renderColumns() {
  const chosen = state.columns.filter((column) => column.checked).length;
  $('#columns-hint').textContent = !state.columns.length
    ? 'Chưa chọn cột: sẽ ghi mọi trường Pango trả về. Bấm “Tải cột từ Pango” để chọn và đặt tên cột.'
    : chosen
      ? `Đã chọn ${chosen} / ${state.columns.length} trường. Sửa ô bên phải để đặt tên cột trên sheet.`
      : 'Chưa tick trường nào: sẽ ghi mọi trường Pango trả về.';
  $('#columns-list').innerHTML = state.columns
    .map(
      (column, index) => `
      <div class="column-row ${column.checked ? '' : 'off'}" data-index="${index}">
        <input type="checkbox" data-col="checked" ${column.checked ? 'checked' : ''} aria-label="Ghi trường ${esc(column.field)}">
        <div class="column-field" title="${esc(column.sample)}">
          <code>${esc(column.field)}</code>
          <div class="sub">${column.sample === '' ? '&nbsp;' : esc(column.sample)}</div>
        </div>
        <input type="text" data-col="header" value="${esc(column.header)}" placeholder="${esc(column.field)}" aria-label="Tên cột cho ${esc(column.field)}">
        <div class="column-move">
          <button class="icon-btn" type="button" data-col="up" aria-label="Chuyển lên">▲</button>
          <button class="icon-btn" type="button" data-col="down" aria-label="Chuyển xuống">▼</button>
        </div>
      </div>`,
    )
    .join('');
}

// Lấy danh sách trường từ các bản ghi mới nhất; giữ nguyên những cột đã cấu hình.
async function loadColumns() {
  const { fields } = await api('POST', '/api/preview', { source: { ...readSource(), dateRange: 'all' } });
  if (!fields.length) throw new Error('Model này chưa có bản ghi nào nên chưa lấy được danh sách trường');
  const firstLoad = !state.columns.length;
  const known = new Map(state.columns.map((column) => [column.field, column]));
  for (const { field, sample } of fields) {
    const existing = known.get(field);
    if (existing) existing.sample = sample;
    else state.columns.push({ field, header: field, sample, checked: firstLoad && DEFAULT_FIELD.test(field) });
  }
  renderColumns();
}

$('#columns-list').addEventListener('input', (event) => {
  if (event.target.dataset.col !== 'header') return;
  state.columns[event.target.closest('.column-row').dataset.index].header = event.target.value;
});

$('#columns-list').addEventListener('change', (event) => {
  if (event.target.dataset.col !== 'checked') return;
  state.columns[event.target.closest('.column-row').dataset.index].checked = event.target.checked;
  renderColumns();
});

$('#columns-list').addEventListener('click', (event) => {
  const direction = event.target.dataset.col;
  if (direction !== 'up' && direction !== 'down') return;
  const index = Number(event.target.closest('.column-row').dataset.index);
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= state.columns.length) return;
  [state.columns[index], state.columns[swapWith]] = [state.columns[swapWith], state.columns[index]];
  renderColumns();
});

$('#load-columns-btn').addEventListener('click', async (event) => {
  event.target.disabled = true;
  $('#job-error').hidden = true;
  try {
    await loadColumns();
  } catch (err) {
    showJobError(err.message);
  } finally {
    event.target.disabled = false;
  }
});

function showJobError(message) {
  const el = $('#job-error');
  el.textContent = message;
  el.hidden = false;
}

jobForm.mode.addEventListener('change', syncConditionalFields);
jobForm.scheduleType.addEventListener('change', syncConditionalFields);

$('#new-job').addEventListener('click', () => openJobDialog(null));

$('#preview-btn').addEventListener('click', () => {
  try {
    openPreview(readSource(), selectedColumns());
  } catch (err) {
    showJobError(err.message);
  }
});

jobForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const spreadsheet = jobForm.spreadsheet.value.trim();
    const existing = state.jobs.find((j) => j.id === state.editingId);
    const payload = {
      name: jobForm.elements.name.value,
      enabled: existing?.enabled ?? true,
      source: readSource(),
      columns: selectedColumns(),
      target: {
        spreadsheetId: spreadsheet.match(/\/d\/([\w-]+)/)?.[1] ?? spreadsheet,
        sheetName: jobForm.sheetName.value,
        startCell: jobForm.startCell.value,
        mode: jobForm.mode.value,
        keyColumn: jobForm.mode.value === 'upsert' ? jobForm.keyColumn.value : '',
        includeHeader: jobForm.includeHeader.checked,
      },
      schedule: {
        type: jobForm.scheduleType.value,
        time: jobForm.scheduleType.value === 'daily' ? jobForm.scheduleTime.value : '',
      },
    };
    if (state.editingId) await api('PUT', `/api/jobs/${state.editingId}`, payload);
    else await api('POST', '/api/jobs', payload);
    jobDialog.close();
    toast(state.editingId ? 'Đã lưu thay đổi' : 'Đã tạo job');
    await refresh();
  } catch (err) {
    showJobError(err.message);
  }
});

/* ---------- Xem trước ---------- */

// columns: [{ field, header }] của job; rỗng thì hiển thị mọi trường.
async function openPreview(source, columns) {
  const body = $('#preview-body');
  body.innerHTML = '<p class="muted">Đang lấy dữ liệu từ Pango…</p>';
  $('#preview-dialog').showModal();
  try {
    const { fields, rows } = await api('POST', '/api/preview', { source });
    if (!rows.length) {
      body.innerHTML = '<p class="muted">Pango không trả về bản ghi nào trong khoảng thời gian này.</p>';
      return;
    }
    const cols = columns.length ? columns : fields.map(({ field }) => ({ field, header: field }));
    body.innerHTML = `
      <p class="muted">${rows.length} bản ghi mới nhất của model <code>${esc(source.modelId)}</code>, đúng như sẽ ghi lên sheet.</p>
      <div class="table-wrap card">
        <table>
          <thead><tr>${cols.map((c) => `<th>${esc(c.header)}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((row) => `<tr>${cols.map((c) => `<td>${esc(row[c.field])}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>`;
  } catch (err) {
    body.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
  }
}

$$('[data-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));

/* ---------- Cài đặt ---------- */

const pangoForm = $('#pango-form');
const googleForm = $('#google-form');

async function loadSettings() {
  try {
    const settings = await api('GET', '/api/settings');
    pangoForm.baseUrl.value = settings.pango.baseUrl;
    pangoForm.apiKey.value = '';
    pangoForm.apiKey.placeholder = settings.pango.hasApiKey ? '•••••••• (đã lưu — để trống nếu không đổi)' : 'Dán API key vào đây';
    pangoForm.token.value = '';
    pangoForm.token.placeholder = settings.pango.hasToken ? '•••••••• (đã lưu — để trống nếu không đổi)' : 'Chỉ cần nếu Pango từ chối khi chỉ có API key';
    const expiry = $('#token-expiry');
    const expiresAt = settings.pango.tokenExpiresAt;
    expiry.hidden = !expiresAt;
    if (expiresAt) {
      expiry.textContent = expiresAt < Date.now() ? `Token đã hết hạn từ ${fullTime(expiresAt)}.` : `Token hết hạn lúc ${fullTime(expiresAt)}.`;
      expiry.classList.toggle('error-text', expiresAt < Date.now());
    }
    const { google } = settings;
    googleForm.clientId.value = google.clientId;
    googleForm.clientSecret.value = '';
    googleForm.clientSecret.placeholder = google.hasClientSecret ? '•••••••• (đã lưu — để trống nếu không đổi)' : 'Dán Client secret vào đây';
    $('#google-dot').classList.toggle('ok', google.connected);
    $('#google-account').textContent = google.connected ? google.email || 'Đã đăng nhập' : 'Chưa đăng nhập';
    $('#google-login').textContent = google.connected ? 'Đổi tài khoản' : 'Đăng nhập Google';
    $('#google-login').hidden = !(google.clientId && google.hasClientSecret);
    $('#google-logout').hidden = !google.connected;
    $('#google-test').hidden = !google.connected;
  } catch (err) {
    toast(err.message, 'error');
  }
}

pangoForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('PUT', '/api/settings', { pango: { baseUrl: pangoForm.baseUrl.value, apiKey: pangoForm.apiKey.value, token: pangoForm.token.value } });
    toast('Đã lưu cấu hình Pango');
    await Promise.all([loadSettings(), refresh()]);
  } catch (err) {
    toast(err.message, 'error');
  }
});

googleForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('PUT', '/api/settings', { google: { clientId: googleForm.clientId.value, clientSecret: googleForm.clientSecret.value } });
    toast('Đã lưu OAuth client');
    await Promise.all([loadSettings(), refresh()]);
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#google-logout').addEventListener('click', async () => {
  try {
    await api('POST', '/api/google/logout');
    toast('Đã đăng xuất Google');
    await Promise.all([loadSettings(), refresh()]);
  } catch (err) {
    toast(err.message, 'error');
  }
});

const googleRedirectUri = `${location.origin}/api/google/callback`;
$('#google-redirect').textContent = googleRedirectUri;
$('#copy-redirect').addEventListener('click', async () => {
  await navigator.clipboard.writeText(googleRedirectUri);
  toast('Đã sao chép Redirect URI');
});

$$('[data-test]').forEach((button) =>
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await api('POST', `/api/settings/test/${button.dataset.test}`);
      toast(result.message);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  }),
);

/* ---------- Khởi động ---------- */

// Google chuyển về đây sau khi đăng nhập: /?view=settings&google=ok hoặc &googleError=...
const query = new URLSearchParams(location.search);
if (query.get('view') === 'settings') showView('settings');
if (query.get('google') === 'ok') toast('Đã đăng nhập Google');
if (query.get('googleError')) toast(query.get('googleError'), 'error');
if (query.size) history.replaceState(null, '', location.pathname);


refresh().catch((err) => toast(err.message, 'error'));
setInterval(() => refresh().catch(() => {}), 2500);
