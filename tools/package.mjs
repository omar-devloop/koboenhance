/**
 * tools/package.mjs — builds the Chrome Web Store upload zip.
 *
 * Only the files the extension actually loads reach the zip: the manifest, its
 * service worker, every declared content script, the icons and the popup (plus
 * any script the popup HTML references). A stray .js elsewhere in the repo is
 * not shipped. TypeScript sources, docs, any CSV export of a real account and
 * the build scripts can never ship.
 *
 * Usage:
 *   npm run package          (build first, then package)
 *   node tools/package.mjs   (package the current build)
 *
 * Produces dist/KoboEnhance-<version>.zip.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZipArchive } from "archiver";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, "dist");
const stageDir = path.join(distDir, "stage");

/** Directories that can never contribute a shipped file. */
const SKIP_DIRS = new Set(["dist", "node_modules", ".git", ".github", ".vscode", ".idea"]);

/** Extensions that must never appear in the package. */
const FORBIDDEN_EXT = new Set([".ts", ".md", ".csv", ".ps1", ".map"]);

function walk(dir, relDir = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function fail(message) {
  console.error(`\npackage: ${message}\n`);
  process.exit(1);
}

if (!fs.existsSync(path.join(root, "manifest.json"))) fail("manifest.json not found");

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const version = String(manifest.version || "");
if (!version) fail("manifest.json has no version");
if (!/^\d+(\.\d+){0,3}$/.test(version)) {
  fail(`manifest version "${version}" is not a Chrome version (1-4 dot-separated integers)`);
}

const pkgPath = path.join(root, "package.json");
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (String(pkg.version) !== version) {
    fail(`version mismatch: manifest ${version} vs package.json ${pkg.version}`);
  }
}

// ------------------------------------------------------------- required ----
const required = new Set(["manifest.json"]);

/** Manifest paths are repo-relative; refuse anything that could escape it. */
function addRequired(rel) {
  const clean = path.posix.normalize(String(rel).replace(/\\/g, "/"));
  if (clean.startsWith("/") || clean === ".." || clean.startsWith("../")) {
    fail(`unsafe manifest path: ${rel}`);
  }
  required.add(clean);
}

if (manifest.background?.service_worker) addRequired(manifest.background.service_worker);

const popup = manifest.action?.default_popup ? String(manifest.action.default_popup) : "";
if (popup) {
  addRequired(popup);
  const popupFile = path.join(root, popup);
  if (fs.existsSync(popupFile)) {
    const html = fs.readFileSync(popupFile, "utf8");
    const srcRe = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
    for (const match of html.matchAll(srcRe)) {
      const src = match[1];
      if (/^(https?:)?\/\//i.test(src)) fail(`popup loads a remote script: ${src}`);
      addRequired(path.posix.join(path.posix.dirname(popup), src));
    }
  }
}

for (const entry of manifest.content_scripts || []) {
  for (const file of entry.js || []) addRequired(file);
}
for (const icon of Object.values(manifest.icons || {})) addRequired(icon);

const missing = [...required].filter((rel) => !fs.existsSync(path.join(root, rel))).sort();
if (missing.length) fail(`package is missing manifest paths: ${missing.join(", ")}`);

// ---------------------------------------------------------------- stage ----
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

for (const rel of [...required].sort()) {
  const to = path.join(stageDir, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(root, rel), to);
}

// ------------------------------------------------------------- forbidden ---
const forbidden = walk(stageDir).filter((rel) => FORBIDDEN_EXT.has(path.posix.extname(rel).toLowerCase()));
if (forbidden.length) fail(`unexpected files in package: ${forbidden.join(", ")}`);

// ------------------------------------------------------------------ zip ----
fs.mkdirSync(distDir, { recursive: true });
const zipPath = path.join(distDir, `KoboEnhance-${version}.zip`);
fs.rmSync(zipPath, { force: true });

const files = walk(stageDir);
await new Promise((resolve, reject) => {
  const output = fs.createWriteStream(zipPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  output.on("close", resolve);
  output.on("error", reject);
  archive.on("warning", (err) => (err.code === "ENOENT" ? console.warn("package:", err.message) : reject(err)));
  archive.on("error", reject);
  archive.pipe(output);
  // One entry per file: no directory records, so the archive is exactly the
  // manifest's paths plus the popup assets.
  for (const rel of files) archive.file(path.join(stageDir, rel), { name: rel });
  archive.finalize();
});
const kb = fs.statSync(zipPath).size / 1024;
console.log("");
console.log(`Packaged KoboEnhance ${version}`);
console.log(`  files: ${files.length}`);
console.log(`  size:  ${Math.round(kb)} KB`);
console.log(`  zip:   ${zipPath}`);
console.log("");
console.log("Upload this zip at https://chrome.google.com/webstore/devconsole");
