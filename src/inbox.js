// Bản ghi Pango đẩy sang qua webhook, lưu theo model trong data/models/<mã model>.json
// (có số điện thoại, email nên nằm trong data/ đã được gitignore).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const MODELS_DIR = path.join(DATA_DIR, 'models');
// Mã model dùng làm tên file, nên chỉ nhận đúng dạng mã của Pango (M-XXXXX-O-XXXXX-M).
const MODEL_ID = /^[\w-]{1,100}$/;

export const isModelId = (value) => typeof value === 'string' && MODEL_ID.test(value);

const fileOf = (modelId) => path.join(MODELS_DIR, `${modelId}.json`);

// mã model -> { records: Map(id bản ghi -> bản ghi), receivedAt: lần nhận gần nhất }
const models = loadAll();

function loadAll() {
  const loaded = new Map();
  let files = [];
  try {
    files = fs.readdirSync(MODELS_DIR);
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Không đọc được ${MODELS_DIR}: ${err.message}`);
  }
  for (const file of files) {
    const modelId = path.basename(file, '.json');
    if (!file.endsWith('.json') || !isModelId(modelId)) continue;
    try {
      const records = JSON.parse(fs.readFileSync(fileOf(modelId), 'utf8'));
      loaded.set(modelId, {
        records: new Map(records.map((record) => [String(record.id), record])),
        receivedAt: Math.round(fs.statSync(fileOf(modelId)).mtimeMs),
      });
    } catch (err) {
      throw new Error(`Không đọc được ${fileOf(modelId)}: ${err.message}`);
    }
  }
  return loaded;
}

// Trả về null nếu model chưa nhận bản ghi nào qua webhook.
export function getRecords(modelId) {
  const model = models.get(modelId);
  return model ? [...model.records.values()] : null;
}

export function listModels() {
  return [...models].map(([modelId, model]) => ({ modelId, records: model.records.size, receivedAt: model.receivedAt }));
}

// Gộp theo id: bản ghi gửi lại thì thay bản cũ, bản ghi Pango đánh dấu đã xoá thì bỏ.
// Trả về số bản ghi thêm mới / cập nhật / xoá để ghi log.
export function saveRecords(modelId, incoming) {
  const records = models.get(modelId)?.records ?? new Map();
  const counts = { added: 0, updated: 0, deleted: 0, total: 0 };
  for (const record of incoming) {
    const id = String(record.id);
    if (record.recordStatus === 'Deleted') {
      if (records.delete(id)) counts.deleted++;
      continue;
    }
    counts[records.has(id) ? 'updated' : 'added']++;
    records.set(id, record);
  }
  counts.total = records.size;
  models.set(modelId, { records, receivedAt: Date.now() });
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const tmp = `${fileOf(modelId)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...records.values()]));
  fs.renameSync(tmp, fileOf(modelId));
  return counts;
}
