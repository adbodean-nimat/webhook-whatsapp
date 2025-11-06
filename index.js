// index.js
// WhatsApp Business Platform (Cloud API) — Webhook con logging a archivo + derivación
// Autor: Antonio (toto) @ NIMAT

import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

// En Node 18+ fetch es global.
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ verify: rawBodySaver }));

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // token de verificación (Meta)
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // token de acceso de Cloud API
const WABA_PHONE_ID = process.env.WABA_PHONE_ID; // ej: 123456789012345
const APP_SECRET = process.env.APP_SECRET || null; // opcional: para verificar X-Hub-Signature-256

// Derivación a Ventas
const VENTAS_NUMBER_E164 = process.env.VENTAS_NUMBER_E164 || "+54911XXXXXXX";
const VENTAS_NUMBER_PLAIN = VENTAS_NUMBER_E164.replace(/\+/g, "");

// Archivo de logs (JSON Lines)
const LOG_FILE_PATH =
  process.env.LOG_FILE_PATH || path.join(__dirname, "data", "waba-events.jsonl");

// Asegurar carpeta
fs.mkdirSync(path.dirname(LOG_FILE_PATH), { recursive: true });

// ====== UTILES ======
function rawBodySaver(req, res, buf) {
  req.rawBody = buf;
}

function log(...args) {
  console.log(new Date().toISOString(), "—", ...args);
}

// Cola de escritura para evitar condiciones de carrera al escribir el archivo
const writeQueue = [];
let writing = false;

function diskLog(kind, payload = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    kind, // 'status' | 'message' | 'action' | 'error'
    ...payload,
  });
  writeQueue.push(line + "\n");
  flushQueue();
}

async function flushQueue() {
  if (writing || writeQueue.length === 0) return;
  writing = true;
  try {
    const chunk = writeQueue.splice(0, writeQueue.length).join("");
    await fs.promises.appendFile(LOG_FILE_PATH, chunk, "utf8");
  } catch (err) {
    console.error("diskLog error:", err?.message);
  } finally {
    writing = false;
    if (writeQueue.length) setImmediate(flushQueue);
  }
}

process.on("SIGTERM", async () => {
  await new Promise((r) => {
    const interval = setInterval(() => {
      if (!writing && writeQueue.length === 0) {
        clearInterval(interval);
        r();
      }
    }, 20);
  });
  process.exit(0);
});

// ====== WhatsApp API helpers ======
async function sendMessage(to, payload) {
  const url = `https://graph.facebook.com/v20.0/${WABA_PHONE_ID}/messages`;
  const body = { messaging_product: "whatsapp", to, ...payload };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
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

async function sendText(to, text) {
  return sendMessage(to, { type: "text", text: { body: text } });
}

async function sendQuickReplyVentas(to) {
  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "¿Querés hablar con Ventas?" },
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
  // Enviar tarjeta de contacto + texto con wa.me
  await sendMessage(to, {
    type: "contacts",
    contacts: [
      {
        name: { formatted_name: "NIMAT Ventas" },
        phones: [{ phone: VENTAS_NUMBER_E164, type: "CELL", wa_id: VENTAS_NUMBER_PLAIN }],
      },
    ],
  });

  const texto = [
    "Te derivo con nuestro equipo de Ventas:",
    `➡️ wa.me/${VENTAS_NUMBER_PLAIN}`,
    `También podés agendar este contacto: ${VENTAS_NUMBER_E164}`,
  ].join("\n");

  await sendText(to, texto);
  diskLog("action", { action: "derivacion_enviada", to });
}

// ====== Seguridad: verificación de firma (opcional pero recomendado) ======
function verifySignature(req) {
  if (!APP_SECRET) return true; // deshabilitado si no hay APP_SECRET
  const signature = req.get("x-hub-signature-256") || "";
  const expected =
    "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");

  // timing safe compare
  const buffA = Buffer.from(signature);
  const buffB = Buffer.from(expected);
  if (buffA.length !== buffB.length) return false;
  return crypto.timingSafeEqual(buffA, buffB);
}

// ====== WEBHOOK (VERIFY) ======
app.get("/whatsapp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    log("Webhook verificado correctamente");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ====== WEBHOOK (RECEIVE) ======
app.post("/whatsapp/webhook", async (req, res) => {
  try {
    if (!verifySignature(req)) {
      log("Firma inválida X-Hub-Signature-256");
      diskLog("error", { where: "verifySignature", message: "invalid_signature" });
      return res.sendStatus(401);
    }

    const { object, entry } = req.body || {};
    if (object !== "whatsapp_business_account" || !Array.isArray(entry)) {
      return res.sendStatus(200);
    }

    for (const ent of entry) {
      for (const change of ent.changes || []) {
        const val = change.value || {};

        // 1) ESTADOS DE MENSAJES
        if (Array.isArray(val.statuses)) {
          for (const st of val.statuses) {
            const info = {
              status: st.status,           // sent, delivered, read, failed
              message_id: st.id,
              recipient_id: st.recipient_id,
              timestamp: st.timestamp,
              conversation: st.conversation,
              pricing: st.pricing,
              errors: st.errors,
            };
            log("STATUS:", info.status, info.message_id);
            diskLog("status", info);
          }
        }

        // 2) MENSAJES ENTRANTES
        if (Array.isArray(val.messages)) {
          for (const msg of val.messages) {
            const from = msg.from;
            const type = msg.type;
            const textLower = msg.text?.body?.toLowerCase?.() || "";

            log("INCOMING:", { from, type, msgId: msg.id });
            diskLog("message", {
              from,
              type,
              msg_id: msg.id,
              text: msg.text?.body || null,
              button: msg.button || null,
              interactive: msg.interactive || null,
              image: msg.image || null,
              document: msg.document || null,
              timestamp: msg.timestamp,
            });

            // Si apretó botón quick-reply
            if (type === "button" && msg.button?.payload) {
              const payload = msg.button.payload;
              if (payload === "CONTACTAR_VENTAS" || payload === "ATENCION_HUMANA") {
                await sendDerivacion(from);
                continue;
              }
            }

            // Palabras clave para derivar
            if (["ventas", "hablar con ventas", "humano", "asesor", "baja", "derivar"].some(k => textLower.includes(k))) {
              await sendDerivacion(from);
              continue;
            }

            // Respuesta por defecto: ofrecer botón
            await sendQuickReplyVentas(from);
          }
        }
      }
    }

    // ACK rápido
    return res.sendStatus(200);
  } catch (err) {
    log("ERROR webhook:", err?.message);
    diskLog("error", { where: "webhook", message: err?.message });
    // Nunca devolver 500 a Meta; 200 evita reintentos agresivos
    return res.sendStatus(200);
  }
});

app.get("/health", (_req, res) => res.send("ok"));

app.listen(PORT, () => log(`Servidor escuchando en :${PORT} — log en ${LOG_FILE_PATH}`));
