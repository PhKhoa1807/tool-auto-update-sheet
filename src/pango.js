// Đổi bản ghi custom model mà Pango đẩy sang qua webhook thành các dòng để ghi lên sheet.
const DAY = 86_400_000;
const TZ_OFFSET = 7 * 3_600_000; // Giờ Việt Nam, không phụ thuộc múi giờ của máy chạy tool.

const TIMESTAMP_FIELD = /(Timestamp\d+|At)$/;

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
  // Mốc thời gian có thể tới dưới dạng số hoặc chuỗi số.
  if (typeof value === 'string' && /^\d{12,14}$/.test(value) && TIMESTAMP_FIELD.test(key)) return formatTime(Number(value));
  if (typeof value === 'number' && TIMESTAMP_FIELD.test(key)) return value > 0 ? formatTime(value) : '';
  return value ?? '';
}

function toRow(record) {
  const row = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) continue;
    row[key] = formatValue(key, value);
  }
  return row;
}

// Lọc theo khoảng ngày của job, mới nhất trước.
export function toRows(records, source) {
  const { from, to } = rangeBounds(source.dateRange);
  return records
    .map((record) => ({ record, createdAt: Number(record.modelCreatedAt) || 0 }))
    .filter(({ createdAt }) => createdAt >= from && createdAt < to)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ record }) => toRow(record));
}
