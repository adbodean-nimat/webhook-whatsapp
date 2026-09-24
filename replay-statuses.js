import "dotenv/config";
import { createStatusOutbox } from "./wep-status.js";
import { resolveWepConfig } from "./wep-config.js";

if (process.argv.length !== 3 || process.argv[2] !== "--all") {
  console.error("Uso: npm run replay:statuses -- --all (lee todos los JSONL locales; solo reenvía estados pendientes a WEP)");
  process.exit(2);
}
if (process.env.WEP_HABILITAR !== "true") {
  console.error("Configurar WEP_HABILITAR=true antes de reprocesar");
  process.exit(2);
}
const dir = process.env.LOG_LOCAL_DIR || "/tmp/nimat-logs";
const wepConfig = resolveWepConfig(process.env, dir);
const outbox = createStatusOutbox({
  dir,
  url: wepConfig.url,
  token: wepConfig.token,
});
const count = outbox.load();
console.log(`${count} estado(s) únicos pendientes`);
await outbox.drain();
const remaining = outbox.pendingCount();
console.log(`${remaining} estado(s) pendientes después del intento`);
if (remaining) process.exitCode = 1;
