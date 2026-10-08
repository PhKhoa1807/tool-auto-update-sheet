// Lấy bản ghi của một custom model từ Pango CDP (datahub search API).
const ORDER = 'modelCreatedAt:DESC';
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const TIMEOUT_MS = 30_000;
const DAY = 86_400_000;
const TZ_OFFSET = 7 * 3_600_000; // Giờ Việt Nam, không phụ thuộc múi giờ của máy chạy tool.

const NESTED_GROUPS = ['customFieldTexts', 'customFieldLongs', 'customFieldDoubles', 'customFieldBooleans', 'customFieldTimestamps', 'customFieldListTexts'];
const TIMESTAMP_FIELD = /(Timestamp\d+|At)$/;

export function assertConfigured({ baseUrl, apiKey }) {
  if (!baseUrl) throw new Error('Chưa nhập Base URL của Pango (vào Cài đặt)');
  if (!apiKey) throw new Error('Chưa nhập API key của Pango (vào Cài đặt)');
}

// Khoảng [from, to) theo modelCreatedAt, tính theo ngày Việt Nam.
function rangeBounds(dateRange) {
  const now = Date.now();
  const today = Math.floor((now + TZ_OFFSET) / DAY) * DAY - TZ_OFFSET;
  switch (dateRange) {
    case 'today': return { from: today, to: Infinity };
    case 'yesterday': return { from: today - DAY, to: today };
    case 'last7days': return { from: today - 6 * DAY, to: Infinity };
    case 'last30days': return { from: today - 29 * DAY, to: Infinity };
    case 'thisMonth': {
      const local = new Date(now + TZ_OFFSET);
      return { from: Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - TZ_OFFSET, to: Infinity };
    }
    default: return { from: -Infinity, to: Infinity };
  }
}

const formatTime = (ms) => new Date(ms + TZ_OFFSET).toISOString().slice(0, 19).replace('T', ' ');

function formatValue(key, value) {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'number' && TIMESTAMP_FIELD.test(key)) return value > 0 ? formatTime(value) : '';
  return value ?? '';
}

// Trải phẳng một bản ghi: các custom field lên trước (xếp theo tên), rồi tới các trường hệ thống.
function flatten(record) {
  const row = {};
  for (const group of NESTED_GROUPS) {
    const fields = record[group] ?? {};
    for (const key of Object.keys(fields).sort()) row[key] = formatValue(key, fields[key]);
  }
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) continue;
    row[key] = formatValue(key, value);
  }
  return row;
}

async function searchPage(config, modelId, page) {
  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/custom-models/${encodeURIComponent(modelId)}/search`);
  url.searchParams.set('page', page);
  url.searchParams.set('pageSize', PAGE_SIZE);
  url.searchParams.set('orderBy', ORDER);

  const cookies = [`API_KEY=${config.apiKey}`];
  if (config.token) cookies.push(`TOKEN=${config.token}`);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', cookie: cookies.join('; ') },
      body: JSON.stringify({ page, pageSize: PAGE_SIZE, moreFilters: [], order: ORDER }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Không gọi được Pango: ${err.cause?.message ?? err.message}`, { cause: err });
  }
  // `detail` là nội dung Pango trả về, chỉ để ghi log chứ không hiện cho người dùng.
  const text = await response.text().catch(() => '');
  const fail = (message) => Object.assign(new Error(message), { status: response.status, detail: text.slice(0, 500) });
  if (response.status === 401 || response.status === 403) {
    throw fail(`Pango từ chối xác thực (${response.status}): API key hoặc token sai hoặc đã hết hạn`);
  }
  if (!response.ok) throw fail(`Pango trả về lỗi ${response.status} cho model ${modelId}`);

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Không phải JSON thì báo lỗi định dạng ở dưới.
  }
  if (!data?.success || !Array.isArray(data.results?.content)) {
    throw fail(`Pango trả về dữ liệu không đúng định dạng cho model ${modelId}`);
  }
  if (data.permissionView && data.permissionView.hasPermission === false) {
    throw new Error(`Tài khoản Pango không có quyền xem model ${modelId}`);
  }
  return data.results;
}

// Trả về mảng object đã trải phẳng, mới nhất trước. `limit` dùng cho xem trước.
export async function fetchData(source, config, { limit = Infinity } = {}) {
  assertConfigured(config);
  if (!source?.modelId) throw new Error('Thiếu mã model Pango');

  const { from, to } = rangeBounds(source.dateRange);
  const seen = new Set();
  const records = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const results = await searchPage(config, source.modelId, page);
    let added = 0;
    let pastRange = false;
    for (const record of results.content) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      added++;
      if (record.modelCreatedAt >= to) continue;
      // Đã sắp xếp mới nhất trước, nên gặp bản ghi cũ hơn `from` là có thể dừng.
      if (record.modelCreatedAt < from) { pastRange = true; continue; }
      records.push(record);
    }
    const totalPages = results.page?.totalPages ?? 0;
    if (pastRange || records.length >= limit || page + 1 >= totalPages) break;
    if (!added) throw new Error('Pango trả về trang trùng lặp — không phân trang được, dừng để tránh ghi thiếu dữ liệu');
  }

  return records.slice(0, limit).map(flatten);
}
