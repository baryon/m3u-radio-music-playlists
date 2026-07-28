#!/usr/bin/env node
//
// Builds the static site into dist/.
//
// The file viewer (index.html) fetches ./file_index.json and then opens each
// entry by its relative path (`./${item.path}`), so a working site is just:
// the viewer, the index, and every indexed file sitting at the path the index
// claims it's at. That's what this produces.
//
// The index is generated from the repo (not from dist) because file dates come
// from `git log`, which only works inside the repository. dist is then filled
// from that same index, so the two can't drift: every file in dist is in the
// index, and every file in the index is in dist.
//
// Files are hard-linked rather than copied — the tree is ~114k files and well
// over a gigabyte, and hard links make the build near-instant and free on disk.
// Playlists are never modified in place by anything here, so sharing inodes
// with the working tree is safe. Use --copy if you need a standalone dist you
// can move to another filesystem (rsync/scp follow links, so this mostly
// matters for `mv`).

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
process.chdir(repoRoot); // generate_index.js scans "." and shells out to git

const { generateIndex } = require("../generate_index.js");

function parseArgs(argv) {
  const opts = { copy: false, out: path.join(repoRoot, "dist") };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--copy") opts.copy = true;
    else if (arg === "--out") opts.out = path.resolve(repoRoot, argv[++i] || "");
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/build.js [--out <dir>] [--copy]");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

const { copy: forceCopy, out: distDir } = parseArgs(process.argv.slice(2));

// Refuse to touch anything that isn't a directory we can own outright, so a
// stray `--out .` can't wipe the repo.
if (distDir === repoRoot || !distDir.startsWith(repoRoot + path.sep)) {
  console.error(`Refusing to build into ${distDir} — pick a directory inside the repo.`);
  process.exit(1);
}

console.log(`Building into ${path.relative(repoRoot, distDir)}/`);
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

const index = generateIndex({ root: ".", outFile: null });

let linked = 0;
let copied = 0;
let failed = 0;
let bytes = 0;

// One hard link per file, falling back to a real copy when the filesystem
// won't have it (cross-device, permissions, or a filesystem without links).
function placeFile(src, dest, size) {
  if (!forceCopy) {
    try {
      fs.linkSync(src, dest);
      linked++;
      bytes += size || 0;
      return;
    } catch (e) {
      if (!["EXDEV", "EPERM", "EMLINK", "ENOSYS", "EACCES"].includes(e.code)) throw e;
    }
  }
  try {
    fs.copyFileSync(src, dest);
    copied++;
    bytes += size || 0;
  } catch (e) {
    failed++;
    console.warn(`Could not place ${path.relative(repoRoot, src)}: ${e.message}`);
  }
}

// Directories the viewer loads but that aren't browsable content, so they're
// deliberately kept out of the index (vendor/ is in EXCLUDED_DIRS) and won't be
// picked up by the index-driven mirror below. They still have to reach dist or
// the page breaks — hls.min.js in particular.
const SITE_ASSETS = ["vendor"];

function mirrorAssetDir(relDir) {
  const srcDir = path.join(repoRoot, relDir);
  if (!fs.existsSync(srcDir)) {
    console.warn(`Asset directory ${relDir}/ is missing — skipping.`);
    return;
  }
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(path.join(distDir, rel), { recursive: true });
      mirrorAssetDir(rel);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.join(distDir, relDir), { recursive: true });
      placeFile(path.join(repoRoot, rel), path.join(distDir, rel), fs.statSync(path.join(repoRoot, rel)).size);
    }
  }
}

function mirror(items) {
  for (const item of items) {
    const src = path.join(repoRoot, item.path);
    const dest = path.join(distDir, item.path);
    if (item.type === "directory") {
      fs.mkdirSync(dest, { recursive: true });
      mirror(item.children);
    } else {
      placeFile(src, dest, item.size);
      const done = linked + copied;
      if (done % 25000 === 0) console.log(`  ${done} files...`);
    }
  }
}

const mirrorStart = Date.now();
mirror(index.root);
for (const asset of SITE_ASSETS) mirrorAssetDir(asset);

fs.writeFileSync(path.join(distDir, "file_index.json"), JSON.stringify(index));

// The player calls into hls.js for every .m3u8 stream, and the iptv playlists
// are all .m3u8 — a dist without it is a dist that can't play them.
if (!fs.existsSync(path.join(distDir, "vendor/hls.min.js"))) {
  console.error("vendor/hls.min.js is missing from dist — HLS streams will not play.");
  process.exit(1);
}

// index.html is itself an indexed file, so the mirror above already placed it.
// If that ever stops being true the site is broken, so check rather than assume.
if (!fs.existsSync(path.join(distDir, "index.html"))) {
  console.error("index.html is missing from dist — the viewer will not load.");
  process.exit(1);
}

const mb = (bytes / 1024 ** 2).toFixed(1);
console.log(
  `Placed ${linked + copied} files (${linked} linked, ${copied} copied, ${mb} MB) in ${Date.now() - mirrorStart}ms.`
);
if (failed) console.log(`${failed} file(s) could not be placed.`);
console.log(`Done. Serve it with: npm run serve`);
