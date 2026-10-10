require('dotenv').config();

const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { extractStaticZip } = require('./services/archive');
const { normalizePublicGitUrl, deployPublicGitRepository } = require('./services/git');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const REPOSITORIES_DIR = path.join(DATA_DIR, 'repositories');
const BUILD_DIR = path.join(DATA_DIR, 'builds');
const DEPLOYMENTS_DIR = path.join(DATA_DIR, 'deployments');
const SITES_DIR = path.join(ROOT, 'public', 'sites');

for (const dir of [DATA_DIR, UPLOAD_DIR, REPOSITORIES_DIR, BUILD_DIR, DEPLOYMENTS_DIR, SITES_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('Set SESSION_SECRET to a random value of at least 32 characters before production deployment.');
}
if (!process.env.SESSION_SECRET) {
  console.warn('WARNING: SESSION_SECRET is not set. Set it in .env before deploying publicly.');
}
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');

const db = new sqlite3.Database(path.join(DATA_DIR, 'site-thelaunch.sqlite'));
function run(sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (err) {
    if (err) reject(err); else resolve({ id: this.lastID, changes: this.changes });
  }));
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}
async function ensureColumn(table, column, definition) {
  const columns = await all(`PRAGMA table_info(${table})`);
  if (!columns.some((item) => item.name === column)) await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
async function initializeDatabase() {
  await run('PRAGMA journal_mode = WAL');
  await run('PRAGMA foreign_keys = ON');
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('upload','git')),
    source_url TEXT,
    original_filename TEXT,
    source_archive_path TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_url TEXT
  )`);
  await ensureColumn('projects', 'source_archive_path', 'TEXT');
  await ensureColumn('projects', 'updated_at', "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
  await run(`CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    published_url TEXT,
    log TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT
  )`);
  await run('CREATE INDEX IF NOT EXISTS idx_projects_user_created ON projects(user_id, created_at)');
  await run('CREATE INDEX IF NOT EXISTS idx_deployments_project_created ON deployments(project_id, created_at)');
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '30kb' }));
app.use(express.urlencoded({ extended: false, limit: '30kb' }));
if (isProduction) app.set('trust proxy', 1);
app.use(session({
  name: 'thelaunch.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR }),
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: 1000 * 60 * 60 * 8 }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
app.use('/api/auth', authLimiter);
app.use('/api/projects/upload', uploadLimiter);

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Please sign in to continue.' });
  next();
}
function safeUser(user) { return { id: user.id, name: user.name, email: user.email }; }
function cleanName(value) { return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 48); }
function validProjectName(name) { return /^[a-zA-Z0-9][a-zA-Z0-9 _-]{1,47}$/.test(name); }
function publicSiteUrl(projectId) {
  const base = String(process.env.PUBLIC_SITE_BASE_URL || '').trim().replace(/\/$/, '');
  return `${base}/sites/${projectId}/`;
}
function projectPath(id) {
  if (!/^[a-f0-9-]{36}$/i.test(String(id))) throw new Error('Invalid project identifier.');
  return path.join(SITES_DIR, id);
}
function safeLog(message) { return String(message || '').slice(0, 5000); }

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}.zip`)
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5, fieldSize: 2000 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.zip') return cb(new Error('Please upload a .zip file containing a static website.'));
    cb(null, true);
  }
});

async function createDeployment(projectId, userId, work) {
  const deploymentId = crypto.randomUUID();
  await run('INSERT INTO deployments (id, project_id, user_id, status, log) VALUES (?, ?, ?, ?, ?)',
    [deploymentId, projectId, userId, 'building', 'Deployment started.']);
  const stageDir = path.join(DEPLOYMENTS_DIR, `${projectId}-${deploymentId}`);
  const finalDir = projectPath(projectId);
  try {
    await fs.promises.rm(stageDir, { recursive: true, force: true });
    await fs.promises.mkdir(stageDir, { recursive: true });
    const result = await work(stageDir);
    await fs.promises.access(path.join(stageDir, 'index.html'));
    const backupDir = path.join(DEPLOYMENTS_DIR, `${projectId}-previous`);
    await fs.promises.rm(backupDir, { recursive: true, force: true });
    try { await fs.promises.rename(finalDir, backupDir); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    try {
      await fs.promises.rename(stageDir, finalDir);
    } catch (err) {
      try { await fs.promises.rename(backupDir, finalDir); } catch {}
      throw err;
    }
    await fs.promises.rm(backupDir, { recursive: true, force: true });
    const url = publicSiteUrl(projectId);
    const log = safeLog(result && result.log ? result.log : 'Static files validated and published successfully.');
    await run('UPDATE deployments SET status = ?, published_url = ?, log = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['live', url, log, deploymentId]);
    await run('UPDATE projects SET status = ?, published_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['live', url, projectId]);
    return { id: deploymentId, status: 'live', published_url: url, log };
  } catch (err) {
    await fs.promises.rm(stageDir, { recursive: true, force: true });
    await run('UPDATE deployments SET status = ?, log = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['failed', safeLog(err.message || 'Deployment failed.'), deploymentId]);
    await run('UPDATE projects SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['failed', projectId]);
    throw err;
  }
}

app.get('/api/config', (_req, res) => res.json({
  platformName: 'Site theLaunch',
  features: { zipUpload: true, publicGitDeploy: true, staticHosting: true },
  maxUploadBytes: 10 * 1024 * 1024
}));

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const name = cleanName(req.body.name);
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (name.length < 2) return res.status(400).json({ error: 'Enter a name with at least 2 characters.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 190) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 10 || password.length > 72) return res.status(400).json({ error: 'Use a password between 10 and 72 characters.' });
    const existing = await get('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });
    const hash = await bcrypt.hash(password, 12);
    const result = await run('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', [name, email, hash]);
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = { id: result.id, name, email };
      req.session.save((saveErr) => saveErr ? next(saveErr) : res.status(201).json({ user: req.session.user }));
    });
  } catch (err) { next(err); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = await get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = safeUser(user);
      req.session.save((saveErr) => saveErr ? next(saveErr) : res.json({ user: req.session.user }));
    });
  } catch (err) { next(err); }
});

app.post('/api/auth/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('thelaunch.sid', { httpOnly: true, sameSite: 'lax', secure: isProduction });
    res.json({ ok: true });
  });
});
app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));

app.get('/api/projects', requireAuth, async (req, res, next) => {
  try {
    const projects = await all(`SELECT id, name, source_type, source_url, original_filename, status, published_url, created_at, updated_at
      FROM projects WHERE user_id = ? ORDER BY created_at DESC`, [req.session.user.id]);
    res.json({ projects });
  } catch (err) { next(err); }
});

app.post('/api/projects/upload', requireAuth, (req, res, next) => {
  upload.single('siteZip')(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message || 'Upload failed.' });
    if (!req.file) return res.status(400).json({ error: 'Choose a ZIP file first.' });
    let id;
    try {
      const name = cleanName(req.body.name);
      if (!validProjectName(name)) return res.status(400).json({ error: 'Project name must be 2–48 characters and start with a letter or number.' });
      id = crypto.randomUUID();
      await run(`INSERT INTO projects (id, user_id, name, source_type, original_filename, source_archive_path, status)
        VALUES (?, ?, ?, 'upload', ?, ?, 'draft')`,
      [id, req.session.user.id, name, path.basename(req.file.originalname).slice(0, 180), req.file.path]);
      const deployment = await createDeployment(id, req.session.user.id, async (stageDir) => {
        await extractStaticZip(req.file.path, stageDir);
        return { log: 'ZIP validated. Static website published.' };
      });
      res.status(201).json({ message: 'Website published successfully.', project: { id, name, source_type: 'upload', status: 'live', published_url: deployment.published_url }, deployment });
    } catch (err) {
      if (!id) await fs.promises.unlink(req.file.path).catch(() => {});
      if (id) console.error('Upload deployment failed:', err.message);
      res.status(400).json({ error: err.message || 'ZIP deployment failed.' });
    }
  });
});

app.post('/api/projects/git', requireAuth, async (req, res, next) => {
  let id;
  try {
    const name = cleanName(req.body.name);
    const sourceUrl = String(req.body.sourceUrl || '').trim();
    const normalizedUrl = normalizePublicGitUrl(sourceUrl);
    if (!validProjectName(name)) return res.status(400).json({ error: 'Project name must be 2–48 characters and start with a letter or number.' });
    if (!normalizedUrl) return res.status(400).json({ error: 'Enter a public GitHub or GitLab repository URL using HTTPS.' });
    id = crypto.randomUUID();
    await run(`INSERT INTO projects (id, user_id, name, source_type, source_url, status)
      VALUES (?, ?, ?, 'git', ?, 'draft')`, [id, req.session.user.id, name, normalizedUrl.replace(/\.git$/i, '')]);
    const deployment = await createDeployment(id, req.session.user.id, async (stageDir) => {
      await deployPublicGitRepository(normalizedUrl, stageDir);
      return { log: `Cloned public repository ${normalizedUrl} and published its static files. Repository build scripts were not executed.` };
    });
    res.status(201).json({ message: 'Repository cloned and static website published.', project: { id, name, source_type: 'git', source_url: normalizedUrl, status: 'live', published_url: deployment.published_url }, deployment });
  } catch (err) {
    if (id) console.error('Git deployment failed:', err.message);
    if (id) return res.status(400).json({ error: err.message || 'Git deployment failed.' });
    next(err);
  }
});

app.get('/api/projects/:id', requireAuth, async (req, res, next) => {
  try {
    const project = await get('SELECT id, name, source_type, source_url, original_filename, status, published_url, created_at, updated_at FROM projects WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    const deployments = await all('SELECT id, status, published_url, log, created_at, finished_at FROM deployments WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 20', [project.id, req.session.user.id]);
    res.json({ project, deployments });
  } catch (err) { next(err); }
});

app.post('/api/projects/:id/deploy', requireAuth, async (req, res, next) => {
  try {
    const project = await get('SELECT * FROM projects WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    let deployment;
    if (project.source_type === 'git' && project.source_url) {
      deployment = await createDeployment(project.id, req.session.user.id, async (stageDir) => {
        await deployPublicGitRepository(project.source_url, stageDir);
        return { log: `Re-deployed from ${project.source_url}. Build scripts were not executed.` };
      });
    } else if (project.source_type === 'upload' && project.source_archive_path && fs.existsSync(project.source_archive_path)) {
      deployment = await createDeployment(project.id, req.session.user.id, async (stageDir) => {
        await extractStaticZip(project.source_archive_path, stageDir);
        return { log: 'Re-deployed from the stored ZIP archive.' };
      });
    } else {
      return res.status(409).json({ error: 'The original source is unavailable. Upload a new ZIP to publish this project.' });
    }
    res.json({ message: 'Deployment completed.', deployment });
  } catch (err) { next(err); }
});

app.delete('/api/projects/:id', requireAuth, async (req, res, next) => {
  try {
    const project = await get('SELECT id, source_archive_path FROM projects WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    await run('DELETE FROM deployments WHERE project_id = ? AND user_id = ?', [project.id, req.session.user.id]);
    await run('DELETE FROM projects WHERE id = ? AND user_id = ?', [project.id, req.session.user.id]);
    await fs.promises.rm(projectPath(project.id), { recursive: true, force: true });
    if (project.source_archive_path) await fs.promises.unlink(project.source_archive_path).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Only published, validated static files are served from this directory.
app.use('/sites', express.static(SITES_DIR, { index: 'index.html', extensions: ['html'], dotfiles: 'deny', fallthrough: true, setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff') }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], dotfiles: 'deny' }));
app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong. Check the server terminal for details.' });
});

initializeDatabase().then(() => {
  app.listen(PORT, () => console.log(`Site theLaunch is running at http://localhost:${PORT}`));
}).catch((err) => {
  console.error('Database initialization failed:', err);
  process.exit(1);
});
