/**
 * syncDriveToBunnyStream.js
 *
 * Downloads videos from a Google Drive folder (top-level only) and uploads
 * them to a Bunny.net STREAM library (instead of a storage zone).
 *
 * Usage:
 *   node syncDriveToBunnyStream.js <DRIVE_FOLDER_ID> [MAX_NUMBER]
 *
 * MAX_NUMBER (optional):
 *   Many lesson filenames contain a number (e.g. "Lesson 12 - Intro.mp4").
 *   If MAX_NUMBER is given, any video whose filename number is GREATER than
 *   MAX_NUMBER is skipped — i.e. only videos numbered <= MAX_NUMBER are
 *   uploaded. If omitted, all videos are considered.
 *
 *   CAVEAT: this relies on extractNumberFromName() finding exactly one
 *   meaningful number in the filename. If a filename has multiple numbers
 *   (e.g. "Module 2 - Lesson 12.mp4", or a date like "2024"), the FIRST
 *   number found is used — which may not be the one you intend. Files with
 *   NO number in the name are always uploaded regardless of MAX_NUMBER,
 *   since there's nothing to compare. Double-check extractNumberFromName()
 *   against your actual filenames before relying on this filter, and
 *   consider doing a dry run first (see DRY_RUN below).
 *
 * Prerequisites:
 *   npm install googleapis
 *
 * Required environment variables:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  - path to your Google service account key file
 *   BUNNY_STREAM_LIBRARY_ID      - your Bunny Stream library ID
 *   BUNNY_STREAM_API_KEY         - your Stream library's API key
 *                                  (Stream > Your Library > API — NOT the
 *                                  account-level API key, and NOT a storage
 *                                  zone password; a 401 on either call below
 *                                  almost always means the wrong key/library)
 *   BUNNY_STREAM_COLLECTION_ID   - (optional) collection ID to place videos in
 */


const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

// ─── Configuration ────────────────────────────────────────────────────────
const GOOGLE_SERVICE_ACCOUNT_JSON = "./upload-keys.json";
const BUNNY_STREAM_LIBRARY_ID = "636044";
const BUNNY_STREAM_API_KEY = "86d2c38c-9c4f-4a05-a4ea7e55d8c8-12d8-466a";
const BUNNY_STREAM_COLLECTION_ID = process.env.BUNNY_STREAM_COLLECTION_ID || undefined;


if (!BUNNY_STREAM_LIBRARY_ID || !BUNNY_STREAM_API_KEY) {
  console.error("Missing BUNNY_STREAM_LIBRARY_ID or BUNNY_STREAM_API_KEY environment variables.");
  process.exit(1);
}

const STREAM_BASE = `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}`;

// ─── Bunny Stream helpers ─────────────────────────────────────────────────

/**
 * Step 1: create the "slot" video object in the library.
 * Returns the videoId (guid) to use for the upload step.
 */
async function createStreamVideo(title) {
  const body = { title };
  if (BUNNY_STREAM_COLLECTION_ID) body.collectionId = BUNNY_STREAM_COLLECTION_ID;

  const res = await fetch(`${STREAM_BASE}/videos`, {
    method: "POST",
    headers: {
      AccessKey: BUNNY_STREAM_API_KEY,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`createStreamVideo failed [${res.status}]: ${text}`);
  }

  const data = await res.json();
  return data.guid;
}

/**
 * Step 2: upload the raw binary video content for a previously-created videoId.
 */
async function uploadStreamVideo(videoId, buffer) {
  const res = await fetch(`${STREAM_BASE}/videos/${videoId}`, {
    method: "PUT",
    headers: {
      AccessKey: BUNNY_STREAM_API_KEY,
      Accept: "application/json",
    },
    body: buffer,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`uploadStreamVideo failed [${res.status}]: ${text}`);
  }

  return res.json();
}

/**
 * Checks whether a video with this exact title already exists in the library,
 * to provide a rough "skip if already uploaded" guard. Stream has no concept
 * of folder paths like storage zones do, so title is the closest match.
 */
async function existsInStream(title) {
  const url = new URL(`${STREAM_BASE}/videos`);
  url.searchParams.set("search", title);
  url.searchParams.set("itemsPerPage", "100");
  if (BUNNY_STREAM_COLLECTION_ID) url.searchParams.set("collection", BUNNY_STREAM_COLLECTION_ID);

  const res = await fetch(url, {
    headers: {
      AccessKey: BUNNY_STREAM_API_KEY,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`existsInStream check failed [${res.status}]: ${text}`);
  }

  const data = await res.json();
  const items = data.items ?? [];
  return items.some((v) => v.title === title);
}

// ─── Google Drive helpers ─────────────────────────────────────────────────

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
      // orderBy: "name", // uncomment for a deterministic, repeatable order
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

/**
 * Extracts the first standalone number found in a filename, e.g.
 * "Lesson 12 - Intro.mp4" -> 12, "03_welcome.mp4" -> 3.
 * Returns null if no number is found.
 *
 * NOTE: only the FIRST number in the string is used. If your filenames
 * have multiple numbers, adjust this regex/logic to target the right one.
 */
function extractNumberFromName(filename) {
  const match = filename.match(/\d+/);
  if (!match) return null;
  return parseInt(match[0], 10);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const rootFolderId = process.argv[2];
  const maxNumberArg = process.argv[3];

  if (!rootFolderId) {
    console.error("Usage: node syncDriveToBunnyStream.js <DRIVE_FOLDER_ID> [MAX_NUMBER]");
    process.exit(1);
  }

  let maxNumber = null;
  if (maxNumberArg !== undefined) {
    maxNumber = parseInt(maxNumberArg, 10);
    if (Number.isNaN(maxNumber) || maxNumber < 0) {
      console.error(`Invalid MAX_NUMBER: "${maxNumberArg}" (must be a non-negative integer)`);
      process.exit(1);
    }
  }

  // Build the Drive client from the service account key
  const keyFileContent = fs.readFileSync(path.resolve(GOOGLE_SERVICE_ACCOUNT_JSON), "utf-8");
  const serviceAccountKey = JSON.parse(keyFileContent);

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccountKey,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  const drive = google.drive({ version: "v3", auth });

  // ── 1. Collect all video files ─────────────────────────────────────────
  console.log(`\n🔍 Scanning Google Drive folder: ${rootFolderId}\n`);
  const allVideos = await collectVideos(drive, rootFolderId);
  console.log(`Found ${allVideos.length} video(s) total in the folder.`);

  if (startAfterIndex > 0) {
    console.log(
      `⏭  Skipping the first ${startAfterIndex} video(s) per START_AFTER_INDEX=${startAfterIndex}.`
    );
  }

  const videos = allVideos.slice(startAfterIndex);
  console.log(`Will attempt ${videos.length} video(s) (indices ${startAfterIndex + 1}–${allVideos.length}).\n`);

  if (videos.length === 0) {
    console.log("Nothing to do. Exiting.");
    return;
  }

  // ── 2. Upload each video via the Stream API ─────────────────────────────
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    const overallIndex = startAfterIndex + i + 1;
    const prefix = `[${overallIndex}/${allVideos.length}]`;

    console.log(`${prefix} ${video.name}`);

    try {
      const alreadyExists = await existsInStream(video.name);
      if (alreadyExists) {
        console.log(`  ⏭  Skipped (a video titled "${video.name}" already exists in this library)\n`);
        skipped++;
        continue;
      }

      console.log(`  ⬇️  Downloading from Drive…`);
      const buffer = await downloadFile(drive, video.id);
      const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(2);
      console.log(`  📦 ${sizeMB} MB`);

      console.log(`  🆕 Creating Stream video object…`);
      const videoId = await createStreamVideo(video.name);

      console.log(`  ⬆️  Uploading to Stream (videoId: ${videoId})…`);
      await uploadStreamVideo(videoId, buffer);

      console.log(`  ✅ Uploaded — videoId: ${videoId}\n`);
      uploaded++;
    } catch (err) {
      console.error(`  ❌ Failed: ${err.message}\n`);
      failed++;
    }
  }

  // ── 3. Summary ────────────────────────────────────────────────────────
  console.log("─".repeat(50));
  console.log(`✅ Uploaded : ${uploaded}`);
  console.log(`⏭  Skipped  : ${skipped}`);
  console.log(`❌ Failed   : ${failed}`);
  console.log(`📁 Attempted: ${videos.length} (of ${allVideos.length} total)`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});