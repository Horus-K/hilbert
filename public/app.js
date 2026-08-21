// ---------- 状态 ----------
let pages = [];
let groups = [];
let activeId = null;
let editingId = null; // null 表示新建模式
let deletingId = null;
let currentType = 'link'; // 弹窗中当前选择的页面类型
let mdEditing = false; // 是否处于 Markdown 右侧编辑模式
let currentView = 'welcome'; // welcome | page | settings
let customFiles = [];
let isAdmin = false;          // 当前用户是否超级管理员
let myPermissions = null;     // 当前用户权限缓存 [{ pageId, actions }]
let rbacRoles = [];           // RBAC 角色列表
let rbacAssignments = [];     // RBAC 分配列表
let editingRoleId = null;     // 当前编辑的角色 ID（null 为新建）
let favorites = [];           // 当前用户收藏的页面 ID 列表
let currentUserEmail = '';    // 当前用户邮箱（用于 localStorage 隔离）
let collapsedGroups = [];     // 已折叠的分组名列表（默认全部折叠）
let viewingPageDoc = false;   // 是否正在查看页面专属文档
let docPageId = null;         // 当前查看文档的页面 ID
let docEditing = false;       // 是否处于文档编辑模式
let docContent = '';          // 当前文档内容

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const pageList = $('pageList');
const mainFrame = $('mainFrame');
const loadingMask = $('loadingMask');
const iframeWrap = $('iframeWrap');
const mdView = $('mdView');
const mdBody = $('mdBody');
const mdEditor = $('mdEditor');
const mdToolbar = $('mdToolbar');
const mdToolbarIcon = $('mdToolbarIcon');
const mdToolbarTitle = $('mdToolbarTitle');
const mdEditBtn = $('mdEditBtn');
const mdSaveBtn = $('mdSaveBtn');
const mdCancelBtn = $('mdCancelBtn');
const welcomeView = $('welcomeView');
const settingsView = $('settingsView');
const groupList = $('groupList');
const groupError = $('groupError');
const newGroupName = $('newGroupName');
const favoritesSection = $('favoritesSection');
const favoritesList = $('favoritesList');
const favoritesCount = $('favoritesCount');
const pinnedSection = $('pinnedSection');
const pinnedList = $('pinnedList');
const pinnedCount = $('pinnedCount');
const customView = $('customView');
const customFrame = $('customFrame');
const modalFileList = $('modalFileList');
const modalFileInput = $('modalFileInput');
const modalFileUploadZone = $('modalFileUploadZone');
const customFileField = $('customFileField');
const userAvatar = $('userAvatar');
const userName = $('userName');
const userEmail = $('userEmail');
const logoutBtn = $('logoutBtn');

const modalOverlay = $('modalOverlay');
const confirmOverlay = $('confirmOverlay');
const formError = $('formError');
const toast = $('toast');

// ---------- API ----------
// 全局 fetch 包装：携带 Cookie + 401 自动跳转登录
function authenticatedFetch(url, options) {
  return fetch(url, Object.assign({ credentials: 'include' }, options)).then(function(res) {
    if (res.status === 401) {
      window.location.href = '/login.html';
      return new Promise(function() {}); // 挂起，等待重定向
    }
    return res;
  });
}

async function api(path, options = {}) {
  const res = await authenticatedFetch('/hilbert-api/pages' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

async function groupsApi(path = '', options = {}) {
  const res = await authenticatedFetch('/hilbert-api/groups' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

async function rbacApi(path = '', options = {}) {
  const res = await authenticatedFetch('/hilbert-api/rbac' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

// ---------- 权限判断 ----------
function hasPagePermission(pageId, action) {
  if (isAdmin) return true;
  if (!myPermissions) return false;
  for (const p of myPermissions) {
    if (p.pageId === '*' || p.pageId === pageId) {
      if (p.actions.includes(action)) return true;
    }
  }
  return false;
}

function canCreatePage() { return hasPagePermission('*', 'create'); }
function canEditPage(pageId) { return hasPagePermission(pageId, 'update'); }
function canDeletePage(pageId) { return hasPagePermission(pageId, 'delete'); }
function canReadPage(pageId) { return hasPagePermission(pageId, 'read'); }

// ---------- 收藏功能 ----------
async function favoritesApi(path = '', options = {}) {
  const res = await authenticatedFetch('/hilbert-api/favorites' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

async function loadFavorites() {
  try {
    favorites = await favoritesApi();
    if (!Array.isArray(favorites)) favorites = [];
  } catch { favorites = []; }
}

async function toggleFavorite(pageId) {
  try {
    favorites = await favoritesApi('/toggle', {
      method: 'POST',
      body: JSON.stringify({ pageId })
    });
    renderFavorites();
    renderSidebar();
  } catch (err) {
    showToast(err.message);
  }
}

function isFavorited(pageId) {
  return favorites.includes(pageId);
}

// ---------- 置顶功能 ----------
async function togglePagePin(pageId) {
  try {
    const updated = await authenticatedFetch('/hilbert-api/pages/' + pageId + '/pin', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await updated.json();
    if (!updated.ok) throw new Error(data.error || '操作失败');
    // 更新本地数据
    const page = pages.find(p => p.id === pageId);
    if (page) page.pinned = data.pinned;
    renderSidebar();
  } catch (err) {
    showToast(err.message);
  }
}

function renderPinned() {
  // 获取所有置顶页面（按权限过滤）
  const pinnedPages = pages.filter(p => p.pinned && (isAdmin || canReadPage(p.id)));
  pinnedCount.textContent = pinnedPages.length || '';

  if (pinnedPages.length === 0) {
    pinnedSection.classList.add('hidden');
    return;
  }
  pinnedSection.classList.remove('hidden');
  pinnedList.innerHTML = '';

  for (const p of pinnedPages) {
    const item = document.createElement('div');
    const isDirect = p.type === 'direct';
    item.className = 'pinned-item' + (p.id === activeId ? ' active' : '') + (isDirect ? ' is-direct' : '');
    item.innerHTML = `
      <span class="item-icon">${escapeHtml(p.icon || (p.type === 'markdown' ? '📝' : '🔗'))}</span>
      <span class="item-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
      <span class="item-type-badge">${p.type === 'markdown' ? 'MD' : p.type === 'custom' ? 'CM' : p.type === 'direct' ? 'DL' : p.type === 'iframe' ? 'IF' : ''}</span>`;

    item.addEventListener('click', () => {
      if (isDirect) {
        window.open(p.url, '_blank');
        return;
      }
      selectPage(p.id);
    });
    pinnedList.appendChild(item);
  }
}

function renderFavorites() {
  favoritesList.innerHTML = '';
  // 过滤掉已不存在的页面
  const favPages = favorites.map(id => pages.find(p => p.id === id)).filter(Boolean);
  // 过滤无 read 权限的页面
  const visiblePages = favPages.filter(p => isAdmin || canReadPage(p.id));
  favoritesCount.textContent = visiblePages.length || '';
  if (visiblePages.length === 0) {
    favoritesSection.classList.add('empty');
    const hint = document.createElement('div');
    hint.className = 'favorites-empty-hint';
    hint.textContent = '点击页面星标添加收藏';
    favoritesList.appendChild(hint);
    return;
  }
  favoritesSection.classList.remove('empty');
  for (const p of visiblePages) {
    const item = document.createElement('div');
    item.className = 'fav-item' + (p.id === activeId ? ' active' : '');
    item.innerHTML = `
      <span class="fav-indicator"></span>
      <span class="item-icon">${escapeHtml(p.icon || (p.type === 'markdown' ? '📝' : '🔗'))}</span>
      <span class="item-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
      <button class="fav-remove-btn" title="取消收藏">★</button>`;
    item.addEventListener('click', (e) => {
      if (e.target.closest('.fav-remove-btn')) return;
      if (p.type === 'direct') {
        window.open(p.url, '_blank');
        return;
      }
      selectPage(p.id);
    });
    item.querySelector('.fav-remove-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(p.id);
    });
    favoritesList.appendChild(item);
  }
}

// ---------- 分组折叠状态 ----------
function loadCollapsedGroups() {
  try {
    const raw = localStorage.getItem('hilbert_collapsed_groups');
    // 默认全部折叠：如果没有存储过状态，则所有分组都折叠
    collapsedGroups = raw ? JSON.parse(raw) : null;
  } catch { collapsedGroups = null; }
}

function saveCollapsedGroups() {
  try {
    localStorage.setItem('hilbert_collapsed_groups', JSON.stringify(collapsedGroups));
  } catch { /* 存储失败忽略 */ }
}

function toggleGroupCollapse(groupName) {
  if (collapsedGroups === null) {
    // 首次操作：从全部折叠状态开始切换
    // 获取所有分组名，除了当前分组外其他都保持折叠
    collapsedGroups = [...groups].filter(g => g !== groupName);
  } else {
    const idx = collapsedGroups.indexOf(groupName);
    if (idx >= 0) {
      collapsedGroups.splice(idx, 1); // 展开
    } else {
      collapsedGroups.push(groupName); // 折叠
    }
  }
  saveCollapsedGroups();
  renderSidebar();
}

// ---------- 渲染 ----------
function renderSidebar() {
  pageList.innerHTML = '';
  $('settingsEntry').classList.toggle('active', currentView === 'settings');

  // 权限控制：新建页面按钮
  const canCreate = canCreatePage();
  $('newPageBtn').classList.toggle('hidden', !canCreate && !isAdmin);

  // 权限控制：设置入口仅管理员可见
  $('settingsEntry').classList.toggle('hidden', !isAdmin);

  // 刷新收藏区域
  renderFavorites();

  // 刷新置顶区域
  renderPinned();

  if (pages.length === 0) return;

  // 按分组聚合，顺序跟随 groups 数组（设置页拖拽排序的结果）
  const groupMap = new Map();
  // 先按 groups 顺序初始化（保证排序）
  for (const g of groups) {
    groupMap.set(g, []);
  }
  for (const p of pages) {
    // 非管理员：过滤无 read 权限的页面
    if (!isAdmin && !canReadPage(p.id)) continue;
    const g = p.group || '未分组';
    if (!groupMap.has(g)) groupMap.set(g, []);
    groupMap.get(g).push(p);
  }

  // 加载折叠状态（默认全部折叠）
  loadCollapsedGroups();

  for (const [groupName, items] of groupMap) {
    if (items.length === 0) continue; // 跳过空分组
    // collapsedGroups 为 null 表示默认全部折叠
    const isCollapsed = collapsedGroups === null || collapsedGroups.includes(groupName);
    
    // 分组标题（可点击折叠/展开）
    const title = document.createElement('div');
    title.className = 'group-title' + (isCollapsed ? ' collapsed' : '');
    title.innerHTML = `<span class="group-arrow">${isCollapsed ? '▶' : '▼'}</span><span class="group-name-text">${escapeHtml(groupName)}</span>`;
    title.addEventListener('click', () => toggleGroupCollapse(groupName));
    pageList.appendChild(title);

    // 分组内容容器
    const groupContent = document.createElement('div');
    groupContent.className = 'group-content' + (isCollapsed ? ' collapsed' : '');
    pageList.appendChild(groupContent);

    for (const p of items) {
      const item = document.createElement('div');
      const canEdit = canEditPage(p.id);
      const canDel = canDeletePage(p.id);
      const canCopy = canCreatePage();
      const isDirect = p.type === 'direct';
      const isFav = isFavorited(p.id);
      const isPinned = !!p.pinned;
      item.className = 'page-item' + (p.id === activeId ? ' active' : '') + (isDirect ? ' is-direct' : '') + (isPinned ? ' is-pinned' : '');
      item.innerHTML = `
        <span class="item-icon">${escapeHtml(p.icon || (p.type === 'markdown' ? '📝' : '🔗'))}</span>
        <span class="item-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
        <span class="item-type-badge">${p.type === 'markdown' ? 'MD' : p.type === 'custom' ? 'CM' : p.type === 'direct' ? 'DL' : p.type === 'iframe' ? 'IF' : ''}</span>
        <span class="item-actions">
          <button class="page-doc-btn" title="页面文档">📄</button>
          <button class="fav-star ${isFav ? 'favorited' : ''}" title="${isFav ? '取消收藏' : '添加收藏'}">${isFav ? '★' : '☆'}</button>
          <button class="more" title="更多操作">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
          </button>
          <div class="item-menu">
            ${isAdmin ? `<button class="menu-pin">${isPinned ? '📌 取消置顶' : '📍 置顶'}</button>` : ''}
            ${canCopy ? '<button class="menu-copy">复制</button>' : ''}
            ${canEdit ? '<button class="menu-edit">编辑</button>' : ''}
            ${canDel ? '<button class="menu-del danger">删除</button>' : ''}
          </div>
        </span>`;

      // 点击事件：直链页面在新标签页打开
      item.addEventListener('click', () => {
        if (isDirect) {
          window.open(p.url, '_blank');
          return;
        }
        selectPage(p.id);
      });
      // 文档按钮
      const docBtn = item.querySelector('.page-doc-btn');
      docBtn.addEventListener('click', e => {
        e.stopPropagation();
        openPageDoc(p);
      });
      // 星标按钮
      const favBtn = item.querySelector('.fav-star');
      favBtn.addEventListener('click', e => {
        e.stopPropagation();
        toggleFavorite(p.id);
      });
      // 三点菜单：展开/收起，同一时间只保留一个打开的菜单
      // 用 fixed 定位避开 .page-list 的 overflow 裁剪，位置按按钮实际坐标计算
      const menu = item.querySelector('.item-menu');
      const moreBtn = item.querySelector('.more');
      // 如果没有任何操作按钮，隐藏三点菜单
      if (!menu.children.length) {
        moreBtn.classList.add('hidden');
      }
      moreBtn.addEventListener('click', e => {
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
      const pinMenuBtn = menu.querySelector('.menu-pin');
      if (pinMenuBtn) pinMenuBtn.addEventListener('click', () => {
        closeAllItemMenus();
        togglePagePin(p.id);
      });
      const copyBtn = menu.querySelector('.menu-copy');
      if (copyBtn) copyBtn.addEventListener('click', () => {
        closeAllItemMenus();
        duplicatePage(p);
      });
      const editBtn = menu.querySelector('.menu-edit');
      if (editBtn) editBtn.addEventListener('click', () => {
        closeAllItemMenus();
        if (!confirmDiscardIfEditing()) return;
        openModal(p);
      });
      const delBtn = menu.querySelector('.menu-del');
      if (delBtn) delBtn.addEventListener('click', () => {
        closeAllItemMenus();
        if (!confirmDiscardIfEditing()) return;
        openConfirm(p);
      });
      groupContent.appendChild(item);
    }
  }
}

function selectPage(id, skipPushState) {
  if (id === activeId && !mdEditing && !docEditing && !viewingPageDoc && currentView === 'page') return;
  if (!confirmDiscardIfEditing()) return;
  const page = pages.find(p => p.id === id);
  if (!page) return;
  activeId = id;
  exitDocView();
  renderSidebar();
  showPage(page);
  // 更新浏览器地址栏 URL（直链页面除外）
  if (!skipPushState && page.type !== 'direct') {
    history.pushState({ pageId: id }, '', '/page/' + id);
  }
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
  } else if (page.type === 'direct' || page.type === 'iframe') {
    body.url = page.url;
  } else if (page.type === 'custom') {
    body.sourceId = page.id;
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
  // 点击页面后收起侧边栏（常驻模式下不收起）
  if (!sidebarPinned) $('sidebar').classList.add('collapsed');
  welcomeView.classList.add('hidden');
  settingsView.classList.add('hidden');

  if (page.type === 'markdown') {
    iframeWrap.classList.add('hidden');
    mdView.classList.remove('hidden');
    customView.classList.add('hidden');
    loadingMask.classList.add('fade-out');
    exitMdEdit();
    // 更新工具栏标题和图标
    mdToolbarIcon.textContent = page.icon || '📝';
    mdToolbarTitle.textContent = page.name;
    // 根据权限控制编辑按钮
    mdEditBtn.classList.toggle('hidden', !canEditPage(page.id));
    renderMarkdown(page);
  } else if (page.type === 'custom') {
    iframeWrap.classList.add('hidden');
    mdView.classList.add('hidden');
    customView.classList.remove('hidden');
    welcomeView.classList.add('hidden');
    settingsView.classList.add('hidden');
    loadingMask.classList.add('fade-out');
    exitMdEdit();
    const entry = page.entry || 'index.html';
    customFrame.src = '/hilbert-custom/' + page.id + '/' + entry;
  } else if (page.type === 'direct') {
    // 直链页面：新标签页打开后回到欢迎页
    iframeWrap.classList.add('hidden');
    mdView.classList.add('hidden');
    customView.classList.add('hidden');
    exitMdEdit();
    window.open(page.url, '_blank');
    showWelcome();
  } else if (page.type === 'iframe') {
    // 直接嵌入：iframe 直接加载目标 URL，流量不经过 Node 服务
    mdView.classList.add('hidden');
    iframeWrap.classList.remove('hidden');
    exitMdEdit();
    loadingMask.classList.remove('fade-out');
    mainFrame.src = page.url;
  } else {
    mdView.classList.add('hidden');
    iframeWrap.classList.remove('hidden');
    exitMdEdit();
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
  updateSidebarTrigger();
  saveViewState();
}

function renderMarkdown(page) {
  mdBody.innerHTML = marked.parse(page.content || '');
  mdView.scrollTop = 0;
}

// ---------- 视图状态持久化 ----------
function saveViewState() {
  try {
    sessionStorage.setItem('hilbert_view', JSON.stringify({ view: currentView, activeId }));
  } catch { /* 忽略 */ }
}

function restoreViewState() {
  try {
    const raw = sessionStorage.getItem('hilbert_view');
    if (raw) return JSON.parse(raw);
  } catch { /* 忽略 */ }
  return null;
}

// ---------- 欢迎页 / 设置页 ----------
function showWelcome() {
  currentView = 'welcome';
  activeId = null;
  exitMdEdit();
  iframeWrap.classList.add('hidden');
  mdView.classList.add('hidden');
  customView.classList.add('hidden');
  settingsView.classList.add('hidden');
  welcomeView.classList.remove('hidden');
  loadingMask.classList.add('fade-out');
  // 权限控制：欢迎页按钮
  $('welcomeNewBtn').classList.toggle('hidden', !canCreatePage() && !isAdmin);
  $('welcomeSettingsBtn').classList.toggle('hidden', !isAdmin);
  renderSidebar();
  updateSidebarTrigger();
  saveViewState();
  // 回到主面板时清除 URL 路径
  history.pushState(null, '', '/');
}

function showSettings() {
  // 仅超级管理员可访问设置页
  if (!isAdmin) {
    showToast('仅超级管理员可访问设置页');
    return;
  }
  if (!confirmDiscardIfEditing()) return;
  currentView = 'settings';
  // 进入设置页后收起侧边栏（常驻模式下不收起）
  if (!sidebarPinned) $('sidebar').classList.add('collapsed');
  activeId = null;
  exitMdEdit();
  iframeWrap.classList.add('hidden');
  mdView.classList.add('hidden');
  customView.classList.add('hidden');
  welcomeView.classList.add('hidden');
  settingsView.classList.remove('hidden');
  groupError.classList.add('hidden');
  renderGroupList();
  // RBAC 面板：仅管理员可见
  if (isAdmin) {
    $('rbacPanel').classList.remove('hidden');
    loadAndRenderRbac();
  } else {
    $('rbacPanel').classList.add('hidden');
  }
  renderSidebar();
  updateSidebarTrigger();
  saveViewState();
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
let dragSrcIndex = null; // 拖拽源索引

function renderGroupList() {
  groupList.innerHTML = '';
  if (groups.length === 0) {
    const li = document.createElement('li');
    li.className = 'group-empty';
    li.textContent = '暂无分组，请在上方添加';
    groupList.appendChild(li);
    return;
  }
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const count = pages.filter(p => p.group === g).length;
    const li = document.createElement('li');
    li.className = 'group-item';
    li.draggable = true;
    li.dataset.index = i;
    li.innerHTML = `
      <span class="group-drag-handle" title="拖拽排序">≡</span>
      <span class="group-name" title="双击编辑名称">${escapeHtml(g)}</span>
      <span class="group-count">${count} 个页面</span>
      <button class="group-del" title="删除分组">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>`;

    // 删除按钮
    li.querySelector('.group-del').addEventListener('click', () => deleteGroup(g, count));

    // 双击编辑名称
    const nameSpan = li.querySelector('.group-name');
    nameSpan.addEventListener('dblclick', () => startGroupEdit(li, g, nameSpan));

    // 拖拽事件
    li.addEventListener('dragstart', e => {
      dragSrcIndex = parseInt(li.dataset.index);
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(dragSrcIndex));
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      document.querySelectorAll('.group-item').forEach(el => el.classList.remove('drag-over'));
    });
    li.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      li.classList.add('drag-over');
    });
    li.addEventListener('dragleave', () => {
      li.classList.remove('drag-over');
    });
    li.addEventListener('drop', async e => {
      e.preventDefault();
      li.classList.remove('drag-over');
      const targetIndex = parseInt(li.dataset.index);
      if (dragSrcIndex === null || dragSrcIndex === targetIndex) return;
      // 重排分组数组
      const newOrder = [...groups];
      const [moved] = newOrder.splice(dragSrcIndex, 1);
      newOrder.splice(targetIndex, 0, moved);
      try {
        groups = await groupsApi('/order', { method: 'PUT', body: JSON.stringify({ order: newOrder }) });
        renderGroupList();
        renderSidebar();
        showToast('分组顺序已更新');
      } catch (err) {
        showToast(err.message);
      }
      dragSrcIndex = null;
    });

    groupList.appendChild(li);
  }
}

// 分组名称 inline 编辑
function startGroupEdit(li, oldName, nameSpan) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'group-edit-input';
  input.value = oldName;
  input.maxLength = 20;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  const finish = async (save) => {
    const newName = input.value.trim();
    if (save && newName && newName !== oldName) {
      try {
        groups = await groupsApi('/' + encodeURIComponent(oldName), { method: 'PUT', body: JSON.stringify({ name: newName }) });
        pages = await api('');
        renderGroupList();
        renderSidebar();
        showToast('分组已重命名');
        return;
      } catch (err) {
        showToast(err.message);
      }
    }
    // 取消或失败：恢复原名
    renderGroupList();
  };

  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = oldName; input.blur(); }
  });
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

// ---------- RBAC 权限管理（设置页） ----------

async function loadAndRenderRbac() {
  try {
    [rbacRoles, rbacAssignments] = await Promise.all([
      rbacApi('/roles'),
      rbacApi('/assignments')
    ]);
    renderRbacRoles();
    renderRbacAssignments();
  } catch (err) {
    showToast('加载权限配置失败: ' + err.message);
  }
}

function renderRbacRoles() {
  const container = $('rbacRoleList');
  container.innerHTML = '';
  if (rbacRoles.length === 0) {
    container.innerHTML = '<div class="rbac-empty">暂无角色，请点击上方按钮新建</div>';
    return;
  }
  for (const role of rbacRoles) {
    const assignedCount = rbacAssignments.filter(a => a.roleId === role.id).length;
    const permSummary = (role.permissions || []).map(p => {
      const label = p.pageId === '*' ? '全部页面(自动包含新页面)' : (pages.find(pg => pg.id === p.pageId)?.name || p.pageId.slice(0, 8));
      return label + '(' + p.actions.join('/') + ')';
    }).join('、') || '无权限';
    const card = document.createElement('div');
    card.className = 'rbac-role-card';
    card.innerHTML = `
      <div class="rbac-role-info">
        <span class="rbac-role-name">${escapeHtml(role.name)}</span>
        <span class="rbac-role-desc">${escapeHtml(role.description || '')}</span>
        <span class="rbac-role-meta">${assignedCount} 个用户 · ${escapeHtml(permSummary)}</span>
      </div>
      <div class="rbac-role-actions">
        <button class="ghost-btn rbac-edit-role" data-id="${role.id}">编辑</button>
        <button class="danger-btn rbac-del-role" data-id="${role.id}">删除</button>
      </div>`;
    card.querySelector('.rbac-edit-role').addEventListener('click', () => openRoleModal(role));
    card.querySelector('.rbac-del-role').addEventListener('click', () => deleteRole(role));
    container.appendChild(card);
  }
}

function renderRbacAssignments() {
  const container = $('rbacAssignList');
  container.innerHTML = '';
  // 管理员提示：显示在分配列表下方，消除管理员对自身权限的疑虑
  const hint = $('rbacAdminHint');
  if (hint) hint.style.display = isAdmin ? '' : 'none';
  if (rbacAssignments.length === 0) {
    container.innerHTML = '<div class="rbac-empty">暂无分配关系</div>';
    return;
  }
  for (const a of rbacAssignments) {
    const role = rbacRoles.find(r => r.id === a.roleId);
    const roleName = role ? role.name : '(已删除角色)';
    const isWildcard = a.email.includes('*');
    const row = document.createElement('div');
    row.className = 'rbac-assign-row';
    row.innerHTML = `
      <span class="rbac-assign-email">${escapeHtml(a.email)}${isWildcard ? ' <span class="rbac-wildcard-badge" title="通配符模式：匹配所有符合条件的用户">通配</span>' : ''}</span>
      <span class="rbac-assign-role">${escapeHtml(roleName)}</span>
      <button class="danger-btn rbac-del-assign" title="移除">✕</button>`;
    row.querySelector('.rbac-del-assign').addEventListener('click', () => removeAssignment(a));
    container.appendChild(row);
  }
}

// 角色编辑弹窗
function openRoleModal(role = null) {
  editingRoleId = role ? role.id : null;
  $('rbacRoleModalTitle').textContent = role ? '编辑角色' : '新建角色';
  $('rbacRoleName').value = role ? role.name : '';
  $('rbacRoleDesc').value = role ? (role.description || '') : '';
  $('rbacRoleError').classList.add('hidden');
  // 渲染权限表格
  renderPermTable(role);
  $('rbacRoleModal').classList.remove('hidden');
  setTimeout(() => $('rbacRoleName').focus(), 50);
}

function closeRoleModal() {
  $('rbacRoleModal').classList.add('hidden');
  editingRoleId = null;
}

function renderPermTable(role) {
  const container = $('rbacPermTable');
  container.innerHTML = '';
  // 清除旧的通配提示
  const oldHint = $('rbacPermAllHint');
  if (oldHint) oldHint.remove();
  const rolePerms = role ? (role.permissions || []) : [];
  // 检查是否已有通配权限（排除仅含 create 的条目）
  const wildcardPerm = rolePerms.find(p => p.pageId === '*' && p.actions.some(a => a !== 'create'));
  $('rbacPermAll').checked = !!wildcardPerm;
  // 设置独立「新增页面」开关状态
  const hasCreate = wildcardPerm
    ? wildcardPerm.actions.includes('create')
    : rolePerms.some(p => p.actions && p.actions.includes('create'));
  $('rbacPermCreate').checked = hasCreate;
  // 获取所有页面（包括无 read 权限的，管理员才能配置）
  const allPages = pages;
  if (allPages.length === 0) {
    container.innerHTML = '<div class="rbac-empty">暂无页面可配置</div>';
    return;
  }
  // 表头
  const header = document.createElement('div');
  header.className = 'rbac-perm-row rbac-perm-header';
  header.innerHTML = '<span class="rbac-perm-page">页面</span><span class="rbac-perm-actions"><label><input type="checkbox" class="perm-act-head" data-act="read" /> 查看</label><label><input type="checkbox" class="perm-act-head" data-act="update" /> 修改</label><label><input type="checkbox" class="perm-act-head" data-act="delete" /> 删除</label></span>';
  container.appendChild(header);
  // 表头 checkbox 事件：全选/全不选该列
  header.querySelectorAll('.perm-act-head').forEach(cb => {
    cb.addEventListener('change', () => {
      container.querySelectorAll('.perm-act[data-act="' + cb.dataset.act + '"]').forEach(c => c.checked = cb.checked);
    });
  });
  // 每行一个页面
  const isAllMode = $('rbacPermAll').checked;
  for (const p of allPages) {
    // 通配模式下用通配权限的 actions，否则用该页面自己的权限
    const perm = wildcardPerm || rolePerms.find(rp => rp.pageId === p.id);
    const actions = perm ? perm.actions : [];
    const row = document.createElement('div');
    row.className = 'rbac-perm-row';
    row.dataset.pageId = p.id;
    row.innerHTML = `<span class="rbac-perm-page" title="${escapeHtml(p.name)}">${escapeHtml(p.icon || '')} ${escapeHtml(p.name)}</span><span class="rbac-perm-actions"><label><input type="checkbox" class="perm-act" data-act="read" ${actions.includes('read') ? 'checked' : ''} /> 查看</label><label><input type="checkbox" class="perm-act" data-act="update" ${actions.includes('update') ? 'checked' : ''} /> 修改</label><label><input type="checkbox" class="perm-act" data-act="delete" ${actions.includes('delete') ? 'checked' : ''} /> 删除</label></span>`;
    // 通配模式下禁用行 checkbox
    if (isAllMode) {
      row.querySelectorAll('.perm-act').forEach(cb => { cb.checked = true; cb.disabled = true; });
    }
    container.appendChild(row);
  }
  // 通配模式下显示提示
  if (isAllMode) {
    const hint = document.createElement('p');
    hint.id = 'rbacPermAllHint';
    hint.className = 'rbac-perm-all-hint';
    hint.textContent = '✓ 后续新增的页面也会自动继承以上勾选的查看、修改、删除权限';
    container.parentNode.insertBefore(hint, container.nextSibling);
  }
}

function collectPermFromTable() {
  const isAll = $('rbacPermAll').checked;
  const permissions = [];
  if (isAll) {
    // 通配权限：从表头 checkbox 收集（仅 read/update/delete）
    const actions = [];
    $('rbacPermTable').querySelectorAll('.perm-act-head').forEach(cb => {
      if (cb.checked) actions.push(cb.dataset.act);
    });
    if (actions.length > 0) permissions.push({ pageId: '*', actions });
  } else {
    // 逐页收集（仅 read/update/delete）
    $('rbacPermTable').querySelectorAll('.rbac-perm-row[data-page-id]').forEach(row => {
      const actions = [];
      row.querySelectorAll('.perm-act').forEach(cb => {
        if (cb.checked) actions.push(cb.dataset.act);
      });
      if (actions.length > 0) {
        permissions.push({ pageId: row.dataset.pageId, actions });
      }
    });
  }
  // 独立的「新增页面」权限（全局，不绑定具体页面）
  if ($('rbacPermCreate').checked) {
    permissions.push({ pageId: '*', actions: ['create'] });
  }
  return permissions;
}

async function saveRole() {
  const name = $('rbacRoleName').value.trim();
  const desc = $('rbacRoleDesc').value.trim();
  const permissions = collectPermFromTable();
  $('rbacRoleError').classList.add('hidden');
  if (!name) {
    $('rbacRoleError').textContent = '角色名称不能为空';
    $('rbacRoleError').classList.remove('hidden');
    return;
  }
  const body = { name, description: desc, permissions };
  try {
    if (editingRoleId) {
      await rbacApi('/roles/' + editingRoleId, { method: 'PUT', body: JSON.stringify(body) });
      showToast('角色已更新');
    } else {
      await rbacApi('/roles', { method: 'POST', body: JSON.stringify(body) });
      showToast('角色已创建');
    }
    closeRoleModal();
    await loadAndRenderRbac();
  } catch (err) {
    $('rbacRoleError').textContent = err.message;
    $('rbacRoleError').classList.remove('hidden');
  }
}

async function deleteRole(role) {
  const assignedCount = rbacAssignments.filter(a => a.roleId === role.id).length;
  const hint = assignedCount > 0 ? `，当前有 ${assignedCount} 个用户绑定了该角色，删除后绑定关系将一并清除` : '';
  if (!confirm(`确定要删除角色「${role.name}」吗${hint}？`)) return;
  try {
    await rbacApi('/roles/' + role.id, { method: 'DELETE' });
    showToast('角色已删除');
    await loadAndRenderRbac();
  } catch (err) {
    showToast(err.message);
  }
}

// 邮箱分配弹窗
function openAssignModal() {
  $('rbacAssignEmail').value = '';
  $('rbacAssignError').classList.add('hidden');
  // 填充分角色下拉
  const sel = $('rbacAssignRole');
  sel.innerHTML = rbacRoles.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
  if (rbacRoles.length === 0) {
    $('rbacAssignError').textContent = '请先创建角色';
    $('rbacAssignError').classList.remove('hidden');
  }
  $('rbacAssignModal').classList.remove('hidden');
  setTimeout(() => $('rbacAssignEmail').focus(), 50);
}

function closeAssignModal() {
  $('rbacAssignModal').classList.add('hidden');
}

async function addAssignment() {
  const email = $('rbacAssignEmail').value.trim();
  const roleId = $('rbacAssignRole').value;
  $('rbacAssignError').classList.add('hidden');
  if (!email) {
    $('rbacAssignError').textContent = '邮箱不能为空';
    $('rbacAssignError').classList.remove('hidden');
    return;
  }
  if (!roleId) {
    $('rbacAssignError').textContent = '请选择角色';
    $('rbacAssignError').classList.remove('hidden');
    return;
  }
  try {
    await rbacApi('/assignments', { method: 'POST', body: JSON.stringify({ email, roleId }) });
    showToast('角色已分配');
    closeAssignModal();
    await loadAndRenderRbac();
  } catch (err) {
    $('rbacAssignError').textContent = err.message;
    $('rbacAssignError').classList.remove('hidden');
  }
}

async function removeAssignment(a) {
  if (!confirm(`确定要移除「${a.email}」的角色绑定吗？`)) return;
  try {
    await rbacApi('/assignments/' + encodeURIComponent(a.email) + '/' + a.roleId, { method: 'DELETE' });
    showToast('已移除');
    await loadAndRenderRbac();
  } catch (err) {
    showToast(err.message);
  }
}

// RBAC 弹窗事件绑定
$('rbacNewRoleBtn').addEventListener('click', () => openRoleModal());
$('rbacRoleModalClose').addEventListener('click', closeRoleModal);
$('rbacRoleCancelBtn').addEventListener('click', closeRoleModal);
$('rbacRoleModal').addEventListener('click', e => { if (e.target === $('rbacRoleModal')) closeRoleModal(); });
$('rbacRoleSaveBtn').addEventListener('click', saveRole);
$('rbacPermAll').addEventListener('change', () => {
  const isAll = $('rbacPermAll').checked;
  $('rbacPermTable').classList.toggle('rbac-perm-all-mode', isAll);
  // 显示/隐藏通配提示
  let hint = $('rbacPermAllHint');
  if (isAll && !hint) {
    hint = document.createElement('p');
    hint.id = 'rbacPermAllHint';
    hint.className = 'rbac-perm-all-hint';
    hint.textContent = '✓ 后续新增的页面也会自动继承以上勾选的查看、修改、删除权限';
    $('rbacPermTable').parentNode.insertBefore(hint, $('rbacPermTable').nextSibling);
  } else if (!isAll && hint) {
    hint.remove();
  }
  if (isAll) {
    // 全选模式下所有行 checkbox 禁用并全选
    $('rbacPermTable').querySelectorAll('.perm-act').forEach(cb => { cb.checked = true; cb.disabled = true; });
  } else {
    $('rbacPermTable').querySelectorAll('.perm-act').forEach(cb => { cb.disabled = false; });
  }
});

$('rbacNewAssignBtn').addEventListener('click', () => openAssignModal());
$('rbacAssignModalClose').addEventListener('click', closeAssignModal);
$('rbacAssignCancelBtn').addEventListener('click', closeAssignModal);
$('rbacAssignModal').addEventListener('click', e => { if (e.target === $('rbacAssignModal')) closeAssignModal(); });
$('rbacAssignSaveBtn').addEventListener('click', addAssignment);

// ---------- Markdown 右侧原地编辑 ----------
function enterMdEdit() {
  const page = pages.find(p => p.id === activeId);
  if (!page || page.type !== 'markdown') return;
  mdEditing = true;
  mdEditor.value = page.content || '';
  mdBody.classList.add('hidden');
  mdEditor.classList.remove('hidden');
  mdView.classList.add('editing');
  mdView.scrollTop = 0;
  mdEditor.focus();
  // 切换工具栏按钮
  mdEditBtn.classList.add('hidden');
  mdSaveBtn.classList.remove('hidden');
  mdCancelBtn.classList.remove('hidden');
}

function exitMdEdit() {
  mdEditing = false;
  mdEditor.classList.add('hidden');
  mdBody.classList.remove('hidden');
  mdView.classList.remove('editing');
  // 切换工具栏按钮
  mdSaveBtn.classList.add('hidden');
  mdCancelBtn.classList.add('hidden');
  // 编辑按钮的显隐由权限决定，在 showPage 中已处理
  const page = pages.find(p => p.id === activeId);
  if (page && page.type === 'markdown') {
    mdEditBtn.classList.toggle('hidden', !canEditPage(page.id));
  }
}

function isMdDirty() {
  const page = pages.find(p => p.id === activeId);
  return mdEditing && page && mdEditor.value !== (page.content || '');
}

// ---------- 页面专属文档 ----------
async function openPageDoc(page) {
  if (!confirmDiscardIfEditing()) return;
  viewingPageDoc = true;
  docPageId = page.id;
  docEditing = false;
  currentView = 'page';

  // 切换右侧视图
  iframeWrap.classList.add('hidden');
  customView.classList.add('hidden');
  mdView.classList.remove('hidden');
  welcomeView.classList.add('hidden');
  settingsView.classList.add('hidden');
  exitMdEdit();

  // 更新工具栏
  mdToolbarIcon.textContent = '📄';
  mdToolbarTitle.textContent = page.name + ' - 文档';
  mdEditBtn.classList.remove('hidden');
  mdSaveBtn.classList.add('hidden');
  mdCancelBtn.classList.add('hidden');

  // 加载文档内容
  try {
    const doc = await api('/' + page.id + '/doc');
    docContent = doc.content || '';
    if (docContent) {
      mdBody.innerHTML = marked.parse(docContent);
    } else {
      mdBody.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px 0;">暂无文档，点击右上角「编辑」开始编写</p>';
    }
  } catch (err) {
    showToast('加载文档失败: ' + err.message);
    docContent = '';
    mdBody.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px 0;">暂无文档</p>';
  }
  mdView.scrollTop = 0;
  loadingMask.classList.add('fade-out');
  updateSidebarTrigger();
  saveViewState();
}

function enterDocEdit() {
  if (!docPageId) return;
  docEditing = true;
  mdEditor.value = docContent || '';
  mdBody.classList.add('hidden');
  mdEditor.classList.remove('hidden');
  mdView.classList.add('editing');
  mdView.scrollTop = 0;
  mdEditor.focus();
  mdEditBtn.classList.add('hidden');
  mdSaveBtn.classList.remove('hidden');
  mdCancelBtn.classList.remove('hidden');
}

function exitDocEdit() {
  docEditing = false;
  mdEditor.classList.add('hidden');
  mdBody.classList.remove('hidden');
  mdView.classList.remove('editing');
  mdSaveBtn.classList.add('hidden');
  mdCancelBtn.classList.add('hidden');
  mdEditBtn.classList.remove('hidden');
}

function isDocDirty() {
  return docEditing && mdEditor.value !== (docContent || '');
}

async function saveDocEdit() {
  if (!docPageId) return;
  const content = mdEditor.value;
  try {
    const result = await api('/' + docPageId + '/doc', {
      method: 'PUT',
      body: JSON.stringify({ content })
    });
    docContent = result.content || '';
    exitDocEdit();
    if (docContent) {
      mdBody.innerHTML = marked.parse(docContent);
    } else {
      mdBody.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px 0;">暂无文档，点击右上角「编辑」开始编写</p>';
    }
    showToast('文档已保存');
    // 刷新侧边栏以更新 hasDoc 状态
    await refresh();
  } catch (err) {
    showToast(err.message);
  }
}

function exitDocView() {
  viewingPageDoc = false;
  docPageId = null;
  docEditing = false;
  docContent = '';
  exitDocEdit();
}

// 编辑中离开页面前的丢弃确认（包含文档编辑状态）
function confirmDiscardIfEditing() {
  if (mdEditing && isMdDirty()) {
    return confirm('文档内容尚未保存，确定要离开吗？');
  }
  if (docEditing && isDocDirty()) {
    return confirm('文档内容尚未保存，确定要离开吗？');
  }
  return true;
}

async function saveMdEdit() {
  const page = pages.find(p => p.id === activeId);
  if (!page) return;
  const content = mdEditor.value;
  if (!content.trim()) {
    showToast('Markdown 内容不能为空');
    return;
  }
  try {
    const updated = await api('/' + page.id, {
      method: 'PUT',
      body: JSON.stringify({ content })
    });
    Object.assign(page, updated);
    exitMdEdit();
    renderMarkdown(page);
    showToast('文档已保存');
  } catch (err) {
    showToast(err.message);
  }
}

// 编辑模式下 Ctrl+S 保存
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    if (mdEditing) {
      e.preventDefault();
      saveMdEdit();
    } else if (docEditing) {
      e.preventDefault();
      saveDocEdit();
    }
  }
});

// 工具栏按钮事件
mdEditBtn.addEventListener('click', () => {
  if (viewingPageDoc) {
    enterDocEdit();
  } else {
    enterMdEdit();
  }
});
mdSaveBtn.addEventListener('click', () => {
  if (viewingPageDoc) {
    saveDocEdit();
  } else {
    saveMdEdit();
  }
});
mdCancelBtn.addEventListener('click', () => {
  if (viewingPageDoc) {
    if (isDocDirty() && !confirm('内容尚未保存，确定要放弃修改吗？')) return;
    exitDocEdit();
  } else {
    if (isMdDirty() && !confirm('内容尚未保存，确定要放弃修改吗？')) return;
    exitMdEdit();
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
  const isDirect = type === 'direct';
  const isIframe = type === 'iframe';
  const needUrl = isLink || isDirect || isIframe;
  $('urlField').classList.toggle('hidden', !needUrl);
  // 直链和直接嵌入只显示 URL，不显示高级配置（认证/代理/DNS）
  $('resolveIpField').classList.toggle('hidden', !isLink);
  $('proxyModeField').classList.toggle('hidden', !isLink);
  $('authField').classList.toggle('hidden', !isLink);
  $('customFileField').classList.toggle('hidden', type !== 'custom');
  $('fieldUrl').required = needUrl;
  // 更新 URL 标签文字
  const urlLabel = $('urlField').querySelector('label');
  if (urlLabel) {
    urlLabel.innerHTML = isDirect
      ? '目标链接 <span class="required">*</span>'
      : isIframe
        ? '嵌入链接 <span class="required">*</span>'
        : '嵌入链接 <span class="required">*</span>';
  }
  // markdown 页面的正文统一在右侧原地编辑，弹窗不提供内容输入
}

document.querySelectorAll('.type-opt').forEach(btn => {
  btn.addEventListener('click', () => setType(btn.dataset.type));
});

// 认证开关：勾选后展开认证配置区
$('authEnabled').addEventListener('change', () => {
  $('authBox').classList.toggle('hidden', !$('authEnabled').checked);
});

// 认证模式切换：basic/login 显示账号密码，header 显示自定义头，oauth 显示客户端凭证，login 额外显示登录路径与请求格式
function setAuthMode(mode) {
  $('authMode').value = mode;
  $('authUserPass').classList.toggle('hidden', mode === 'header' || mode === 'oauth');
  $('authLoginPath').classList.toggle('hidden', mode !== 'login');
  $('authLoginOpts').classList.toggle('hidden', mode !== 'login');
  $('authHeaderInputs').classList.toggle('hidden', mode !== 'header');
  $('authOAuthFields').classList.toggle('hidden', mode !== 'oauth');
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
  $('fieldResolveIp').value = page ? (page.resolveIp || '') : '';
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
  $('authTokenUrl').value = hasAuth ? (page.auth.tokenUrl || '') : '';
  $('authClientId').value = hasAuth ? (page.auth.clientId || '') : '';
  $('authClientSecret').value = hasAuth ? (page.auth.clientSecret || '') : '';
  $('authScope').value = hasAuth ? (page.auth.scope || '') : '';
  fillGroupSelect(page ? page.group : (groups[0] || '未分组'));
  setType(page ? page.type || 'link' : 'link');
  // 重置弹窗文件管理状态
  modalFileInput.value = '';
  customFiles = [];
  modalFileList.innerHTML = '';
  // 编辑 custom 页面时加载已有文件
  if (page && page.type === 'custom') {
    loadModalFiles(page.id);
  }
  formError.classList.add('hidden');
  modalOverlay.classList.remove('hidden');
  setTimeout(() => $('fieldName').focus(), 50);
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  editingId = null;
  customFiles = [];
  modalFileList.innerHTML = '';
  modalFileInput.value = '';
}

$('pageForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = {
    type: currentType,
    name: $('fieldName').value.trim(),
    icon: $('fieldIcon').value.trim() || ({ markdown: '📝', custom: '🖥️', direct: '🔗', iframe: '🖼️' }[currentType] || '🔗'),
    group: $('fieldGroup').value || '未分组'
  };
  if (currentType === 'link') {
    body.url = $('fieldUrl').value.trim();
    body.proxyMode = $('fieldProxyMode').value;
    // 始终传递 resolveIp（空字符串时后端会删除该字段）
    body.resolveIp = $('fieldResolveIp').value.trim();
    // 认证配置：勾选时按所选模式提交，未勾选时显式清除
    if ($('authEnabled').checked) {
      const mode = $('authMode').value;
      if (mode === 'header') {
        body.auth = {
          mode,
          headerName: $('authHeaderName').value.trim(),
          headerValue: $('authHeaderValue').value.trim()
        };
      } else if (mode === 'oauth') {
        body.auth = {
          mode,
          tokenUrl: $('authTokenUrl').value.trim(),
          clientId: $('authClientId').value.trim(),
          clientSecret: $('authClientSecret').value
        };
        const scope = $('authScope').value.trim();
        if (scope) body.auth.scope = scope;
      } else {
        body.auth = { mode, username: $('authUser').value.trim(), password: $('authPass').value };
        if (mode === 'login') {
          body.auth.loginPath = $('authLoginPath').value.trim() || '/login';
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
  } else if (currentType === 'direct' || currentType === 'iframe') {
    body.url = $('fieldUrl').value.trim();
  }
  const saveBtn = $('saveBtn');
  saveBtn.disabled = true;
  try {
    if (editingId) {
      await api('/' + editingId, { method: 'PUT', body: JSON.stringify(body) });
      showToast('页面已更新');
    } else {
      const created = await api('', { method: 'POST', body: JSON.stringify(body) });
      editingId = created.id; // 保存 ID 以便后续上传文件
      activeId = created.id;
      currentView = 'page';
      showToast('页面已创建，现在可以上传文件');
      // 新建 custom 页面后，加载文件列表（此时只有默认 index.html）
      if (currentType === 'custom') {
        await loadModalFiles(created.id);
      }
    }
    // custom 页面不关闭弹窗，允许继续上传文件；其他类型正常关闭
    if (currentType !== 'custom') {
      closeModal();
    }
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

// ---------- 弹窗内自定义页面文件管理 ----------
async function loadModalFiles(pageId) {
  try {
    const res = await authenticatedFetch('/hilbert-api/pages/' + pageId + '/files', {
      headers: { 'Content-Type': 'application/json' }
    });
    customFiles = await res.json();
    renderModalFileList(pageId);
  } catch (err) {
    showToast('加载文件列表失败: ' + err.message);
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderModalFileList(pageId) {
  modalFileList.innerHTML = '';
  if (customFiles.length === 0) {
    modalFileList.innerHTML = '<li class="file-empty">暂无文件，请上传</li>';
    return;
  }
  const page = pages.find(p => p.id === pageId);
  const entry = page ? (page.entry || 'index.html') : 'index.html';
  for (const f of customFiles) {
    const li = document.createElement('li');
    li.className = 'file-item';
    const isEntry = f.name === entry;
    li.innerHTML = `
      <span class="file-name">${escapeHtml(f.name)}${isEntry ? ' <em class="file-entry-badge">入口</em>' : ''}</span>
      <span class="file-size">${formatFileSize(f.size)}</span>
      <span class="file-actions">
        ${!isEntry ? '<button class="file-del-btn" title="删除">✕</button>' : ''}
      </span>`;
    if (!isEntry) {
      li.querySelector('.file-del-btn').addEventListener('click', () => deleteModalFile(pageId, f.name));
    }
    modalFileList.appendChild(li);
  }
}

async function uploadModalFiles() {
  if (!editingId) {
    showToast('请先保存页面配置');
    return;
  }
  const files = modalFileInput.files;
  if (!files.length) return;
  const formData = new FormData();
  for (const f of files) formData.append('files', f);
  try {
    const res = await authenticatedFetch('/hilbert-api/pages/' + editingId + '/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '上传失败');
    showToast('已上传 ' + data.uploaded.length + ' 个文件');
    modalFileInput.value = '';
    await loadModalFiles(editingId);
    // 刷新预览 iframe
    const page = pages.find(p => p.id === editingId);
    if (page) customFrame.src = '/hilbert-custom/' + editingId + '/' + (page.entry || 'index.html') + '?t=' + Date.now();
  } catch (err) {
    showToast(err.message);
  }
}

async function deleteModalFile(pageId, filename) {
  if (!confirm('确定要删除文件「' + filename + '」吗？')) return;
  try {
    const res = await authenticatedFetch('/hilbert-api/pages/' + pageId + '/files/' + encodeURIComponent(filename), { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '删除失败');
    showToast('文件已删除');
    await loadModalFiles(pageId);
    const page = pages.find(p => p.id === pageId);
    if (page) customFrame.src = '/hilbert-custom/' + pageId + '/' + (page.entry || 'index.html') + '?t=' + Date.now();
  } catch (err) {
    showToast(err.message);
  }
}

// 弹窗文件上传事件
$('modalFileUploadZone').addEventListener('click', () => modalFileInput.click());
modalFileInput.addEventListener('change', uploadModalFiles);
modalFileUploadZone.addEventListener('dragover', e => { e.preventDefault(); modalFileUploadZone.classList.add('dragover'); });
modalFileUploadZone.addEventListener('dragleave', () => modalFileUploadZone.classList.remove('dragover'));
modalFileUploadZone.addEventListener('drop', e => {
  e.preventDefault();
  modalFileUploadZone.classList.remove('dragover');
  const dt = e.dataTransfer;
  if (dt.files.length) {
    modalFileInput.files = dt.files;
    uploadModalFiles();
  }
});

// ---------- 侧边栏 hover 自动展开/收起 + 常驻模式 ----------
let sidebarCollapseTimer = null;
let sidebarPinned = false;

// 从 localStorage 恢复常驻状态
try {
  sidebarPinned = localStorage.getItem('hilbert_sidebar_pinned') === '1';
} catch { /* 忽略 */ }

function applySidebarPinState() {
  document.body.classList.toggle('sidebar-pinned', sidebarPinned);
  const btn = $('sidebarPinBtn');
  btn.classList.toggle('pinned', sidebarPinned);
  btn.title = sidebarPinned ? '取消常驻' : '侧边栏常驻';
  if (sidebarPinned) {
    // 常驻模式：展开侧边栏
    $('sidebar').classList.remove('collapsed');
  }
}

// 初始应用
applySidebarPinState();

$('sidebarPinBtn').addEventListener('click', () => {
  sidebarPinned = !sidebarPinned;
  try {
    localStorage.setItem('hilbert_sidebar_pinned', sidebarPinned ? '1' : '0');
  } catch { /* 忽略 */ }
  applySidebarPinState();
});

function updateSidebarTrigger() {
  const trigger = $('sidebarTrigger');
  // 所有页面都显示触发区域，允许 hover 展开侧边栏
  trigger.classList.remove('hidden');
}

$('sidebarTrigger').addEventListener('mouseenter', () => {
  clearTimeout(sidebarCollapseTimer);
  $('sidebar').classList.remove('collapsed');
});

$('sidebarTrigger').addEventListener('mouseleave', () => {
  // 延迟收起，等待侧边栏滑出动画完成后再判断
  sidebarCollapseTimer = setTimeout(() => {
    if (!sidebarPinned) $('sidebar').classList.add('collapsed');
  }, 300);
});

$('sidebar').addEventListener('mouseenter', () => {
  clearTimeout(sidebarCollapseTimer);
});

$('sidebar').addEventListener('mouseleave', () => {
  if (!sidebarPinned) $('sidebar').classList.add('collapsed');
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
    // 加载当前用户信息（Google 账号）+ 管理员状态 + 权限
    const meRes = await authenticatedFetch('/hilbert-api/me');
    if (meRes.ok) {
      const me = await meRes.json();
      if (me.picture) {
        userAvatar.src = me.picture;
        userAvatar.alt = me.name || '';
      }
      userName.textContent = me.name || 'Admin';
      userEmail.textContent = me.email || '';
      isAdmin = !!me.isAdmin;
      currentUserEmail = me.email || '';
      await loadFavorites();
    }
    // 加载权限
    const permRes = await authenticatedFetch('/hilbert-api/my-permissions');
    if (permRes.ok) {
      const permData = await permRes.json();
      isAdmin = !!permData.isAdmin;
      myPermissions = permData.permissions;
    }
  } catch (_) { /* 用户信息加载失败不影响主流程 */ }

  try {
    [pages, groups] = await Promise.all([api(''), groupsApi()]);
  } catch (err) {
    showToast('加载失败：' + err.message);
    return;
  }
  renderSidebar();
  // 优先从 URL 检测当前页面（/page/:id 格式）
  const pathMatch = location.pathname.match(/^\/page\/([^/]+)/);
  if (pathMatch) {
    const urlPageId = decodeURIComponent(pathMatch[1]);
    const target = pages.find(p => p.id === urlPageId);
    if (target && target.type !== 'direct') {
      activeId = urlPageId;
      currentView = 'page';
      showPage(target);
      renderSidebar();
    } else {
      showWelcome();
    }
  } else {
    const saved = restoreViewState();
    if (saved && saved.view === 'settings' && isAdmin) {
      showSettings();
    } else if (saved && saved.view === 'page' && saved.activeId) {
      const target = pages.find(p => p.id === saved.activeId);
      if (target && target.type !== 'direct') {
        activeId = saved.activeId;
        currentView = 'page';
        showPage(target);
        renderSidebar();
      } else {
        showWelcome();
      }
    } else {
      showWelcome(); // 无保存状态时默认欢迎页
    }
  }

  // 加载版本号
  try {
    const vRes = await authenticatedFetch('/hilbert-api/version', { headers: { 'Content-Type': 'application/json' } });
    const vData = await vRes.json();
    $('versionBadge').textContent = 'v' + vData.version;
  } catch (_) { /* ignore */ }
}

init();

// 浏览器前进/后退导航
window.addEventListener('popstate', () => {
  const match = location.pathname.match(/^\/page\/([^/]+)/);
  if (match) {
    const pageId = decodeURIComponent(match[1]);
    selectPage(pageId, true);
  } else {
    showWelcome();
  }
});

// ---------- 登出 ----------
logoutBtn.addEventListener('click', async () => {
  try {
    await authenticatedFetch('/hilbert-api/logout', { method: 'POST' });
  } catch (_) {}
  window.location.href = '/login.html';
});
