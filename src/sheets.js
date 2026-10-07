// MOCK — thay phần thân 2 hàm này bằng Google Sheets API (package `googleapis`).
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function testConnection({ clientEmail, privateKey }) {
  await delay(600);
  if (!clientEmail || !privateKey) throw new Error('Chưa tải lên file JSON của service account (vào Cài đặt)');
  return { ok: true };
}

// target: { spreadsheetId, sheetName, startCell, mode: overwrite|append|upsert, keyColumn, includeHeader }
// table: { headers: string[], values: any[][] }
export async function writeRows(target, table, config) {
  await testConnection(config);
  await delay(900);
  return { rowsWritten: table.values.length };
}
