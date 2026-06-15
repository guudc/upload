/**
 * listBunnyVideos.js
 *
 * Fetches all videos from Bunny.net under Academy/Video/Lessons
 * and writes them to videos.json as a numbered list.
 *
 * Usage:
 *   node listBunnyVideos.js
 *
 * Output: videos.json
 */

const fs = require("fs");

// ─── Configuration — fill these in ───────────────────────────────────────────

const BUNNY_STORAGE_ZONE="requiza"
const BUNNY_API_KEY="f0e2696b-46ca-4cab-982ca8445e4a-02c8-4c87"
const BUNNY_HOSTNAME="storage.bunnycdn.com"
const BUNNY_CDN_URL="https://requiza.b-cdn.net"

const BUNNY_FOLDER = "Academy/Video/Lessons";

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const url = `https://${BUNNY_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${BUNNY_FOLDER}/`;

  console.log(`\n🔍 Listing files in: ${url}\n`);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      AccessKey: BUNNY_API_KEY,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Bunny.net list failed [${response.status}]: ${body}`);
  }

  const files = await response.json();

  const VIDEO_EXTENSIONS = new Set([
    ".mp4", ".mov", ".avi", ".mkv", ".webm",
    ".mpeg", ".mpg", ".ogg", ".3gp", ".flv", ".wmv",
  ]);

  const videos = files
    .filter((file) => {
      const ext = file.ObjectName.slice(file.ObjectName.lastIndexOf(".")).toLowerCase();
      return !file.IsDirectory && VIDEO_EXTENSIONS.has(ext);
    })
    .map((file) => {
      // Extract the first number found in the filename e.g. "lesson-3.mp4" → 3
      const match = file.ObjectName.match(/(\d+)/);
      const number = match ? parseInt(match[1], 10) : null;
      return {
        number,
        name: file.ObjectName,
        url: `${BUNNY_CDN_URL}/${BUNNY_FOLDER}/${file.ObjectName}`,
        size_mb: (file.Length / 1024 / 1024).toFixed(2),
      };
    })
    .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));

  // Build output keyed by the number extracted from the filename
  const output = {};
  for (const video of videos) {
    const key = video.number ?? video.name;
    output[key] = {
      name: video.name,
      url: video.url,
      size_mb: video.size_mb,
    };
  }

  const outputPath = "videos.json";
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");

  console.log(`✅ Found ${videos.length} video(s). Saved to ${outputPath}\n`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});