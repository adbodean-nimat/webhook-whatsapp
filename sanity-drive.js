// sanity-drive.js
import dotenv from "dotenv";
import fs from "fs";
import { google } from "googleapis";
dotenv.config();
const cid = process.env.GOOGLE_OAUTH_CLIENT_ID;
const sec = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const rft = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

if (!cid || !sec || !rft || !folderId) {
  console.error("Faltan variables OAuth o FOLDER_ID");
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(cid, sec, "http://localhost");
oauth2.setCredentials({ refresh_token: rft });
const drive = google.drive({ version: "v3", auth: oauth2 });

const tmp = "/tmp/hello.json";
fs.writeFileSync(tmp, JSON.stringify({ hello: "world", ts: Date.now() }));

const name = "hello.json";

// ¿Existe?
const { data: { files = [] } } = await drive.files.list({
  q: `'${folderId}' in parents and name='${name}' and trashed=false`,
  fields: "files(id,name)"
});

const media = { mimeType: "application/json", body: fs.createReadStream(tmp) };
let fileId = files[0]?.id || null;

if (fileId) {
  await drive.files.update({ fileId, media });
  console.log("Actualizado:", fileId);
} else {
  const { data } = await drive.files.create({
    requestBody: { name, parents: [folderId], mimeType: "application/json" },
    media,
    fields: "id"
  });
  fileId = data.id;
  console.log("Creado:", fileId);
}
console.log("OK");
