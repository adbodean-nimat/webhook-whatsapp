// index.js
// WhatsApp Business Platform — Webhook con log (JSONL) y sync a Google Drive usando OAuth (usuario humano)

import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { google } from "googleapis";
import { title } from "process";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ verify: rawBodySaver }));

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WABA_PHONE_ID = process.env.WABA_PHONE_ID;
const APP_SECRET = process.env.APP_SECRET || null;

// Derivación a Ventas
const VENTAS_NUMBER_E164 = process.env.VENTAS_NUMBER_E164;
const VENTAS_NUMBER_PLAIN = VENTAS_NUMBER_E164.replace(/\+/g, "");

// Log local + Sync a Drive
const LOG_LOCAL_DIR = process.env.LOG_LOCAL_DIR || "/tmp/nimat-logs";
const DRIVE_SYNC_ENABLED = String(process.env.DRIVE_SYNC_ENABLED || "true") === "true";
const DRIVE_SYNC_INTERVAL_MS = Number(process.env.DRIVE_SYNC_INTERVAL_MS || 15000);
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

// ====== GOOGLE DRIVE (OAuth con usuario) ======
let drive = null;

async function initDriveOAuth() {
  if (!DRIVE_SYNC_ENABLED) return;
  const cid = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const sec = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const rft = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!cid || !sec || !rft || !GOOGLE_DRIVE_FOLDER_ID) {
    console.warn("Drive OAuth deshabilitado: faltan CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN / FOLDER_ID");
    return;
  }

  // OAuth2 con refresh token (no necesitamos redirect aquí)
  const oauth2 = new google.auth.OAuth2(cid, sec, "http://localhost");
  oauth2.setCredentials({ refresh_token: rft });

  // Cliente de Drive
  drive = google.drive({ version: "v3", auth: oauth2 });

  // Sanity: acceso a la carpeta (Mi unidad)
  try {
    await drive.files.get({ fileId: GOOGLE_DRIVE_FOLDER_ID, fields: "id, name" });
    console.log("Drive OAuth OK. Carpeta accesible:", GOOGLE_DRIVE_FOLDER_ID);
  } catch (e) {
    console.error("No accedo a la carpeta de Drive. ¿Folder ID correcto y usuario con acceso?", e?.message);
  }
}

function rawBodySaver(req, res, buf) { req.rawBody = buf; }
function log(...args) { console.log(new Date().toISOString(), "—", ...args); }

fs.mkdirSync(LOG_LOCAL_DIR, { recursive: true });

// ====== UTIL FECHAS/FILES ======
const pad = (n) => String(n).padStart(2, "0");
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
};
const localPathFor = (key) => path.join(LOG_LOCAL_DIR, `waba-events-${key}.jsonl`);

async function md5File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("md5");
    const s = fs.createReadStream(filePath);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

async function driveFindFileIdByName(name) {
  if (!drive) return null;
  const q = `'${GOOGLE_DRIVE_FOLDER_ID}' in parents and name='${name}' and trashed=false`;
  const { data } = await drive.files.list({ q, fields: "files(id,name)" });
  return data.files?.[0]?.id || null;
}

async function driveDownloadToLocal(fileId, destPath) {
  const dest = fs.createWriteStream(destPath);
  const resp = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
  await new Promise((resolve, reject) => {
    resp.data.pipe(dest).on("finish", resolve).on("error", reject);
  });
}

async function driveCreateOrUpdate(name, localPath, fileId = null) {
  const media = { mimeType: "application/json", body: fs.createReadStream(localPath) };
  if (fileId) {
    await drive.files.update({ fileId, media });
    return fileId;
  }
  const requestBody = { name, parents: [GOOGLE_DRIVE_FOLDER_ID], mimeType: "application/json" };
  const { data } = await drive.files.create({ requestBody, media, fields: "id" });
  return data.id;
}

// ====== SEED AL INICIAR (traer archivo de HOY si existe en Drive) ======
async function seedTodayFromDrive() {
  if (!drive) return;
  const key = todayKey();
  const name = `waba-events-${key}.jsonl`;
  const local = localPathFor(key);
  if (fs.existsSync(local)) return; // ya existe local

  const fid = await driveFindFileIdByName(name);
  if (fid) {
    fs.mkdirSync(path.dirname(local), { recursive: true });
    await driveDownloadToLocal(fid, local);
    log("Seed desde Drive OK:", name);
  }
}

// ====== QUEUE DE LOG (escritura local) ======
const writeQueue = [];
let writing = false;

function diskLog(kind, payload = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...payload }) + "\n";
  writeQueue.push({ key: todayKey(), line });
  flushQueue();
}

async function flushQueue() {
  if (writing || writeQueue.length === 0) return;
  writing = true;
  try {
    const groups = new Map();
    for (const item of writeQueue.splice(0, writeQueue.length)) {
      const arr = groups.get(item.key) || [];
      arr.push(item.line);
      groups.set(item.key, arr);
    }
    for (const [key, lines] of groups.entries()) {
      const fpath = localPathFor(key);
      fs.mkdirSync(path.dirname(fpath), { recursive: true });
      await fs.promises.appendFile(fpath, lines.join(""), "utf8");
    }
  } catch (err) {
    console.error("diskLog error:", err?.message);
  } finally {
    writing = false;
    if (writeQueue.length) setImmediate(flushQueue);
  }
}

// ====== SYNC A DRIVE (si cambió el archivo de hoy) ======
const lastUploadedHash = new Map(); // key -> md5
let syncing = false;

async function syncTodayToDrive() {
  if (!drive || syncing) return;
  const key = todayKey();
  const name = `waba-events-${key}.jsonl`;
  const local = localPathFor(key);
  if (!fs.existsSync(local)) return;

  const hash = await md5File(local).catch(() => null);
  if (!hash || lastUploadedHash.get(key) === hash) return;

  syncing = true;
  try {
    let fileId = await driveFindFileIdByName(name);
    fileId = await driveCreateOrUpdate(name, local, fileId);
    lastUploadedHash.set(key, hash);
    log("Sync a Drive OK:", name, fileId);
  } catch (e) {
    console.error("Sync Drive error:", e?.response?.data || e?.message);
  } finally {
    syncing = false;
  }
}

process.on("SIGTERM", async () => {
  await new Promise((r) => {
    const iv = setInterval(() => {
      if (!writing && writeQueue.length === 0) { clearInterval(iv); r(); }
    }, 20);
  });
  await syncTodayToDrive().catch(() => {});
  process.exit(0);
});

// ====== WhatsApp API helpers ======
async function sendMessage(to, payload) {
  const url = `https://graph.facebook.com/v20.0/${WABA_PHONE_ID}/messages`;
  const body = { messaging_product: "whatsapp", to, ...payload };
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    log("ERROR enviando mensaje", resp.status, json);
    diskLog("error", { where: "sendMessage", status: resp.status, json, to, payload });
    throw new Error(`Falló envío: ${resp.status}`);
  }
  log("Mensaje enviado OK", json);
  return json;
}

async function sendText(to, text) { return sendMessage(to, { type: "text", text: { body: text } }); }

async function sendQuickReplyVentas(to) {
   const bodyText = [
    "🙏 ¡Gracias por tu mensaje!",
    "Este número no es atendido. Para consultas y pedidos, contactá a nuestro equipo de Ventas."
  ].join("\n");
  const footerText = "El equipo de NIMAT";
  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      footer: { text: footerText },
      action: {
        buttons: [
          { type: "reply", reply: { id: "CONTACTAR_VENTAS", title: "Hablar con Ventas" } },
          { type: "reply", reply: { id: "ATENCION_HUMANA", title: "Atención humana" } },
        ],
      },
    },
  });
}

async function sendDerivacion(to) {
  await sendMessage(to, {
    type: "contacts",
    contacts: [{
      name: { 
        formatted_name: "NIMAT - Veronica Severo",
        first_name: 'Verónica',
        last_name: 'Severo',
        middle_name: '',
        suffix: '',
        prefix: '' 
       },
      phones: [{ phone: VENTAS_NUMBER_E164, type: "WORK", wa_id: VENTAS_NUMBER_PLAIN }]
    }],
  });
  const texto = [
    "Te derivo con nuestro equipo de Ventas:",
    `➡️ wa.me/${VENTAS_NUMBER_PLAIN}`,
    `También podés agendar este contacto: ${VENTAS_NUMBER_E164}`
  ].join("\n");
  await sendText(to, texto);
  diskLog("action", { action: "derivacion_enviada", to });
}

// ====== Seguridad (firma de Meta opcional) ======
function verifySignature(req) {
  if (!APP_SECRET) return true;
  const sig = req.get("x-hub-signature-256") || "";
  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ====== WEBHOOKS ======
app.get("/whatsapp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post("/whatsapp/webhook", async (req, res) => {
  try {
    if (!verifySignature(req)) {
      diskLog("error", { where: "verifySignature", message: "invalid_signature" });
      return res.sendStatus(401);
    }
    const { object, entry } = req.body || {};
    if (object !== "whatsapp_business_account" || !Array.isArray(entry)) return res.sendStatus(200);

    for (const ent of entry) {
      for (const change of ent.changes || []) {
        const val = change.value || {};

        if (Array.isArray(val.statuses)) {
          for (const st of val.statuses) {
            const info = {
              status: st.status, message_id: st.id, recipient_id: st.recipient_id,
              timestamp: st.timestamp, conversation: st.conversation, pricing: st.pricing, errors: st.errors
            };
            log("STATUS:", info.status, info.message_id);
            diskLog("status", info);
          }
        }

        if (Array.isArray(val.messages)) {
          for (const msg of val.messages) {
            const from = msg.from;
            const type = msg.type;
            const textLower = msg.text?.body?.toLowerCase?.() || "";
            log("INCOMING:", { from, type, msgId: msg.id });
            diskLog("message", {
              from, type, msg_id: msg.id, text: msg.text?.body || null,
              button: msg.button || null, interactive: msg.interactive || null,
              image: msg.image || null, document: msg.document || null, timestamp: msg.timestamp,
            });

            if (type === "interactive") {
              const btnId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
              if (["CONTACTAR_VENTAS","ATENCION_HUMANA"].includes(btnId)) {
                await sendDerivacion(from);
                continue;
              }
            }
            if (type === "button" && msg.button?.payload) {
              const p = msg.button.payload;
              if (p === "CONTACTAR_VENTAS" || p === "ATENCION_HUMANA") { await sendDerivacion(from); continue; }
            }

            if (["ventas","hablar con ventas","humano","asesor","baja","derivar"].some(k => textLower.includes(k))) {
              await sendDerivacion(from);
              continue;
            }
            
            await sendQuickReplyVentas(from);
          }
        }
      }
    }
    return res.sendStatus(200);
  } catch (err) {
    log("ERROR webhook:", err?.message);
    diskLog("error", { where: "webhook", message: err?.message });
    return res.sendStatus(200);
  }
});

app.get("/health", (_req, res) => res.send("ok"));

// ====== STARTUP ======
(async () => {
  await initDriveOAuth();
  await seedTodayFromDrive().catch(e => console.warn("Seed fallida:", e?.message));
  if (DRIVE_SYNC_ENABLED) setInterval(syncTodayToDrive, DRIVE_SYNC_INTERVAL_MS);
  app.listen(PORT, () => log(`Servidor escuchando en :${PORT} — logs en ${LOG_LOCAL_DIR}`));
})();
