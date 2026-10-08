// Gắn request id cho mọi dòng log phát sinh trong cùng một request (kể cả job chạy nền do request đó kích hoạt).
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const storage = new AsyncLocalStorage();

export const generateRequestId = () => randomUUID();

export const getRequestId = () => storage.getStore()?.requestId;

export const runWithRequestId = (requestId, fn) => storage.run({ requestId }, fn);
