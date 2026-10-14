// Các tình huống ghi sheet, chạy với một Sheets API giả lưu dữ liệu trong bộ nhớ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeTable } from '../src/sheets.js';
import { toRows } from '../src/pango.js';

// Sheets API giả: một tab, lưới là mảng 2 chiều; values.get trả chuỗi và bỏ ô/dòng trống ở cuối như Google.
function fakeApi(initial = []) {
  const grid = initial.map((row) => [...row]);
  const tab = { sheetId: 1, title: 'Data', gridProperties: { rowCount: 1000, columnCount: 26 } };
  const colOf = (letters) => [...letters].reduce((sum, ch) => sum * 26 + ch.charCodeAt(0) - 64, 0);
  const parse = (range) => {
    const [, a1] = range.split('!');
    const [start, end] = a1.split(':');
    const s = /^([A-Z]+)(\d+)?$/.exec(start);
    const e = end ? /^([A-Z]+)(\d+)?$/.exec(end) : null;
    return { col: colOf(s[1]), row: Number(s[2] ?? 1), lastCol: e ? colOf(e[1]) : Infinity };
  };
  const api = {
    grid,
    spreadsheets: {
      get: async () => ({ data: { sheets: [{ properties: tab }] } }),
      batchUpdate: async () => ({ data: { replies: [{}] } }),
      values: {
        get: async ({ range }) => {
          const { col, row, lastCol } = parse(range);
          const rows = grid.slice(row - 1).map((r) => {
            const cells = r.slice(col - 1, lastCol === Infinity ? undefined : lastCol).map((v) => (v === undefined || v === null ? '' : String(v)));
            while (cells.length && cells.at(-1) === '') cells.pop();
            return cells;
          });
          while (rows.length && !rows.at(-1).length) rows.pop();
          return { data: { values: rows.length ? rows : undefined } };
        },
        update: async ({ range, requestBody }) => {
          const { col, row } = parse(range);
          requestBody.values.forEach((values, i) => {
            const r = (grid[row - 1 + i] ??= []);
            values.forEach((v, j) => { r[col - 1 + j] = v; });
          });
        },
        clear: async () => { grid.length = 0; },
      },
    },
  };
  return api;
}

const columns = ['id', 'name', 'phone'];
const table = (records, fields = columns, headers = fields) => ({
  fields,
  headers,
  values: records.map((r) => fields.map((f) => r[f] ?? '')),
});
const target = (extra = {}) => ({ spreadsheetId: 'x', sheetName: 'Data', startCell: 'A1', mode: 'upsert', keyColumn: 'id', includeHeader: true, ...extra });
const A = { id: 'r1', name: 'An', phone: '0901' };
const B = { id: 'r2', name: 'Bình', phone: '0902' };
const C = { id: 'r3', name: 'Chi', phone: '0903' };
const asText = (grid) => grid.map((r) => r.map((v) => String(v ?? '')));

test('1. Tab trống, có tiêu đề: ghi tiêu đề + dữ liệu', async () => {
  const api = fakeApi();
  await writeTable(api, target(), table([A, B]));
  assert.deepEqual(asText(api.grid), [columns, ['r1', 'An', '0901'], ['r2', 'Bình', '0902']]);
});

test('2. Chạy lại với cùng dữ liệu: không nhân đôi', async () => {
  const api = fakeApi();
  for (let i = 0; i < 3; i++) await writeTable(api, target(), table([A, B]));
  assert.equal(api.grid.length, 3);
});

test('3. Có bản ghi mới: thêm xuống cuối, dòng cũ giữ nguyên vị trí', async () => {
  const api = fakeApi();
  await writeTable(api, target(), table([A, B]));
  await writeTable(api, target(), table([C, A, B])); // toRows trả mới nhất trước
  assert.deepEqual(asText(api.grid).map((r) => r[0]), ['id', 'r1', 'r2', 'r3']);
});

test('4. Bản ghi bị sửa trên Pango: cập nhật đúng dòng đó', async () => {
  const api = fakeApi();
  await writeTable(api, target(), table([A, B]));
  await writeTable(api, target(), table([{ ...A, phone: '0999' }, B]));
  assert.deepEqual(asText(api.grid)[1], ['r1', 'An', '0999']);
  assert.equal(api.grid.length, 3);
});

test('5. Bản ghi rơi khỏi khoảng ngày (VD 7 ngày gần nhất): dòng cũ vẫn còn trên sheet', async () => {
  const api = fakeApi();
  await writeTable(api, target(), table([A, B]));
  await writeTable(api, target(), table([C]));
  assert.deepEqual(asText(api.grid).map((r) => r[0]), ['id', 'r1', 'r2', 'r3']);
});

test('6. Sheet đã có dữ liệu cũ đúng cột: nhận ra, không trùng', async () => {
  const api = fakeApi([columns, ['r1', 'An', '0901'], ['r2', 'Bình', '0902']]);
  await writeTable(api, target(), table([A, B, C]));
  assert.deepEqual(asText(api.grid).map((r) => r[0]), ['id', 'r1', 'r2', 'r3']);
});

test('7. Dữ liệu cũ để id ở cột khác: KHÔNG nhận ra, lần đầu thêm trùng', async () => {
  const api = fakeApi([['name', 'id', 'phone'], ['An', 'r1', '0901']]);
  await writeTable(api, target(), table([A]));
  assert.equal(api.grid.length, 3, 'r1 bị thêm lại thành dòng mới');
});

test('8. Ô bắt đầu A6: không đụng 5 dòng phía trên', async () => {
  const top = [['Báo cáo'], [], ['ghi chú'], [], []];
  const api = fakeApi(top);
  await writeTable(api, target({ startCell: 'A6' }), table([A]));
  await writeTable(api, target({ startCell: 'A6' }), table([A, B]));
  assert.deepEqual(asText(api.grid.slice(0, 5)), asText(top));
  assert.deepEqual(asText(api.grid.slice(5)).map((r) => r[0]), ['id', 'r1', 'r2']);
});

test('9. Không tick ghi tiêu đề: chỉ ghi dữ liệu, chạy lại không trùng', async () => {
  const api = fakeApi();
  await writeTable(api, target({ includeHeader: false }), table([A]));
  await writeTable(api, target({ includeHeader: false }), table([A, B]));
  assert.deepEqual(asText(api.grid).map((r) => r[0]), ['r1', 'r2']);
});

test('10. Cột khoá không nằm trong các cột được tick: báo lỗi', async () => {
  const api = fakeApi();
  await assert.rejects(writeTable(api, target(), table([A], ['name', 'phone'])), /Không tìm thấy cột khoá/);
});

test('11. Cột khoá nhập theo tên tiêu đề đã đổi (VD "Mã") cũng được', async () => {
  const api = fakeApi();
  const t = table([A], columns, ['Mã', 'Tên', 'SĐT']);
  await writeTable(api, target({ keyColumn: 'Mã' }), t);
  await writeTable(api, target({ keyColumn: 'Mã' }), t);
  assert.equal(api.grid.length, 2);
});

test('12. Có tick tiêu đề nhưng sheet cũ KHÔNG có dòng tiêu đề: dòng dữ liệu đầu bị tiêu đề đè', async () => {
  const api = fakeApi([['r9', 'Cũ', '0909'], ['r1', 'An', '0901']]);
  await writeTable(api, target(), table([A]));
  const ids = asText(api.grid).map((r) => r[0]);
  assert.deepEqual(ids, ['id', 'r1']);
  assert.ok(!ids.includes('r9'), 'r9 không còn trên Pango nên bị mất hẳn');
});

test('13. Bỏ tick tiêu đề nhưng sheet cũ CÓ dòng tiêu đề: tiêu đề cũ được giữ như một dòng', async () => {
  const api = fakeApi([columns, ['r1', 'An', '0901']]);
  await writeTable(api, target({ includeHeader: false }), table([A, B]));
  assert.deepEqual(asText(api.grid).map((r) => r[0]), ['id', 'r1', 'r2']);
});

test('14. Sheet có id trùng nhau sẵn: chỉ dòng sau được cập nhật, dòng trước giữ dữ liệu cũ', async () => {
  const api = fakeApi([columns, ['r1', 'An', 'cũ-1'], ['r1', 'An', 'cũ-2']]);
  await writeTable(api, target(), table([{ ...A, phone: 'mới' }]));
  assert.deepEqual(asText(api.grid).map((r) => r[2]), ['phone', 'cũ-1', 'mới']);
});

test('15. id dạng số: sheet trả về chuỗi vẫn khớp', async () => {
  const api = fakeApi();
  await writeTable(api, target(), table([{ id: 12345, name: 'An' }]));
  await writeTable(api, target(), table([{ id: 12345, name: 'An 2' }]));
  assert.equal(api.grid.length, 2);
});

test('16. Bản ghi id rỗng: mỗi lần chạy thêm một dòng mới (webhook đã chặn id rỗng)', async () => {
  const api = fakeApi();
  await writeTable(api, target(), table([{ id: '', name: 'X' }]));
  await writeTable(api, target(), table([{ id: '', name: 'X' }]));
  assert.equal(api.grid.length, 3);
});

test('17. Có dòng trống xen giữa: được giữ nguyên, không vỡ', async () => {
  const api = fakeApi([columns, ['r1', 'An', '0901'], [], ['r2', 'Bình', '0902']]);
  await writeTable(api, target(), table([A, B, C]));
  assert.deepEqual(asText(api.grid).map((r) => r[0] ?? ''), ['id', 'r1', '', 'r2', 'r3']);
});

test('18. Cột ghi chú bên phải vùng job (cột D): không bị đụng', async () => {
  const api = fakeApi([[...columns, 'Ghi chú'], ['r1', 'An', '0901', 'đã gọi']]);
  await writeTable(api, target(), table([{ ...A, phone: '0999' }]));
  assert.deepEqual(asText(api.grid)[1], ['r1', 'An', '0999', 'đã gọi']);
});

test('19. Đổi thứ tự cột trong job sau khi đã có dữ liệu: dòng cũ lệch cột, bị trùng', async () => {
  const api = fakeApi();
  await writeTable(api, target(), table([A]));
  await writeTable(api, target(), table([A], ['name', 'id', 'phone']));
  assert.equal(api.grid.length, 3, 'id giờ đọc ở cột B, dòng cũ có "An" ở đó nên không khớp');
});

test('20. Sửa tay một ô trong vùng job: lần chạy sau bị ghi đè theo Pango', async () => {
  const api = fakeApi();
  await writeTable(api, target(), table([A]));
  api.grid[1][1] = 'Sửa tay';
  await writeTable(api, target(), table([A]));
  assert.equal(api.grid[1][1], 'An');
});

test('21. Job cũ còn chế độ "append" đã bỏ: báo lỗi, không đụng sheet', async () => {
  const api = fakeApi([columns, ['r1', 'An', '0901']]);
  await assert.rejects(writeTable(api, target({ mode: 'append' }), table([A, B])), /không còn hỗ trợ/);
  assert.equal(api.grid.length, 2);
});

test('22. So sánh: "Ghi đè toàn bộ tab" + 7 ngày gần nhất thì mất dữ liệu cũ hơn', async () => {
  const api = fakeApi([columns, ['r0', 'Rất cũ', '0900']]);
  await writeTable(api, target({ mode: 'overwrite' }), table([A]));
  assert.deepEqual(asText(api.grid).map((r) => r[0]), ['id', 'r1']);
});

test('23. Lọc khoảng ngày theo modelCreatedAt, giờ Việt Nam, mới nhất trước', () => {
  const now = Date.now();
  const records = [
    { id: 'old', modelCreatedAt: now - 40 * 86_400_000 },
    { id: 'week', modelCreatedAt: now - 3 * 86_400_000 },
    { id: 'new', modelCreatedAt: now },
  ];
  assert.deepEqual(toRows(records, { dateRange: 'all' }).map((r) => r.id), ['new', 'week', 'old']);
  assert.deepEqual(toRows(records, { dateRange: 'last7days' }).map((r) => r.id), ['new', 'week']);
  assert.deepEqual(toRows(records, { dateRange: 'today' }).map((r) => r.id), ['new']);
});
