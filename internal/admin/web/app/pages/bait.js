// 鱼饵偏好：每种鱼吃什么、不吃什么，可以按时间轮换。
import { h, api, toast, errText, pageHead, work, ib, h2s, h3s, hint, note, kv, bullets, brief, pill, callout, btn, empty, loading, searchBox, debounce, sidePage, confirmDialog, segmented, toggleEl, icon } from '../core.js';

const DIET = [['lure', 'Приманки'], ['worm', 'Черви'], ['fish', 'Живцы'], ['boilie', 'Варёные насадки'], ['plant', 'Растительные'], ['crustacean', 'Ракообразные']];
const WILDCARD = [['Все виды насадок', 'Все насадки'], ['Приманки', 'Все искусственные приманки'], ['Живые насадки', 'Все живые насадки'], ['Живцы', 'Все живцы']];
let Q = '', LOC = '', FILTER = 'all';
const PAGE = 30;
let SHOWN = PAGE;

const put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body) });

// 一句话概括这条鱼现在的规则（演示页的「现在 吃 …」那一行）
function nowLine(r) {
  if (!r.has_rule) return 'Не задано, решение по фактическим данным уловов';
  const bits = [];
  if ((r.allow || []).length) bits.push('Ест ' + r.allow.slice(0, 2).join(', ') + (r.allow.length > 2 ? ` и др. ${r.allow.length} видов` : ''));
  if ((r.bottom_only || []).length) bits.push('на донке ещё ест ' + r.bottom_only.slice(0, 2).join(', '));
  if ((r.deny || []).length) bits.push('Не ест ' + r.deny.slice(0, 2).join(', '));
  if (r.rotation && r.rotation.enabled) bits.push('Ротация ' + r.rotation.total + ' групп');
  if (r.condition && r.condition !== '无') bits.push(r.condition);
  if (r.source === 'override' && r.enabled === false) bits.push('Отключено');
  const line = bits.slice(0, 3).join('; ');
  return line ? (line.length > 64 ? line.slice(0, 62) + '…' : line) : 'Включено, но наживки не указаны';
}

export default async function bait() {
  const areas = await api('/api/fish/areas').catch(() => []);
  const listWrap = h('div', { class: 'fishlist' });
  const count = h('span', { class: 'hint', style: { margin: '0 0 0 6px' } });
  const banner = h('div');
  let rows = [];
  async function load() {
    listWrap.replaceChildren(h('div', { style: { padding: '18px' } }, loading(4)));
    try {
      const d = await api('/api/bait/prefs?limit=2000&q=' + encodeURIComponent(Q) + '&loc=' + encodeURIComponent(LOC));
      rows = d.rows || [];
      banner.replaceChildren(d.rules_enabled === false ? h('div', { class: 'note' }, 'Рыба выбирает наживку: выкл.', h('a', { href: '#rules/switches', text: 'Открыть переключатели' })) : '');
      draw();
    } catch (e) { listWrap.replaceChildren(empty('Ошибка чтения', errText(e))); }
  }
  function draw() {
    const list = rows.filter((r) => FILTER === 'all' || (FILTER === 'tier3' && r.tier3 > 0) || (FILTER === 'rule' && r.has_rule) || (FILTER === 'none' && !r.has_rule) || (FILTER === 'edited' && r.source === 'override'));
    const page = list.slice(0, SHOWN);
    count.textContent = list.length > page.length ? `${list.length} видов рыб · сначала показаны ${page.length}` : `${list.length} видов рыб`;
    const more = list.length > page.length
      ? h('div', { style: { display: 'flex', justifyContent: 'center', padding: '14px 0 4px' } },
        btn(`ещё показать ${Math.min(PAGE, list.length - page.length)} видов (ещё ${list.length - page.length} видов)`, () => { SHOWN += PAGE; draw(); }, 'ghost'))
      : null;
    listWrap.replaceChildren(...(page.length ? page.map((r) => {
      const locs = (r.locs || []).slice(0, 2).join(' · ');
      return h('section', { class: 'fishcard' },
        h('div', { class: 'fishcard-head' },
          h('span', { class: 'fi' }, h('b', { class: 'fname', text: r.name_zh }), locs ? h('span', { class: 'fkey', text: locs }) : null),
          h('span', { class: 'now' }, h('em', { text: 'Сейчас' }), h('span', { text: nowLine(r) })),
          h('button', { type: 'button', class: 'edit', text: 'Изменить', onclick: () => editFish(r, load) })));
    }) : [empty('Нет рыб, подходящих под условия', 'Смените фильтр или очистите строку поиска.')]), more);
  }
  load();
  const locSel = h('select', { class: 'select', style: { width: '112px', flex: '0 0 auto' }, onchange: (e) => { LOC = e.target.value; SHOWN = PAGE; load(); } },
    h('option', { value: '', text: 'Все водоёмы' }), (Array.isArray(areas) ? areas : []).map((a) => h('option', { value: a.loc, text: a.loc, selected: a.loc === LOC })));
  const aside = [
    ib('За что отвечает каждый из трёх списков', 'Уровень детальнее, чем «одно правило на рыбу»', bullets([
      'Любит: наживки, на которые обычно клюёт.',
      'Только на донку: на поплавок и спиннинг не берёт.',
      'Не ест: явно исключено, не клюёт, даже если остальные условия выполнены.',
      'Ротация групп: наживки делятся на группы и меняются по времени — подходит, чтобы ограничить «на точке работает только одна наживка».',
      'Предварительное условие: понятная фраза, например «ночью», «температура воды 12℃ и выше».',
      'Если не отметить «Включено», этот набор правил не действует — работает поведение по умолчанию.',
    ])),
    ib('Какой уровень вы меняете', 'Меняется не сама рыба, а правила наживки на сервере', bullets([
      'Влияет только на то, клюёт ли эта рыба и на что; вид, вес и трофейность не меняются.',
      'Сохранение записывается в правила этого сервера, файлы клиента не меняются, после перезапуска ничего не теряется.',
      '«Сбросить» удаляет только переопределение этой рыбы и возвращает заводские правила.',
    ])),
    ib('Как применяется', null, hint('После сохранения правила подгружаются примерно через 30 секунд — перезапускать сервер или перезаходить игрокам не нужно.')),
  ];
  const filterSel = h('select', { class: 'select', style: { width: '104px', flex: '0 0 auto' }, onchange: (e) => { FILTER = e.target.value; SHOWN = PAGE; draw(); } },
    [['all', 'Все рыбы'], ['tier3', 'Есть наживка Tier 3'], ['rule', 'Задано'], ['none', 'Не задано'], ['edited', 'Изменённые мной']].map(([v, l]) => h('option', { value: v, text: l, selected: v === FILTER })));
  const body = [
    banner,
    h('div', { class: 'row baitfilters', style: { gap: '8px', margin: '0 0 14px', flexWrap: 'nowrap' } },
      h('div', { style: { flex: '1 1 100%', minWidth: '0' } }, searchBox('Поиск по названию рыбы ID', debounce((v) => { Q = v; SHOWN = PAGE; load(); }, 300), Q)),
      locSel, filterSel, h('span', { class: 'spacer' }), count),
    listWrap,
  ];
  return [pageHead('Предпочтения наживки', 'Что любит и чего не ест каждая рыба. Нажмите «Изменить», чтобы править по пунктам; изменения применяются примерно через 30 секунд.'), work(body, aside)];
}

function chipsInline(list) {
  const l = list || [];
  if (!l.length) return h('span', { class: 'muted', text: '—' });
  return h('span', { text: l.slice(0, 6).join(', ') + (l.length > 6 ? ` и др. ${l.length} видов` : '') });
}
// 水层条：左水面右水底，色块是活动范围，竖线是最爱的深度
function layerBar(layer, width = 200) {
  if (!layer || !(layer[0] || layer[2])) return h('span', { class: 'muted', text: '—' });
  const [lo, best, hi] = layer;
  return h('div', { title: `Держится на ${(lo * 100).toFixed(0)}%–${(hi * 100).toFixed(0)}% глубине, любимая — ${(best * 100).toFixed(0)}%(0 = поверхность, 100% = дно)`, style: { position: 'relative', width: width + 'px', height: '10px', borderRadius: '5px', background: 'var(--surface-4)' } },
    h('div', { style: { position: 'absolute', left: Math.max(0, lo * 100) + '%', width: Math.max(2, (Math.min(1, hi) - Math.max(0, lo)) * 100) + '%', top: 0, bottom: 0, borderRadius: '5px', background: 'var(--accent)', opacity: 0.55 } }),
    h('div', { style: { position: 'absolute', left: `calc(${Math.max(0, Math.min(1, best)) * 100}% - 1px)`, top: '-2px', bottom: '-2px', width: '2px', background: '#fff' } }));
}

function editFish(r, reload) {
  const st = {
    allow: [...(r.allow || [])], deny: [...(r.deny || [])], bottom: [...(r.bottom_only || [])],
    groups: (r.groups || []).map((g) => [...g]), sec: r.rotate_sec || 0, mode: r.rotate_mode || 'soft',
    enabled: r.source === 'override' ? !!r.enabled : true, cond: r.condition && r.condition !== '无' ? r.condition : '',
  };
  const snapshot = () => JSON.stringify(st);
  const initial = snapshot();
  const body = h('div');
  const chipList = (arr) => h('div', { class: 'chips' }, arr.length ? arr.map((v, i) => h('span', { class: 'chip' }, h('span', { text: v }),
    h('button', { type: 'button', 'aria-label': 'Убрать ' + v, onclick: () => { arr.splice(i, 1); draw(); } }, icon('x', 11))))
    : h('span', { class: 'muted small', text: '(пусто)' }));
  const bucket = (title, help, arr) => h('div', { style: { padding: '12px 0', borderTop: '1px solid var(--line)' } },
    h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '6px' } }, h('div', {}, h('b', { text: title }), help ? h('div', { class: 'muted small', text: help }) : null),
      btn('Добавить', () => pickBait(title, (name) => { if (!arr.includes(name)) arr.push(name); draw(); }), 'ghost sm', { icon: 'plus' })),
    chipList(arr));
  function draw() {
    const rot = r.rotation || {};
    body.replaceChildren(...[
      h('h3', { style: { fontSize: '14px', margin: '0 0 2px' }, text: 'Что ест' }),
      bucket('Любит', 'На эти наживки её можно поймать.', st.allow),
      bucket('Не ест', 'На эти наживки её не поймать.', st.deny),
      bucket('На донке ест только', 'На донке признаёт только эти наживки. Пусто — без ограничений.', st.bottom),
      h('h3', { style: { fontSize: '14px', margin: '22px 0 2px' }, text: 'Ротация по времени' }),
      h('p', { class: 'muted small', style: { marginBottom: '8px' }, text: 'Рыба любит разные наживки в разное время. Ротация работает при минимум двух группах и интервале больше 0.' }),
      rot.enabled ? callout('info', `Сейчас активна группа № ${rot.active + 1}/${rot.total} (${(rot.active_baits || []).join(', ')})`) : null,
      ...st.groups.map((g, i) => h('div', { style: { padding: '10px 0', borderTop: '1px solid var(--line)' } },
        h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '6px' } }, h('b', { class: 'small', text: '№ ' + (i + 1) + ' групп' }),
          h('div', { class: 'row' }, btn('Добавить', () => pickBait('№ ' + (i + 1) + ' групп', (name) => { if (!g.includes(name)) g.push(name); draw(); }), 'ghost sm', { icon: 'plus' }),
            btn('', () => { st.groups.splice(i, 1); draw(); }, 'ghost icon sm', { icon: 'trash', 'aria-label': 'Удалить эту группу' }))),
        chipList(g))),
      h('div', { class: 'row', style: { padding: '8px 0' } }, btn('Добавить группу', () => { if (st.groups.length >= 20) return toast('Не более 20 групп', 'bad'); st.groups.push([]); draw(); }, 'ghost sm', { icon: 'plus' })),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', { text: 'Как часто менять группу' }), h('div', { class: 'input-wrap has-unit', style: { '--unit-w': '2em' } },
          h('input', { class: 'input num', value: st.sec ? Math.round(st.sec / 60) : 0, oninput: (e) => { st.sec = Math.max(0, Math.round(Number(e.target.value || 0) * 60)); } }), h('span', { class: 'unit', text: 'мин' })), h('div', { class: 'help', text: '0 — без ротации.' })),
        h('div', { class: 'field' }, h('span', { class: 'label', text: 'Режим ротации' }), segmented([['soft', 'Мягкий'], ['strict', 'Строгий']], st.mode, (v) => { st.mode = v; }),
          h('div', { class: 'help', text: 'Мягкий: на наживки других групп тоже ловится, но реже. Строгий: работает только текущая группа.' }))),
      h('h3', { style: { fontSize: '14px', margin: '22px 0 8px' }, text: 'Прочее' }),
      h('div', { class: 'field' }, h('label', { text: 'Предварительное условие (необязательно)' }), h('input', { class: 'input', value: st.cond, placeholder: 'например, зона 80', oninput: (e) => { st.cond = e.target.value.trim(); } }),
        h('div', { class: 'help', text: 'Для Норвежского моря «зона 80» означает точку 80 м на бумажной карте. Для ограничения по сетке эхолота укажите «эхолот зона 80».' })),
      h('div', { style: { marginTop: '12px' } }, toggleEl({ checked: st.enabled, label: 'Использовать мои настройки (если выключено — правила по умолчанию)', onChange: (v) => { st.enabled = v; } })),
      habits(r)].filter(Boolean));
  }
  draw();
  const save = async () => {
    try {
      await put('/api/bait/rules', { fish_zh: r.name_zh, allow: st.allow, deny: st.deny, bottom_only: st.bottom, condition: st.cond,
        groups: st.groups.map((g) => g.filter(Boolean)).filter((g) => g.length), rotate_sec: st.sec, rotate_mode: st.mode, enabled: st.enabled });
      toast('Сохранено, вступит в силу примерно через 30 секунд');
      saved = true; d.close(); reload();
    } catch (e) { toast(errText(e), 'bad'); }
  };
  let saved = false;
  const d = sidePage({
    title: r.name_zh, sub: r.fish_key, body, effect:'Вступает в силу не позже чем через 30 секунд после сохранения, перезапускать клиент не нужно.',
    foot: [r.source === 'override' ? btn('Сбросить', async () => {
      if (!(await confirmDialog({ title: `Сбросить «${r.name_zh}» к значениям по умолчанию?`, desc: 'Ваши настройки будут удалены, вернутся встроенные правила.', confirm: 'Сбросить' }))) return;
      try { await api('/api/bait/rules/reset', { method: 'POST', body: JSON.stringify({ fish_zh: r.name_zh }) }); toast('Сброшено, вступит в силу не позже чем через 30 секунд'); saved = true; d.close(); reload(); } catch (e) { toast(errText(e), 'bad'); }
    }, 'ghost') : null, h('span', { class: 'spacer' }), btn('Сохранить', save, 'primary')],
    beforeClose: () => saved || snapshot() === initial || window.confirm('Отменить несохранённые изменения наживки?'),
    isDirty: () => !saved && snapshot() !== initial,
  });
}

// 只读：这条鱼的习性数据，帮助判断该怎么设置
function habits(r) {
  if (!r.diet && !r.layer && !r.official?.length && !r.baits?.length && !r.bite_verdict) return null;
  const bars = DIET.map(([k, label]) => {
    const v = (r.diet && r.diet[k]) || 0, gate = k === 'lure' ? 0.3 : 0.25, likes = v >= gate;
    return h('div', { class: 'row', style: { flexWrap: 'nowrap', fontSize: '12.5px' } },
      h('span', { class: 'muted', style: { width: '52px' }, text: label }),
      h('div', { style: { flex: 1, height: '8px', borderRadius: '4px', background: 'var(--surface-4)', position: 'relative', overflow: 'hidden' } },
        h('div', { style: { position: 'absolute', inset: '0 auto 0 0', width: Math.min(100, v / 2.2 * 100) + '%', background: likes ? 'var(--ok)' : 'var(--faint)', borderRadius: '4px' } })),
      h('span', { class: likes ? '' : 'muted', style: { width: '56px', textAlign: 'right' }, text: likes ? 'Любит' : 'Средне' }));
  });
  return h('details', { class: 'advanced', style: { marginTop: '22px' } }, h('summary', {}, 'Повадки этой рыбы ', h('small', { text: '(справочные данные, только чтение)' })),
    h('div', { class: 'stack', style: { paddingTop: '12px' } },
      h('div', {}, h('div', { class: 'small text-2', style: { marginBottom: '6px' }, text: r.lure_ok ? 'Берёт на искусственные приманки.' : 'Не берёт на искусственные приманки.' }), h('div', { class: 'stack', style: { gap: '5px' } }, bars)),
      h('div', {}, h('div', { class: 'small text-2', style: { marginBottom: '6px' }, text: 'Горизонт обитания (слева поверхность, справа дно, белая линия — любимая глубина)' }), layerBar(r.layer, 320)),
      r.bite_verdict ? h('p', { text: `${r.bite_verdict} · Основная ${r.bite_ready ?? '—'} · Запасная ${r.bite_fallback ?? '—'} · Не ест ${r.bite_blocked ?? '—'}` }) : null,
      r.official?.length ? h('p', { text: 'Доля на офиц. сервере: ' + r.official.map(b => `${b.bait_id} ${b.pct}%`).join(', ') }) : null,
      r.baits?.length ? h('p', { text: 'Данные по наживкам: ' + r.baits.map(b => `${b.bait_id} (T${b.tier} / ${b.evidence})`).join(', ') }) : null,
      r.qual_g ? h('div', { class: 'small muted', text: `зачётных примерно ${r.qual_g} g${r.trophy_g ? `, трофеев примерно ${r.trophy_g} g` : ''}. ` }) : null));
}

// 选饵：先选类别，再搜具体的饵
let CATS = null;
function pickBait(target, onPick) {
  let cat = 0, sub = 0, q = '', generation = 0;
  const results = h('div', { class: 'card', style: { maxHeight: '380px', overflow: 'auto' } });
  const subSel = h('select', { class: 'select', style: { width: '220px' }, onchange: (e) => { sub = Number(e.target.value); load(); } });
  const input = h('input', { class: 'input', placeholder: 'Поиск по названию наживки', oninput: debounce((e) => { q = input.value; load(); }, 250) });
  const fillSub = () => {
    const node = (CATS || []).find((c) => c.key === cat);
    subSel.replaceChildren(h('option', { value: 0, text: 'Все' }), ...((node && node.children) || []).map((s) => h('option', { value: s.sub, text: `${s.label} (${s.count})` })));
    subSel.disabled = cat <= 0;
  };
  async function load() {
    const id = ++generation;
    if (cat === -1) {
      results.replaceChildren(h('div', { class: 'list' }, WILDCARD.map(([name, desc]) => h('button', { type: 'button', class: 'list-item clickable', onclick: () => { close(); onPick(name); } }, h('span', { class: 'grow' }, h('b', { text: name }), h('small', { class: 'sub', text: desc }))))));
      return;
    }
    results.replaceChildren(h('div', { style: { padding: '12px' } }, loading(3)));
    try {
      const d = await api(`/api/bait/items?limit=200&cat=${cat}&sub=${sub}&q=${encodeURIComponent(q)}`);
      if (id !== generation) return;
      const rows = d.rows || [];
      results.replaceChildren(rows.length ? h('div', { class: 'list' }, rows.map((x) => h('button', { type: 'button', class: 'list-item clickable', onclick: () => { close(); onPick(x.name_zh || x.item_id); } },
        h('span', { class: 'grow' }, h('b', { text: x.name_zh || x.item_id }), h('small', { class: 'sub mono', text: x.item_id })), h('span', { class: 'muted small', text: x.sub_label || '' })))) : empty('Ничего не найдено'));
    } catch (e) { if (id === generation) results.replaceChildren(empty('Ошибка чтения', errText(e))); }
  }
  const seg = segmented([['0', 'Все'], ['27', 'Наживка'], ['17', 'Приманки'], ['-1', 'Вся категория']], '0', (v) => { cat = Number(v); sub = 0; input.hidden = cat === -1; subSel.hidden = cat === -1; fillSub(); load(); });
  const { close } = sidePage({ title: `Добавить в «${target}»`, nested: true, body: h('div', { class: 'stack' }, h('div', { class: 'row' }, seg, subSel), input, results) });
  (CATS ? Promise.resolve() : api('/api/bait/categories').then((d) => { CATS = d.categories || []; }).catch(() => { CATS = []; })).then(() => { fillSub(); load(); });
}
