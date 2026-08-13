// ---------- 状态 ----------
let pages = [];
let groups = [];
let activeId = null;
let editingId = null; // null 表示新建模式
let deletingId = null;
let currentType = 'link'; // 弹窗中当前选择的页面类型
let mdEditing = false; // 是否处于 Markdown 右侧编辑模式
let currentView = 'welcome'; // welcome | page | settings

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const pageList = $('pageList');
const mainFrame = $('mainFrame');
const loadingMask = $('loadingMask');
const iframeWrap = $('iframeWrap');
const mdView = $('mdView');
const mdBody = $('mdBody');
const mdEditor = $('mdEditor');
const welcomeView = $('welcomeView');
const settingsView = $('settingsView');
const groupList = $('groupList');
const groupError = $('groupError');
const newGroupName = $('newGroupName');
const reloadBtn = $('reloadBtn');
const editToggleBtn = $('editToggleBtn');
const editCancelBtn = $('editCancelBtn');
const editSaveBtn = $('editSaveBtn');
const topbarIcon = $('topbarIcon');
const topbarName = $('topbarName');
const openExternalBtn = $('openExternalBtn');

const modalOverlay = $('modalOverlay');
const confirmOverlay = $('confirmOverlay');
const formError = $('formError');
const toast = $('toast');

// ---------- API ----------
async function api(path, options = {}) {
  const res = await fetch('/api/pages' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

async function groupsApi(path = '', options = {}) {
  const res = await fetch('/api/groups' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

// ---------- 渲染 ----------
function renderSidebar() {
  pageList.innerHTML = '';
  $('settingsEntry').classList.toggle('active', currentView === 'settings');

  if (pages.length === 0) return;

  // 按分组聚合，保持出现顺序
  const groupMap = new Map();
  for (const p of pages) {
    const g = p.group || '未分组';
    if (!groupMap.has(g)) groupMap.set(g, []);
    groupMap.get(g).push(p);
  }

  for (const [groupName, items] of groupMap) {
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = groupName;
    pageList.appendChild(title);

    for (const p of items) {
      const item = document.createElement('div');
      item.className = 'page-item' + (p.id === activeId ? ' active' : '');
      item.innerHTML = `
        <span class="item-icon">${escapeHtml(p.icon || (p.type === 'markdown' ? '📝' : '🔗'))}</span>
        <span class="item-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
        <span class="item-type-badge">${p.type === 'markdown' ? 'MD' : ''}</span>
        <span class="item-actions">
          <button class="edit" title="编辑">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          </button>
          <button class="del" title="删除">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </span>`;

      item.addEventListener('click', () => selectPage(p.id));
      item.querySelector('.edit').addEventListener('click', e => {
        e.stopPropagation();
        if (!confirmDiscardIfEditing()) return;
        openModal(p);
      });
      item.querySelector('.del').addEventListener('click', e => {
        e.stopPropagation();
        if (!confirmDiscardIfEditing()) return;
        openConfirm(p);
      });
      pageList.appendChild(item);
    }
  }
}

function selectPage(id) {
  if (id === activeId && !mdEditing && currentView === 'page') return;
  if (!confirmDiscardIfEditing()) return;
  const page = pages.find(p => p.id === id);
  if (!page) return;
  activeId = id;
  renderSidebar();
  showPage(page);
}

// 根据页面类型切换右侧展示：link → iframe，markdown → 渲染文档
function showPage(page) {
  currentView = 'page';
  welcomeView.classList.add('hidden');
  settingsView.classList.add('hidden');
  reloadBtn.classList.remove('hidden');
  topbarIcon.textContent = page.icon || (page.type === 'markdown' ? '📝' : '🔗');
  topbarName.textContent = page.name;

  if (page.type === 'markdown') {
    iframeWrap.classList.add('hidden');
    mdView.classList.remove('hidden');
    loadingMask.classList.add('fade-out');
    openExternalBtn.classList.add('hidden');
    exitMdEdit();
    editToggleBtn.classList.remove('hidden');
    renderMarkdown(page);
  } else {
    mdView.classList.add('hidden');
    iframeWrap.classList.remove('hidden');
    openExternalBtn.classList.remove('hidden');
    editToggleBtn.classList.add('hidden');
    exitMdEdit();
    openExternalBtn.href = page.url;
    loadingMask.classList.remove('fade-out');
    // 配置了 Basic Auth 的页面走本地反向代理，由服务端自动携带认证头
    mainFrame.src = page.auth ? '/proxy/' + page.id + '/' : page.url;
  }
}

function renderMarkdown(page) {
  mdBody.innerHTML = marked.parse(page.content || '');
  mdView.scrollTop = 0;
}

// ---------- 欢迎页 / 设置页 ----------
function showWelcome() {
  currentView = 'welcome';
  activeId = null;
  exitMdEdit();
  iframeWrap.classList.add('hidden');
  mdView.classList.add('hidden');
  settingsView.classList.add('hidden');
  welcomeView.classList.remove('hidden');
  loadingMask.classList.add('fade-out');
  topbarIcon.textContent = '👋';
  topbarName.textContent = '欢迎';
  reloadBtn.classList.add('hidden');
  openExternalBtn.classList.add('hidden');
  editToggleBtn.classList.add('hidden');
  renderSidebar();
}

function showSettings() {
  if (!confirmDiscardIfEditing()) return;
  currentView = 'settings';
  activeId = null;
  exitMdEdit();
  iframeWrap.classList.add('hidden');
  mdView.classList.add('hidden');
  welcomeView.classList.add('hidden');
  settingsView.classList.remove('hidden');
  topbarIcon.textContent = '⚙️';
  topbarName.textContent = '设置';
  reloadBtn.classList.add('hidden');
  openExternalBtn.classList.add('hidden');
  editToggleBtn.classList.add('hidden');
  groupError.classList.add('hidden');
  renderGroupList();
  renderSidebar();
}

$('settingsEntry').addEventListener('click', showSettings);
$('welcomeNewBtn').addEventListener('click', () => openModal());
$('welcomeSettingsBtn').addEventListener('click', showSettings);

// ---------- 分组管理（设置页） ----------
function renderGroupList() {
  groupList.innerHTML = '';
  if (groups.length === 0) {
    const li = document.createElement('li');
    li.className = 'group-empty';
    li.textContent = '暂无分组，请在上方添加';
    groupList.appendChild(li);
    return;
  }
  for (const g of groups) {
    const count = pages.filter(p => p.group === g).length;
    const li = document.createElement('li');
    li.className = 'group-item';
    li.innerHTML = `
      <span class="group-name">${escapeHtml(g)}</span>
      <span class="group-count">${count} 个页面</span>
      <button class="group-del" title="删除分组">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>`;
    li.querySelector('.group-del').addEventListener('click', () => deleteGroup(g, count));
    groupList.appendChild(li);
  }
}

async function addGroup() {
  const name = newGroupName.value.trim();
  groupError.classList.add('hidden');
  if (!name) {
    groupError.textContent = '分组名称不能为空';
    groupError.classList.remove('hidden');
    return;
  }
  try {
    groups = await groupsApi('', { method: 'POST', body: JSON.stringify({ name }) });
    newGroupName.value = '';
    renderGroupList();
    showToast('分组已添加');
  } catch (err) {
    groupError.textContent = err.message;
    groupError.classList.remove('hidden');
  }
}

async function deleteGroup(name, count) {
  const hint = count > 0 ? `，其下 ${count} 个页面将移至「未分组」` : '';
  if (!confirm(`确定要删除分组「${name}」吗${hint}？`)) return;
  try {
    groups = await groupsApi('/' + encodeURIComponent(name), { method: 'DELETE' });
    pages = await api(''); // 页面分组可能已变更
    renderGroupList();
    renderSidebar();
    showToast('分组已删除');
  } catch (err) {
    showToast(err.message);
  }
}

$('addGroupBtn').addEventListener('click', addGroup);
newGroupName.addEventListener('keydown', e => {
  if (e.key === 'Enter') addGroup();
});

// ---------- Markdown 右侧原地编辑 ----------
function enterMdEdit() {
  const page = pages.find(p => p.id === activeId);
  if (!page || page.type !== 'markdown') return;
  mdEditing = true;
  mdEditor.value = page.content || '';
  mdBody.classList.add('hidden');
  mdEditor.classList.remove('hidden');
  editToggleBtn.classList.add('hidden');
  editCancelBtn.classList.remove('hidden');
  editSaveBtn.classList.remove('hidden');
  mdView.classList.add('editing');
  mdView.scrollTop = 0;
  mdEditor.focus();
}

function exitMdEdit() {
  mdEditing = false;
  mdEditor.classList.add('hidden');
  mdBody.classList.remove('hidden');
  editCancelBtn.classList.add('hidden');
  editSaveBtn.classList.add('hidden');
  mdView.classList.remove('editing');
}

function isMdDirty() {
  const page = pages.find(p => p.id === activeId);
  return mdEditing && page && mdEditor.value !== (page.content || '');
}

// 编辑中离开页面前的丢弃确认，返回 true 表示可以继续
function confirmDiscardIfEditing() {
  if (!isMdDirty()) return true;
  return confirm('文档内容尚未保存，确定要离开吗？');
}

async function saveMdEdit() {
  const page = pages.find(p => p.id === activeId);
  if (!page) return;
  const content = mdEditor.value;
  if (!content.trim()) {
    showToast('Markdown 内容不能为空');
    return;
  }
  editSaveBtn.disabled = true;
  try {
    const updated = await api('/' + page.id, {
      method: 'PUT',
      body: JSON.stringify({ content })
    });
    Object.assign(page, updated);
    exitMdEdit();
    editToggleBtn.classList.remove('hidden');
    renderMarkdown(page);
    showToast('文档已保存');
  } catch (err) {
    showToast(err.message);
  } finally {
    editSaveBtn.disabled = false;
  }
}

editToggleBtn.addEventListener('click', enterMdEdit);
editCancelBtn.addEventListener('click', () => {
  if (!confirmDiscardIfEditing()) return;
  exitMdEdit();
  editToggleBtn.classList.remove('hidden');
});
editSaveBtn.addEventListener('click', saveMdEdit);

// 编辑模式下 Ctrl+S 保存
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && mdEditing) {
    e.preventDefault();
    saveMdEdit();
  }
});

mainFrame.addEventListener('load', () => {
  loadingMask.classList.add('fade-out');
});

// ---------- 弹窗：新增 / 编辑 ----------
function setType(type) {
  currentType = type;
  document.querySelectorAll('.type-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
  const isLink = type === 'link';
  $('urlField').classList.toggle('hidden', !isLink);
  $('authField').classList.toggle('hidden', !isLink);
  $('fieldUrl').required = isLink;
  // markdown 页面的正文统一在右侧原地编辑，弹窗不提供内容输入
}

document.querySelectorAll('.type-opt').forEach(btn => {
  btn.addEventListener('click', () => setType(btn.dataset.type));
});

// 认证开关：勾选后展开认证配置区
$('authEnabled').addEventListener('change', () => {
  $('authBox').classList.toggle('hidden', !$('authEnabled').checked);
});

// 认证模式切换：basic/login 显示账号密码，header 显示自定义头，login 额外显示登录路径
function setAuthMode(mode) {
  $('authMode').value = mode;
  $('authUserPass').classList.toggle('hidden', mode === 'header');
  $('authLoginPath').classList.toggle('hidden', mode !== 'login');
  $('authHeaderInputs').classList.toggle('hidden', mode !== 'header');
}
$('authMode').addEventListener('change', () => setAuthMode($('authMode').value));

// 填充分组下拉：已配置分组 + 当前页面分组（防止失效）+ 未分组
function fillGroupSelect(selected) {
  const opts = [...groups];
  if (selected && !opts.includes(selected)) opts.push(selected);
  if (!opts.includes('未分组')) opts.push('未分组');
  $('fieldGroup').innerHTML = opts
    .map(g => `<option value="${escapeHtml(g)}"${g === selected ? ' selected' : ''}>${escapeHtml(g)}</option>`)
    .join('');
}

function openModal(page = null) {
  editingId = page ? page.id : null;
  $('modalTitle').textContent = page ? '编辑页面' : '新建页面';
  $('fieldName').value = page ? page.name : '';
  $('fieldUrl').value = page && page.type !== 'markdown' ? page.url : '';
  $('fieldIcon').value = page ? page.icon : '';
  const hasAuth = !!(page && page.auth);
  $('authEnabled').checked = hasAuth;
  $('authBox').classList.toggle('hidden', !hasAuth);
  const mode = hasAuth ? (page.auth.mode || 'basic') : 'basic';
  setAuthMode(mode);
  $('authUser').value = hasAuth ? (page.auth.username || '') : '';
  $('authPass').value = hasAuth ? (page.auth.password || '') : '';
  $('authLoginPath').value = hasAuth && page.auth.loginPath !== '/login' ? page.auth.loginPath : '';
  $('authHeaderName').value = hasAuth ? (page.auth.headerName || '') : '';
  $('authHeaderValue').value = hasAuth ? (page.auth.headerValue || '') : '';
  fillGroupSelect(page ? page.group : (groups[0] || '未分组'));
  setType(page ? page.type || 'link' : 'link');
  formError.classList.add('hidden');
  modalOverlay.classList.remove('hidden');
  setTimeout(() => $('fieldName').focus(), 50);
}

function closeModal() {
  modalOverlay.classList.add('hidden');
}

$('pageForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = {
    type: currentType,
    name: $('fieldName').value.trim(),
    icon: $('fieldIcon').value.trim() || (currentType === 'markdown' ? '📝' : '🔗'),
    group: $('fieldGroup').value || '未分组'
  };
  if (currentType === 'link') {
    body.url = $('fieldUrl').value.trim();
    // 认证配置：勾选时按所选模式提交，未勾选时显式清除
    if ($('authEnabled').checked) {
      const mode = $('authMode').value;
      if (mode === 'header') {
        body.auth = {
          mode,
          headerName: $('authHeaderName').value.trim(),
          headerValue: $('authHeaderValue').value.trim()
        };
      } else {
        body.auth = { mode, username: $('authUser').value.trim(), password: $('authPass').value };
        if (mode === 'login') body.auth.loginPath = $('authLoginPath').value.trim() || '/login';
      }
    } else {
      body.auth = null;
    }
  }
  // markdown 正文统一在右侧原地编辑维护，新建时由服务端生成占位文档
  const saveBtn = $('saveBtn');
  saveBtn.disabled = true;
  try {
    if (editingId) {
      await api('/' + editingId, { method: 'PUT', body: JSON.stringify(body) });
      showToast('页面已更新');
    } else {
      const created = await api('', { method: 'POST', body: JSON.stringify(body) });
      activeId = created.id;
      currentView = 'page';
      showToast('页面已创建');
    }
    closeModal();
    await refresh();
  } catch (err) {
    formError.textContent = err.message;
    formError.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
  }
});

$('newPageBtn').addEventListener('click', () => openModal());
$('modalClose').addEventListener('click', closeModal);
$('cancelBtn').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => {
  if (e.target === modalOverlay) closeModal();
});

// ---------- 弹窗：删除确认 ----------
function openConfirm(page) {
  deletingId = page.id;
  $('confirmName').textContent = page.name;
  confirmOverlay.classList.remove('hidden');
}

$('confirmCancel').addEventListener('click', () => confirmOverlay.classList.add('hidden'));
confirmOverlay.addEventListener('click', e => {
  if (e.target === confirmOverlay) confirmOverlay.classList.add('hidden');
});

$('confirmDelete').addEventListener('click', async () => {
  try {
    await api('/' + deletingId, { method: 'DELETE' });
    showToast('页面已删除');
    if (activeId === deletingId) activeId = null;
    confirmOverlay.classList.add('hidden');
    await refresh();
  } catch (err) {
    showToast(err.message);
  }
});

// ---------- 顶栏操作 ----------
$('reloadBtn').addEventListener('click', () => {
  if (currentView !== 'page') return;
  if (!confirmDiscardIfEditing()) return;
  const page = pages.find(p => p.id === activeId);
  if (page) showPage(page);
});

// ---------- 侧边栏折叠 ----------
$('toggleSidebar').addEventListener('click', () => {
  $('sidebar').classList.add('collapsed');
  $('expandSidebar').classList.remove('hidden');
});

$('expandSidebar').addEventListener('click', () => {
  $('sidebar').classList.remove('collapsed');
  $('expandSidebar').classList.add('hidden');
});

// ---------- 工具 ----------
function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

// ---------- 初始化 ----------
async function refresh() {
  pages = await api('');
  // 修正失效的 activeId
  if (activeId && !pages.some(p => p.id === activeId)) activeId = null;
  renderSidebar();

  if (currentView === 'page') {
    const active = pages.find(p => p.id === activeId);
    if (active) {
      showPage(active);
    } else {
      showWelcome();
    }
  }
}

async function init() {
  try {
    [pages, groups] = await Promise.all([api(''), groupsApi()]);
  } catch (err) {
    topbarName.textContent = '加载失败：' + err.message;
    return;
  }
  renderSidebar();
  showWelcome(); // 起始页统一为欢迎页
}

init();
