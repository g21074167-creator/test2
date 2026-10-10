const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const { pipeline } = require('stream/promises');

const MAX_ENTRIES = 2000;
const MAX_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024;
const MAX_FILE_SIZE = 25 * 1024 * 1024;

function safeArchivePath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0')) return null;
  const normalized = rawPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.')) return null;
  const cleaned = path.posix.normalize(normalized);
  if (!cleaned || cleaned === '.' || cleaned.startsWith('../')) return null;
  return cleaned;
}

function resolveInside(root, relative) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...relative.split('/'));
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Archive contains an unsafe file path.');
  }
  return target;
}

async function flattenSingleFolder(targetDir) {
  const items = await fs.promises.readdir(targetDir, { withFileTypes: true });
  if (items.length !== 1 || !items[0].isDirectory()) return;
  const nested = path.join(targetDir, items[0].name);
  try {
    await fs.promises.access(path.join(nested, 'index.html'));
  } catch {
    return;
  }
  for (const item of await fs.promises.readdir(nested)) {
    await fs.promises.rename(path.join(nested, item), path.join(targetDir, item));
  }
  await fs.promises.rmdir(nested);
}

async function extractStaticZip(zipPath, targetDir) {
  const directory = await unzipper.Open.file(zipPath);
  if (!directory.files.length || directory.files.length > MAX_ENTRIES) {
    throw new Error(`ZIP must contain between 1 and ${MAX_ENTRIES} entries.`);
  }
  let totalSize = 0;
  for (const entry of directory.files) {
    const safePath = safeArchivePath(entry.path);
    if (!safePath) throw new Error('ZIP contains an unsafe file path.');
    if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
      throw new Error('ZIP files containing symbolic links are not accepted.');
    }
    const size = Number(entry.uncompressedSize || 0);
    totalSize += size;
    if (size > MAX_FILE_SIZE || totalSize > MAX_TOTAL_UNCOMPRESSED) {
      throw new Error('ZIP exceeds the allowed extracted size limits.');
    }
  }

  await fs.promises.mkdir(targetDir, { recursive: true });
  for (const entry of directory.files) {
    const safePath = safeArchivePath(entry.path);
    const outputPath = resolveInside(targetDir, safePath);
    if (entry.type === 'Directory' || safePath.endsWith('/')) {
      await fs.promises.mkdir(outputPath, { recursive: true });
      continue;
    }
    if (entry.type !== 'File') continue;
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await pipeline(entry.stream(), fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o644 }));
  }

  await flattenSingleFolder(targetDir);
  try {
    await fs.promises.access(path.join(targetDir, 'index.html'));
  } catch {
    throw new Error('ZIP must contain an index.html at its root (or inside one top-level folder).');
  }
}

module.exports = { extractStaticZip };
