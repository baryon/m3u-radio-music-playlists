#!/usr/bin/env node
//
// Zero-dependency static server for dist/.
//
// Opening index.html straight off the filesystem doesn't work: it fetches
// ./file_index.json, and browsers block that under file:// as a cross-origin
// request — which surfaces as the viewer's "Could not load files" screen. So
// the site has to come over HTTP, even locally.

const fs = require("fs");
const http = require("http");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.PORT) || 8080,
    dir: path.join(repoRoot, "dist"),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") opts.port = Number(argv[++i]);
    else if (arg === "--dir" || arg === "-d") opts.dir = path.resolve(repoRoot, argv[++i] || "");
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/serve.js [--port <n>] [--dir <dir>]");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

const { port, dir: rootDir } = parseArgs(process.argv.slice(2));

if (!fs.existsSync(path.join(rootDir, "index.html"))) {
  console.error(`No index.html in ${rootDir}. Run \`npm run build\` first.`);
  process.exit(1);
}

// Playlists are served as text/plain so the viewer's "raw" button opens them in
// a tab instead of triggering a download. Everything the viewer previews needs
// a type the browser understands; anything else falls back to octet-stream.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m3u": "text/plain; charset=utf-8",
  ".m3u8": "text/plain; charset=utf-8",
  ".pls": "text/plain; charset=utf-8",
  ".xspf": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, "Method Not Allowed", { Allow: "GET, HEAD" });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    return send(res, 400, "Bad Request");
  }

  // Resolve first, then confirm the result is still inside rootDir — that
  // catches ../ traversal and encoded variants alike.
  let filePath = path.resolve(rootDir, "." + pathname);
  if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
    return send(res, 403, "Forbidden");
  }

  let stats;
  try {
    stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      stats = fs.statSync(filePath);
    }
  } catch {
    return send(res, 404, "Not Found");
  }

  const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stats.size,
    "Cache-Control": "no-cache",
  });
  if (req.method === "HEAD") return res.end();

  const stream = fs.createReadStream(filePath);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Try: npm run serve -- --port ${port + 1}`);
    process.exit(1);
  }
  throw e;
});

server.listen(port, () => {
  console.log(`Serving ${path.relative(repoRoot, rootDir) || "."}/ at http://localhost:${port}/`);
  console.log("Press Ctrl+C to stop.");
});
