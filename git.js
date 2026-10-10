const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const execFileAsync = promisify(execFile);

function normalizePublicGitUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
  if (!['github.com', 'gitlab.com'].includes(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || parts.some((p) => p === '.' || p === '..')) return null;
  parts[1] = parts[1].replace(/\.git$/i, '');
  if (!parts[0] || !parts[1] || !/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(parts[1])) return null;
  return `https://${url.hostname}/${parts[0]}/${parts[1]}.git`;
}

async function copyStaticTree(source, destination) {
  await fs.promises.mkdir(destination, { recursive: true });
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.env') continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Repository contains a symbolic link; deployment was stopped.');
    if (entry.isDirectory()) {
      await copyStaticTree(from, to);
    } else if (entry.isFile()) {
      await pipeline(fs.createReadStream(from), fs.createWriteStream(to, { flags: 'wx', mode: 0o644 }));
    }
  }
}

async function findSiteRoot(repoDir) {
  try { await fs.promises.access(path.join(repoDir, 'index.html')); return repoDir; } catch {}
  const entries = await fs.promises.readdir(repoDir, { withFileTypes: true });
  const visible = entries.filter((e) => e.name !== '.git' && e.name !== 'README.md' && e.name !== 'LICENSE');
  if (visible.length === 1 && visible[0].isDirectory()) {
    const nested = path.join(repoDir, visible[0].name);
    try { await fs.promises.access(path.join(nested, 'index.html')); return nested; } catch {}
  }
  throw new Error('Repository must contain a static index.html at its root or inside one top-level folder.');
}

async function deployPublicGitRepository(sourceUrl, targetDir) {
  const safeUrl = normalizePublicGitUrl(sourceUrl);
  if (!safeUrl) throw new Error('Enter a valid public GitHub or GitLab repository URL.');
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `thelaunch-${crypto.randomUUID()}-`));
  const cloneDir = path.join(tempDir, 'repo');
  try {
    await execFileAsync('git', ['clone', '--depth', '1', '--no-recurse-submodules', '--', safeUrl, cloneDir], {
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    const siteRoot = await findSiteRoot(cloneDir);
    await fs.promises.mkdir(targetDir, { recursive: true });
    await copyStaticTree(siteRoot, targetDir);
    try { await fs.promises.access(path.join(targetDir, 'index.html')); }
    catch { throw new Error('The repository did not produce a root index.html file.'); }
    return { normalizedUrl: safeUrl.replace(/\.git$/i, '') };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

module.exports = { normalizePublicGitUrl, deployPublicGitRepository };
