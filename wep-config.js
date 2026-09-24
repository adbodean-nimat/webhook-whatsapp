export function resolveWepConfig(env, logDir) {
  const raw = env.WEP_HABILITAR ?? "false";
  if (raw !== "true" && raw !== "false") throw new Error("WEP_HABILITAR debe ser true o false");
  if (raw === "false") return { enabled: false, url: undefined, token: undefined };
  if (!env.WEP_STATUS_URL || !env.WEP_STATUS_TOKEN) {
    throw new Error("WEP_HABILITAR=true requiere WEP_STATUS_URL y WEP_STATUS_TOKEN");
  }
  if (!["development", "test"].includes(env.NODE_ENV) &&
      (env.WEP_STATUS_PERSISTENCE !== "render-disk" || logDir === "/tmp" || logDir.startsWith("/tmp/"))) {
    throw new Error("WEP requiere disco persistente de Render: configurar LOG_LOCAL_DIR en el mount y WEP_STATUS_PERSISTENCE=render-disk");
  }
  return { enabled: true, url: env.WEP_STATUS_URL, token: env.WEP_STATUS_TOKEN };
}
