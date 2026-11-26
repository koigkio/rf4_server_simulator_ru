// 玩家：顶上选人，下面按二级页签看和改这个人的一切。
import {
  h, api, apiList, post, icon, toast, errText, pageHead, pageTabs, work, ib, h2s, h3s, hint, note, kv, bullets, pill, callout, badge,
  empty, btn, loading, Form, savebar,
  searchBox, debounce, confirmDialog, sidePage, fmt, timeText, relTime, navigate, segmented, hideSavebar, replaceHash, render, setCrumbTail,
  getToken, loginDialog,
} from '../core.js';
import { itemIcon } from '../widgets.js';
import { ru } from '../names-ru.js';

const TABS = [['profile', 'Профили'], ['items', 'Инвентарь и снаряжение'], ['keepnet', 'Садок'], ['records', 'Записи по рыбам'], ['skills', 'Навыки'], ['mail', 'Почта']];
const GRADE = ['Не поймана', 'Поймана', 'Зачётная', 'Звёзды', 'Синяя корона'];
const cents = (v) => (Number(v || 0) / 100).toFixed(2).replace(/\.00$/, '');
let QUERY = '';

export default async function players(params, scope) {
  const [uidParam, tabParam] = params;
  const routeHash = location.hash;
  const isCurrent = () => scope.isCurrent() && location.hash === routeHash;
  if (!getToken()) {
    // 玩家数据不对未登录访客下发；其余页面都能直接看。
    return [
      pageHead('Игроки', 'Просмотр и изменение уровня, валюты, инвентаря, садка, атласа и навыков персонажа.'),
      work([
        h2s('Для этой страницы нужен вход'),
        hint('Профили игроков содержат данные учётных записей и без входа не выдаются. После входа страница загрузится автоматически; остальные страницы доступны и без входа.'),
        h('div', { style: { marginTop: '14px' } }, btn('Вход в админ-панель', () => loginDialog(), 'primary')),
        h('p', { class: 'hint', style: { marginTop: '12px' }, html: 'Войти можно и на главной странице центра управления: состояние входа у страниц общее.' }),
      ], ib('Почему отдельная защита', null, hint('Изменения данных игроков пишутся в аудит и базу персонажей, поэтому только эти функции требуют входа.'))),
    ];
  }
  const tab = TABS.some(([k]) => k === tabParam) ? tabParam : 'profile';
  const tabLabel = (TABS.find(([k]) => k === tab) || [])[1];

  let list = [], listError = '', request = 0;
  let expired = false;
  const loadList = async (background = false) => {
    const id = ++request;
    try {
      const rows = await apiList('/api/players?q=' + encodeURIComponent(QUERY), { preserveSession: background });
      if (id === request) { list = rows; listError = ''; }
    } catch (e) { if (id === request) { listError = errText(e); if (background && e.status === 401) expired = true; } }
  };
  await loadList();
  if (!isCurrent()) return [];
  const uid = uidParam || (list[0] ? String(list[0].uid) : '');
  if (!uidParam && uid) { navigate('players', uid, tab); return []; }

  const whoRow = h('div', { class: 'whorow', role: 'group', 'aria-label': 'Список игроков' });
  const presence = row => {
    const state = listError || row?.online_known === false || typeof row?.online !== 'boolean' ? 'unknown' : row.online ? 'online' : 'offline';
    return h('span', { class: 'player-presence', dataset: { state }, text: {online:'Онлайн', offline:'Офлайн', unknown:'Состояние не передано'}[state] });
  };
  const drawWho = () => {
    const focused = whoRow.contains(document.activeElement) ? document.activeElement.dataset.uid : null;
    const shown = list.slice(0, 16);
    whoRow.replaceChildren(...[
      shown.length ? h('div', { class: 'seg player-roster' }, ...shown.map((p2) => h('button', {
        type: 'button', dataset: {uid: p2.uid}, 'aria-pressed': String(String(p2.uid) === String(uid)),
        class: String(p2.uid) === String(uid) ? 'roster-option on' : 'roster-option',
        onclick: () => { if (String(p2.uid) !== String(uid)) navigate('players', p2.uid, tab); },
      }, h('span', { class:'player-identity' }, h('strong', {text:p2.name, title:p2.name}), h('small', { text:'UID ' + p2.uid })),
      h('span', {class:'roster-level', text:`Lv.${p2.level}`}), h('span', {class:'roster-state'}, presence(p2), p2.banned ? h('small',{text:'Забанен'}) : null),
      h('span', {class:'roster-mark', 'aria-hidden':'true'}, String(p2.uid) === String(uid) ? icon('check',16) : null))))
        : h('span', { class: 'hint', text: listError ? 'Не удалось прочитать список игроков: ' + listError : QUERY ? 'Игрок не найден' : 'Ещё никто из игроков не входил' }),
      list.length > shown.length ? h('span', { class: 'hint', text: 'Всего ' + list.length + ' чел., воспользуйтесь поиском выше' }) : null,
    ].filter(Boolean));
    if (focused) [...whoRow.querySelectorAll('button')].find(b => b.dataset.uid === focused)?.focus({preventScroll:true});
  };
  drawWho();

  let refreshPresence = () => {};
  const search = searchBox('Поиск по нику или UID', debounce((v) => { QUERY = v; loadList().then(() => { drawWho(); refreshPresence(); }); }, 260), QUERY);
  search.querySelector('input').setAttribute('aria-label','Поиск по нику или UID');
  const searchRow = h('div', { class: 'roster-toolbar' }, h('h3', {text:'Сменить игрока'}), search);

  const tabsEl = pageTabs(TABS, tab, (k) => navigate('players', uid, k));
  setCrumbTail(tabLabel);

  let p = null;
  if (uid) { try { p = await api('/api/players/detail?uid=' + encodeURIComponent(uid)); } catch (e) { p = null; } }
  if (!isCurrent()) return [];

  if (!p) {
    return [
      pageHead('Игроки', 'Просмотр и изменение уровня, валюты, инвентаря, садка, атласа и навыков персонажа.'),
      tabsEl,
      work([searchRow, whoRow, h('div', { style: { marginTop: '18px' } }, callout(uid ? 'bad' : 'info', uid ? 'Не удалось прочитать этого игрока, возможно, его уже нет.' : 'Сначала выберите игрока выше.'))], [
        ib('Пояснение', null, bullets(['Изменять можно только персонажей, которые уже входили в игру.', 'Если игрок онлайн, он сразу увидит изменения, перезаходить не нужно.'])),
      ]),
    ];
  }

  const reload = () => { if (isCurrent() && whoRow.isConnected) render(); };
  const status = h('span');
  const headerStatus = h('span');
  refreshPresence = syncStatus;
  syncStatus();
  function syncStatus() {
    const row = list.find(row => String(row.uid) === String(uid));
    headerStatus.replaceChildren(presence(row));
    status.replaceChildren(presence(row), p.banned ? ' Забанен' : '');
  }
  let polling = false;
  const poll = setInterval(async () => {
    if (polling || expired || !isCurrent() || !whoRow.isConnected || document.hidden) return;
    polling = true;
    try {
      await loadList(true);
      if (isCurrent() && whoRow.isConnected) {
        drawWho(); syncStatus();
        if (expired) status.replaceChildren('Сессия истекла, черновик не потерян.', btn('Войти снова', () => loginDialog(), 'ghost'));
      }
    }
    finally { polling = false; }
  }, 8000);
  const resume = () => { expired = false; syncStatus(); };
  document.addEventListener('rf4:login', resume);
  scope.setPageCleanup(() => { clearInterval(poll); document.removeEventListener('rf4:login', resume); });
  const meta = `UID ${p.uid} · Lv.${p.level} · Опыт ${fmt(p.xp)} · Предметы ${p.item_count || 0} · Садок ${p.keepnet_count || 0} · Почта ${p.mail_count || 0}`;
  const actRow = h('div', { class: 'row', style: { gap: '8px', margin: '0 0 14px', padding: '0', borderBottom: '0', flexWrap: 'nowrap', justifyContent: 'flex-start' } },
    btn('Написать письмо', () => navigate('mail', p.uid), 'sm', { icon: 'mail' }),
    btn('Отключение игрока', async () => {
      if (!(await confirmDialog({ title: `Сбросить «${p.name}» отключить от сервера?`, desc: 'Игрок будет отключён и сможет сразу войти снова.', confirm: 'Отключение игрока' }))) return;
      try { await post('/api/players/kick', { uid: p.uid }); toast('Отключён'); } catch (e) { toast(errText(e), 'bad'); }
    }, 'ghost sm'),
    btn(p.banned ? 'Разбанить' : 'Бан', async () => {
      const ban = !p.banned;
      if (!(await confirmDialog({ title: ban ? `Забанить «${p.name}»? ` : `Снять бан с «${p.name}»?`, desc: ban ? 'После бана игрок не сможет войти в игру.' : 'После разбана игрок сможет входить как обычно.', confirm: ban ? 'Бан' : 'Разбанить', danger: ban }))) return;
      try { await post('/api/players/ban', { uid: p.uid, banned: ban }); toast(ban ? 'Забанен' : 'Бан снят'); render(); } catch (e) { toast(errText(e), 'bad'); }
    }, p.banned ? 'ghost sm' : 'danger sm'));

  const builders = { profile, items, keepnet, records, skills, mail };
  const pane = builders[tab](p, reload, scope.setLeaveGuard);

  const hh = p.happy_hour || {};
  const aside = [
    ib('Эта учётная запись', null, status, kv([
      ['UID', String(p.uid)],
      ['Ник', p.name || '—'],
      ['Уровень', 'Lv.' + p.level],
      ['Серебро', cents(p.silver) + ' Серебро'],
      ['Золото', cents(p.gold) + ' Золото'],
      ['Премиум', p.membership === 1 ? (p.membership_active === false ? 'Временный премиум истёк' : 'Временный премиум') : p.membership === 2 ? 'Вечный премиум' : 'Обычный'],
      ['Последний вход', p.last_login ? relTime(p.last_login) : '—'],
    ])),
    ib('Инвентарь и садок', null, kv([
      ['Предметы', String(p.item_count || 0) + ' шт.'],
      ['Садок', String(p.keepnet_count || 0) + ' шт.'],
      ['Почта', String(p.mail_count || 0) + ' писем'],
    ]), hint(hh.enabled === false ? 'Счастливый час выключен в разделе «Ловля и клёв».' : !hh.qualified ? 'С премиумом действует бонус счастливого часа.' : hh.unlimited ? 'Вечный премиум — счастливый час действует всегда.' : 'Счастливый час активен, осталось около ' + Math.ceil((hh.remaining_seconds || 0) / 60) + ' мин.')),
    ib('Связанные действия', null, h('div', { class: 'pills' },
      h('a', { class: 'pill', href: '#mail/' + p.uid, text: 'Написать письмо этому игроку' }),
      h('a', { class: 'pill', href: '#audit', text: 'Что он изменял' })),
      hint('Баны и отключения записываются в журнал аудита.')),
  ];
  return [
    pageHead('Игроки', 'Просмотр и изменение уровня, валюты, инвентаря, садка, атласа и навыков персонажа.'),
    tabsEl,
    work([searchRow, whoRow, h('div', {class:'player-heading'}, h2s(`${p.name} (UID ${p.uid})`), headerStatus), hint(meta), actRow, pane], aside),
  ];
}

// ---------- 概况 ----------
function profile(p, reload, setDirty) {
  const form = new Form();
  // 保存条内联在表单底部（演示页就是 section 底部的「放弃修改 / 核对并保存」）。
  const actions = h('div', { class: 'savebar-inline' });
  savebar(form, {
    inline: actions,
    effect:'Игроки онлайн получают обновление сразу.',
    onSave: async (v) => {
      const body = { uid: p.uid };
      if ('name' in v) body.name = v.name;
      for (const key of ['level', 'xp']) if (key in v) body[key] = Number(v[key]);
      for (const key of ['silver', 'gold', 'bank']) if (key in v) body[key] = Math.round(Number(v[key]) * 100);
      const m = +memberField.input.value;
      const exp = m === 1 && expInput.value ? Math.floor(new Date(expInput.value).getTime() / 1000) : 0;
      if ('membership' in v || 'membership_exp' in v) {
        if (m === 1 && (!exp || exp <= Date.now() / 1000)) throw new Error('Для временного премиума выберите дату окончания в будущем');
        body.membership = m; body.membership_exp = exp;
      }
      await post('/api/players/update', body);
      setTimeout(() => { if (!form.isDirty()) reload(); }, 0);
    },
  });
  setDirty(() => form.isDirty());
  // 会员：分段选择 + 到期时间
  const memberField = form.field({ key: 'membership', label: 'Премиум', kind: 'string' }, String(p.membership || 0));
  memberField.input = h('input', { type: 'hidden', value: memberField.original });
  const toLocal = (ts) => { if (!ts) return ''; const d = new Date(ts * 1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  const expField = form.field({ key: 'membership_exp', label: 'До', kind: 'string' }, toLocal(p.membership_exp));
  const expInput = h('input', { type: 'datetime-local', class: 'input', value: expField.original, style: { width: '240px' }, oninput: () => form.refresh() });
  expField.input = expInput;
  const expWrap = h('div', { class: 'row', hidden: String(p.membership) !== '1' }, h('span', { class: 'muted small', text: 'Время окончания' }), expInput);
  const seg = segmented([['0', 'Обычный'], ['1', 'Временный премиум'], ['2', 'Вечный премиум']], String(p.membership || 0), (v) => { memberField.input.value = v; expWrap.hidden = v !== '1'; form.refresh(); });
  seg.classList.add('membership-options');
  const hh = p.happy_hour || {};
  const hhText = hh.enabled === false ? 'Счастливый час выключен в «Правилах игры».' : !hh.qualified ? 'С премиумом действует бонус счастливого часа.'
    : hh.unlimited ? 'Вечный премиум — счастливый час действует всегда.' : `Счастливый час активен, осталось около ${Math.ceil((hh.remaining_seconds || 0) / 60)} мин.`;
  const memberRow = h('div', { class: 'row' }, h('span', { class: 'lab' },
    h('b', { text: 'Премиум' }), h('small', { text: 'Для временного укажите окончание' })),
    h('span', { class: 'ctrl' }, seg));
  const expRow = h('div', { class: 'row', hidden: String(p.membership) !== '1' }, h('span', { class: 'lab' }, h('b', { text: 'Окончание премиума' })),
    h('span', { class: 'ctrl' }, expInput));
  const hhNote = h('p', { class: 'hint', style: { margin: '10px 0 0' }, text: hhText });
  const resetExp = () => { expRow.hidden = memberField.input.value !== '1'; };
  seg.addEventListener('click', () => setTimeout(resetExp, 0), true);
  resetExp();
  return h('div', {},
    h('div', { class: 'rows' },
      form.row({ key: 'name', label: 'Ник', kind: 'string', required: true }, p.name),
      form.row({ key: 'level', label: 'Уровень', kind: 'int', min: 1, max: 58, unit: 'ур.' }, p.level),
      form.row({ key: 'xp', label: 'Всего опыта', kind: 'int', min: 0, help: 'Уровень и опыт должны соответствовать друг другу, иначе полоса опыта будет отображаться неправильно.' }, p.xp),
      form.row({ key: 'silver', label: 'Серебро (копейки)', kind: 'float', min: 0, help: 'Вводите число как в игре, можно с двумя знаками после запятой.' }, cents(p.silver)),
      form.row({ key: 'gold', label: 'Золото (копейки)', kind: 'float', min: 0 }, cents(p.gold)),
      form.row({ key: 'bank', label: 'Банк (копейки)', kind: 'float', min: 0 }, cents(p.bank)),
      memberRow, expRow),
    hhNote,
    actions);
}

// ---------- 背包 ----------
function items(p, reload) {
  let q = '';
  const body = h('tbody');
  const draw = () => {
    const rows = (p.items || []).filter((x) => !q || `${x.item_id} ${x.name} ${ru(x.name)} ${x.guid}`.toLowerCase().includes(q));
    body.replaceChildren(...(rows.length ? rows.map((x) => h('tr', {},
      h('td', {}, h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, itemIcon(x.item_id), h('div', {}, h('b', { text: x.name || x.item_id }), h('span', { class: 'sub mono', title: x.guid, text: x.item_id + ' · ' + String(x.guid).slice(-8) })))),
      h('td', { text: x.container === 'equip' ? 'Экипировано' : x.container === 'bag' ? 'Инвентарь' : (x.container || '') }),
      h('td', { class: 'num', text: fmt(x.qty) }),
      h('td', { class: 'num', text: x.durability === undefined || x.durability === null ? '—' : Number(x.durability) <= 1 ? (Number(x.durability) * 100).toFixed(1) + '%' : String(x.durability) }),
      h('td', { class: 'num' }, btn('Удалить', async () => {
        if (!(await confirmDialog({ title: `Удалить «${x.name || x.item_id}»? `, desc: `${p.name} (UID ${p.uid}) · экземпляр ${x.guid} · Количество ${x.qty}— восстановить будет нельзя.`, confirm: 'Удалить', danger: true }))) return;
        try { await post('/api/players/items/delete', { uid: p.uid, guids: [x.guid] }); toast('Удалено, вступит в силу примерно через 2 секунды'); setTimeout(reload, 2300); } catch (e) { toast(errText(e), 'bad'); }
      }, 'ghost sm')))) : [h('tr', {}, h('td', { colspan: 5 }, empty(q ? 'Нет подходящих предметов' : 'Инвентарь пуст')))]));
  };
  draw();
  return h('div', { class: 'stack' },
    searchBox('Фильтр по названию предмета или ID', (v) => { q = v.toLowerCase(); draw(); }),
    h('div', { class: 'tbl', style: { maxHeight: '62vh', overflow: 'auto' } }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: 'Предметы' }), h('th', { text: 'Место' }), h('th', { class: 'num', text: 'Количество' }), h('th', { class: 'num', text: 'Прочность' }), h('th', {}))), body)));
}

// ---------- 护鱼网 ----------
function keepnet(p, reload) {
  const rows = p.keepnet || [];
  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('span', { class: 'grow muted small', text: `Всего ${rows.length} рыб. После удаления статистика и рыбный рынок обновятся.` }), btn('Положить рыбу', () => addFish(p, reload), 'primary sm', { icon: 'plus' })),
    rows.length ? h('div', { class: 'tbl', style: { maxHeight: '62vh', overflow: 'auto' } }, h('table', {},
      h('thead', {}, h('tr', {}, ['Рыба', 'Вес', 'Категория', 'Место', 'Наживка', 'Время', ''].map((t, i) => h('th', { class: i === 1 ? 'num' : '', text: t })))),
      h('tbody', {}, rows.map((x) => h('tr', {},
        h('td', {}, h('b', { text: x.name_zh || x.species }), h('span', { class: 'sub mono', text: x.species })),
        h('td', { class: 'num', text: fmt(x.weight_g) + ' g' }),
        h('td', {}, badge(GRADE[x.cat] || ('Категория ' + x.cat), x.cat >= 4 ? 'accent' : x.cat >= 3 ? 'warn' : '')),
        h('td', { text: x.keep_level || x.keep_loc || '—' }),
        h('td', { class: 'mono small', text: x.keep_bait || '—' }),
        h('td', { class: 'small muted', text: timeText(x.ts) }),
        h('td', {}, btn('Удалить', async () => {
          if (!(await confirmDialog({ title: 'Удалить эту рыбу из садка?', desc: 'Восстановить будет нельзя.', confirm: 'Удалить', danger: true }))) return;
          try { await post('/api/players/keepnet/delete', { uid: p.uid, guids: [x.echo_guid] }); toast('Удалено, вступит в силу примерно через 2 секунды'); setTimeout(reload, 2300); } catch (e) { toast(errText(e), 'bad'); }
        }, 'ghost sm'))))))) : h('div', { class: 'card' }, empty('Садок пуст')));
}
function addFish(p, reload) {
  const form = new Form();
  const results = h('div', { class: 'card', style: { maxHeight: '200px', overflow: 'auto' } });
  const species = form.stacked({ key: 'species', label: 'Вид рыбы', kind: 'string', required: true, placeholder: 'Поиск по названию рыбы, например плотва', span: true }, '');
  const speciesInput = form.fields.get('species').input;
  let selected = '';
  speciesInput.addEventListener('input', () => { selected = ''; hint.textContent = ''; results.replaceChildren(); });
  const hint = h('div', { class: 'help' });
  speciesInput.addEventListener('input', debounce(async () => {
    const q = speciesInput.value.trim();
    if (!q) { results.replaceChildren(); return; }
    const list = await apiList('/api/fish/pool?limit=30&q=' + encodeURIComponent(q)).catch(() => []);
    if (speciesInput.value.trim() !== q) return;
    results.replaceChildren(list.length ? h('div', { class: 'list' }, list.map((f) => h('button', { type: 'button', class: 'list-item clickable', onclick: () => { selected = speciesInput.value = f.fish_key; hint.textContent = `${f.name_zh}, часто встречается ${fmt(f.min_g)}–${fmt(f.max_g)} g`; results.replaceChildren(); } },
      h('div', { class: 'grow' }, h('div', { class: 'title', text: f.name_zh }), h('div', { class: 'sub mono', text: f.fish_key })), h('span', { class: 'muted small', text: `${fmt(f.min_g)}–${fmt(f.max_g)} g` })))) : empty('Ничего не найдено', 'Попробуйте другое название рыбы или ID.'));
  }, 250));
  sidePage({
    title: 'В садок', beforeClose: () => !form.isDirty() || confirm('Отменить несохранённую запись садка?'), isDirty: () => form.isDirty(),
    body: h('div', { class: 'stack' }, species, results, hint, h('div', { class: 'form-grid' },
      form.stacked({ key: 'weight_g', label: 'Вес (г)', kind: 'int', min: 1 }, '500'),
      form.stacked({ key: 'cat', label: 'Категория', kind: 'select', options: [['1', 'Обычный'], ['2', 'Зачётная'], ['3', 'Трофей'], ['4', 'Синяя корона']] }, '1'),
      form.stacked({ key: 'keep_level', label: 'Место (необязательно)', kind: 'string', placeholder: 'Например level_001_lake' }, ''),
      form.stacked({ key: 'keep_loc', label: 'Локация (необязательно)', kind: 'string' }, ''),
      form.stacked({ key: 'keep_spot', label: 'Номер точки', kind: 'int', min: 0 }, '0'),
      form.stacked({ key: 'keep_bait', label: 'Наживка (необязательно)', kind: 'string', placeholder: 'Например worm_01' }, ''))),
    actions: [{ label: 'Отмена', kind: 'ghost' }, {
      label: 'Положить', kind: 'primary', onClick: async () => {
        if (!form.validate(['species', 'weight_g', 'keep_spot'])) return true;
        if (!selected || selected !== speciesInput.value) { hint.textContent = 'Выберите вид рыбы из результатов поиска.'; speciesInput.focus(); return true; }
        await post('/api/players/keepnet/add', { uid: p.uid, species: selected, weight_g: +form.value('weight_g'), cat: +form.value('cat'), keep_level: form.value('keep_level'), keep_loc: form.value('keep_loc'), keep_spot: +form.value('keep_spot'), keep_bait: form.value('keep_bait') });
        toast('Положено, вступит в силу примерно через 2 секунды'); setTimeout(reload, 2300);
      },
    }],
  });
}

// ---------- 图鉴补录 ----------
function records(p, reload, setDirty) {
  const box = h('div', {}, loading(5));
  let data = null, level = '', q = '';
  const changes = new Map();
  setDirty(() => changes.size > 0);
  const saveBtn = btn('Сохранить дополнение', async () => {
    const invalid = [...changes.values()].find(c => c.raw && (!/^[1-9]\d*$/.test(c.raw) || !Number.isSafeInteger(Number(c.raw))));
    if (invalid) { toast(invalid.fish_key + ' : вес дополнения должен быть целым положительным числом граммов, пусто — автоматически.', 'bad'); return; }
    saveBtn.disabled = true;
    try {
      const r = await post('/api/players/records', { uid: p.uid, level, changes: [...changes.values()].map(({fish_key, grade, raw}) => ({fish_key, grade, weight_g: Number(raw)})) });
      toast('Сохранено, резервная копия сохранения создана автоматически (' + r.backup + ')');
      changes.clear(); await load(level);
    } catch (e) { toast(errText(e), 'bad'); saveBtn.disabled = false; }
  }, 'primary', { disabled: true });
  const sync = () => { saveBtn.disabled = !changes.size; saveBtn.textContent = changes.size ? `Сохранить дополнения (${changes.size})` : 'Сохранить дополнение'; };
  async function load(lv) {
    box.replaceChildren(loading(5));
    try { data = await api('/api/players/records?uid=' + p.uid + '&level=' + encodeURIComponent(lv || '')); level = data.level; draw(); }
    catch (e) { box.replaceChildren(empty('Ошибка чтения', errText(e))); }
  }
  function draw() {
    const mapSel = h('select', { class: 'select', style: { width: '220px' }, onchange: async (e) => {
      if (changes.size && !(await confirmDialog({ title: 'Изменения этой карты ещё не сохранены', desc: 'При смене карты эти изменения будут потеряны.', confirm: 'Отменить и переключить' }))) { e.target.value = level; return; }
      changes.clear(); sync(); load(e.target.value);
    } }, data.maps.map((m) => h('option', { value: m.level, text: m.name, selected: m.level === data.level })));
    const tbody = h('tbody');
    const rows = () => tbody.replaceChildren(...data.fish.filter((f) => !q || `${f.name} ${ru(f.name)} ${f.fish_key}`.toLowerCase().includes(q)).map((f) => {
      const c = changes.get(f.fish_key) || { fish_key: f.fish_key, grade: f.restored_grade || 0, weight_g: f.restored_weight_g || 0 };
      const sel = h('select', { class: 'select', style: { height: '30px' } }, [0, 1, 2, 3, 4].map((g) => h('option', { value: g, text: g === 0 ? 'Не дополнять' : GRADE[g], selected: +c.grade === g })));
      const w = h('input', { class: 'input num', style: { height: '30px', width: '130px' }, placeholder: 'Авто', value: c.raw ?? (c.weight_g || '') });
      const edit = () => { changes.set(f.fish_key, { fish_key: f.fish_key, grade: +sel.value, raw: w.value.trim() }); sync(); };
      sel.addEventListener('change', () => { w.value = ''; edit(); });
      w.addEventListener('input', edit);
      return h('tr', {}, h('td', {}, h('b', { text: f.name }), h('span', { class: 'sub mono', text: f.fish_key })),
        h('td', {}, badge(GRADE[f.grade] || 'Не поймана', f.grade >= 4 ? 'accent' : f.grade >= 3 ? 'warn' : f.grade > 0 ? 'ok' : '')),
        h('td', { class: 'num', text: f.weight_g ? fmt(f.weight_g) + ' g' : '—' }), h('td', {}, sel), h('td', {}, w));
    }));
    rows();
    box.replaceChildren(h('div', { class: 'stack' },
      callout('info', 'Используется, чтобы заполнить атлас. Дополнение засчитывается как улов, но без опыта, денег и без помещения в садок. Настоящие записи уловов не перезаписываются. Перед сохранением автоматически создаётся резервная копия. Лучше делать это, когда игрок не в сети.'),
      h('div', { class: 'row records-toolbar' }, mapSel, h('div', { class: 'grow' }, searchBox('Фильтр по названию рыбы', (v) => { q = v.toLowerCase(); rows(); })), saveBtn),
      h('div', { class: 'tbl', style: { maxHeight: '58vh', overflow: 'auto' } }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { text: 'Рыба' }), h('th', { text: 'Сейчас' }), h('th', { class: 'num', text: 'Самая тяжёлая' }), h('th', { text: 'Дополнить как' }), h('th', { text: 'Вес дополнения (г)' }))), tbody))));
  }
  load('');
  return box;
}

// ---------- 技能 ----------
function skills(p, reload, setDirty) {
  const list = p.skills || [];
  const avail = Number(p.available_points ?? 0);
  const unsaved = new Set();
  setDirty(() => unsaved.size > 0);
  const points = h('input', { class: 'input num', style: { width: '100px' }, value: avail, oninput: () => { unsaved.add('points'); } });
  return h('div', { class: 'stack' },
    h('div', { class: 'card', style: { padding: '14px 16px', background: 'var(--surface-2)' } }, h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('b', { text: 'Нераспределённые очки навыков' }), h('div', { class: 'muted small', text: `Всего получено за уровни ${p.skill_total ?? 0} очк., использовано ${p.skill_spent ?? 0} очк.` })),
      points, btn('Сохранить', async () => {
        const raw = points.value.trim(), value = Number(raw);
        if (!/^\d+$/.test(raw) || value > 1000000) { toast('Очки навыков должны быть целым числом от 0 до 1000000.', 'bad'); points.focus(); return; }
        try { const result = await post('/api/players/skills/points', { uid: p.uid, points: value }); if (points.value.trim() === raw) { points.value = String(result.available_points); unsaved.delete('points'); } toast('Сохранено, игроки онлайн сразу получили обновление'); } catch (e) { toast(errText(e), 'bad'); }
      }, 'primary sm'))),
    h('p', { class: 'muted small', text: 'Ниже — мастерство в каждом способе ловли (0–100%). ' }),
    h('div', { class: 'grid-2' }, list.map((s) => {
      const v = Number(s.points) || 0;
      const out = h('output', { text: v.toFixed(1) + '%' });
      const range = h('input', { type: 'range', min: 0, max: 100, step: 0.1, value: v, oninput: (e) => { out.textContent = Number(e.target.value).toFixed(1) + '%'; save.hidden = false; unsaved.add(s.skill_id); } });
      const save = btn('Сохранить', async () => {
        try { await post('/api/players/skills/update', { uid: p.uid, skill_id: s.skill_id, points: +range.value }); unsaved.delete(s.skill_id); toast(`Сохранено «${s.name}», игроки онлайн сразу получили обновление`); save.hidden = true; } catch (e) { toast(errText(e), 'bad'); }
      }, 'primary sm', { hidden: true });
      return h('div', { class: 'card', style: { padding: '12px 14px', background: 'var(--surface-2)' } },
        h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('b', { text: s.name }), save),
        h('div', { class: 'range-row', style: { marginTop: '6px' } }, range, out));
    })),
    h('div', {}, btn('Сбросить всё', async () => {
      if (!(await confirmDialog({ title: 'Обнулить всё мастерство?', desc: 'Мастерство во всех способах ловли станет 0%, восстановить будет нельзя.', confirm: 'Обнулить', danger: true }))) return;
      try { for (const s of list) await post('/api/players/skills/update', { uid: p.uid, skill_id: s.skill_id, points: 0 }); unsaved.clear(); toast('Обнулено'); reload(); } catch (e) { toast(errText(e), 'bad'); }
    }, 'danger sm')));
}

// ---------- 邮箱 ----------
function mail(p, reload) {
  const rows = p.mails || [];
  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('span', { class: 'grow muted small', text: 'Если у игрока сломанное письмо, из которого нельзя забрать вложения, его можно удалить здесь и отправить заново.' }), btn('Написать ему письмо', () => navigate('mail', p.uid), 'primary sm', { icon: 'mail' })),
    rows.length ? h('div', { class: 'tbl', style: { maxHeight: '62vh', overflow: 'auto' } }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: 'Содержание' }), h('th', { text: 'Тип' }), h('th', { text: 'Состояние' }), h('th', { text: 'Время' }), h('th', {}))),
      h('tbody', {}, rows.map((m) => h('tr', {},
        h('td', { style: { whiteSpace: 'normal', maxWidth: '420px' } }, h('b', { text: m.text || '(только вложения)' }), h('span', { class: 'sub mono', text: 'Почта #' + m.id })),
        h('td', { text: m.kind ? 'С вложениями' : 'Текст' }),
        h('td', {}, m.read ? badge('Прочитано') : badge('Не прочитано', 'accent')),
        h('td', { class: 'small muted', title: timeText(m.created_ts), text: relTime(m.created_ts) }),
        h('td', {}, btn('Удалить', async () => {
          if (!(await confirmDialog({ title: `Удаление письма #${m.id}? `, desc: `${p.name} (UID ${p.uid}) · ${m.text || 'Только вложения'}. Восстановить будет нельзя.`, confirm: 'Удалить', danger: true }))) return;
          try { await post('/api/players/mail/delete', { uid: p.uid, ids: [m.id] }); toast('Удалено'); setTimeout(reload, 300); } catch (e) { toast(errText(e), 'bad'); }
        }, 'ghost sm'))))))) : h('div', { class: 'card' }, empty('Почта пуста')));
}
