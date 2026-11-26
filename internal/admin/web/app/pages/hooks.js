// 鱼钩：按型号微调咬口难易。真实物理数据只读。
import { h, api, post, toast, errText, pageHead, work, ib, h2s, hint, bullets, badge, btn, empty, loading, searchBox, debounce, sidePage, Form, fmt, replaceHash, render } from '../core.js';
import { itemIcon } from '../widgets.js';

const FAMILY = [['', 'Все типы крючков'], ['classic', 'Обычный крючок'], ['carp', 'Карповый крючок'], ['treble', 'Тройник'], ['jighead', 'Джиг-головка'], ['offset', 'Офсетный крючок'], ['marine', 'Морской крючок'], ['other', 'Прочее']];
const familyName = (f) => (FAMILY.find(([k]) => k === f) || [f, f])[1];
const isDefault = (p) => Number(p.solid_scale) === 1 && Number(p.hold_scale) === 1 && !Number(p.small_fish_floor) && !Number(p.over_capacity_hold_floor);
let Q = '', FAM = '', SIZE = '';

// 兼容旧的搏鱼书签；等路由替换视图后定位到真实的鱼参数分组。
function openFight() {
  const target = '#tuning/gameplay';
  const observer = new MutationObserver(() => {
    observer.disconnect();
    if (location.hash === target) document.getElementById('pg-fish')?.scrollIntoView({ block: 'start' });
  });
  observer.observe(document.getElementById('view'), { childList: true });
  replaceHash(target);
  render();
}

export default async function hooks(params = []) {
  if (params[0] === 'fight') { openFight(); return []; }
  const tbody = h('tbody');
  const count = h('span', { class: 'muted small' });
  const sizeSel = h('select', { class: 'select', 'aria-label': 'Номер крючка', style: { width: '130px' }, onchange: (e) => { SIZE = e.target.value; load(); } }, h('option', { value: '', text: 'Все размеры' }),
    Array.from({ length: 34 }, (_, size) => h('option', { value: size, text: '#' + size, selected: String(size) === SIZE })));
  const famSel = h('select', { class: 'select', style: { width: '140px' }, onchange: (e) => { FAM = e.target.value; load(); } }, FAMILY.map(([k, l]) => h('option', { value: k, text: l, selected: k === FAM })));
  let sequence = 0;
  const statDl = h('dl');
  async function load() {
    const request = ++sequence;
    count.textContent = 'Загрузка'; statDl.replaceChildren();
    tbody.replaceChildren(h('tr', {}, h('td', { colspan: 7 }, loading(4))));
    try {
      const d = await api(`/api/hooks/profiles?limit=500&q=${encodeURIComponent(Q)}&size=${encodeURIComponent(SIZE)}&family=${encodeURIComponent(FAM)}`);
      if (request !== sequence) return;
      if (!Array.isArray(d.profiles) || !Number.isInteger(d.total)) throw new Error('Список моделей неполный');
      const list = d.profiles;
      count.textContent = list.length < (d.total || 0) ? `Найдено ${fmt(d.total)} шт., показаны первые ${list.length} шт.` : `${fmt(list.length)} моделей`;
      statDl.replaceChildren(
        h('div', {}, h('dt', { text: 'Подходящих' }), h('dd', { text: fmt(d.total || list.length) })),
        h('div', {}, h('dt', { text: 'На этой странице' }), h('dd', { text: fmt(list.length) })),
        h('div', {}, h('dt', { text: 'Не по умолчанию на странице' }), h('dd', { text: fmt(list.filter((p) => !isDefault(p)).length) })));
      tbody.replaceChildren(...(list.length ? list.map((p) => h('tr', {},
        h('td', {}, h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, itemIcon(p.item_id, 32), h('div', {}, h('b', { text: p.name || p.brand || p.item_id }), h('span', { class: 'sub mono', text: p.item_id })))),
        h('td', { text: familyName(p.family) }),
        h('td', { class: 'num', text: '#' + p.size }),
        h('td', { class: 'num', text: Number(p.strength_kg).toFixed(1) + ' kg' }),
        h('td', { class: 'num', text: fmt(Math.round(p.entry_capacity_g)) + ' g' }),
        h('td', {}, isDefault(p) ? badge('По умолчанию') : null, h('span', { class: 'sub', text: `Засечка ×${p.solid_scale} · Удержание ×${p.hold_scale} · Минимум для мелкой рыбы ${p.small_fish_floor} · Минимум для крупной рыбы ${p.over_capacity_hold_floor}` })),
        h('td', { class: 'num' }, btn('Настроить', () => edit(p, load), 'sm')))) : [h('tr', {}, h('td', { colspan: 7 }, empty('Нет подходящих крючков')))]));
    } catch (e) {
      if (request !== sequence) return;
      count.textContent = 'Не получено';
      tbody.replaceChildren(h('tr', {}, h('td', { colspan: 7 }, empty('Ошибка чтения', errText(e)), btn('Повторить', load))));
    }
  }
  const scheduleLoad = debounce(() => { if (tbody.isConnected) load(); }, 300);
  load();
  const aside = [
    ib('За что отвечает эта страница', 'Для каждой модели крючка можно отдельно настроить засечку и надёжность удержания после засечки', bullets([
      'Прочность, длина и подходящий вес рыбы у крючка не меняются.',
      'Лёгкость засечки ×1 — по умолчанию; больше 1 — рыба засекается легче.',
      'Надёжность удержания ×1 — по умолчанию; больше 1 — при вываживании рыба реже сходит.',
      'Влияет только на эту модель, другие размеры того же типа настраиваются отдельно.',
    ])),
    ib('Параметры вываживания', null, h('a', { class: 'pill', href: '#hooks/fight', text: 'Параметры игры → Ловля → Рыба' })),
    ib('Сколько изменено', null, statDl, hint('После изменения подгружается примерно через 30 секунд, перезапуск не нужен.')),
  ];
  return [
    pageHead('Ощущение крючков', 'Для разных моделей крючков можно отдельно настроить засечку и удержание. Прочность крючка не меняется.'),
    work([
      h2s('Модели крючков'),
      hint('Фильтр по типу и размеру; «Настроить» — изменить одну модель.'),
      h('div', { class: 'hooks-toolbar', style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', margin: '0 0 12px' } },
        h('div', { style: { flex: '1 1 200px', minWidth: '160px', maxWidth: '320px' } }, searchBox('Поиск модели или бренда, например simmons', v => { Q = v; scheduleLoad(); }, Q)),
        famSel, sizeSel, h('span', { style: { flex: '1 1 auto' } }), count),
      h('div', { class: 'tbl', style: { maxHeight: 'calc(100vh - 330px)', overflow: 'auto' } }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { text: 'Крючок' }), h('th', { text: 'Тип' }), h('th', { class: 'num', text: 'Размер' }), h('th', { class: 'num', text: 'Прочность' }),
          h('th', { class: 'num', title: 'Какой рот рыбы помещается в крючок этого размера', text: 'Подходящий вес рыбы' }), h('th', {}), h('th', { class: 'num', text: 'Настроить' }))), tbody)),
    ], aside),
  ];

}

function edit(p, reload) {
  const form = new Form();
  const body = h('div', { class: 'stack' },
    h('dl', { class: 'kv small' },
      h('dt', { text: 'Тип / размер' }), h('dd', { text: `${familyName(p.family)} · #${p.size}` }),
      h('dt', { text: 'Длина' }), h('dd', { text: Number(p.length_mm).toFixed(2) + ' mm' }),
      h('dt', { text: 'Прочность' }), h('dd', { text: Number(p.strength_kg).toFixed(2) + ' kg' }),
      h('dt', { text: 'Подходящий вес рыбы' }), h('dd', { text: 'около ' + fmt(Math.round(p.entry_capacity_g)) + ' g и меньше' })),
    h('div', {},
      form.row({ key: 'solid_scale', label: 'Лёгкость засечки', help: '1 — по умолчанию. Больше 1 — засекается легче, меньше 1 — труднее.', kind: 'float', min: 0, max: 3, def: '1', unit: '×' }, p.solid_scale),
      form.row({ key: 'hold_scale', label: 'Надёжность после засечки', help: '1 — по умолчанию. Больше 1 — при вываживании рыба реже сходит.', kind: 'float', min: 0, max: 3, def: '1', unit: '×' }, p.hold_scale),
      h('details', { class: 'advanced' }, h('summary', {}, 'Дополнительно'), h('div', {},
        form.row({ key: 'small_fish_floor', label: 'Минимальная засечка для мелкой рыбы', help: 'Если рыба намного меньше крючка, засечка не опускается ниже этой доли.0–1. ', kind: 'float', min: 0, max: 1, def: '0' }, p.small_fish_floor),
        form.row({ key: 'over_capacity_hold_floor', label: 'Минимальное удержание для крупной рыбы', help: 'Если рыба тяжелее подходящего для крючка веса, удержание не опускается ниже этой доли.0–1. ', kind: 'float', min: 0, max: 1, def: '0' }, p.over_capacity_hold_floor)))));
  const advanced = body.querySelector('details');
  const error = h('p', { role: 'alert', hidden: true });
  body.append(error);
  sidePage({
    effect:'После сохранения основной сервер подгрузит изменения примерно за 30 секунд.',
    title: p.name || p.item_id, beforeClose: () => !form.isDirty() || confirm('Отменить несохранённые настройки?'), isDirty: () => form.isDirty(), desc: p.item_id, body,
    actions: [
      { label: 'Сбросить', kind: 'ghost', onClick: () => {
        for (const f of form.fields.values()) f.input.value = f.spec.def;
        advanced.open = true; error.hidden = true; form.validate([...form.fields.keys()]); form.refresh(); return true;
      } },
      { label: 'Отмена', kind: 'ghost' },
      { label: 'Сохранить', kind: 'primary', onClick: async () => {
        const keys = ['solid_scale', 'hold_scale', 'small_fish_floor', 'over_capacity_hold_floor'];
        error.hidden = true;
        if (!form.validate(keys)) { advanced.open = true; body.querySelector('[aria-invalid="true"]')?.focus(); return true; }
        const v = form.values(keys);
        try {
          await post('/api/hooks/profiles', { item_id: p.item_id, solid_scale: +v.solid_scale, hold_scale: +v.hold_scale, small_fish_floor: +v.small_fish_floor, over_capacity_hold_floor: +v.over_capacity_hold_floor });
        } catch (e) { error.textContent = errText(e); error.hidden = false; return true; }
        toast('Сохранено, вступит в силу примерно через 30 секунд'); reload();
      } },
    ],
  });
}
