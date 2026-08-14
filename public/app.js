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
  const res = await fetch('/hilbert-api/pages' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

async function groupsApi(path = '', options = {}) {
  const res = await fetch('/hilbert-api/groups' + path, {
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
          <button class="more" title="更多操作">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
          </button>
          <div class="item-menu">
            <button class="menu-copy">复制</button>
            <button class="menu-edit">编辑</button>
            <button class="menu-del danger">删除</button>
          </div>
        </span>`;

      item.addEventListener('click', () => selectPage(p.id));
      // 三点菜单：展开/收起，同一时间只保留一个打开的菜单
      // 用 fixed 定位避开 .page-list 的 overflow 裁剪，位置按按钮实际坐标计算
      const menu = item.querySelector('.item-menu');
      item.querySelector('.more').addEventListener('click', e => {
        e.stopPropagation();
        const willOpen = !menu.classList.contains('open');
        closeAllItemMenus();
        if (willOpen) {
          const rect = e.currentTarget.getBoundingClientRect();
          menu.style.top = rect.bottom + 4 + 'px';
          menu.style.right = window.innerWidth - rect.right + 'px';
          menu.classList.add('open');
          item.classList.add('menu-open');
        }
      });
      menu.addEventListener('click', e => e.stopPropagation());
      menu.querySelector('.menu-copy').addEventListener('click', () => {
        closeAllItemMenus();
        duplicatePage(p);
      });
      menu.querySelector('.menu-edit').addEventListener('click', () => {
        closeAllItemMenus();
        if (!confirmDiscardIfEditing()) return;
        openModal(p);
      });
      menu.querySelector('.menu-del').addEventListener('click', () => {
        closeAllItemMenus();
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

// 关闭所有已展开的页面项菜单（点击其他区域时由 document 监听触发）
function closeAllItemMenus() {
  document.querySelectorAll('.item-menu.open').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('.page-item.menu-open').forEach(i => i.classList.remove('menu-open'));
}
document.addEventListener('click', closeAllItemMenus);
// 列表滚动时菜单会脱离按钮位置，直接关闭
pageList.addEventListener('scroll', closeAllItemMenus);

// 复制页面：以现有配置新建一份副本（link 携带 url/认证，markdown 携带正文）
async function duplicatePage(page) {
  const body = {
    type: page.type,
    name: page.name + '（副本）',
    icon: page.icon,
    group: page.group
  };
  if (page.type === 'link') {
    body.url = page.url;
    if (page.proxyMode) body.proxyMode = page.proxyMode;
    if (page.auth) body.auth = page.auth;
  } else {
    body.content = page.content || '';
  }
  try {
    await api('', { method: 'POST', body: JSON.stringify(body) });
    showToast('页面已复制');
    await refresh();
  } catch (err) {
    showToast(err.message);
  }
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
    // link 页面一律走反向代理：剥离目标站的 iframe 嵌入限制、改写 Origin/Referer
    // 通过 CSRF 校验；直连目标 URL 会因跨域被目标站拒绝（如 Grafana 的 origin not allowed）
    // 新架构：代理路径直接使用页面 URL 的路径部分（如 /xxl-job-admin/）；
    // 挂载模式（编辑页面指定 proxyMode=mount）统一从 /hilbert-proxy/<id> 进入，
    // 适用于根路径站点（与面板根路径冲突）或恒等映射异常的站点
    const pageUrl = new URL(page.url);
    const pagePath = pageUrl.pathname.replace(/\/+$/, '');
    mainFrame.src = (page.proxyMode === 'mount' ? '/hilbert-proxy/' + page.id + '/' : (pagePath || '/'))
      + (pageUrl.search || '');
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

// 强制刷新：清除本应用的本地存储 + Cache Storage + 重新加载当前页（带时间戳参数绕过浏览器 HTTP 缓存）
$('refreshBtn').addEventListener('click', e => {
  e.stopPropagation(); // 不触发外层「设置」按钮
  // 先打标记（必须在 clear 之前），这样新页面加载时才能读到
  sessionStorage.setItem('__forceRefresh', '1');
  try {
    localStorage.clear();
    // 仅清除业务相关数据；不清 sessionStorage（__forceRefresh 标记需保留）
    if ('caches' in window) {
      // 删除所有 Service Worker / Cache API 缓存
      caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
    }
  } catch { /* 隐私模式等场景下 storage 不可写，仅继续刷新 */ }
  // 在 URL 上加时间戳，强制绕过浏览器的 HTTP 缓存拉取 app.js / style.css 等静态资源
  const url = new URL(location.href);
  url.searchParams.set('_fresh', Date.now());
  location.href = url.toString();
});
// 刷新后首次加载，给一点视觉反馈
window.addEventListener('load', () => {
  if (sessionStorage.getItem('__forceRefresh')) {
    sessionStorage.removeItem('__forceRefresh');
    showToast('缓存已清除，页面已重新加载');
  }
});
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
  $('proxyModeField').classList.toggle('hidden', !isLink);
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

// 认证模式切换：basic/login 显示账号密码，header 显示自定义头，login 额外显示登录路径与请求格式
function setAuthMode(mode) {
  $('authMode').value = mode;
  $('authUserPass').classList.toggle('hidden', mode === 'header');
  $('authLoginPath').classList.toggle('hidden', mode !== 'login');
  $('authLoginOpts').classList.toggle('hidden', mode !== 'login');
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

// 代理模式提示：URL 无路径时恒等映射会加载面板自身造成无限嵌套，需提醒改用挂载
function updateProxyModeHint() {
  const hint = $('proxyModeHint');
  let emptyPath = false;
  try {
    emptyPath = !new URL($('fieldUrl').value.trim()).pathname.replace(/\/+$/, '');
  } catch { /* URL 尚未输完整时忽略 */ }
  if (emptyPath && $('fieldProxyMode').value === 'identity') {
    hint.textContent = '⚠️ 该 URL 没有路径，恒等映射会加载面板自身导致无限嵌套，建议改用挂载模式';
    hint.classList.add('warn');
  } else {
    hint.textContent = '恒等映射 URL 更简洁；若站点 URL 没有路径（如 https://notes.example.com/），需选择挂载模式';
    hint.classList.remove('warn');
  }
}
$('fieldUrl').addEventListener('input', updateProxyModeHint);
$('fieldProxyMode').addEventListener('change', updateProxyModeHint);

function openModal(page = null) {
  editingId = page ? page.id : null;
  $('modalTitle').textContent = page ? '编辑页面' : '新建页面';
  $('fieldName').value = page ? page.name : '';
  $('fieldUrl').value = page && page.type !== 'markdown' ? page.url : '';
  $('fieldProxyMode').value = page && page.proxyMode === 'mount' ? 'mount' : 'identity';
  updateProxyModeHint();
  $('fieldIcon').value = page ? page.icon : '';
  const hasAuth = !!(page && page.auth);
  $('authEnabled').checked = hasAuth;
  $('authBox').classList.toggle('hidden', !hasAuth);
  const mode = hasAuth ? (page.auth.mode || 'basic') : 'basic';
  setAuthMode(mode);
  $('authUser').value = hasAuth ? (page.auth.username || '') : '';
  $('authPass').value = hasAuth ? (page.auth.password || '') : '';
  $('authLoginPath').value = hasAuth && page.auth.loginPath !== '/login' ? page.auth.loginPath : '';
  $('authLoginFormat').value = hasAuth && page.auth.loginFormat === 'form' ? 'form' : 'json';
  $('authUserField').value = hasAuth && page.auth.userField !== 'user' ? (page.auth.userField || '') : '';
  $('authPasswordField').value = hasAuth && page.auth.passwordField !== 'password' ? (page.auth.passwordField || '') : '';
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
    body.proxyMode = $('fieldProxyMode').value;
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
        if (mode === 'login') {
          body.auth.loginPath = $('authLoginPath').value.trim() || '/login';
          // 请求格式与字段名：适配不同目标站（如 XXL-JOB 需 form + userName/password）
          body.auth.loginFormat = $('authLoginFormat').value;
          const userField = $('authUserField').value.trim();
          const passwordField = $('authPasswordField').value.trim();
          if (userField) body.auth.userField = userField;
          if (passwordField) body.auth.passwordField = passwordField;
        }
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
