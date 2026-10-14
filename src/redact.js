// Che số điện thoại, email, tên và token trước khi ghi log (giống @zma/telemetry bên platform).

export const REDACTED = '[REDACTED]';

const MAX_DETAIL = 1000;
const MAX_CAUSES = 5;

const SENSITIVE_KEYS = new Set([
  'phone',
  'phone_number',
  'phonenumber',
  'mobile',
  'email',
  'email_address',
  'emailaddress',
  'name',
  'player_name',
  'playername',
  'display_name',
  'displayname',
  'token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'session_token',
  'sessiontoken',
  'authorization',
  'password',
  'secret',
  'client_secret',
  'clientsecret',
  'api_key',
  'apikey',
  'app_key',
  'appkey',
  'bearer',
  'jwt',
  'id_token',
  'idtoken',
]);

// Số điện thoại Việt Nam + các dạng quốc tế phổ biến.
const PHONE_PATTERN = /(?:\+?84|0)(?:[\s.-]?)(?:3|5|7|8|9)(?:[\s.-]?\d){7,8}\b|\+?\d{10,15}\b/g;

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// JWT dạng header.payload.signature.
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

const isSensitiveKey = (key) => SENSITIVE_KEYS.has(key.toLowerCase());

const truncate = (text) => (text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}… (truncated)` : text);

export function redactString(value) {
  let out = value.replace(JWT_PATTERN, REDACTED);
  out = out.replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
  out = out.replace(EMAIL_PATTERN, REDACTED);
  out = out.replace(PHONE_PATTERN, REDACTED);
  return out;
}

// Nội dung bên kia trả về: nếu là JSON thì che theo tên trường, không thì che theo mẫu trong chuỗi.
function redactDetail(detail) {
  let parsed = detail;
  if (typeof detail === 'string') {
    try {
      parsed = JSON.parse(detail);
    } catch {
      return redactString(detail);
    }
  }
  return typeof parsed === 'string' ? redactString(parsed) : (JSON.stringify(redactValue(parsed)) ?? String(parsed));
}

// Chỉ lấy các trường cụ thể, không in nguyên object lỗi vì lỗi của Google có kèm header chứa access token.
// Ngoài name/message/stack như platform, giữ thêm mã lỗi, nội dung bên kia trả về và chuỗi `cause`.
function redactError(err, depth = 0) {
  const status = err.response?.status ?? err.status;
  const detail = err.detail ?? err.response?.data;
  const out = { name: err.name, message: redactString(err.message) };
  if (err.stack) out.stack = redactString(err.stack);
  if (err.code) out.code = err.code;
  if (status) out.status = status;
  if (detail !== undefined && detail !== '') out.response = truncate(redactDetail(detail));
  if (err.cause !== undefined && depth < MAX_CAUSES) {
    out.cause = err.cause instanceof Error ? redactError(err.cause, depth + 1) : redactValue(err.cause);
  }
  return out;
}

export function redactValue(value, key) {
  if (key !== undefined && isSensitiveKey(key)) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value instanceof Error) return redactError(value);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, k);
    return out;
  }
  return REDACTED;
}
