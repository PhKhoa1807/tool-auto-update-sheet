// Ghi dữ liệu lên Google Sheets bằng tài khoản Google đã đăng nhập qua OAuth.
import { sheets as sheetsApi, auth } from '@googleapis/sheets';

// openid + email chỉ để biết đang đăng nhập bằng tài khoản nào.
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'openid', 'email'];
const TIMEOUT_MS = 60_000;

function createOAuthClient(config, redirectUri) {
  if (!config.clientId || !config.clientSecret) throw new Error('Chưa nhập OAuth Client ID và Client secret (vào Cài đặt)');
  return new auth.OAuth2(config.clientId, config.clientSecret, redirectUri);
}

function createClient(config) {
  const oauth = createOAuthClient(config);
  if (!config.refreshToken) throw new Error('Chưa đăng nhập Google (vào Cài đặt, bấm “Đăng nhập Google”)');
  oauth.setCredentials({ refresh_token: config.refreshToken });
  return { oauth, api: sheetsApi({ version: 'v4', auth: oauth, timeout: TIMEOUT_MS }) };
}

// URL màn hình xin quyền của Google. prompt=consent để lần nào Google cũng trả refresh token.
export function buildAuthUrl(config, redirectUri, state) {
  return createOAuthClient(config, redirectUri).generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state });
}

// Đổi mã Google trả về sau khi đăng nhập thành refresh token + email tài khoản.
export async function exchangeCode(config, redirectUri, code) {
  let tokens;
  try {
    ({ tokens } = await createOAuthClient(config, redirectUri).getToken(code));
  } catch (err) {
    throw explain(err, config);
  }
  if (!tokens.refresh_token) throw new Error('Google không trả về refresh token. Hãy đăng nhập lại và đồng ý cấp quyền.');
  if (!tokens.scope?.includes('auth/spreadsheets')) {
    throw new Error('Bạn chưa tick quyền chỉnh sửa Google Sheets ở màn hình đồng ý. Hãy đăng nhập lại và tick quyền đó.');
  }
  let email = '';
  try {
    email = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf8')).email ?? '';
  } catch {
    // Không đọc được email thì vẫn ghi sheet được, chỉ là không hiển thị tên tài khoản.
  }
  return { refreshToken: tokens.refresh_token, email };
}

// Đổi lỗi của Google thành câu người dùng hiểu được; lỗi của chính tool thì giữ nguyên.
function explain(err, config) {
  const explained = translate(err, config);
  // Giữ lỗi gốc của Google trong `cause` để log ghi được đầy đủ.
  if (explained !== err) explained.cause = err;
  return explained;
}

function translate(err, config) {
  const status = err.response?.status ?? (typeof err.status === 'number' ? err.status : undefined);
  const account = config.email || 'tài khoản Google đang đăng nhập';
  const oauthError = `${err.response?.data?.error} ${err.message}`;
  const detail = err.response?.data?.error_description ?? err.response?.data?.error?.message ?? err.message;
  if (/invalid_grant/.test(oauthError)) {
    return new Error('Phiên đăng nhập Google đã hết hạn hoặc bị thu hồi. Vào Cài đặt và đăng nhập Google lại.');
  }
  if (/invalid_client|unauthorized_client/.test(oauthError)) {
    return new Error(`Google không chấp nhận OAuth Client ID / Client secret (${detail}). Kiểm tra lại trong Cài đặt.`);
  }
  if (/must not be an Office file/.test(detail)) {
    return new Error('File đích là file Excel (.xlsx) nằm trên Drive chứ chưa phải Google Sheets. Mở file, chọn Tệp → Lưu dưới dạng Google Trang tính, rồi dán link của file mới vào job.');
  }
  if (status === 403) return new Error(`Google Sheets 403: ${account} không có quyền chỉnh sửa sheet này (${detail}).`);
  if (status === 404) return new Error(`Google Sheets 404: không tìm thấy sheet — sai link/ID, hoặc ${account} chưa được chia sẻ sheet này.`);
  if (status) return new Error(`Google Sheets ${status}: ${detail}`);
  return err;
}

export async function testConnection(config) {
  const { oauth } = createClient(config);
  try {
    await oauth.getAccessToken();
  } catch (err) {
    throw explain(err, config);
  }
}

const quoteTab = (name) => `'${name.replace(/'/g, "''")}'`;

function toLetters(column) {
  let letters = '';
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

// "B2" -> { col: 2, row: 2 } (đều tính từ 1).
export function parseCell(cell) {
  const match = /^([A-Za-z]{1,3})([1-9]\d*)$/.exec(String(cell ?? '').trim());
  if (!match) throw new Error(`Ô bắt đầu “${cell}” không hợp lệ (ví dụ đúng: A1)`);
  const col = [...match[1].toUpperCase()].reduce((sum, ch) => sum * 26 + ch.charCodeAt(0) - 64, 0);
  return { col, row: Number(match[2]) };
}

// Gộp dữ liệu mới vào các dòng đang có trên sheet theo cột khoá: trùng khoá thì thay dòng, chưa có thì thêm xuống cuối.
export function mergeByKey(existing, table, { keyColumn, includeHeader }) {
  let keyIndex = table.headers.indexOf(keyColumn);
  if (keyIndex === -1) keyIndex = table.fields.indexOf(keyColumn);
  if (keyIndex === -1) throw new Error(`Không tìm thấy cột khoá “${keyColumn}” trong các cột của job (${table.headers.join(', ')})`);

  const body = includeHeader ? existing.slice(1) : existing.slice();
  const rowByKey = new Map();
  body.forEach((row, index) => {
    const key = String(row[keyIndex] ?? '');
    if (key) rowByKey.set(key, index);
  });
  for (const row of table.values) {
    const key = String(row[keyIndex] ?? '');
    const at = key ? rowByKey.get(key) : undefined;
    if (at !== undefined) {
      body[at] = row;
    } else {
      if (key) rowByKey.set(key, body.length);
      body.push(row);
    }
  }
  return includeHeader ? [table.headers, ...body] : body;
}

// Trả về properties của tab; chưa có tab thì tạo mới.
async function ensureTab(api, spreadsheetId, title) {
  const { data } = await api.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const found = data.sheets?.find((sheet) => sheet.properties.title === title);
  if (found) return found.properties;
  const created = await api.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  return created.data.replies[0].addSheet.properties;
}

// Nới tab cho đủ số dòng/cột trước khi đọc ghi, vì Sheets API báo lỗi nếu vùng vượt quá lưới.
async function ensureGrid(api, spreadsheetId, tab, rows, cols) {
  const grid = tab.gridProperties;
  const requests = [];
  if (rows > grid.rowCount) requests.push({ appendDimension: { sheetId: tab.sheetId, dimension: 'ROWS', length: rows - grid.rowCount } });
  if (cols > grid.columnCount) requests.push({ appendDimension: { sheetId: tab.sheetId, dimension: 'COLUMNS', length: cols - grid.columnCount } });
  if (!requests.length) return;
  await api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  grid.rowCount = Math.max(grid.rowCount, rows);
  grid.columnCount = Math.max(grid.columnCount, cols);
}

// target: { spreadsheetId, sheetName, startCell, mode: overwrite|append|upsert, keyColumn, includeHeader }
// table: { fields: string[], headers: string[], values: any[][] }
export async function writeRows(target, table, config) {
  const { api } = createClient(config);
  try {
    return await writeTable(api, target, table);
  } catch (err) {
    throw explain(err, config);
  }
}

// Tách riêng khỏi phần xác thực để test được với một Sheets API giả.
export async function writeTable(api, target, table) {
  const { spreadsheetId, mode, includeHeader } = target;
  const { col, row } = parseCell(target.startCell);
  const tabRef = quoteTab(target.sheetName);
  const lastCol = col + Math.max(table.headers.length, 1) - 1;
  const withHeader = (values) => (includeHeader ? [table.headers, ...values] : values);

  const tab = await ensureTab(api, spreadsheetId, target.sheetName);
  await ensureGrid(api, spreadsheetId, tab, row, lastCol);

  // Các dòng đang có, tính từ ô bắt đầu; Google bỏ các dòng trống ở cuối.
  const readExisting = async () => {
    const { data } = await api.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabRef}!${toLetters(col)}${row}:${toLetters(lastCol)}`,
    });
    return data.values ?? [];
  };

  let values;
  let startRow = row;
  if (mode === 'append') {
    const existing = await readExisting();
    values = existing.length ? table.values : withHeader(table.values);
    startRow = row + existing.length;
  } else if (mode === 'upsert') {
    values = mergeByKey(await readExisting(), table, target);
  } else {
    await api.spreadsheets.values.clear({ spreadsheetId, range: tabRef });
    values = withHeader(table.values);
  }

  if (values.length) {
    await ensureGrid(api, spreadsheetId, tab, startRow + values.length - 1, lastCol);
    // RAW để giữ nguyên chuỗi như Pango trả về (số điện thoại không mất số 0 đầu).
    await api.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabRef}!${toLetters(col)}${startRow}`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
  }
  return { rowsWritten: table.values.length };
}
