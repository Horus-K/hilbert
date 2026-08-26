// ---------- 状态 ----------
let pages = [];
let groups = [];
let activeId = null;
let editingId = null; // null 表示新建模式
let deletingId = null;
let currentType = 'link'; // 弹窗中当前选择的页面类型
let mdEditing = false; // 是否处于 Markdown 右侧编辑模式
let markdownEditor = null; // Vditor 实例，Markdown 页面和页面文档共用
let currentView = 'welcome'; // welcome | page | settings
let customFiles = [];
let isAdmin = false;          // 当前用户是否超级管理员
let myPermissions = null;     // 当前用户权限缓存 [{ pageId, actions }]
let rbacRoles = [];           // RBAC 角色列表
let rbacAssignments = [];     // RBAC 分配列表
let editingRoleId = null;     // 当前编辑的角色 ID（null 为新建）
let favorites = [];           // 当前用户收藏的页面 ID 列表
let currentUserEmail = '';    // 当前用户邮箱（用于 localStorage 隔离）
let proxyRoutingMode = 'mount'; // host = 逐页面子域名；mount = 旧版共享 origin 挂载路径
let collapsedGroups = [];     // 已折叠的分组名列表（默认全部折叠）
let viewingPageDoc = false;   // 是否正在查看页面专属文档
let docPageId = null;         // 当前查看文档的页面 ID
let docEditing = false;       // 是否处于文档编辑模式
let docContent = '';          // 当前文档内容
let pageSearchQuery = '';     // 侧边栏页面名称搜索

// ---------- 标签页状态 ----------
let tabs = [];                // 已打开的标签列表 [{ id, pageId, viewType, title, icon, mdContent, scrollTop }]
let activeTabId = null;       // 当前激活的标签 ID

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
const mdCloseBtn = $('mdCloseBtn');
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
const userDisplayName = $('userDisplayName');
const userEmail = $('userEmail');
const userGroups = $('userGroups');
const logoutBtn = $('logoutBtn');
const tabPanels = $('tabPanels');
const tabBar = $('tabBar');
const tabList = $('tabList');

function renderMarkdownSafely(content) {
  const html = marked.parse(content || '');
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['form', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style']
  });
}

const modalOverlay = $('modalOverlay');
const confirmOverlay = $('confirmOverlay');
const formError = $('formError');
const toast = $('toast');

function renderPageLogo(container, page, fallback) {
  const logo = getPageLogo(page, fallback);
  container.textContent = logo.text;
  if (!logo.src) return;
  const image = document.createElement('img');
  image.className = 'page-logo';
  image.src = logo.src;
  image.alt = '';
  image.addEventListener('error', () => { container.textContent = page.icon || fallback; });
  container.replaceChildren(image);
}

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

async function opsApi(path = '', options = {}) {
  const res = await authenticatedFetch('/hilbert-api/ops' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `请求失败 (${res.status})`);
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
  const pinnedPages = pages.filter(p => p.pinned && (isAdmin || canReadPage(p.id)) && matchesPageSearch(p, pageSearchQuery));
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
      <span class="item-icon"></span>
      <span class="item-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
      <span class="item-type-badge">${p.type === 'markdown' ? 'MD' : p.type === 'custom' ? 'CM' : p.type === 'direct' ? 'DL' : p.type === 'iframe' ? 'IF' : ''}</span>`;

    renderPageLogo(item.querySelector('.item-icon'), p, p.type === 'markdown' ? '📝' : '🔗');
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
  const visiblePages = favPages.filter(p => (isAdmin || canReadPage(p.id)) && matchesPageSearch(p, pageSearchQuery));
  favoritesCount.textContent = visiblePages.length || '';
  if (visiblePages.length === 0) {
    favoritesSection.classList.add('empty');
    const hint = document.createElement('div');
    hint.className = 'favorites-empty-hint';
    hint.textContent = pageSearchQuery ? '没有匹配的收藏页面' : '点击页面更多操作添加收藏';
    favoritesList.appendChild(hint);
    return;
  }
  favoritesSection.classList.remove('empty');
  for (const p of visiblePages) {
    const item = document.createElement('div');
    item.className = 'fav-item' + (p.id === activeId ? ' active' : '');
    item.innerHTML = `
      <span class="fav-indicator"></span>
      <span class="item-icon"></span>
      <span class="item-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
      <button class="fav-remove-btn" title="取消收藏">★</button>`;
    renderPageLogo(item.querySelector('.item-icon'), p, p.type === 'markdown' ? '📝' : '🔗');
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

function toggleGroupCollapse(groupId) {
  if (collapsedGroups === null) {
    // 首次操作：从全部折叠状态开始切换
    // 获取所有分组名，除了当前分组外其他都保持折叠
    collapsedGroups = groups.map(g => g.id).filter(id => id !== groupId);
  } else {
    const idx = collapsedGroups.indexOf(groupId);
    if (idx >= 0) {
      collapsedGroups.splice(idx, 1); // 展开
    } else {
      collapsedGroups.push(groupId); // 折叠
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
    groupMap.set(g.id, { name: g.name, items: [] });
  }
  groupMap.set('', { name: '未分组', items: [] });
  for (const p of pages.filter(p => matchesPageSearch(p, pageSearchQuery))) {
    // 非管理员：过滤无 read 权限的页面
    if (!isAdmin && !canReadPage(p.id)) continue;
    const groupId = p.groupId || '';
    if (!groupMap.has(groupId)) groupMap.set(groupId, { name: '未分组', items: [] });
    groupMap.get(groupId).items.push(p);
  }

  // 加载折叠状态（默认全部折叠）
  loadCollapsedGroups();

  for (const [groupId, { name: groupName, items }] of groupMap) {
    if (items.length === 0) continue; // 跳过空分组
    // collapsedGroups 为 null 表示默认全部折叠
    const isCollapsed = !pageSearchQuery && (collapsedGroups === null || collapsedGroups.includes(groupId));
    
    // 分组标题（可点击折叠/展开）
    const title = document.createElement('div');
    title.className = 'group-title' + (isCollapsed ? ' collapsed' : '');
    title.innerHTML = `<span class="group-arrow">${isCollapsed ? '▶' : '▼'}</span><span class="group-name-text">${escapeHtml(groupName)}</span>`;
    title.addEventListener('click', () => toggleGroupCollapse(groupId));
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
      item.className = 'page-item' + (p.id === activeId ? ' active' : '') + (isDirect ? ' is-direct' : '') + (isPinned ? ' is-pinned' : '') + (p.hasDoc && p.type !== 'markdown' ? ' has-doc' : '');
      item.innerHTML = `
        <span class="item-icon"></span>
        <span class="item-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
        <span class="item-type-badge">${p.type === 'markdown' ? 'MD' : p.type === 'custom' ? 'CM' : p.type === 'direct' ? 'DL' : p.type === 'iframe' ? 'IF' : ''}</span>
        <span class="item-actions">
          ${p.type !== 'markdown' ? '<button class="page-doc-btn' + (p.hasDoc ? ' active' : '') + (viewingPageDoc && docPageId === p.id ? ' viewing' : '') + '" title="页面文档">📄</button>' : ''}
          <button class="more" title="更多操作">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
          </button>
          <div class="item-menu">
            <button class="menu-fav">${isFav ? '★ 取消收藏' : '☆ 添加收藏'}</button>
            ${isAdmin ? `<button class="menu-pin">${isPinned ? '📌 取消置顶' : '📍 置顶'}</button>` : ''}
            ${p.type === 'link' ? '<button class="menu-open-external">↗ 在新标签页打开</button>' : ''}
            ${canCopy ? '<button class="menu-copy">复制</button>' : ''}
            ${canEdit ? '<button class="menu-edit">编辑</button>' : ''}
            ${canDel ? '<button class="menu-del danger">删除</button>' : ''}
          </div>
        </span>`;

      renderPageLogo(item.querySelector('.item-icon'), p, p.type === 'markdown' ? '📝' : '🔗');
      // 点击事件：直链页面在新标签页打开
      item.addEventListener('click', () => {
        if (isDirect) {
          window.open(p.url, '_blank');
          return;
        }
        selectPage(p.id);
      });
      // 文档按钮（仅非 markdown 页面有）
      const docBtn = item.querySelector('.page-doc-btn');
      if (docBtn) {
        docBtn.addEventListener('click', e => {
          e.stopPropagation();
          // 再次点击同一页面文档按钮时关闭文档
          if (viewingPageDoc && docPageId === p.id) {
            if (!confirmDiscardIfEditing()) return;
            exitDocView();
            renderSidebar();
            showPage(p);
            return;
          }
          openPageDoc(p);
        });
      }
      // 收藏按钮（在更多操作菜单内）
      const favMenuItem = item.querySelector('.menu-fav');
      if (favMenuItem) {
        favMenuItem.addEventListener('click', e => {
          e.stopPropagation();
          toggleFavorite(p.id);
        });
      }
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
      const openExternalBtn = menu.querySelector('.menu-open-external');
      if (openExternalBtn) openExternalBtn.addEventListener('click', () => {
        closeAllItemMenus();
        window.open(p.proxyUrl || p.url, '_blank', 'noopener');
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
  const page = pages.find(p => p.id === id);
  if (!page) return;
  if (page.type === 'direct') { window.open(page.url, '_blank'); return; }
  // 已打开且是当前标签：忽略（编辑中除外）
  const existingTab = tabs.find(t => t.pageId === id);
  if (existingTab && existingTab.id === activeTabId && !mdEditing && !docEditing && !viewingPageDoc) return;
  if (!confirmDiscardIfEditing()) return;
  openTab(page, skipPushState);
}

// ==================== 标签页管理 ====================

function renderTabs() {
  tabList.innerHTML = '';
  if (tabs.length === 0) {
    tabBar.classList.remove('visible');
    return;
  }
  tabBar.classList.add('visible');
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab-item' + (tab.id === activeTabId ? ' active' : '');
    el.innerHTML = `<span class="tab-icon"></span><span class="tab-title">${escapeHtml(tab.title)}</span><button class="tab-close" title="关闭标签">×</button>`;
    renderPageLogo(el.querySelector('.tab-icon'), tab, '🔗');
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) return;
      if (tab.id !== activeTabId) {
        if (!confirmDiscardIfEditing()) return;
        activateTab(tab.id, 'push');
      }
    });
    el.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    tabList.appendChild(el);
  }
  // 滚动到激活的标签
  const activeEl = tabList.querySelector('.tab-item.active');
  if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
}

function openTab(page, skipPushState) {
  // 检查是否已有该页面的标签
  const existing = tabs.find(t => t.pageId === page.id);
  if (existing) {
    activateTab(existing.id, skipPushState ? null : 'push');
    return;
  }
  // 创建新标签
  const tabId = 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const viewType = (page.type === 'markdown') ? 'markdown' : (page.type === 'custom') ? 'custom' : 'iframe';
  const tab = {
    id: tabId,
    pageId: page.id,
    viewType: viewType,
    title: page.name,
    icon: page.icon || (page.type === 'markdown' ? '📝' : '🔗'),
    logo: page.logo || '',
    mdContent: null,
    scrollTop: 0
  };
  // Markdown 页面预渲染内容
  if (page.type === 'markdown') {
    tab.mdContent = renderMarkdownSafely(page.content);
  }
  tabs.push(tab);
  // 为 iframe/custom 标签创建独立面板（保留在 DOM 中以保持状态）
  if (viewType === 'iframe' || viewType === 'custom') {
    const panel = document.createElement('div');
    panel.className = 'tab-panel';
    panel.id = 'panel-' + tabId;
    panel.innerHTML = '<div class="loading-mask"><div class="spinner"></div><p>页面加载中…</p></div>';
    tabPanels.appendChild(panel);
  }
  activateTab(tabId, skipPushState ? null : 'push');
}

function updatePageHistory(pageId, mode) {
  if (!mode) return;
  const state = { pageId };
  const path = '/page/' + encodeURIComponent(pageId);
  if (mode === 'replace') history.replaceState(state, '', path);
  else history.pushState(state, '', path);
}

function activateTab(tabId, historyMode = null) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;
  activeTabId = tabId;
  activeId = tab.pageId;
  currentView = 'page';
  exitDocView();
  // 隐藏所有默认视图 + 所有标签面板
  welcomeView.classList.add('hidden');
  settingsView.classList.add('hidden');
  iframeWrap.classList.add('hidden');
  mdView.classList.add('hidden');
  customView.classList.add('hidden');
  tabPanels.classList.remove('hidden');
  tabPanels.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  // 更新标签数据（标题/图标可能因页面编辑而变化）
  const page = pages.find(p => p.id === tab.pageId);
  if (page) {
    tab.title = page.name;
    tab.icon = page.icon || (page.type === 'markdown' ? '📝' : '🔗');
    tab.logo = page.logo || '';
  }
  // 按类型显示内容
  if (tab.viewType === 'iframe' || tab.viewType === 'custom') {
    const panel = document.getElementById('panel-' + tabId);
    if (panel) {
      panel.classList.add('active');
      let iframe = panel.querySelector('iframe');
      if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.title = tab.title + ' - 嵌入页面';
        iframe.referrerPolicy = 'no-referrer';
        panel.appendChild(iframe);
        iframe.addEventListener('load', () => {
          const mask = panel.querySelector('.loading-mask');
          if (mask) mask.classList.add('fade-out');
        });
        // 设置 iframe src
        if (page) {
          if (tab.viewType === 'custom') {
            const entry = page.entry || 'index.html';
            iframe.src = '/hilbert-custom/' + page.id + '/' + entry;
          } else if (page.type === 'iframe') {
            iframe.src = page.url;
          } else {
            const pageUrl = new URL(page.url);
            const mountPath = page.mountPath || '/hilbert-proxy/' + page.id;
            const upstreamPath = pageUrl.pathname || '/';
            iframe.setAttribute('sandbox', [
              'allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-modals',
              'allow-downloads', 'allow-popups', 'allow-popups-to-escape-sandbox',
              'allow-top-navigation-by-user-activation', 'allow-storage-access-by-user-activation'
            ].join(' '));
            iframe.src = page.proxyUrl || (
              page.proxyOrigin + mountPath + upstreamPath + (pageUrl.search || '')
            );
          }
        }
      }
    }
  } else if (tab.viewType === 'markdown') {
    mdView.classList.remove('hidden');
    exitMdEdit();
    renderPageLogo(mdToolbarIcon, tab, '📝');
    mdToolbarTitle.textContent = tab.title;
    mdEditBtn.classList.toggle('hidden', !canEditPage(tab.pageId));
    // 使用缓存的渲染内容（保留滚动位置等状态）
    if (tab.mdContent !== null) {
      mdBody.innerHTML = tab.mdContent;
    } else if (page) {
      mdBody.innerHTML = renderMarkdownSafely(page.content);
      tab.mdContent = mdBody.innerHTML;
    }
    mdView.scrollTop = tab.scrollTop || 0;
  }
  // 收起侧边栏（常驻模式下不收起）
  if (!sidebarPinned) $('sidebar').classList.add('collapsed');
  renderTabs();
  renderSidebar();
  updateSidebarTrigger();
  saveViewState();
  updatePageHistory(tab.pageId, historyMode);
}

function closeTab(tabId) {
  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx < 0) return;
  // 关闭前确认未保存的编辑
  const tab = tabs[idx];
  if (tab.id === activeTabId) {
    if (mdEditing && isMdDirty()) {
      if (!confirm('文档内容尚未保存，确定要关闭标签吗？')) return;
    }
    if (docEditing && isDocDirty()) {
      if (!confirm('文档内容尚未保存，确定要关闭标签吗？')) return;
    }
  }
  // 移除面板
  if (tab.viewType === 'iframe' || tab.viewType === 'custom') {
    const panel = document.getElementById('panel-' + tabId);
    if (panel) panel.remove();
  }
  tabs.splice(idx, 1);
  if (activeTabId === tabId) {
    activeTabId = null;
    if (tabs.length > 0) {
      const newIdx = Math.min(idx, tabs.length - 1);
      activateTab(tabs[newIdx].id, 'replace');
    } else {
      // 无标签时复用完整的欢迎页切换，避免遗留已关闭页面的视图状态。
      showWelcome();
      history.pushState(null, '', '/');
    }
  } else {
    renderTabs();
  }
  saveViewState();
}

function closeAllTabs() {
  tabs = [];
  activeTabId = null;
  tabPanels.innerHTML = '';
  tabBar.classList.remove('visible');
}

function saveTabs() {
  try {
    // 更新当前激活标签的 markdown 内容缓存
    if (activeTabId) {
      const activeTab = tabs.find(t => t.id === activeTabId);
      if (activeTab && activeTab.viewType === 'markdown') {
        activeTab.mdContent = mdBody.innerHTML;
        activeTab.scrollTop = mdView.scrollTop;
      }
    }
    const tabData = tabs.map(t => ({
      id: t.id,
      pageId: t.pageId,
      viewType: t.viewType,
      title: t.title,
      icon: t.icon,
      logo: t.logo
    }));
    sessionStorage.setItem('hilbert_tabs', JSON.stringify({ tabs: tabData, activeTabId }));
  } catch { /* 忽略 */ }
}

function restoreTabs() {
  try {
    const raw = sessionStorage.getItem('hilbert_tabs');
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data.tabs || data.tabs.length === 0) return false;
    let restored = false;
    for (const td of data.tabs) {
      const page = pages.find(p => p.id === td.pageId);
      if (!page) continue; // 页面已删除，跳过
      const tab = {
        id: td.id,
        pageId: td.pageId,
        viewType: td.viewType,
        title: page.name,
        icon: page.icon || td.icon || '🔗',
        logo: page.logo || '',
        mdContent: null,
        scrollTop: 0
      };
      if (tab.viewType === 'markdown') {
        tab.mdContent = renderMarkdownSafely(page.content);
      }
      tabs.push(tab);
      if (tab.viewType === 'iframe' || tab.viewType === 'custom') {
        const panel = document.createElement('div');
        panel.className = 'tab-panel';
        panel.id = 'panel-' + tab.id;
        panel.innerHTML = '<div class="loading-mask"><div class="spinner"></div><p>页面加载中…</p></div>';
        tabPanels.appendChild(panel);
      }
      restored = true;
    }
    if (restored) {
      const targetId = data.activeTabId && tabs.find(t => t.id === data.activeTabId)
        ? data.activeTabId
        : tabs[tabs.length - 1].id;
      activateTab(targetId);
      return true;
    }
  } catch { /* 忽略 */ }
  return false;
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
    groupId: page.groupId
  };
  if (page.type === 'link') {
    body.url = page.url;
    body.sessionMode = page.sessionMode || 'server';
    body.origins = page.origins || {};
    body.authOrigins = page.authOrigins || [];
    body.resolveIp = page.resolveIp || '';
    body.proxyMode = proxyRoutingMode;
    if (proxyRoutingMode === 'mount' && page.mountPath) body.mountPath = page.mountPath;
    if (page.auth && canEditPage(page.id)) {
      body.sourceId = page.id; // 仅有源页面修改权限时由服务端复制认证 Secret
    }
  } else if (page.type === 'direct' || page.type === 'iframe') {
    body.url = page.url;
  } else if (page.type === 'custom') {
    body.sourceId = page.id;
  } else {
    body.content = page.content || '';
  }
  try {
    const created = await api('', { method: 'POST', body: JSON.stringify(body) });
    let logoWarning = false;
    try {
      const logoResult = await api('/' + created.id + '/logo', {
        method: 'PUT',
        body: JSON.stringify({ logoUrl: page.logoUrl || '' })
      });
      logoWarning = !!logoResult.logoWarning;
    } catch { logoWarning = true; }
    showToast(logoWarning ? '页面已复制，Logo 获取失败，已使用默认图标' : '页面已复制');
    await refresh();
  } catch (err) {
    showToast(err.message);
  }
}

// 根据页面类型切换右侧展示：link → iframe，markdown → 渲染文档
function showPage(page) {
  // 委托给标签系统：每个页面在独立标签中打开
  openTab(page);
}

function renderMarkdown(page) {
  mdBody.innerHTML = renderMarkdownSafely(page.content);
  mdView.scrollTop = 0;
}

// ---------- 视图状态持久化 ----------
function saveViewState() {
  try {
    sessionStorage.setItem('hilbert_view', JSON.stringify({ view: currentView, activeId }));
    saveTabs();
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
  exitDocView();
  closeAllTabs();
  iframeWrap.classList.add('hidden');
  mdView.classList.add('hidden');
  customView.classList.add('hidden');
  tabPanels.classList.add('hidden');
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
  exitDocView();
  closeAllTabs();
  iframeWrap.classList.add('hidden');
  mdView.classList.add('hidden');
  customView.classList.add('hidden');
  tabPanels.classList.add('hidden');
  welcomeView.classList.add('hidden');
  settingsView.classList.remove('hidden');
  groupError.classList.add('hidden');
  renderGroupList();
  // RBAC 面板：仅管理员可见
  if (isAdmin) {
    $('rbacPanel').classList.remove('hidden');
    $('opsPanel').classList.remove('hidden');
    $('diagnosticsPanel').classList.remove('hidden');
    $('backupsPanel').classList.remove('hidden');
    $('sessionsPanel').classList.remove('hidden');
    $('auditPanel').classList.remove('hidden');
    loadAndRenderRbac();
    loadOperations();
  } else {
    $('rbacPanel').classList.add('hidden');
  }
  renderSidebar();
  updateSidebarTrigger();
  saveViewState();
}


function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB';
  return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

async function loadSystemStatus() {
  try {
    const status = await opsApi('/status');
    const items = [
      ['版本', status.app.version],
      ['运行时间', Math.floor(status.app.uptimeSeconds / 60) + ' 分钟'],
      ['Node.js', status.app.node],
      ['内存 RSS', formatBytes(status.memory.rss)],
      ['数据目录', status.data.directory],
      ['数据目录可写', status.data.writable ? '正常' : '异常'],
      ['页面 / 分组', status.data.pages + ' / ' + status.data.groups],
      ['角色 / 分配', status.data.roles + ' / ' + status.data.assignments],
      ['代理路由', status.proxy.routingMode + (status.proxy.hostTemplate ? ' · ' + status.proxy.hostTemplate : '')],
      ['Secret 加密', status.encryption.enabled ? status.encryption.algorithm + ' · ' + status.encryption.source : '未启用'],
      ['活跃会话', status.sessions.active + '（主站 ' + status.sessions.mainActive + ' / 代理 ' + status.sessions.proxyActive + '）'],
      ['备份 / 审计', status.backups.count + ' / ' + formatBytes(status.audit.bytes)]
    ];
    $('opsStatusGrid').innerHTML = items.map(([label, value]) =>
      '<div class="ops-status-item"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(String(value ?? '-')) + '</strong></div>'
    ).join('');
  } catch (err) {
    $('opsStatusGrid').innerHTML = '<div class="rbac-empty">加载失败：' + escapeHtml(err.message) + '</div>';
  }
}

function populateDiagnosticPages() {
  const links = pages.filter(page => page.type === 'link');
  $('opsDiagnosticPage').innerHTML = links.map(page =>
    '<option value="' + page.id + '">' + escapeHtml((page.icon || '🔗') + ' ' + page.name) + '</option>'
  ).join('');
  $('opsRunDiagnosticBtn').disabled = links.length === 0;
}

async function runPageDiagnostic() {
  const pageId = $('opsDiagnosticPage').value;
  if (!pageId) return;
  const output = $('opsDiagnosticResult');
  output.classList.remove('hidden');
  output.textContent = '诊断中…';
  try {
    const res = await authenticatedFetch('/hilbert-api/ops/diagnostics/pages/' + encodeURIComponent(pageId), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json().catch(() => ({}));
    output.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    output.textContent = '诊断失败：' + err.message;
  }
}

async function loadBackups() {
  try {
    const backups = await opsApi('/backups');
    const container = $('opsBackupList');
    if (!backups.length) {
      container.innerHTML = '<div class="rbac-empty">暂无备份</div>';
      return;
    }
    container.innerHTML = backups.map(item =>
      '<div class="ops-row"><div><strong>' + escapeHtml(item.name) + '</strong><small>' +
      escapeHtml(formatDateTime(item.createdAt) + ' · ' + formatBytes(item.size)) +
      '</small></div><div class="ops-row-actions">' +
      '<a class="ghost-btn" href="/hilbert-api/ops/backups/' + encodeURIComponent(item.name) + '/download">下载</a>' +
      '<button class="ghost-btn ops-restore-backup" data-name="' + escapeHtml(item.name) + '">恢复</button>' +
      '<button class="danger-btn ops-delete-backup" data-name="' + escapeHtml(item.name) + '">删除</button></div></div>'
    ).join('');
    container.querySelectorAll('.ops-restore-backup').forEach(button => button.addEventListener('click', () => restoreBackup(button.dataset.name)));
    container.querySelectorAll('.ops-delete-backup').forEach(button => button.addEventListener('click', () => deleteBackupFile(button.dataset.name)));
  } catch (err) { showToast('加载备份失败：' + err.message); }
}

async function createBackupFile() {
  try {
    $('opsCreateBackupBtn').disabled = true;
    const result = await opsApi('/backups', { method: 'POST', body: '{}' });
    showToast('备份已创建：' + result.name);
    await loadBackups();
  } catch (err) { showToast(err.message); }
  finally { $('opsCreateBackupBtn').disabled = false; }
}

async function restoreBackup(name) {
  const confirmation = prompt('恢复会覆盖当前页面、分组、角色、收藏和自定义文件。\n请输入 RESTORE 继续：');
  if (confirmation !== 'RESTORE') return;
  try {
    const result = await opsApi('/backups/' + encodeURIComponent(name) + '/restore', {
      method: 'POST', body: JSON.stringify({ confirm: confirmation })
    });
    showToast('恢复完成，安全备份：' + result.safetyBackup);
    [pages, groups] = await Promise.all([api(''), groupsApi()]);
    renderSidebar(); renderGroupList(); populateDiagnosticPages();
    await Promise.all([loadSystemStatus(), loadBackups(), loadAndRenderRbac()]);
  } catch (err) { showToast('恢复失败：' + err.message); }
}

async function uploadAndRestoreBackup() {
  const input = $('opsBackupUploadInput');
  const file = input.files && input.files[0];
  if (!file) return;
  const confirmation = prompt('将从「' + file.name + '」恢复，当前页面、分组、角色、收藏和自定义文件会被覆盖。\n请输入 RESTORE 继续：');
  if (confirmation !== 'RESTORE') {
    input.value = '';
    return;
  }

  const button = $('opsUploadRestoreBtn');
  const formData = new FormData();
  formData.append('confirm', confirmation);
  formData.append('backup', file);
  try {
    button.disabled = true;
    button.textContent = '上传恢复中…';
    const res = await authenticatedFetch('/hilbert-api/ops/backups/upload-restore', {
      method: 'POST',
      body: formData
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || `请求失败 (${res.status})`);
    showToast('恢复完成，安全备份：' + result.safetyBackup);
    [pages, groups] = await Promise.all([api(''), groupsApi()]);
    renderSidebar(); renderGroupList(); populateDiagnosticPages();
    await Promise.all([loadSystemStatus(), loadBackups(), loadAndRenderRbac()]);
  } catch (err) {
    showToast('上传恢复失败：' + err.message);
  } finally {
    input.value = '';
    button.disabled = false;
    button.textContent = '上传并恢复';
  }
}

async function deleteBackupFile(name) {
  if (!confirm('确定删除备份「' + name + '」吗？')) return;
  try {
    await opsApi('/backups/' + encodeURIComponent(name), { method: 'DELETE' });
    await loadBackups();
  } catch (err) { showToast(err.message); }
}

async function loadSessions() {
  try {
    const sessions = await opsApi('/sessions');
    const container = $('opsSessionList');
    if (!sessions.length) { container.innerHTML = '<div class="rbac-empty">暂无活跃会话</div>'; return; }
    container.innerHTML = sessions.map(session =>
      '<div class="ops-row"><div><strong>' + escapeHtml(session.email || '-') +
      (session.current ? ' <span class="rbac-wildcard-badge">当前</span>' : '') +
      '</strong><small>' + escapeHtml((session.type === 'proxy' ? '页面代理' : '主站') +
      (session.pageId ? ' · ' + session.pageId.slice(0, 8) : '') + ' · 最近 ' + formatDateTime(session.lastSeenAt) +
      ' · 到期 ' + formatDateTime(session.expiresAt) + ' · ' + (session.ip || '-')) + '</small></div>' +
      '<div class="ops-row-actions"><button class="danger-btn ops-revoke-session" data-id="' + session.id + '">撤销</button></div></div>'
    ).join('');
    container.querySelectorAll('.ops-revoke-session').forEach(button => button.addEventListener('click', () => revokeSession(button.dataset.id)));
  } catch (err) { showToast('加载会话失败：' + err.message); }
}

async function revokeSession(id) {
  if (!confirm('确定撤销该会话吗？主会话关联的页面会话也会失效。')) return;
  try {
    await opsApi('/sessions/' + encodeURIComponent(id) + '/revoke', { method: 'POST', body: '{}' });
    await Promise.all([loadSessions(), loadSystemStatus()]);
  } catch (err) { showToast(err.message); }
}

async function loadAudit() {
  try {
    const params = new URLSearchParams({ limit: '100' });
    const actor = $('opsAuditActor').value.trim();
    const action = $('opsAuditAction').value.trim();
    if (actor) params.set('actor', actor);
    if (action) params.set('action', action);
    const entries = await opsApi('/audit?' + params.toString());
    const container = $('opsAuditList');
    if (!entries.length) { container.innerHTML = '<div class="rbac-empty">暂无审计记录</div>'; return; }
    container.innerHTML = entries.map(entry =>
      '<div class="ops-row ops-audit-row"><div><strong>' + escapeHtml(entry.action) +
      ' <span class="ops-outcome ' + escapeHtml(entry.outcome) + '">' + escapeHtml(entry.outcome) + '</span></strong>' +
      '<small>' + escapeHtml(formatDateTime(entry.timestamp) + ' · ' + (entry.actor || 'anonymous') + ' · ' + (entry.ip || '-')) +
      '</small></div><code>' + escapeHtml(entry.resourceId || '') + '</code></div>'
    ).join('');
  } catch (err) { showToast('加载审计日志失败：' + err.message); }
}

function loadOperations() {
  populateDiagnosticPages();
  Promise.all([loadSystemStatus(), loadBackups(), loadSessions(), loadAudit()]);
}

$('opsRefreshStatusBtn').addEventListener('click', loadSystemStatus);
$('opsRunDiagnosticBtn').addEventListener('click', runPageDiagnostic);
$('opsCreateBackupBtn').addEventListener('click', createBackupFile);
$('opsUploadRestoreBtn').addEventListener('click', () => $('opsBackupUploadInput').click());
$('opsBackupUploadInput').addEventListener('change', uploadAndRestoreBackup);
$('opsRefreshSessionsBtn').addEventListener('click', loadSessions);
$('opsRefreshAuditBtn').addEventListener('click', loadAudit);
$('opsAuditActor').addEventListener('keydown', e => { if (e.key === 'Enter') loadAudit(); });
$('opsAuditAction').addEventListener('keydown', e => { if (e.key === 'Enter') loadAudit(); });

$('settingsEntry').addEventListener('click', showSettings);

// 强制刷新：清除资源缓存并重新加载，但保留侧边栏常驻、分组折叠等界面偏好。
$('refreshBtn').addEventListener('click', async e => {
  e.stopPropagation(); // 不触发外层「设置」按钮
  sessionStorage.setItem('__forceRefresh', '1');
  try {
    if ('caches' in window) {
      // 删除所有 Service Worker / Cache API 缓存，完成后再重新加载。
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
    }
  } catch { /* Cache API 不可用时仍继续刷新 */ }
  // 在 URL 上加时间戳，强制绕过浏览器的 HTTP 缓存拉取 app.js / style.css 等静态资源。
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
    const count = pages.filter(p => p.groupId === g.id).length;
    const li = document.createElement('li');
    li.className = 'group-item';
    li.draggable = true;
    li.dataset.index = i;
    li.innerHTML = `
      <span class="group-drag-handle" title="拖拽排序">≡</span>
      <span class="group-name" title="双击编辑名称">${escapeHtml(g.name)}</span>
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
        groups = await groupsApi('/order', { method: 'PUT', body: JSON.stringify({ order: newOrder.map(group => group.id) }) });
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
function startGroupEdit(li, group, nameSpan) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'group-edit-input';
  input.value = group.name;
  input.maxLength = 20;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  const finish = async (save) => {
    const newName = input.value.trim();
    if (save && newName && newName !== group.name) {
      try {
        groups = await groupsApi('/' + encodeURIComponent(group.id), { method: 'PUT', body: JSON.stringify({ name: newName }) });
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
    if (e.key === 'Escape') { input.value = group.name; input.blur(); }
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

async function deleteGroup(group, count) {
  const hint = count > 0 ? `，其下 ${count} 个页面将移至「未分组」` : '';
  if (!confirm(`确定要删除分组「${group.name}」吗${hint}？`)) return;
  try {
    groups = await groupsApi('/' + encodeURIComponent(group.id), { method: 'DELETE' });
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
    row.innerHTML = `<span class="rbac-perm-page" title="${escapeHtml(p.name)}"><span class="item-icon"></span> ${escapeHtml(p.name)}</span><span class="rbac-perm-actions"><label><input type="checkbox" class="perm-act" data-act="read" ${actions.includes('read') ? 'checked' : ''} /> 查看</label><label><input type="checkbox" class="perm-act" data-act="update" ${actions.includes('update') ? 'checked' : ''} /> 修改</label><label><input type="checkbox" class="perm-act" data-act="delete" ${actions.includes('delete') ? 'checked' : ''} /> 删除</label></span>`;
    renderPageLogo(row.querySelector('.item-icon'), p, '🔗');
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
function openMarkdownEditor(content) {
  mdEditor.classList.remove('hidden');
  if (!markdownEditor) {
    markdownEditor = new Vditor(mdEditor, {
      height: '100%',
      mode: 'sv',
      value: content || '',
      cdn: '/vendor/vditor',
      lang: 'zh_CN',
      cache: { enable: false },
      // 编辑器本身固定在文档栏下方，无需再次把内部工具栏吸附到页面顶部。
      toolbarConfig: { pin: false },
      preview: {
        actions: [],
        theme: { current: 'light', path: '/vendor/vditor/dist/css/content-theme/' },
        hljs: { style: 'github-dark' }
      },
      toolbar: [
        'emoji', 'headings', 'bold', 'italic', 'strike', '|',
        'line', 'quote', 'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
        'code', 'inline-code', 'link', 'table', '|',
        'undo', 'redo', '|', 'edit-mode', 'outline', 'fullscreen'
      ],
      after: () => markdownEditor.focus()
    });
    return;
  }
  markdownEditor.setValue(content || '', true);
  markdownEditor.focus();
}

function getMarkdownEditorValue() {
  return markdownEditor ? markdownEditor.getValue() : '';
}

function enterMdEdit() {
  const page = pages.find(p => p.id === activeId);
  if (!page || page.type !== 'markdown') return;
  mdEditing = true;
  mdBody.classList.add('hidden');
  mdView.classList.add('editing');
  mdView.scrollTop = 0;
  openMarkdownEditor(page.content || '');
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
  return mdEditing && page && getMarkdownEditorValue() !== (page.content || '');
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
  tabPanels.classList.add('hidden');
  exitMdEdit();

  // 更新工具栏
  mdToolbarIcon.textContent = '📄';
  mdToolbarTitle.textContent = page.name + ' - 文档';
  mdEditBtn.classList.remove('hidden');
  mdSaveBtn.classList.add('hidden');
  mdCancelBtn.classList.add('hidden');
  mdCloseBtn.classList.remove('hidden');

  // 加载文档内容
  try {
    const doc = await api('/' + page.id + '/doc');
    docContent = doc.content || '';
    if (docContent) {
      mdBody.innerHTML = renderMarkdownSafely(docContent);
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
  mdBody.classList.add('hidden');
  mdView.classList.add('editing');
  mdView.scrollTop = 0;
  openMarkdownEditor(docContent || '');
  mdEditBtn.classList.add('hidden');
  mdSaveBtn.classList.remove('hidden');
  mdCancelBtn.classList.remove('hidden');
  mdCloseBtn.classList.add('hidden');
}

function exitDocEdit() {
  docEditing = false;
  mdEditor.classList.add('hidden');
  mdBody.classList.remove('hidden');
  mdView.classList.remove('editing');
  mdSaveBtn.classList.add('hidden');
  mdCancelBtn.classList.add('hidden');
  mdEditBtn.classList.remove('hidden');
  if (viewingPageDoc) mdCloseBtn.classList.remove('hidden');
}

function isDocDirty() {
  return docEditing && getMarkdownEditorValue() !== (docContent || '');
}

async function saveDocEdit() {
  if (!docPageId) return;
  const content = getMarkdownEditorValue();
  try {
    const result = await api('/' + docPageId + '/doc', {
      method: 'PUT',
      body: JSON.stringify({ content })
    });
    docContent = result.content || '';
    exitDocEdit();
    if (docContent) {
      mdBody.innerHTML = renderMarkdownSafely(docContent);
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
  mdCloseBtn.classList.add('hidden');
  tabPanels.classList.remove('hidden');
}

// 编辑中离开页面前的丢弃确认（包含文档编辑状态）
function confirmDiscardIfEditing() {
  // 检查所有标签的未保存编辑
  for (const tab of tabs) {
    if (tab.viewType === 'markdown' && tab.id === activeTabId && mdEditing) {
      const page = pages.find(p => p.id === tab.pageId);
      if (page && getMarkdownEditorValue() !== (page.content || '')) {
        return confirm('文档内容尚未保存，确定要离开吗？');
      }
    }
  }
  if (docEditing && isDocDirty()) {
    return confirm('文档内容尚未保存，确定要离开吗？');
  }
  return true;
}

async function saveMdEdit() {
  const page = pages.find(p => p.id === activeId);
  if (!page) return;
  const content = getMarkdownEditorValue();
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
    // 同步更新标签缓存
    const tab = tabs.find(t => t.pageId === page.id);
    if (tab) {
      tab.mdContent = mdBody.innerHTML;
    }
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

mdCloseBtn.addEventListener('click', () => {
  if (!viewingPageDoc) return;
  if (isDocDirty() && !confirm('内容尚未保存，确定要放弃修改吗？')) return;
  const page = pages.find(p => p.id === docPageId);
  exitDocView();
  renderSidebar();
  if (page) showPage(page);
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
  $('sessionModeField').classList.toggle('hidden', !isLink || proxyRoutingMode !== 'host');
  $('originsField').classList.toggle('hidden', !isLink || proxyRoutingMode !== 'host');
  $('authOriginsField').classList.toggle('hidden', !isLink || proxyRoutingMode !== 'host');
  $('proxyModeField').classList.add('hidden');
  $('mountPathField').classList.toggle('hidden', !isLink || proxyRoutingMode === 'host');
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

// 认证模式切换：basic/login 显示账号密码，header 显示自定义头，oauth 显示客户端凭证，identity 显示身份请求头名，login 额外显示登录路径与请求格式
function setAuthMode(mode) {
  $('authMode').value = mode;
  $('authUserPass').classList.toggle('hidden', mode === 'header' || mode === 'oauth' || mode === 'identity');
  $('authLoginPath').classList.toggle('hidden', mode !== 'login');
  $('authLoginOpts').classList.toggle('hidden', mode !== 'login');
  $('authHeaderInputs').classList.toggle('hidden', mode !== 'header');
  $('authIdentityFields').classList.toggle('hidden', mode !== 'identity');
  $('authOAuthFields').classList.toggle('hidden', mode !== 'oauth');
}
$('authMode').addEventListener('change', () => setAuthMode($('authMode').value));

// 填充分组下拉：已配置分组 + 当前页面分组（防止失效）+ 未分组
function fillGroupSelect(selectedId) {
  const opts = [...groups, { id: '', name: '未分组' }];
  $('fieldGroup').innerHTML = opts
    .map(g => `<option value="${escapeHtml(g.id)}"${g.id === (selectedId || '') ? ' selected' : ''}>${escapeHtml(g.name)}</option>`)
    .join('');
}

function updateProxyModeHint() {
  const hint = $('proxyModeHint');
  hint.textContent = proxyRoutingMode === 'host'
    ? '每个外部页面使用独立通配子域名，公开路径完整镜像上游路径'
    : '所有外部页面均通过隔离 origin 下的独立挂载路径访问';
  hint.classList.remove('warn');
}
$('fieldUrl').addEventListener('input', updateProxyModeHint);
$('fieldProxyMode').addEventListener('change', () => {
  updateProxyModeHint();
  $('mountPathField').classList.toggle('hidden', proxyRoutingMode === 'host');
});

function openModal(page = null) {
  editingId = page ? page.id : null;
  $('modalTitle').textContent = page ? '编辑页面' : '新建页面';
  $('fieldName').value = page ? page.name : '';
  $('fieldUrl').value = page && page.type !== 'markdown' ? page.url : '';
  $('fieldResolveIp').value = page ? (page.resolveIp || '') : '';
  $('fieldSessionMode').value = page && page.sessionMode === 'browser' ? 'browser' : 'server';
  $('fieldOrigins').value = page && page.origins
    ? Object.entries(page.origins).map(([alias, origin]) => alias + '=' + origin).join('\n')
    : '';
  $('fieldAuthOrigins').value = page && page.authOrigins ? page.authOrigins.join(',') : '';
  $('fieldProxyMode').value = 'mount';
  $('fieldMountPath').value = page && page.mountPath ? page.mountPath.replace(/^\//, '') : '';
  updateProxyModeHint();
  $('fieldLogoUrl').value = page ? (page.logoUrl || '') : '';
  const hasAuth = !!(page && page.auth);
  $('authEnabled').checked = hasAuth;
  $('authBox').classList.toggle('hidden', !hasAuth);
  const mode = hasAuth ? (page.auth.mode || 'basic') : 'basic';
  setAuthMode(mode);
  $('authUser').value = hasAuth ? (page.auth.username || '') : '';
  $('authPass').value = '';
  $('authPass').placeholder = hasAuth && page.auth.hasPassword
    ? '密码已配置，留空保持不变'
    : '密码';
  $('authLoginPath').value = hasAuth && page.auth.loginPath !== '/login' ? page.auth.loginPath : '';
  $('authLoginFormat').value = hasAuth && page.auth.loginFormat === 'form' ? 'form' : 'json';
  $('authUserField').value = hasAuth && page.auth.userField !== 'user' ? (page.auth.userField || '') : '';
  $('authPasswordField').value = hasAuth && page.auth.passwordField !== 'password' ? (page.auth.passwordField || '') : '';
  $('authHeaderName').value = hasAuth ? (page.auth.headerName || '') : '';
  $('authHeaderValue').value = '';
  $('authHeaderValue').placeholder = hasAuth && page.auth.hasHeaderValue
    ? '请求头值已配置，留空保持不变'
    : '请求头值，如 Bearer xxx';
  $('authUserHeader').value = hasAuth && page.auth.userHeader !== 'X-Forwarded-User' ? (page.auth.userHeader || '') : '';
  $('authEmailHeader').value = hasAuth && page.auth.emailHeader !== 'X-Forwarded-Mail' ? (page.auth.emailHeader || '') : '';
  $('authDisplayNameHeader').value = hasAuth && page.auth.displayNameHeader !== 'X-Forwarded-DisplayName' ? (page.auth.displayNameHeader || '') : '';
  $('authGroupsHeader').value = hasAuth && page.auth.groupsHeader !== 'X-Forwarded-Groups' ? (page.auth.groupsHeader || '') : '';
  const identityClaims = hasAuth && Array.isArray(page.auth.claims) ? page.auth.claims : [];
  $('authForwardGoogleAuth').checked = hasAuth && (
    page.auth.forwardGoogleAuth === true || identityClaims.some(mapping => mapping.claim === 'googleAuth')
  );
  $('authForwardGoogleAccessToken').checked = hasAuth && (
    page.auth.forwardGoogleAccessToken === true || identityClaims.some(mapping => mapping.claim === 'googleAccessToken')
  );
  $('authTokenUrl').value = hasAuth ? (page.auth.tokenUrl || '') : '';
  $('authClientId').value = hasAuth ? (page.auth.clientId || '') : '';
  $('authClientSecret').value = '';
  $('authClientSecret').placeholder = hasAuth && page.auth.hasClientSecret
    ? 'Client Secret 已配置，留空保持不变'
    : 'Client Secret';
  $('authScope').value = hasAuth ? (page.auth.scope || '') : '';
  fillGroupSelect(page ? page.groupId : (groups[0]?.id || ''));
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
    icon: ({ markdown: '📝', custom: '🖥️', direct: '🔗', iframe: '🖼️' }[currentType] || '🔗'),
    groupId: $('fieldGroup').value || null
  };
  if (currentType === 'link') {
    body.url = $('fieldUrl').value.trim();
    body.proxyMode = proxyRoutingMode;
    if (proxyRoutingMode === 'mount') body.mountPath = $('fieldMountPath').value.trim();
    // 始终传递 resolveIp（空字符串时后端会删除该字段）
    body.resolveIp = $('fieldResolveIp').value.trim();
    body.sessionMode = proxyRoutingMode === 'host' ? $('fieldSessionMode').value : 'server';
    if (proxyRoutingMode === 'host') {
      body.origins = {};
      for (const line of $('fieldOrigins').value.split('\n').map(value => value.trim()).filter(Boolean)) {
        const equals = line.indexOf('=');
        if (equals > 0) body.origins[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
        else body.origins[line] = '';
      }
      body.authOrigins = $('fieldAuthOrigins').value.split(',').map(value => value.trim()).filter(Boolean);
    }
    // 认证配置：勾选时按所选模式提交，未勾选时显式清除
    if ($('authEnabled').checked) {
      const mode = $('authMode').value;
      if (mode === 'header') {
        body.auth = {
          mode,
          headerName: $('authHeaderName').value.trim(),
          headerValue: $('authHeaderValue').value.trim()
        };
      } else if (mode === 'identity') {
        body.auth = { mode };
        const identityHeaders = {
          userHeader: $('authUserHeader').value.trim(),
          emailHeader: $('authEmailHeader').value.trim(),
          displayNameHeader: $('authDisplayNameHeader').value.trim(),
          groupsHeader: $('authGroupsHeader').value.trim()
        };
        for (const [key, value] of Object.entries(identityHeaders)) {
          if (value) body.auth[key] = value;
        }
        body.auth.forwardGoogleAuth = $('authForwardGoogleAuth').checked;
        body.auth.forwardGoogleAccessToken = $('authForwardGoogleAccessToken').checked;
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
    let message;
    if (editingId) {
      await api('/' + editingId, { method: 'PUT', body: JSON.stringify(body) });
      message = '页面已更新';
    } else {
      const created = await api('', { method: 'POST', body: JSON.stringify(body) });
      editingId = created.id; // 保存 ID 以便后续上传文件
      activeId = created.id;
      currentView = 'page';
      message = currentType === 'custom' ? '页面已创建，现在可以上传文件' : '页面已创建';
      // 新建 custom 页面后，加载文件列表（此时只有默认 index.html）
      if (currentType === 'custom') {
        await loadModalFiles(created.id);
      }
    }
    let logoWarning = false;
    try {
      const logoResult = await api('/' + editingId + '/logo', {
        method: 'PUT',
        body: JSON.stringify({ logoUrl: $('fieldLogoUrl').value.trim() })
      });
      logoWarning = !!logoResult.logoWarning;
    } catch { logoWarning = true; }
    showToast(logoWarning ? message + '，Logo 获取失败，已使用默认图标' : message);
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
$('searchPageBtn').addEventListener('click', () => {
  const search = $('pageSearch');
  search.classList.toggle('hidden');
  if (search.classList.contains('hidden')) {
    $('pageSearchInput').value = '';
    pageSearchQuery = '';
    renderSidebar();
  } else {
    $('pageSearchInput').focus();
  }
});
$('pageSearchInput').addEventListener('input', e => {
  pageSearchQuery = e.target.value;
  renderSidebar();
});
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
    // 关闭该页面关联的所有标签
    const relatedTabs = tabs.filter(t => t.pageId === deletingId);
    for (const t of relatedTabs) {
      const panel = document.getElementById('panel-' + t.id);
      if (panel) panel.remove();
    }
    tabs = tabs.filter(t => t.pageId !== deletingId);
    if (activeId === deletingId) activeId = null;
    // 如果关闭的是当前激活标签，切换到相邻标签或显示欢迎页
    if (relatedTabs.some(t => t.id === activeTabId)) {
      activeTabId = null;
      if (tabs.length > 0) {
        activateTab(tabs[0].id, 'replace');
      } else {
        showWelcome();
      }
    } else {
      renderTabs();
    }
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
  // 清理已删除页面的标签
  const deletedPageIds = tabs.map(t => t.pageId).filter(pid => !pages.some(p => p.id === pid));
  if (deletedPageIds.length > 0) {
    for (const pid of deletedPageIds) {
      const relatedTabs = tabs.filter(t => t.pageId === pid);
      for (const t of relatedTabs) {
        const panel = document.getElementById('panel-' + t.id);
        if (panel) panel.remove();
      }
      tabs = tabs.filter(t => t.pageId !== pid);
    }
    if (activeTabId && !tabs.find(t => t.id === activeTabId)) {
      activeTabId = null;
      if (tabs.length > 0) {
        activateTab(tabs[tabs.length - 1].id, 'replace');
      }
    }
    renderTabs();
  }
  renderSidebar();
  // 如果当前在标签页视图中，刷新激活的标签
  if (currentView === 'page' && activeTabId) {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab) {
      activateTab(activeTab.id);
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
      if (me.displayName && me.displayName !== me.name) {
        userDisplayName.textContent = me.displayName;
        userDisplayName.classList.remove('hidden');
      } else {
        userDisplayName.textContent = '';
        userDisplayName.classList.add('hidden');
      }
      userEmail.textContent = me.email || '';
      if (Array.isArray(me.groups) && me.groups.length) {
        userGroups.textContent = me.groups.join(', ');
        userGroups.classList.remove('hidden');
      } else {
        userGroups.textContent = '';
        userGroups.classList.add('hidden');
      }
      isAdmin = !!me.isAdmin;
      proxyRoutingMode = me.proxyRoutingMode === 'host' ? 'host' : 'mount';
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
    const proxyPage = pages.find(page => page.type === 'link' && page.proxyRoutingMode);
    if (proxyPage) proxyRoutingMode = proxyPage.proxyRoutingMode;
  } catch (err) {
    showToast('加载失败：' + err.message);
    return;
  }
  renderSidebar();
  // 优先恢复标签状态
  const pathMatch = location.pathname.match(/^\/page\/([^/]+)/);
  if (pathMatch) {
    const urlPageId = decodeURIComponent(pathMatch[1]);
    const target = pages.find(p => p.id === urlPageId);
    if (target && target.type !== 'direct') {
      // 尝试恢复标签，或打开指定页面
      if (!restoreTabs()) {
        activeId = urlPageId;
        currentView = 'page';
        showPage(target);
        renderSidebar();
      }
    } else {
      showWelcome();
    }
  } else {
    // 尝试恢复标签
    if (!restoreTabs()) {
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
    // 查找已打开的标签
    const existingTab = tabs.find(t => t.pageId === pageId);
    if (existingTab) {
      if (!confirmDiscardIfEditing()) return;
      activateTab(existingTab.id);
    } else {
      if (!confirmDiscardIfEditing()) return;
      const page = pages.find(p => p.id === pageId);
      if (page && page.type !== 'direct') {
        openTab(page, true);
      } else {
        showWelcome();
      }
    }
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
