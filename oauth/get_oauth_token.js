// oauth/get_oauth_token.js
// Genera y muestra un REFRESH TOKEN para Drive OAuth (Desktop App)
import dotenv from "dotenv";
import http from "http";
import open from "open";             // instala 'open' o abrí el URL manualmente
import { google } from "googleapis";
dotenv.config();
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const PORT = process.env.OAUTH_LOCAL_PORT || 5555;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Faltan GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET en el entorno.");
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Servidor local para capturar el 'code'
const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/oauth2callback")) {
    res.writeHead(404); res.end(); return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get("code");
  if (!code) { res.end("Missing code"); return; }

  try {
    const { tokens } = await oauth2.getToken(code);
    res.end("¡Listo! Ya podés volver a la consola.");
    console.log("\nTokens recibidos:");
    console.log(JSON.stringify(tokens, null, 2));
    if (!tokens.refresh_token) {
      console.log("\n⚠️ No vino refresh_token. Reintentá con 'prompt=consent' más abajo.");
    }
  } catch (e) {
    res.end("Error intercambiando token");
    console.error(e);
  } finally {
    server.close();
  }
});

server.listen(PORT, async () => {
  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",        // fuerza a entregar refresh_token
    scope: SCOPES
  });
  console.log("\nAbrí esta URL para autorizar:");
  console.log(authUrl, "\n");
  try { await open(authUrl); } catch { /* si no puede abrir, copialo a mano */ }
});
