// 操作记录：后台每一次修改，可按类型筛选。
import { h, apiList, pageHead, work, ib, h2s, hint, note, kv, bullets, pill, badge, empty, searchBox, timeText, relTime } from '../core.js';
import { auditLabel, AUDIT_LABELS } from '../labels.js';

const KINDS = [
  ['all', 'Все', null],
  ['player', 'Игрок', /^(player_update|grant_item|item_delete|keepnet_|skill_|kick|ban|mail_)/],
  ['play', 'Ловля', /^(tunable|fish_|bite_mode|spawn_mode|hook_profile|bait_rule)/],
  ['shop', 'Магазин', /^shop_/],
  ['login', 'Войти', /^login$/],
];

export default async function audit() {
  const list = await apiList('/api/audit?limit=200');
  let kind = 'all', q = '';
  const tbody = h('tbody');
  const count = h('span', { class: 'muted small' });
  const draw = () => {
    const re = KINDS.find(([k]) => k === kind)[2];
    const rows = list.filter((e) => {
      const a = e.Action ?? e.action;
      if (re && !re.test(a)) return false;
      if (!q) return true;
      return [auditLabel(a), a, e.Target ?? e.target, e.Detail ?? e.detail, e.Admin ?? e.admin].join(' ').toLowerCase().includes(q);
    });
    count.textContent = `${rows.length} шт.`;
    tbody.replaceChildren(...(rows.length ? rows.map((e) => {
      const ts = e.TS ?? e.ts, a = e.Action ?? e.action;
      return h('tr', {},
        h('td', { class: 'nowrap' }, h('span', { text: relTime(ts) }), h('span', { class: 'sub', text: timeText(ts) })),
        h('td', {}, h('b', { text: auditLabel(a) }), AUDIT_LABELS[a] ? null : h('span', { class: 'sub mono', text: a })),
        h('td', { class: 'mono small', text: (e.Target ?? e.target) || '—' }),
        h('td', { class: 'small text-2', style: { whiteSpace: 'normal', maxWidth: '520px', wordBreak: 'break-all' }, text: (e.Detail ?? e.detail) || '' }),
        h('td', { class: 'muted small', text: e.Admin ?? e.admin ?? '' }));
    }) : [h('tr', {}, h('td', { colspan: 5 }, empty('Записей нет')))]));
  };
  draw();
  const filters = h('div', { class: 'seg audit-kind-options' }, KINDS.map(([k, l]) => h('button', { type: 'button', class: k === kind ? 'on' : '', onclick: (ev) => { kind = k; [...filters.children].forEach((b) => b.classList.toggle('on', b === ev.currentTarget)); draw(); } }, l)));
  const statDl = h('dl');
  const refreshStat = () => {
    const byKind = KINDS.slice(1).map(([k, l, re]) => [l, String(list.filter((e) => re.test(e.Action ?? e.action)).length)]);
    statDl.replaceChildren(
      h('div', {}, h('dt', { text: 'Количество записей' }), h('dd', { text: String(list.length) })),
      ...byKind.map(([l, n]) => h('div', {}, h('dt', { text: l }), h('dd', { text: n }))));
  };
  refreshStat();
  const aside = [
    ib('Последние 200', 'Можно смотреть по типам', statDl, hint('Только чтение, нельзя изменить или удалить.')),
    ib('Что записывается', null, bullets([
      'Каждое изменение в админке: правка значений, выдача предметов, баны, письма.',
      'Действия игроков в игре сюда не попадают.',
      'Столбец «Объект» — кого меняли, «Содержание» — на что изменили.',
    ])),
  ];
  return [
    pageHead('Журнал аудита', 'Каждое изменение, сделанное в админ-панели (последние 200).'),
    work([
      h2s('История действий'),
      hint('Фильтруйте по типу или ищите по объекту и содержанию.'),
      h('div', { class: 'audit-toolbar', style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', margin: '0 0 12px' } },
        filters,
        h('div', { style: { flex: '1 1 180px', minWidth: '140px', maxWidth: '280px' } }, searchBox('Поиск по объекту или содержанию', (v) => { q = v.toLowerCase(); draw(); })),
        h('span', { style: { flex: '1 1 auto' } }), count),
      h('div', { class: 'tbl', style: { maxHeight: 'calc(100vh - 330px)', overflow: 'auto' } }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { text: 'Время' }), h('th', { text: 'Действие' }), h('th', { text: 'Объект' }), h('th', { text: 'Содержание' }), h('th', { text: 'Кто' }))), tbody)),
    ], aside),
  ];
}
