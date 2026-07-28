const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Executable and binary extensions to exclude
const EXECUTABLE_EXTENSIONS = new Set([
  // Windows
  ".exe", ".dll", ".msi", ".com", ".bat", ".cmd", ".scr", ".pif", ".gadget",
  // macOS
  ".app", ".dmg", ".pkg", ".dSYM",
  // Linux
  ".bin", ".run", ".deb", ".rpm", ".snap", ".flatpak", ".appimage",
  // Shared libraries
  ".so", ".dylib", ".a", ".lib", ".ko",
  // Compiled objects
  ".o", ".obj", ".pyc", ".pyo", ".class", ".elf", ".out",
  // Other executables
  ".jar", ".war", ".ear", ".vbs", ".vbe", ".ws", ".wsf", ".msc", ".lnk",
]);

// Directories to skip. "dist" and "scripts" are build output/tooling: neither
// belongs in the browsable index (and indexing dist while building into it
// would make the index describe itself).
const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", ".github", "__pycache__", ".vscode", ".idea",
  ".cache", ".npm", ".yarn", "vendor", ".bundle", "dist", "scripts",
  // Submodules ship their own test suites; their fixture playlists are broken
  // by design and shouldn't show up next to real stations.
  "tests",
  // Derived content, left out of the published site: +merged+ is a
  // recombination of the per-source collections, so every stream in it already
  // appears elsewhere in the repo. At 153 MB / 5878 files it's also the single
  // biggest directory, and dropping it is what keeps the build under the
  // GitHub Pages 1 GB site limit (1118 MB -> 965 MB). Remove this line to
  // publish it again.
  "+merged+",
]);

// Allowlist for directories where only part of the contents is content. A
// submodule is a dependency, not a collection: iptv/ ships a whole toolchain
// (README, tsconfig, linter config, ...) around the playlists, and only the
// playlists belong in the viewer. Keyed by path relative to the repo root;
// anything not listed under that path is skipped, files included.
const INCLUDE_ONLY = new Map([["iptv", new Set(["streams"])]]);

// System/meta files to skip
const EXCLUDED_FILES = new Set([
  "generate_index.js", "file_index.json", ".DS_Store", "Thumbs.db",
  "desktop.ini", ".gitignore", ".gitattributes", "package.json",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  // Whole-repo aggregate playlists — every stream in them is already in the
  // per-genre and per-source lists. Verified duplicates: ---randomized.m3u and
  // ---sorted.m3u are line-for-line the same set as ---everything-lite.m3u
  // (just reordered), and lite is a subset of full.
  "---everything-full.m3u", "---everything-lite.m3u",
  "---randomized.m3u", "---sorted.m3u",
]);

// File type categories
function getFileCategory(filename) {
  const ext = path.extname(filename).toLowerCase();

  const categories = {
    image: [
      ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".svg", ".webp", ".ico",
      ".tiff", ".tif", ".avif", ".heic", ".heif",
    ],
    video: [
      ".mp4", ".webm", ".ogg", ".ogv", ".mov", ".avi", ".mkv", ".m4v",
      ".3gp", ".flv",
    ],
    audio: [
      ".mp3", ".wav", ".ogg", ".oga", ".flac", ".aac", ".m4a", ".wma",
      ".opus", ".aiff",
    ],
    document: [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"],
    code: [
      ".js", ".ts", ".jsx", ".tsx", ".py", ".rb", ".java", ".c", ".cpp",
      ".h", ".hpp", ".cs", ".go", ".rs", ".php", ".swift", ".kt", ".scala",
      ".r", ".m", ".mm", ".pl", ".pm", ".lua", ".sh", ".bash", ".zsh",
      ".fish", ".ps1", ".psm1", ".vue", ".svelte", ".elm", ".clj", ".cljs",
      ".ex", ".exs", ".erl", ".hrl", ".hs", ".fs", ".fsx", ".ml", ".mli",
      ".nim", ".cr", ".v", ".zig", ".d", ".pas", ".pp", ".asm", ".s",
      ".sql", ".graphql", ".gql",
    ],
    markup: [
      ".html", ".htm", ".xml", ".xhtml", ".xaml", ".svg", ".wxml", ".jsp",
      ".asp", ".aspx", ".erb", ".ejs", ".haml", ".slim", ".pug", ".jade",
      ".twig", ".blade.php", ".hbs", ".mustache", ".njk", ".liquid",
    ],
    style: [".css", ".scss", ".sass", ".less", ".styl", ".stylus", ".postcss"],
    data: [
      ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
      ".properties", ".env", ".csv", ".tsv", ".xml",
      // Playlist files (plain text)
      ".m3u", ".m3u8", ".pls", ".xspf", ".wpl", ".asx", ".cue",
    ],
    text: [
      ".txt", ".md", ".markdown", ".rst", ".rtf", ".log", ".nfo", ".diz",
      ".srt", ".vtt", ".sub", ".ass", ".ssa", // Subtitle files
    ],
    font: [".ttf", ".otf", ".woff", ".woff2", ".eot"],
    archive: [
      ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".tgz", ".tbz2",
    ],
  };

  for (const [category, extensions] of Object.entries(categories)) {
    if (extensions.includes(ext)) return category;
  }

  return "other";
}

// Check if file is binary/executable
function isExecutable(filename) {
  const ext = path.extname(filename).toLowerCase();
  return EXECUTABLE_EXTENSIONS.has(ext);
}

// Get human-readable file size
function formatSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// A fresh `actions/checkout` (or any fresh clone) writes every file to disk at
// checkout time, so fs.statSync(...).mtime is the same for every file
// regardless of when it was actually last changed — that's why date/time
// sorting looked broken. The real "last modified" date lives in git history
// instead, so we build a path -> last-commit-date map from it once, up front.
//
// `git log --name-only` walks commits newest-first and lists every path each
// commit touched, so the first time we see a given path is its most recent
// commit. That gives us the whole repo's per-file last-modified dates in a
// single git invocation instead of one process per file.
//
// core.quotepath=false matters: by default git quotes/escapes any path with
// non-ASCII characters (e.g. accented station names) as octal-escaped bytes
// like "Radio Ca\303\261\303\263n.m3u" instead of the real UTF-8 filename,
// which then never matches itemRelativePath and silently falls back to the
// checkout-time mtime for every such file.
function collectDates(map, cwd, prefix = "") {
  try {
    const output = execSync(
      'git -c core.quotepath=false log --name-only --no-renames --format="%x01%cI"',
      { encoding: "utf8", cwd, maxBuffer: 1024 * 1024 * 256, stdio: ["ignore", "pipe", "ignore"] }
    );
    let currentDate = null;
    for (const rawLine of output.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      if (rawLine.startsWith("\x01")) {
        currentDate = rawLine.slice(1).trim();
      } else {
        const key = prefix ? `${prefix}/${line}` : line;
        if (currentDate && !map.has(key)) map.set(key, currentDate);
      }
    }
  } catch (e) {
    console.warn(
      `Could not read git history for file dates in ${cwd} (falling back to filesystem mtime):`,
      e.message
    );
  }
}

// Submodules (e.g. iptv/) have their own history — the superproject's log only
// records the pointer commit, not the files inside — so each one is walked in
// its own working directory and its paths prefixed to match the index. A
// shallow submodule only has its tip commit, so every file in it shares that
// one date until someone runs `git -C <path> fetch --unshallow`.
function listSubmodulePaths() {
  try {
    const output = execSync("git config --file .gitmodules --get-regexp path", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[1])
      .filter(Boolean);
  } catch {
    return []; // no .gitmodules, or not a git repo at all
  }
}

function buildFileDateMap() {
  const map = new Map();
  collectDates(map, ".");
  for (const submodulePath of listSubmodulePaths()) {
    if (fs.existsSync(path.join(submodulePath, ".git"))) {
      collectDates(map, submodulePath, submodulePath);
    }
  }
  return map;
}

// Built once per generateIndex() run rather than at import time, so requiring
// this module (scripts/build.js does) doesn't shell out to git as a side effect.
let fileDateMap = new Map();

// Recursively scan directory
function scanDirectory(dir, relativePath = "") {
  const entries = [];

  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      const itemRelativePath = relativePath
        ? `${relativePath}/${item.name}`
        : item.name;

      const allowedHere = INCLUDE_ONLY.get(relativePath);
      if (allowedHere && !allowedHere.has(item.name)) continue;

      if (item.isDirectory()) {
        if (EXCLUDED_DIRS.has(item.name) || item.name.startsWith(".")) {
          continue;
        }

        const children = scanDirectory(fullPath, itemRelativePath);
        if (children.length > 0) {
          // A folder's "modified" date is the most recent modification among
          // everything inside it (recursively), since git doesn't track
          // directories directly.
          let latest = null;
          for (const child of children) {
            if (child.modified && (!latest || child.modified > latest)) {
              latest = child.modified;
            }
          }
          entries.push({
            name: item.name,
            path: itemRelativePath,
            type: "directory",
            children: children,
            modified: latest,
          });
        }
        continue;
      }

      if (EXCLUDED_FILES.has(item.name)) continue;
      if (item.name.startsWith(".")) continue;
      if (isExecutable(item.name)) continue;

      try {
        const stats = fs.statSync(fullPath);
        const category = getFileCategory(item.name);
        const modified =
          fileDateMap.get(itemRelativePath) || stats.mtime.toISOString();

        entries.push({
          name: item.name,
          path: itemRelativePath,
          type: "file",
          category: category,
          extension: path.extname(item.name).toLowerCase(),
          size: stats.size,
          sizeFormatted: formatSize(stats.size),
          modified: modified,
        });
      } catch (e) {
        console.warn(`Could not stat file: ${fullPath}`);
      }
    }
  } catch (e) {
    console.warn(`Could not read directory: ${dir}`);
  }

  entries.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return entries;
}

function countItems(items) {
  let files = 0, dirs = 0;
  for (const item of items) {
    if (item.type === "directory") {
      dirs++;
      const counts = countItems(item.children);
      files += counts.files;
      dirs += counts.dirs;
    } else {
      files++;
    }
  }
  return { files, dirs };
}

// Scans `root` and returns the index object. `outFile` (when given) is where
// the JSON is written; pass null to only get the object back — scripts/build.js
// scans the repo but writes the JSON into dist/.
//
// Note that `root` must be the git repo root for the date map to line up: its
// keys are repo-relative paths, and so are the index's.
function generateIndex({ root = ".", outFile = "file_index.json", quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;
  log("Scanning repository...");
  const startTime = Date.now();

  fileDateMap = buildFileDateMap();

  const index = {
    generated: new Date().toISOString(),
    root: scanDirectory(root),
  };
  index.stats = countItems(index.root);

  if (outFile) fs.writeFileSync(outFile, JSON.stringify(index));

  log(
    `Done in ${Date.now() - startTime}ms. Found ${index.stats.files} files in ${index.stats.dirs} directories.`
  );
  return index;
}

if (require.main === module) generateIndex();

module.exports = { generateIndex, getFileCategory, formatSize, EXCLUDED_DIRS, EXCLUDED_FILES };