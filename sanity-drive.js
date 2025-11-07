import { google } from "googleapis";

const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
let privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

const auth = new google.auth.JWT({
  email: clientEmail,
  key: privateKey,
  scopes: ["https://www.googleapis.com/auth/drive"],
});

await auth.authorize();
const drive = google.drive({ version: "v3", auth });

// Subir un archivo de prueba en memoria
import fs from "fs";
const tmp = "/tmp/hello.json";
fs.writeFileSync(tmp, JSON.stringify({ hello: "world", ts: Date.now() }));

let fileId;
try {
  const name = "hello.json";
  // buscar si ya existe
  const { data: { files = [] } } = await drive.files.list({
    q: `'${folderId}' in parents and name='${name}' and trashed=false`,
    fields: "files(id,name)",
    supportsAllDrives: true
  });
  fileId = files[0]?.id || null;

  if (fileId) {
    await drive.files.update({
      fileId,
      media: { mimeType: "application/json", body: fs.createReadStream(tmp) },
      supportsAllDrives: true
    });
    console.log("Actualizado:", fileId);
  } else {
    const { data } = await drive.files.create({
      requestBody: { name, parents: [folderId], mimeType: "application/json" },
      media: { mimeType: "application/json", body: fs.createReadStream(tmp) },
      fields: "id",
      supportsAllDrives: true
    });
    fileId = data.id;
    console.log("Creado:", fileId);
  }
} catch (e) {
  console.error("Fallo en Drive:", e?.response?.data || e?.message);
  process.exit(1);
}
console.log("OK");
