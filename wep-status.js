import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const RELEVANT = new Set(["sent", "delivered", "read", "failed"]);
const FILE_RE = /^waba-events-\d{8}\.jsonl$/;

export function statusPayload(st) {
  if (!st || !RELEVANT.has(st.status) || !st.id || !st.timestamp) return null;
  const payload = { messageId: st.id, status: st.status, timestamp: st.timestamp };
  const code = st.errors?.[0]?.code;
  if (code !== undefined && code !== null) payload.metaErrorCode = code;
  return payload;
}

export function statusKey(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function appendDurably(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const newFile = !fs.existsSync(file);
  const fd = fs.openSync(file, "a");
  try {
    const bytes = Buffer.from(JSON.stringify(record) + "\n");
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (newFile && process.platform !== "win32") {
    const dirFd = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  }
}

export function createStatusOutbox({ dir, url, token, fetchImpl = fetch, intervalMs = 10000, log = console }) {
  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("WEP_STATUS_URL debe ser HTTPS y no contener credenciales");
    if (!token) throw new Error("WEP_STATUS_TOKEN es obligatorio cuando WEP_STATUS_URL está configurada");
  }
  const pending = new Map();
  const acknowledged = new Set();
  let timer;
  let running = false;
  let nextAttempt = 0;
  let failures = 0;
  const attempt = () => { void drain().catch((e) => log.error(`WEP: error local en la cola: ${e.message}`)); };

  function fileFor(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return path.join(dir, `waba-events-${y}${m}${d}.jsonl`);
  }

  function load() {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir).filter((n) => FILE_RE.test(n)).sort()) {
      const file = path.join(dir, name);
      const lines = fs.readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        let record;
        try { record = JSON.parse(lines[i]); }
        catch (e) {
          throw new Error(`JSONL inválido en ${name}:${i + 1}: ${e.message}`);
        }
        if (record.kind === "wep_status_ack" && record.key) acknowledged.add(record.key);
        if (record.kind === "status") {
          const payload = statusPayload({ id: record.message_id, status: record.status, timestamp: record.timestamp, errors: record.errors });
          if (payload) pending.set(statusKey(payload), payload);
        }
      }
    }
    for (const key of acknowledged) pending.delete(key);
    return pending.size;
  }

  function enqueue(st, logRecord) {
    const payload = statusPayload(st);
    // Store every status in the existing JSONL format, including duplicates and other statuses.
    appendDurably(fileFor(), { ts: new Date().toISOString(), kind: "status", ...logRecord });
    if (payload) {
      const key = statusKey(payload);
      if (!acknowledged.has(key)) pending.set(key, payload);
      if (url) setImmediate(attempt);
    }
  }

  async function drain() {
    if (!url || running || Date.now() < nextAttempt) return;
    running = true;
    try {
      for (const [key, payload] of pending) {
        let response;
        try {
          response = await fetchImpl(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": key },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10000),
          });
        } catch (e) {
          failures++;
          nextAttempt = Date.now() + Math.min(300000, 1000 * 2 ** Math.min(failures, 8));
          log.warn(`WEP no disponible; ${pending.size} estado(s) pendientes; reintento programado: ${e.name || "error"}`);
          break;
        }
        if (response.status !== 200 && response.status !== 204) {
          failures++;
          nextAttempt = Date.now() + Math.min(300000, 1000 * 2 ** Math.min(failures, 8));
          log.warn(`WEP respondió HTTP ${response.status}; ${pending.size} estado(s) pendientes`);
          break;
        }
        // An acknowledgement is durable before removing the item from memory.
        appendDurably(fileFor(), { ts: new Date().toISOString(), kind: "wep_status_ack", key });
        acknowledged.add(key);
        pending.delete(key);
        failures = 0;
        nextAttempt = 0;
      }
    } finally { running = false; }
  }

  function start() { timer = setInterval(attempt, intervalMs); timer.unref?.(); attempt(); }
  function stop() { if (timer) clearInterval(timer); }
  return { load, enqueue, drain, start, stop, pendingCount: () => pending.size };
}
