const $ = (selector) => document.querySelector(selector);
const authView = $('#authView');
const dashboardView = $('#dashboardView');
const authForm = $('#authForm');
const authMessage = $('#authMessage');
const createMessage = $('#createMessage');
let authMode = 'login';
let activeSource = 'upload';
let currentUser = null;
let toastTimer;

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}
function setMessage(element, text, success = false) {
  element.textContent = text || '';
  element.classList.toggle('success', Boolean(success));
}
function showToast(message) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}
function setAuthMode(mode) {
  authMode = mode;
  const register = mode === 'register';
  $('#loginTab').classList.toggle('active', !register);
  $('#registerTab').classList.toggle('active', register);
  $('#nameLabel').classList.toggle('hidden', !register);
  $('#nameInput').required = register;
  $('#passwordInput').autocomplete = register ? 'new-password' : 'current-password';
  $('#authTitle').textContent = register ? 'Create your account' : 'Welcome back';
  $('#authDescription').textContent = register ? 'Start building your publishing workspace.' : 'Sign in to continue to your workspace.';
  $('#authSubmit').innerHTML = register ? 'Create account <span>→</span>' : 'Sign in <span>→</span>';
  setMessage(authMessage, '');
}
async function showDashboard(user) {
  currentUser = user;
  authView.classList.add('hidden'); dashboardView.classList.remove('hidden'); $('#logoutBtn').classList.remove('hidden');
  $('#userName').textContent = user.name; $('#userEmail').textContent = user.email; $('#userAvatar').textContent = (user.name || 'U').trim().charAt(0).toUpperCase();
  await loadProjects();
}
function showAuth() {
  currentUser = null; dashboardView.classList.add('hidden'); authView.classList.remove('hidden'); $('#logoutBtn').classList.add('hidden');
}

$('#loginTab').addEventListener('click', () => setAuthMode('login'));
$('#registerTab').addEventListener('click', () => setAuthMode('register'));
authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#authSubmit'); button.disabled = true; setMessage(authMessage, 'Working…');
  const body = { email: $('#emailInput').value.trim(), password: $('#passwordInput').value };
  if (authMode === 'register') body.name = $('#nameInput').value.trim();
  try {
    const result = await api(`/api/auth/${authMode === 'register' ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(body) });
    authForm.reset(); await showDashboard(result.user); showToast(authMode === 'register' ? 'Account created.' : 'Signed in successfully.');
  } catch (error) { setMessage(authMessage, error.message); }
  finally { button.disabled = false; }
});
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); showAuth(); setAuthMode('login'); showToast('You have signed out.'); }
  catch (error) { showToast(error.message); }
});

function setSource(source) {
  activeSource = source;
  document.querySelectorAll('.source-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.source === source));
  $('#uploadForm').classList.toggle('hidden', source !== 'upload');
  $('#gitForm').classList.toggle('hidden', source !== 'git');
  setMessage(createMessage, '');
}
document.querySelectorAll('.source-tab').forEach((tab) => tab.addEventListener('click', () => setSource(tab.dataset.source)));

async function loadProjects() {
  try {
    const { projects } = await api('/api/projects');
    $('#projectCount').textContent = projects.length;
    $('#liveCount').textContent = projects.filter((p) => p.status === 'live').length;
    $('#latestActivity').textContent = projects.length ? new Date(projects[0].updated_at || projects[0].created_at).toLocaleDateString() : '—';
    const list = $('#projectList'); list.replaceChildren();
    if (!projects.length) {
      list.innerHTML = '<div class="empty-state"><span class="empty-icon">▦</span><b>Your workspace is ready</b><p>Create your first project using the form.</p></div>';
      return;
    }
    for (const project of projects) list.appendChild(renderProject(project));
  } catch (error) { showToast(error.message); }
}
function renderProject(project) {
  const item = document.createElement('article'); item.className = 'project-item';
  const icon = document.createElement('div'); icon.className = 'project-icon'; icon.textContent = project.source_type === 'git' ? '⑂' : '▤';
  const main = document.createElement('div'); main.className = 'project-main';
  const title = document.createElement('div'); title.className = 'project-title'; title.textContent = project.name;
  const meta = document.createElement('div'); meta.className = 'project-meta'; meta.textContent = `${project.source_type === 'git' ? 'Git repository' : 'ZIP upload'} · ${new Date(project.created_at).toLocaleDateString()}`;
  main.append(title, meta);
  const actions = document.createElement('div'); actions.className = 'project-actions';
  const status = document.createElement('span'); status.className = `pill ${['live', 'failed', 'draft', 'building'].includes(project.status) ? project.status : 'draft'}`; status.textContent = project.status;
  actions.appendChild(status);
  if (project.status === 'live' && project.published_url) {
    const open = document.createElement('a'); open.className = 'mini-button'; open.href = project.published_url; open.target = '_blank'; open.rel = 'noopener noreferrer'; open.textContent = 'Open site'; actions.appendChild(open);
  }
  const history = document.createElement('button'); history.className = 'mini-button'; history.type = 'button'; history.textContent = 'History'; history.addEventListener('click', () => showDetails(project.id)); actions.appendChild(history);
  const redeploy = document.createElement('button'); redeploy.className = 'mini-button'; redeploy.type = 'button'; redeploy.textContent = 'Redeploy'; redeploy.addEventListener('click', () => redeployProject(project.id)); actions.appendChild(redeploy);
  const remove = document.createElement('button'); remove.className = 'mini-button'; remove.type = 'button'; remove.textContent = 'Delete'; remove.addEventListener('click', () => deleteProject(project.id, project.name)); actions.appendChild(remove);
  item.append(icon, main, actions); return item;
}

$('#uploadForm').addEventListener('submit', async (event) => {
  event.preventDefault(); setMessage(createMessage, 'Uploading and validating your ZIP…');
  const button = $('#uploadForm button[type="submit"]'); button.disabled = true;
  try {
    const form = new FormData(event.currentTarget);
    const result = await api('/api/projects/upload', { method: 'POST', body: form });
    setMessage(createMessage, `${result.message} ${result.project.published_url}`, true); event.currentTarget.reset(); await loadProjects(); showToast('Website published successfully.');
  } catch (error) { setMessage(createMessage, error.message); }
  finally { button.disabled = false; }
});
$('#gitForm').addEventListener('submit', async (event) => {
  event.preventDefault(); setMessage(createMessage, 'Cloning the public repository and validating static files…');
  const button = $('#gitForm button[type="submit"]'); button.disabled = true;
  const form = new FormData(event.currentTarget);
  try {
    const result = await api('/api/projects/git', { method: 'POST', body: JSON.stringify({ name: form.get('name'), sourceUrl: form.get('sourceUrl') }) });
    setMessage(createMessage, `${result.message} ${result.project.published_url}`, true); event.currentTarget.reset(); await loadProjects(); showToast('Git repository published.');
  } catch (error) { setMessage(createMessage, error.message); }
  finally { button.disabled = false; }
});
async function redeployProject(id) {
  if (!confirm('Redeploy this project from its saved source?')) return;
  showToast('Deployment started…');
  try { const result = await api(`/api/projects/${encodeURIComponent(id)}/deploy`, { method: 'POST', body: '{}' }); showToast(result.message); await loadProjects(); await showDetails(id); }
  catch (error) { showToast(error.message); await loadProjects(); }
}
async function deleteProject(id, name) {
  if (!confirm(`Delete “${name}” and its published files? This cannot be undone.`)) return;
  try { await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }); $('#detailsPanel').classList.add('hidden'); await loadProjects(); showToast('Project deleted.'); }
  catch (error) { showToast(error.message); }
}
async function showDetails(id) {
  try {
    const result = await api(`/api/projects/${encodeURIComponent(id)}`);
    $('#detailsTitle').textContent = `${result.project.name} · Deployment history`;
    const list = $('#deploymentList'); list.replaceChildren();
    if (!result.deployments.length) list.innerHTML = '<p class="muted">No deployments recorded yet.</p>';
    for (const deployment of result.deployments) {
      const row = document.createElement('div'); row.className = 'deployment-row';
      const status = document.createElement('span'); status.className = `pill ${deployment.status}`; status.textContent = deployment.status;
      const log = document.createElement('div'); const logText = document.createElement('p'); logText.textContent = deployment.log || 'No log details.'; log.appendChild(logText);
      if (deployment.published_url) { const link = document.createElement('a'); link.href = deployment.published_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open deployment'; link.className = 'mini-button'; log.appendChild(link); }
      const date = document.createElement('time'); date.textContent = new Date(deployment.created_at).toLocaleString(); row.append(status, log, date); list.appendChild(row);
    }
    $('#detailsPanel').classList.remove('hidden'); $('#detailsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { showToast(error.message); }
}
$('#refreshBtn').addEventListener('click', loadProjects);
$('#closeDetails').addEventListener('click', () => $('#detailsPanel').classList.add('hidden'));

(async function boot() {
  try { const result = await api('/api/me'); if (result.user) await showDashboard(result.user); }
  catch { /* The sign-in screen remains available if the session check fails. */ }
})();
