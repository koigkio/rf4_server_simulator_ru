// RF4 管理后台入口：登录、框架、导航。各页面按需加载。
// 视觉与结构以演示页 RF4-管理工作台.html v177 为准：
// body 直接是两列网格（aside.rail + main），页面顶部是照片横幅 hero，下面是 .work 双栏。
import { h, $, api, post, icon, getToken, setToken, onAuth, route, render, navigate, toast, errText, parseHash, setHeroStats, loginDialog, reloadPage } from './core.js';

// 保留各页说明作为链接提示；常驻导航只展示图标与页名。
const NAV = [
  ['dashboard', 'Обзор', 'Сервисы · онлайн · последние изменения', 'home'],
  ['players', 'Игроки', 'Профиль · имущество · садок · навыки · почта', 'users'],
  ['shop', 'Магазин и склад', 'Цены и наличие на полках', 'store'],
  ['rules', 'Ловля и клёв', 'Переключатели · какая рыба · скорость клёва', 'water'],
  ['waters', 'Водоёмы и рыбы', 'Какая рыба водится на каждом водоёме', 'map'],
  ['hooks', 'Ощущение крючков', 'Реальные модели · размер · вероятность засечки', 'hook'],
  ['bait', 'Предпочтения наживки', 'Что сейчас ест каждая рыба', 'bait'],
  ['mail', 'Почта', 'Сообщения и вложения с предметами', 'mail'],
  ['tuning', 'Параметры игры', 'Ощущения · доход · события', 'sliders'],
  ['release', 'Список изменений', 'Обновления версий · исправления', 'doc'],
  ['about', 'О проекте', 'Описание проекта · README', 'info'],
  ['audit', 'Журнал аудита', 'След каждого действия в админке', 'list'],
];
const PAGES = {
  dashboard: () => import('./pages/dashboard.js'),
  players: () => import('./pages/players.js'),
  mail: () => import('./pages/mail.js'),
  rules: () => import('./pages/rules.js'),
  waters: () => import('./pages/waters.js'),
  bait: () => import('./pages/bait.js'),
  hooks: () => import('./pages/hooks.js'),
  tuning: () => import('./pages/tuning.js'),
  shop: () => import('./pages/shop.js'),
  audit: () => import('./pages/audit.js'),
  release: () => import('./pages/docs.js').then((m) => ({ default: m.changelog })),
  about: () => import('./pages/docs.js').then((m) => ({ default: m.about })),
};
for (const [name, load] of Object.entries(PAGES)) {
  route(name, { render: async (params, scope) => {
    const page = await load();
    return scope.isCurrent() ? page.default(params, scope) : [];
  } });
}

// 模块预取：左栏指到哪一条就把那页先下好，点下去不再等 import。
// 全部预取一次之后（首次渲染后 900ms 空闲时）切换就只剩渲染耗时。
function warm(name) { const load = PAGES[name]; if (load) load().catch(() => {}); }
let warmedAll = false;
function warmAllLater() {
  if (warmedAll) return;
  warmedAll = true;
  const run = () => Object.keys(PAGES).forEach(warm);
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2500 });
  else setTimeout(run, 900);
}

const BUILD = 'v1.9';
let me = null;
let stats = null;

export function buildLabel() { return BUILD; }
function portNow() { return location.port && location.port !== '80' ? location.port : '9500'; }

function brand() {
  return h('div', { class: 'brand' },
    h('b', { text: 'RF4' }),
    h('span', { text: 'Рабочая панель администратора' }),
    h('em', { text: BUILD + ' · Локально ' + portNow() }));
}

// 左栏：照片长条 + 品牌 + 总类导航 + 底部主题/账号。
function rail() {
  const nav = h('nav', { id: 'rail', 'aria-label': 'Навигация по разделам' });
  const toggle = h('button', { id: 'navToggle', type: 'button', 'aria-controls': 'rail railFoot',
    'aria-expanded': 'false', onclick: () => toggle.setAttribute('aria-expanded', String(toggle.getAttribute('aria-expanded') !== 'true')) },
    icon('list', 18), 'Меню');
  NAV.forEach(([key, label, sub, ic]) => {
    nav.append(h('a', { href: '#' + key, title: sub, dataset: { route: key }, onpointerenter: () => warm(key), onfocus: () => warm(key),
      onclick: () => { if (location.hash === '#' + key) closeNavigation(); } },
      h('span', { class: 'cat', 'aria-hidden': 'true' }, icon(ic)),
      h('span', { class: 'txt' }, h('b', { text: label }))));
  });
  const signedIn = !!getToken();
  const accountAction = signedIn ? 'Выйти' : 'Войти';
  return h('aside', { class: 'rail', id: 'workspaceRail', onkeydown: (e) => {
    if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') closeNavigation();
  } },
    h('div', { class: 'railband' }),
    brand(),
    h('div', { class: 'mobile-nav' }, h('b', { text: 'RF4' }), h('span', { id: 'mobilePage' }), toggle),
    nav,
    h('div', { class: 'rail-foot', id: 'railFoot' },
      h('div', { class: 'who' },
        h('span', { text: signedIn ? (me?.username || 'Администратор') : 'Не выполнен вход' }),
        h('button', { class: 'who-out', type: 'button', title: accountAction, onclick: signedIn ? logout : () => loginDialog() },
          icon('logout', 15), accountAction))));
}

function closeNavigation() {
  const toggle = $('#navToggle');
  if (toggle?.getAttribute('aria-expanded') !== 'true') return;
  toggle.setAttribute('aria-expanded', 'false');
  if (toggle.offsetWidth) toggle.focus();
}

function inFrame() { try { return window.top !== window.self; } catch (e) { return false; } }

// ---- 顶部条：面包屑 + 版本戳 + 刷新 ----
function topBar() {
  const key = 'rf4.rail.collapsed';
  let collapsed = false;
  try { collapsed = localStorage.getItem(key) === '1'; } catch {}
  const toggle = h('button', { type: 'button', id: 'railToggle', class: 'ghost', 'aria-controls': 'workspaceRail', onclick: () => {
    collapsed = !collapsed;
    try { localStorage.setItem(key, collapsed ? '1' : '0'); } catch {}
    sync();
  } });
  function sync() {
    document.body.classList.toggle('rail-collapsed', collapsed);
    const action = collapsed ? 'Развернуть боковую панель' : 'Свернуть боковую панель';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', action);
    toggle.title = action;
    toggle.replaceChildren(icon(collapsed ? 'list' : 'back', 18));
  }
  sync();
  return h('div', { class: 'top' },
    h('div', { class: 'crumb', id: 'crumb' },
      toggle,
      h('span', { text: 'RF4' }), h('i', { text: '/' }), h('span', { id: 'crumbGroup', text: 'Обзор' })),
    h('div', { class: 'tools' },
      // 在控制中心的 iframe 里才出现「回控制中心」，单独打开 /admin/ 时不打扰
      inFrame() ? h('a', { class: 'ghost back-home', href: '/', target: '_top', text: '← Назад', title: 'Вернуться в центр управления' }) : null,
      h('span', { id: 'stamp', text: 'Локально · ' + portNow() + ' · ' + BUILD }),
      getToken() ? null : h('button', { class: 'ghost', id: 'loginBtn', type: 'button', onclick: () => loginDialog(), text: 'Войти' }),
      h('button', { class: 'ghost', id: 'reload', type: 'button', onclick: reloadPage, text: 'Обновить страницу' })));
}

function pageFoot() {
  return h('footer', { class: 'pagefoot' },
    h('span', { text: 'Локальная админ-панель · данные с работающего сервера' }),
    h('span', { text: 'Каждое действие записывается в «Журнал аудита»' }));
}

function setCrumb(name) {
  const item = NAV.find(([k]) => k === name);
  const g = $('#crumbGroup');
  if (g) g.textContent = item ? item[1] : 'Обзор';
  const mobile = $('#mobilePage');
  if (mobile) mobile.textContent = item ? item[1] : 'Обзор';
  // 换页时清掉上一页留下的末级（二级页签名），避免面包屑挂错分类。
  const c = document.getElementById('crumb');
  if (c) c.querySelectorAll('i.tail,b').forEach((n) => n.remove());
  document.documentElement.dataset.route = name;
}

document.addEventListener('rf4:route', (e) => {
  for (const a of document.querySelectorAll('#rail a')) {
    if (a.dataset.route === e.detail.name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  closeNavigation();
  setCrumb(e.detail.name);
});

// ---- 主题 ----
const THEMES = [['system', 'Как в системе'], ['light', 'Светлая · кость'], ['dark', 'Тёмная · тушь']];
const themeLabel = (v) => (THEMES.find(([k]) => k === v) || THEMES[0])[1];

// 只改页面状态，不碰任何节点：这样没挂进 DOM 的控件也能先算好文案。
function applyThemeState(v) {
  const root = document.documentElement;
  if (v === 'system') delete root.dataset.theme; else root.dataset.theme = v;
  try { localStorage.setItem('rf4.theme', v); } catch (e) {}
}
// 把某个值画到具体的按钮/菜单上（不按 id 全局找，页面重渲染时旧节点已经不在文档里了）。
function paintTheme(v, btn, menu) {
  const now = btn && btn.querySelector('#themeNow');
  if (now) now.textContent = themeLabel(v);
  if (menu) for (const li of menu.children) {
    const on = li.dataset.v === v;
    li.setAttribute('aria-selected', String(on));
    li.tabIndex = on ? 0 : -1;
  }
  if (btn) btn.dataset.theme = v;
}
function applyTheme(v) {
  applyThemeState(v);
  const btn = $('#themeBtn');
  paintTheme(v, btn, $('#themeMenu'));
  if (btn) btn.dispatchEvent(new CustomEvent('rf4:themechange', { detail: { value: v }, bubbles: false }));
}

// 主题切换挂在页面主操作行（「控制中心 →」旁边），不再占顶栏或左栏。
// 这里只产出控件，挂到哪由 pageHead 的 actions 决定。
export function themeMenu() {
  let saved = 'system';
  try { saved = localStorage.getItem('rf4.theme') || 'system'; } catch (e) {}
  if (!THEMES.some(([k]) => k === saved)) saved = 'system';

  const itemFor = (v, label) => h('li', {
    role: 'option', dataset: { v }, tabindex: -1, 'aria-selected': 'false',
    onclick: (ev) => { ev.stopPropagation(); applyTheme(v); close(); btn.focus(); },
  }, label);

  const menu = h('ul', {
    id: 'themeMenu', class: 'theme-menu', role: 'listbox', 'aria-label': 'Тема интерфейса',
    hidden: true,
    onkeydown: (ev) => {
      const items = [...menu.children];
      const at = items.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const step = ev.key === 'ArrowDown' ? 1 : -1;
        const next = items[(at + step + items.length) % items.length] || items[0];
        next.focus();
      } else if (ev.key === 'Home' || ev.key === 'End') {
        ev.preventDefault();
        (ev.key === 'Home' ? items[0] : items[items.length - 1]).focus();
      } else if (ev.key === 'Enter' || ev.key === ' ') {
        if (at < 0) return;
        ev.preventDefault();
        items[at].click();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        close();
        btn.focus();
      } else if (ev.key === 'Tab') {
        close();
      }
    },
  }, ...THEMES.map(([v, label]) => itemFor(v, label)));

  // 顶带上的祖先节点带 filter/overflow，fixed 会被它们当成包含块、位置算歪，
  // 所以菜单不留在原地：挂到 body 上，按按钮实测坐标摆到它下面。
  // 每页渲染都会重建一次，先把旧的摘掉，避免 body 上越堆越多。
  for (const old of document.querySelectorAll('.theme-menu')) old.remove();
  document.body.appendChild(menu);
  const place = () => {
    const r = btn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = Math.round(r.left) + 'px';
    menu.style.top = Math.round(r.bottom + 8) + 'px';
  };
  const close = () => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    place();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const cur = menu.querySelector('li[aria-selected="true"]') || menu.children[0];
    if (cur) cur.focus();
  };

  const btn = h('button', {
    id: 'themeBtn', type: 'button', class: 'theme-pick', 'aria-haspopup': 'listbox',
    'aria-expanded': 'false', 'aria-controls': 'themeMenu', title: 'Тема интерфейса',
    onclick: (e) => {
      e.stopPropagation();
      if (menu.hidden) open(); else close();
    },
    onkeydown: (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (menu.hidden) open(); }
    },
  }, h('span', { class: 'tb-lab', text: 'Выбор темы интерфейса' }), h('span', { id: 'themeNow', text: themeLabel(saved) }));

  // 按钮此刻还没挂进文档，paintTheme 直接对齐这两个本地节点，
  // 否则回到总览时按钮文案会退回默认值（localStorage 已经是新主题）。
  applyThemeState(saved);
  paintTheme(saved, btn, menu);

  const wrap = h('div', { class: 'tselect theme-inline' }, btn);
  if (!window.__rf4ThemeOutside) {
    window.__rf4ThemeOutside = true;
    const hideAll = () => {
      for (const ul of document.querySelectorAll('.theme-menu')) ul.hidden = true;
      for (const b of document.querySelectorAll('#themeBtn')) b.setAttribute('aria-expanded', 'false');
    };
    document.addEventListener('click', (ev) => {
      if (ev.target.closest && ev.target.closest('.theme-menu, #themeBtn')) return;
      hideAll();
    });
    window.addEventListener('scroll', hideAll, { passive: true });
    window.addEventListener('resize', hideAll);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hideAll(); });
  }
  return wrap;
}

// ---- 更新提示 ----
function safeURL(u) {
  return typeof u === 'string' && (u.startsWith('https://github.com/') || u.startsWith('https://gh-proxy.com/https://github.com/')) ? u : '';
}
export function updateBanner(u, slotEl) {
  const slot = slotEl || $('#updateSlot');
  if (!slot) return;
  if (!u || !u.available) { slot.replaceChildren(); return; }
  const links = [
    [u.download_mirror_url, 'Скачать (зеркало для Китая)', 'primary'],
    [u.download_url, 'Скачать с GitHub', ''],
    [u.channel === 'preview' ? '' : u.preview_download_mirror, 'Попробовать предварительную версию', 'ghost'],
    [u.notes_url, 'Что нового', 'ghost'],
  ].filter(([url]) => safeURL(url)).map(([url, label, kind]) => h('a', { class: 'pill ' + (kind === 'primary' ? 'ok' : ''), href: safeURL(url), target: '_blank', rel: 'noreferrer', text: label }));
  const dismiss = u.forced ? null : h('button', {
    class: 'ghost', text: 'Пропустить эту версию', onclick: async () => {
      try {
        const r = await fetch('/api/update/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: u.latest_version }) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        slot.replaceChildren();
      } catch (e) { toast('Действие не выполнено: ' + errText(e), 'bad'); }
    },
  });
  slot.replaceChildren(h('div', { class: 'upd', style: { margin: '0 0 14px' } },
    h('b', { text: u.forced ? 'Требуется обновление' : 'Есть новая версия' }),
    h('span', { class: 'ver', text: u.latest_version }),
    h('span', { class: 'hint', style: { margin: '0' }, text: 'Текущая ' + (u.current_version || 'Нет данных') + (u.size_text ? ' · Пакет обновления ' + u.size_text : '') }),
    h('span', { class: 'sp' }),
    ...links,
    dismiss || null));
}

// ---- 公告条 ----
function noticeBar() {
  const K = [114, 70, 52, 35, 50, 48, 50, 54];
  const C = ['lNqYypOJ1a3co7Gu2oSL087G', '0pmi3466lvuoy7K11KrYoKCV', '17+k0sn90J6n2IaPldKczI68', '2obar6yR2pKZ39jR25++1amt', 'lv6ecmPUiJKU87XEjJTdiuh1', 'AxoAAwEDRnbXo7MCAANGcAQb', 'AADRtvN3BREKAQcER38CwLKx', 'AwdBcgIVBwcGAA=='];
  const KEY = 'rf4.n0t1ce.v2';
  try { if (localStorage.getItem(KEY) === '1') return null; } catch (e) {}
  let txt = '';
  try {
    const raw = atob(C.join(''));
    let s = '';
    for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw.charCodeAt(i) ^ K[i % K.length]);
    try { txt = decodeURIComponent(escape(s)); } catch (e) { txt = s; }
  } catch (e) { return null; }
  if (!txt) return null;
  const p = txt.lastIndexOf(': ');
  const msg = p > 0 ? [txt.slice(0, p + 1), h('b', { text: txt.slice(p + 1) })] : [txt];
  const bar = h('div', { class: 'notice-bar' }, h('span', {}, msg),
    h('button', { 'aria-label': 'Закрыть', title: 'Закрыть', onclick: () => { bar.remove(); try { localStorage.setItem(KEY, '1'); } catch (e) {} } }, icon('x', 16)));
  return bar;
}

// ---- 登录 ----
function loginView() {
  const user = h('input', { id: 'lu', autocomplete: 'username', required: true });
  const pass = h('input', { id: 'lp', type: 'password', autocomplete: 'current-password', required: true });
  const submit = h('button', { class: 'primary', style: { width: '100%' }, type: 'submit', text: 'Войти' });
  const err = h('p', { class: 'alert', hidden: true });
  const form = h('form', {
    class: 'login-card',
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      err.hidden = true;
      try {
        const d = await post('/api/login', { username: user.value, password: pass.value });
        setToken(d.token);
      } catch (ex) {
        err.hidden = false;
        err.textContent = ex.status === 401 || ex.status === 403 ? 'Неверный логин или пароль.' : errText(ex);
      } finally { submit.disabled = false; }
    },
  },
  h('h1', { text: 'Вход в админ-панель' }),
  h('p', { class: 'lede', text: 'Управление игроками, ловлей, магазином и настройками системы' }),
  err,
  h('label', { class: 'field' }, h('span', { text: 'Логин' }), user),
  h('label', { class: 'field' }, h('span', { text: 'Пароль' }), pass),
  submit,
  h('p', { class: 'hint', html: 'Забыли пароль? Логин и пароль записаны в папке сервера в файле <code>config.yaml</code> в папке сервера (<code>admin.username</code> / <code>admin.password</code>). В сборке по умолчанию: <code>admin</code> / <code>admin123</code>. ' }));
  return h('div', { class: 'login' }, form);
}

async function boot() {
  const app = $('#app');
  me = null;
  if (getToken()) {
    try { me = await api('/api/me'); }
    catch (e) {
      if (e.status === 401 || e.status === 403) { setToken(''); }
      else if (!e.status) {
        app.replaceChildren(h('div', { class: 'login' }, h('p', { class: 'alert' }, 'Нет связи с админ-панелью: ' + errText(e))));
        return;
      }
    }
  }
  try { stats = await api('/api/dashboard'); } catch (e) { stats = null; }
  setHeroStats(stats);
  const notice = noticeBar();
  app.replaceChildren(
    rail(),
    h('main', {},
      topBar(),
      h('div', { id: 'view' }),
      h('div', { id: 'updateSlot' }),
      pageFoot(),
      h('div', { id: 'noticeSlot' }, notice || '')));
  updateBanner((me && me.update) || (stats && stats.update));
  render();
  warmAllLater();
}

export function logout() {
  setToken('');
}
onAuth(async signedIn => {
  if (!signedIn || !$('#view')) { boot(); return; }
  const session = getToken();
  const previousUser = me?.username;
  try { const user = await api('/api/me'); if (getToken() !== session) return; me = user; }
  catch (e) { if (getToken() !== session) return; }
  $('.rail .who')?.replaceWith(rail().querySelector('.who'));
  $('#loginBtn')?.remove();
  closeNavigation();
  if (parseHash().name === 'players' && (!previousUser || me?.username !== previousUser)) render();
  else document.dispatchEvent(new Event('rf4:login'));
});
boot();
export function currentUser() { return me; }
export { parseHash };
