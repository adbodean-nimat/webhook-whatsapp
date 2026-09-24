import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createStatusOutbox } from "./wep-status.js";
import { verifyMetaSignature } from "./meta-signature.js";
import { resolveWepConfig } from "./wep-config.js";

const url = "https://wep.example.test/status";
const token = "test-token";
const quiet = { warn() {}, error() {} };
function makeDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wep-status-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function event(status = "delivered", timestamp = "1700000000") {
  return { id: "wamid.example", status, timestamp };
}
function enqueue(outbox, st) {
  outbox.enqueue(st, { message_id: st.id, status: st.status, timestamp: st.timestamp, errors: st.errors });
}
function outbox(dir, fetchImpl) {
  return createStatusOutbox({ dir, url, token, fetchImpl, log: quiet });
}

test("envía solo el contrato mínimo con autenticación e idempotencia", async (t) => {
  const dir = makeDir(t);
  const calls = [];
  const box = outbox(dir, async (endpoint, init) => { calls.push({ endpoint, init }); return { status: 200 }; });
  box.load();
  enqueue(box, { ...event(), recipient_id: "private-phone", errors: [{ code: 131026, title: "private" }] });
  await box.drain();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, url);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.ok(calls[0].init.headers["Idempotency-Key"]);
  assert.deepEqual(JSON.parse(calls[0].init.body), { messageId: "wamid.example", status: "delivered", timestamp: "1700000000", metaErrorCode: 131026 });
  assert.equal(box.pendingCount(), 0);
});

test("evento repetido y reinicio no causan otro envío tras confirmación", async (t) => {
  const dir = makeDir(t);
  let sent = 0;
  const fetchImpl = async () => { sent++; return { status: 200 }; };
  const first = outbox(dir, fetchImpl);
  first.load();
  enqueue(first, event());
  enqueue(first, event());
  await first.drain();
  assert.equal(sent, 1);
  const restarted = outbox(dir, fetchImpl);
  assert.equal(restarted.load(), 0);
  enqueue(restarted, event());
  await restarted.drain();
  assert.equal(sent, 1);
});

test("estados fuera de orden se reenvían y permiten avance monotónico en WEP", async (t) => {
  const dir = makeDir(t);
  const order = [];
  const rank = { sent: 1, delivered: 2, read: 3 };
  let stored = 0;
  const box = outbox(dir, async (_url, init) => {
    const payload = JSON.parse(init.body);
    order.push(payload.status);
    stored = Math.max(stored, rank[payload.status]);
    return { status: 200 };
  });
  box.load();
  enqueue(box, event("read", "3"));
  enqueue(box, event("sent", "1"));
  enqueue(box, event("delivered", "2"));
  await box.drain();
  assert.deepEqual(order, ["read", "sent", "delivered"]);
  assert.equal(stored, 3);
});

test("fallo temporal queda pendiente y se recupera al reprocesar tras reinicio", async (t) => {
  const dir = makeDir(t);
  const first = outbox(dir, async () => { throw new Error("offline"); });
  first.load();
  enqueue(first, event("failed"));
  await first.drain();
  assert.equal(first.pendingCount(), 1);
  let sent = 0;
  const restarted = outbox(dir, async () => { sent++; return { status: 200 }; });
  assert.equal(restarted.load(), 1);
  await restarted.drain();
  assert.equal(sent, 1);
  assert.equal(restarted.pendingCount(), 0);
});

test("202 sin confirmación durable de WEP no confirma el evento", async (t) => {
  const dir = makeDir(t);
  const box = outbox(dir, async () => ({ status: 202 }));
  box.load();
  enqueue(box, event());
  await box.drain();
  assert.equal(box.pendingCount(), 1);
});

test("JSONL histórico se reprocesa solo como estados, sin mensajes de WhatsApp", async (t) => {
  const dir = makeDir(t);
  fs.writeFileSync(path.join(dir, "waba-events-20250101.jsonl"), [
    JSON.stringify({ kind: "message", msg_id: "incoming" }),
    JSON.stringify({ kind: "status", message_id: "wamid.old", status: "read", timestamp: "1700000000" }),
    JSON.stringify({ kind: "status", message_id: "wamid.old", status: "read", timestamp: "1700000000" }),
  ].join("\n") + "\n");
  const calls = [];
  const box = outbox(dir, async (_url, init) => { calls.push(JSON.parse(init.body)); return { status: 200 }; });
  assert.equal(box.load(), 1);
  await box.drain();
  assert.deepEqual(calls, [{ messageId: "wamid.old", status: "read", timestamp: "1700000000" }]);
});

test("firma inválida o ausente se rechaza", () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const sig = "sha256=" + crypto.createHmac("sha256", "test-secret").update(body).digest("hex");
  assert.equal(verifyMetaSignature(body, sig, "test-secret"), true);
  assert.equal(verifyMetaSignature(body, sig.slice(0, -1) + "0", "test-secret"), false);
  assert.equal(verifyMetaSignature(body, "", "test-secret"), false);
  assert.equal(verifyMetaSignature(body, sig, null), false);
});

test("WEP queda deshabilitado por defecto aunque haya URL configurada", async (t) => {
  const config = resolveWepConfig({ WEP_STATUS_URL: url, WEP_STATUS_TOKEN: token }, "/tmp/nimat-logs");
  assert.deepEqual(config,
    { enabled: false, url: undefined, token: undefined });
  assert.deepEqual(resolveWepConfig({ WEP_HABILITAR: "false", WEP_STATUS_URL: url }, "/tmp/nimat-logs"),
    { enabled: false, url: undefined, token: undefined });
  let calls = 0;
  const box = createStatusOutbox({ dir: makeDir(t), url: config.url, token: config.token, fetchImpl: async () => { calls++; return { status: 200 }; }, log: quiet });
  box.load();
  enqueue(box, event());
  await box.drain();
  assert.equal(calls, 0);
  assert.equal(box.pendingCount(), 1);
});

test("habilitar WEP exige URL, token y persistencia en producción", () => {
  assert.throws(() => resolveWepConfig({ WEP_HABILITAR: "true" }, "/var/data/nimat-logs"), /requiere WEP_STATUS_URL/);
  assert.throws(() => resolveWepConfig({ WEP_HABILITAR: "true", WEP_STATUS_URL: url, WEP_STATUS_TOKEN: token, NODE_ENV: "production" }, "/tmp/nimat-logs"), /disco persistente/);
  assert.deepEqual(resolveWepConfig({ WEP_HABILITAR: "true", WEP_STATUS_URL: url, WEP_STATUS_TOKEN: token, NODE_ENV: "production", WEP_STATUS_PERSISTENCE: "render-disk" }, "/var/data/nimat-logs"),
    { enabled: true, url, token });
});
