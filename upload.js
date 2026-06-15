/**
 * syncDriveToBunny.js
 *
 * Downloads all videos from a Google Drive folder (top-level only) and uploads
 * them to Bunny.net under Academy/Video/Lessons.
 *
 * Usage:
 *   node syncDriveToBunny.js <DRIVE_FOLDER_ID>
 *
 * Prerequisites:
 *   npm install googleapis
 */

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

// ─── Configuration — fill these in ───────────────────────────────────────────

/** Path to your Google service account JSON key file */
const GOOGLE_SERVICE_ACCOUNT_JSON = "./modified-shape-392220-614a2fac5398.json";
console.log({GOOGLE_SERVICE_ACCOUNT_JSON})
/** Bunny.net storage zone name */
const BUNNY_STORAGE_ZONE = "requiza";
/** Bunny.net storage API key */
const BUNNY_API_KEY = "f0e2696b-46ca-4cab-982ca8445e4a-02c8-4c87";
/** Bunny.net storage hostname — usually storage.bunnycdn.com */
const BUNNY_HOSTNAME = "storage.bunnycdn.com";
/** Your CDN pull-zone base URL, e.g. https://yourzone.b-cdn.net */
const BUNNY_CDN_URL = "https://requiza.b-cdn.net";
const BUNNY_DESTINATION_FOLDER = "Academy/Video/Lessons";

const BUNNY_STREAM_LIBRARY_ID = "636044";
const BUNNY_STREAM_API_KEY = "86d2c38c-9c4f-4a05-a4ea7e55d8c8-12d8-466a";

// ─── Bunny helpers ────────────────────────────────────────────────────────────

async function uploadBufferToBunny(buffer, folder, filename) {
  const storagePath = `${folder}/${filename}`;
  const url = `https://${BUNNY_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${storagePath}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      AccessKey: BUNNY_API_KEY,
      "Content-Type": "application/octet-stream",
    },
    body: buffer,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Bunny.net upload failed [${response.status}]: ${body}`);
  }

  return {
    url: `${BUNNY_CDN_URL}/${storagePath}`,
    path: storagePath,
    httpCode: response.status,
  };
}

/** Returns true if the file already exists in Bunny storage. */
async function existsInBunny(storagePath) {
  const url = `https://${BUNNY_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${storagePath}`;
  const res = await fetch(url, {
    method: "HEAD",
    headers: { AccessKey: BUNNY_API_KEY },
  });
  return res.status === 200;
}

// ─── Google Drive helpers ─────────────────────────────────────────────────────

const VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  "video/webm",
  "video/mpeg",
  "video/ogg",
  "video/3gpp",
  "video/x-flv",
  "video/x-ms-wmv",
]);

/** Collect all video files in the top-level of a Drive folder (no recursion). */
async function collectVideos(drive, folderId) {
  const results = [];
  let pageToken;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: 1000,
      pageToken,
    });

    const files = res.data.files ?? [];
    pageToken = res.data.nextPageToken ?? undefined;

    for (const file of files) {
      if (VIDEO_MIME_TYPES.has(file.mimeType)) {
        results.push({ id: file.id, name: file.name, mimeType: file.mimeType });
      }
    }
  } while (pageToken);

  return results;
}

/** Download a Drive file and return it as a Buffer. */
async function downloadFile(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rootFolderId = process.argv[2];
  if (!rootFolderId) {
    console.error("Usage: node syncDriveToBunny.js <DRIVE_FOLDER_ID>");
    process.exit(1);
  }

  // Build the Drive client from the service account key
  const keyFileContent = fs.readFileSync(path.resolve(GOOGLE_SERVICE_ACCOUNT_JSON), "utf-8");
  const serviceAccountKey = JSON.parse(keyFileContent);

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccountKey,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  const drive = google.drive({ version: "v3", auth });

  // ── 1. Collect all video files ─────────────────────────────────────────────
  console.log(`\n🔍 Scanning Google Drive folder: ${rootFolderId}\n`);
  const videos = await collectVideos(drive, rootFolderId);
  console.log(`\nFound ${videos.length} video(s) to process.\n`);

  if (videos.length === 0) {
    console.log("Nothing to do. Exiting.");
    return;
  }

  // ── 2. Upload each video to Bunny ──────────────────────────────────────────
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    const prefix = `[${i + 1}/${videos.length}]`;
    const storagePath = `${BUNNY_DESTINATION_FOLDER}/${video.name}`;

    console.log(`${prefix} ${video.name}`);

    const alreadyExists = await existsInBunny(storagePath);
    if (alreadyExists) {
      console.log(`  ⏭  Skipped (already exists in Bunny)\n`);
      skipped++;
      continue;
    }

    try {
      console.log(`  ⬇️  Downloading from Drive…`);
      const buffer = await downloadFile(drive, video.id);
      const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(2);
      console.log(`  📦 ${sizeMB} MB — uploading to Bunny…`);

      const result = await uploadBufferToBunny(buffer, BUNNY_DESTINATION_FOLDER, video.name);
      console.log(`  ✅ Uploaded → ${result.url}\n`);
      uploaded++;
    } catch (err) {
      console.error(`  ❌ Failed: ${err.message}\n`);
      failed++;
    }
  }

  // ── 3. Summary ────────────────────────────────────────────────────────────
  console.log("─".repeat(50));
  console.log(`✅ Uploaded : ${uploaded}`);
  console.log(`⏭  Skipped  : ${skipped}`);
  console.log(`❌ Failed   : ${failed}`);
  console.log(`📁 Total    : ${videos.length}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
