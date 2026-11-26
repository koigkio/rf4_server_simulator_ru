// 水域与鱼种：每个水域出哪些鱼、各占多少、咬钩快慢。
import { zonesEditor } from './zones.js';
import {
  h, api, apiList, post, toast, errText, pageHead, pageTabs, work, ib, h2s, h3s, hint, note, kv, bullets, pill, badge, btn, empty, loading,
  searchBox, debounce, sidePage, confirmDialog, navigate, Form, savebar, render, webURL, fmt, setCrumbTail,
} from '../core.js';
import { ru } from '../names-ru.js';

const ORDER = ['克马羚诺也湖', '埃尔克湖', '惟有诺克河', '旧奥斯特罗格湖', '白河', '廓里湖', '梅德韦杰湖', '沃尔霍夫河', '北顿涅茨河', '苏拉河', '拉多加湖', '琥珀湖', '拉多加湖群岛', '阿赫图巴河', '铜湖', '下通古斯卡河', '亚马河', '挪威海'];

export function fishIcon(key, w = 64) {
  const img = h('img', { src: webURL('/icons/fish/' + encodeURIComponent(String(key || '').toLowerCase().replace(/\./g, '_')) + '.png'), alt: '', loading: 'lazy', style: { width: w + 'px', height: (w / 2) + 'px', objectFit: 'contain', flex: 'none' } });
  img.onerror = () => { img.style.display = 'none'; };
  return img;
}

export default async function waters(params, scope) {
  const routeHash = location.hash;
  const head = pageHead('Водоёмы и рыбы', 'Какая рыба водится на каждом водоёме и в какой доле.');
  let areas;
  try {
    areas = await api('/api/fish/areas');
    if (!Array.isArray(areas)) throw new Error('Список водоёмов в неполном формате');
  } catch (e) { return [head, work([empty('Не удалось прочитать водоёмы', errText(e)), btn('Повторить', render)])]; }
  if (!scope.isCurrent()) return [];
  const list = areas.slice().sort((a, b) => {
    const ia = ORDER.indexOf(a.loc), ib = ORDER.indexOf(b.loc);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const loc = params[0] || list[0]?.loc;
  const tab = params[1] === 'zones' ? 'zones' : 'fish';
  const TABS = [['fish', 'Вид рыбы'], ['zones', 'Зоны рыбы']];
  setCrumbTail((TABS.find(([k]) => k === tab) || [])[1]);
  const tabsEl = pageTabs(TABS, tab, k => { if (k !== tab) navigate('waters', loc, k); });
  const area = list.find(a => a.loc === loc);
  const seg = h('div', { class: 'seg areas' }, list.map(a => h('button', {
    type: 'button', class: a.loc === loc ? 'on' : '', onclick: () => { if (a.loc !== loc) navigate('waters', a.loc, tab); },
  }, a.loc)));
  if (!area) return [head, work([empty(params[0] ? `Водоём «${loc}» больше недоступен, выберите заново` : 'Список водоёмов пуст'), seg, btn('Прочитать заново', render)])];
  const query = encodeURIComponent(loc);
  const [cfg, zonesData, prefs] = await Promise.all([
    api('/api/fish/config?loc=' + query).catch(() => null),
    api('/api/fish/zones').catch(() => null),
    tab === 'fish' ? api('/api/bait/prefs?limit=2000&loc=' + query).catch(() => null) : null,
  ]);
  if (!scope.isCurrent() || location.hash !== routeHash) return [];
  const zones = Array.isArray(zonesData?.zones) ? zonesData.zones.filter(z => z.loc === loc) : null;
  const settingKeys = ['bite_probability', 'bite_delay_fixed', 'bite_delay_scale', 'bite_delay_max', 'bite_delay_lure_max'];
  const validRoster = Array.isArray(cfg?.fish) && cfg.fish.every(f => typeof f?.fish_key === 'string' && f.fish_key.trim() && Number.isFinite(f.weight) && typeof f.enabled === 'boolean');
  if (cfg?.area !== loc || !validRoster || (tab === 'zones' ? !zones : !settingKeys.every(k => Number.isFinite(cfg.setting?.[k])))) {
    return [head, tabsEl, work([h2s(loc), seg, empty('Не удалось прочитать настройки водоёма', 'Полные настройки текущего водоёма не получены, редактирование невозможно.'), btn('Повторить', render)])];
  }
  if (tab === 'zones') {
    const picker = h('select', { class: 'select', 'aria-label': 'Выберите водоём', onchange: e => navigate('waters', e.target.value, tab) },
      list.map(a => h('option', { value: a.loc, text: a.loc + (a.map_kind === 'sea' ? '(морская карта)' : ''), selected: a.loc === loc })));
    return [head, tabsEl, work([picker, zonesEditor({ area, zones, roster: cfg.fish }, scope)])];
  }
  const baitByKey = Object.fromEntries((prefs?.rows || []).map(r => [r.fish_key, r]));
  const saved = cfg.fish.filter(f => f.enabled && Number(f.weight) > 0);
  const sum = saved.reduce((n, f) => n + Number(f.weight), 0);

  const aside = [
    ib('Сохранённые веса', saved.length ? null : cfg.fish.length ? 'В списке нет включённых видов с весом больше нуля' : 'Список видов пуст', saved.length ? h('dl', {},
      ...saved.slice(0, 10).map((f) => h('div', {}, h('dt', { text: f.name_zh || f.fish_key }), h('dd', { text: `${fmt(f.weight)} · ${(Number(f.weight) / sum * 100).toFixed(1)}%` })))) : null,
      h3s('Список видов водоёма'), h('div', { class: 'pills' }, ...list.slice(0, 8).map((a) => h('span', { class: 'pill', text: a.loc + (Number.isInteger(a.fish_count) ? ` ${a.fish_count} видов` : '') })))),
    ib('За что отвечает эта страница', 'Влияет только на текущий водоём', bullets([
      'Появляется: если снять отметку, этой рыбы на водоёме не будет.',
      'Вес: относительное значение, в столбце «Доля» — пересчёт.',
      'Любимые наживки: из «Предпочтений наживки», здесь только чтение.',
    ]), hint(zones ? `Нарисовано зон рыбы: ${zones.length} шт.` : 'Количество зон рыбы не получено.')),
  ];

  return [
    pageHead('Водоёмы и рыбы', 'Какая рыба водится на каждом водоёме и в какой доле; зоны рыбы рисуются здесь.'),
    tabsEl,
    work([h2s(loc), hint(`${cfg.fish.length} видов рыб · только этот водоём`), seg, !prefs ? hint('Не удалось прочитать предпочтения наживки, снимок ротации не получен.') : null, fishView(cfg, baitByKey, scope)], aside),
  ];
}

// ---------- 鱼种名册 ----------
// 爱吃的饵：静态规则来自鱼饵偏好；轮换只认名册行里后端给的 bait_groups / bait_rotate_sec
function baitLine(row, pref) {
  const allow = (pref && pref.allow) || [];
  const groups = (row.bait_groups || []).filter((g) => g && g.length);
  const state = pref?.rotation;
  const txt = allow.length
    ? 'Ест ' + allow.slice(0, 3).join(', ') + (allow.length > 3 ? ` и др. ${allow.length} видов` : '')
    : '';
  if (!groups.length) return txt ? hint(txt) : null;
  const mode = { strict: 'Строгий', soft: 'Мягкий' }[row.bait_rotate_mode] || 'Режим не получен';
  const stateText = !row.bait_enabled ? 'Правило не включено' : state?.enabled ? `При чтении — группа № ${state.active + 1} · следующая смена: ${new Date(state.next_switch * 1000).toLocaleString()}` : state ? 'Без ротации' : 'Следующая смена не получена';
  return h('details', {}, h('summary', {}, `Ротация ${groups.length} групп · ${mode} · ${stateText}`), hint(txt),
    hint(`Интервал ${row.bait_rotate_sec} с`), ...groups.map((g, i) => hint(`№ ${i + 1}: ${g.join(', ')}`)));
}

function fishView(cfg, baitByKey, scope) {
  const fish = cfg.fish.map((f) => ({ ...f }));
  const s = cfg.setting || {};
  const form = new Form();
  const original = new Map(cfg.fish.map(f => [f.fish_key, f]));
  const changed = f => { const old = original.get(f.fish_key); return !old || old.enabled !== f.enabled || old.weight !== f.weight; };
  const isDirty = () => form.isDirty();
  const bar = h('div', { class: 'savebar', role: 'status' });
  savebar(form, { inline: bar, effect:'Список видов и настройки клёва этого водоёма применяются сразу.',
    onSave: async () => {
      if (!form.validate([...form.fields.keys()])) throw new Error('Проверьте параметры клёва');
      const setting = { ...s,
        bite_probability: +form.value('bite_probability'), bite_delay_fixed: +form.value('bite_delay_fixed'), bite_delay_scale: +form.value('bite_delay_scale'),
        bite_delay_max: +form.value('bite_delay_max'), bite_delay_lure_max: +form.value('bite_delay_lure_max') };
      editor.inert = true;
      try {
        await post('/api/fish/config', { area: cfg.area, setting, fish: fish.filter(changed).map(({ fish_key, weight, enabled }) => ({ fish_key, weight, enabled })) });
        if (editor.isConnected) render();
      } finally { editor.inert = false; }
    },
  });
  // 鱼种表的改动不经过 Form 字段，手动把它算进「未保存」
  const origDirty = form.dirtyKeys.bind(form);
  form.dirtyKeys = () => [...origDirty(), ...(fish.some(changed) ? ['_fish'] : [])];
  const origValues = form.values.bind(form);
  form.values = (keys) => origValues((keys || form.dirtyKeys()).filter((k) => k !== '_fish'));
  const origReset = form.reset.bind(form);
  form.reset = () => { fish.splice(0, fish.length, ...cfg.fish.map(f => ({ ...f }))); origReset(); draw(); };
  scope.setLeaveGuard(isDirty);
  const touch = () => form.refresh();

  let q = '';
  const tbody = h('tbody');
  const total = () => fish.filter((f) => f.enabled && Number(f.weight) > 0).reduce((n, f) => n + Number(f.weight), 0) || 1;
  const matching = () => fish.filter(f => !q || `${f.fish_key} ${f.name_zh} ${ru(f.name_zh)}`.toLowerCase().includes(q));
  const bulk = [true, false].map(enabled => btn('', () => { matching().forEach(f => { f.enabled = enabled; }); touch(); draw(); }, 'ghost sm'));
  const draw = () => {
    const sum = total();
    const rows = matching();
    bulk.forEach((b, i) => { b.textContent = `${i ? 'Отключить' : 'Включить'} ${q ? 'подходящие' : 'все'} (${rows.length})`; b.disabled = !rows.length; });
    tbody.replaceChildren(...(rows.length ? rows.map((f) => {
      const on = h('input', { type: 'checkbox', 'aria-label': 'Включено ' + f.name_zh, onchange: (e) => { f.enabled = e.target.checked; touch(); draw(); } });
      on.checked = !!f.enabled;
      const w = h('input', { class: 'input num', 'aria-label': f.name_zh + 'Вес', style: { width: '90px', height: '30px' }, value: f.weight, onchange: (e) => {
        const raw = e.target.value.trim(), n = Number(raw);
        if (!raw || !Number.isFinite(n) || n < 0) { e.target.value = f.weight; toast('Вес должен быть неотрицательным, сохранено прежнее значение', 'bad'); return; }
        f.weight = n; touch(); draw();
      } });
      const pct = f.enabled && Number(f.weight) > 0 ? (Number(f.weight) / sum * 100) : 0;
      return h('tr', { style: { opacity: f.enabled ? 1 : 0.5 } },
        h('td', {}, on),
        h('td', {}, h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, fishIcon(f.fish_key, 42),
          h('div', { style: { minWidth: 0 } }, h('b', { text: f.name_zh }), h('div', { class: 'mono', style: { fontSize: '11.6px', color: 'var(--muted)' }, text: f.fish_key }),
            baitLine(f, baitByKey[f.fish_key])))),
        h('td', {}, w, h('span', { class: 'sub', text: 'По умолчанию ' + f.base_weight })),
        h('td', { style: { width: '148px' } }, h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'nowrap' } },
          h('div', { style: { flex: '0 0 84px', height: '6px', borderRadius: '3px', background: 'var(--line-soft)', overflow: 'hidden' } }, h('div', { style: { width: Math.min(100, pct) + '%', height: '100%', background: 'var(--accent)' } })),
          h('span', { class: 'hint', style: { width: '46px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }, text: pct ? pct.toFixed(1) + '%' : '—' }))),
        h('td', {}, badge(({ official: 'Недельная статистика', manual: 'Ручное переопределение', static: 'Статический' })[f.weight_source] || (original.has(f.fish_key) ? 'Не получено' : 'Новый')), changed(f) ? badge('Не сохранено', 'warn') : null));
    }) : [h('tr', {}, h('td', { colspan: 5 }, empty(fish.length ? 'Нет подходящих рыб' : 'Список видов пуст')))]));
  };
  draw();

  const params = h('div', {},
    form.row({ key: 'bite_probability', label: 'Вероятность поклёвки на заброс', help: '1 — поклёвка на каждом забросе.', kind: 'float', min: 0, max: 1, def: '1' }, s.bite_probability),
    form.row({ key: 'bite_delay_scale', label: 'Скорость клёва', help: '0.5 = вдвое быстрее, 2 = вдвое медленнее.', kind: 'float', min: 0, unit: '×', def: '1' }, s.bite_delay_scale),
    form.row({ key: 'bite_delay_max', label: 'Максимальное ожидание', help: 'При обычной ловле через это время поклёвка будет гарантированно.', kind: 'float', min: 1, unit: 'с', def: '20' }, s.bite_delay_max),
    form.row({ key: 'bite_delay_lure_max', label: 'Максимальное ожидание на спиннинге', kind: 'float', min: 0.5, unit: 'с', def: '6' }, s.bite_delay_lure_max),
    form.row({ key: 'bite_delay_fixed', label: 'Фиксированное время поклёвки', help: '0 — случайно; если указать число, поклёвка всегда будет через это время.', kind: 'float', min: 0, unit: 'с', def: '0' }, s.bite_delay_fixed));

  const editor = h('div', { class: 'stack' }, bar,
    h('details', { class: 'advanced', style: { borderTop: 0, marginTop: '-6px' } }, h('summary', {}, 'Скорость клёва на этом водоёме ', h('small', { text: `(сейчас: ${Number(s.bite_delay_fixed) > 0 ? 'Фиксированно ' + s.bite_delay_fixed + ' с' : 'Максимум ' + s.bite_delay_max + ' с'})` })), params),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', margin: '0 0 10px' } },
      h('div', { style: { flex: '1 1 200px', minWidth: '150px', maxWidth: '320px' } }, searchBox('Фильтр по названию рыбы', (v) => { q = v.toLowerCase(); draw(); })),
      ...bulk,
      btn('Сбросить', async () => {
        if (!(await confirmDialog({ title: `Сбросить «${cfg.area}» к значениям по умолчанию?`, desc: 'Немедленно удаляет настройки клёва и ручные веса видов этого водоёма и отменяет черновик страницы. Если есть недельная база — восстанавливается она, иначе используются статические веса.', confirm: 'Сбросить', danger: true }))) return;
        try { await post('/api/fish/config/reset', { area: cfg.area }); toast('Сброшено к значениям по умолчанию, применено сразу'); if (tbody.isConnected) render(); } catch (e) { toast(errText(e), 'bad'); }
      }, 'ghost sm'),
      btn('Добавить вид', () => addFish(fish, () => { touch(); draw(); }), 'sm', { icon: 'plus' })),
    h('p', { class: 'muted small', text: '«Вес» определяет, как часто попадается эта рыба: чем больше вес, тем чаще; процент справа — пересчитанная доля. Выключено или вес 0 — этой рыбы здесь нет.' }),
    h('div', { class: 'tbl', style: { maxHeight: 'calc(100vh - 360px)', overflow: 'auto' } }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: 'Появляется' }), h('th', { text: 'Рыба' }), h('th', { class: 'num', text: 'Вес' }), h('th', { class: 'num', text: 'Доля' }), h('th', { text: 'Источник сохранения' }))), tbody)));
  return editor;
}

function addFish(fish, done) {
  const results = h('div', { class: 'card', style: { maxHeight: '400px', overflow: 'auto' } }, empty('Начните вводить название рыбы'));
  const search = debounce(async (q) => {
    const list = await apiList('/api/fish/pool?limit=80&q=' + encodeURIComponent(q)).catch(() => []);
    results.replaceChildren(list.length ? h('div', { class: 'list' }, list.map((x) => {
      const has = fish.some((f) => f.fish_key === x.fish_key);
      return h('div', { class: 'list-item' + (has ? '' : ' clickable'), style: { opacity: has ? 0.5 : 1 }, onclick: has ? null : () => {
        fish.push({ fish_key: x.fish_key, name_zh: x.name_zh, base_weight: 0, weight: 1, enabled: true, has_override: true });
        close(); done(); toast(`Добавлено «${x.name_zh}», не забудьте сохранить`);
      } }, fishIcon(x.fish_key), h('div', { class: 'grow' }, h('div', { class: 'title', text: x.name_zh }), h('div', { class: 'sub mono', text: x.fish_key })),
      has ? badge('Уже в списке') : h('span', { class: 'muted small', text: `${fmt(x.min_g)}–${fmt(x.max_g)} g` }));
    })) : empty('Ничего не найдено'));
  }, 250);
  const { close } = sidePage({ title: 'Добавить вид', body: h('div', { class: 'stack' }, searchBox('Введите название рыбы, например щука', search), results) });
}
