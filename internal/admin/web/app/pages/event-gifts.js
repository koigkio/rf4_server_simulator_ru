import { h, api, webURL, post, btn, note, pblock, empty, confirmDialog, errText } from '../core.js';
import { itemIcon, pickItem } from '../widgets.js';

const GROUPS = [
  ['2024 Новый год', 9, 'MMXXIV', 'MMXXIV EXTRA'], ['7-летие', 11, 'VII', 'VII EXTRA'],
  ['2025 Новый год', 13, 'MMXXV', '2025 EXTRA'], ['8-летие', 15, 'VIII', 'VIII EXTRA'],
  ['2026 Новый год', 17, 'MMXXVI', '2026 Особый приз'], ['9-летие', 19, 'IX', 'IX EXTRA'],
];
const labels = Object.fromEntries(GROUPS.flatMap(([year, id, a, b]) => [[id, `${year} · ${a}`], [id + 1, `${year} · ${b}`]]));
const PRESETS = [
  ['anniversary-2024', '7-летие (2024)', 11], ['anniversary-2025', '8-летие (2025)', 15],
  ['anniversary-2026', '9-летие (2026)', 19], ['newyear-2025', '2025 Новый год', 13], ['newyear-2026', '2026 Новый год', 17],
];
const modes = [['off', 'Не включать'], ['newyear', 'Новогоднее событие'], ['anniversary', 'Юбилейное событие']];
const B = 'event_branches', T = 'event_anniversary_end_unix', G = 'event_stage_gifts';
const restartHint = 'Игрокам нужно перезайти в игру.';
const eventTiming = 'Сервер применит до 30 с; ' + restartHint;
const stageCount = b => [14, 18].includes(Number(b)) ? 10 : 7;
const validQty = n => Number.isInteger(n) && n >= 1 && n <= 99;
const modeOf = t => String(t.event_newyear_enabled ?? 1) === '1' ? 'newyear' : String(t.event_anniversary_enabled ?? 0) === '1' ? 'anniversary' : 'off';
const ids = text => Object.keys(labels).filter(id => String(text).split(',').map(s => s.trim()).includes(id));
const localDate = ts => {
  const d = new Date(Number(ts) * 1000);
  return ts && Number.isFinite(+d) ? new Date(+d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
};
const snapshot = t => ({ [B]: ids(t[B] ?? Object.keys(labels).join(',')).join(','), [T]: String(t[T] ?? 1825632000), [G]: JSON.parse(t[G] || '{}') ?? {} });
const rewardVersion = (settings, mode) => JSON.stringify([settings[G], settings[B], mode]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyNames = { [B]: 'Ветки события', [T]: 'Время окончания', [G]: 'Награды за этапы' };
const wide = () => h('div', { class: 'stack', style: { gridColumn: '1 / -1', minWidth: '0' } });
function select(label, options, value, change) {
  return h('label', {}, label, h('select', { class: 'select', onchange: e => change(e.target.value) },
    options.map(([v, name]) => h('option', { value: v, selected: String(v) === String(value), text: name }))));
}

async function loadPreset([id, name, first]) {
  const r = await fetch(webURL(`/event-reward-presets/${id}.json`));
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  const data = await r.json();
  for (const b of [first, first + 1]) for (let s = 0; s <= stageCount(b); s++) {
    const list = data?.[b]?.[s];
    if (!Array.isArray(list) || !list.length || !list.every(g => g?.item && validQty(g.qty))) throw new Error(`${name}: ветка ${b} этап ${s} — ресурсы неполные`);
  }
  return { [first]: data[first], [first + 1]: data[first + 1] };
}

export function eventView(t) {
  let saved = snapshot(t), draft = structuredClone(saved), mode = modeOf(t);
  let rewardBase = rewardVersion(saved, mode);
  let branch = '13', stage = 1, preset = 'anniversary-2026', busy = false, unknown = false;
  try { [branch, stage] = JSON.parse(sessionStorage.getItem('event-gift-selection')) || [branch, stage]; } catch {}
  const names = new Map();
  const modeBox = wide(), branchBox = wide(), timeBox = wide(), giftsBox = wide();
  const message = h('p', { role: 'status', class: 'hint' });
  const preview = h('pre', { 'aria-label': 'Сохраняемые награды', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } });
  const details = h('details', {}, h('summary', { text: 'Предпросмотр сохраняемых наград' }), preview);
  const saveBtn = btn('Сохранить изменения', save, 'primary'), discard = btn('Отменить', reset, 'ghost');
  const retry = btn('Перечитать событие', () => refresh(true), 'ghost');
  const actions = h('div', { class: 'row' }, discard, saveBtn, retry);
  const blocks = [
    note('Событие, ветки и срок:', eventTiming),
    pblock(1, 'Текущее событие', 'Активно только одно событие; щелчок сразу переключает.', modeBox),
    pblock(2, 'Ветки события', 'Отметьте линии заданий для выдачи; если снять все — задания не выдаются.', branchBox, { id: 'pg-branch' }),
    pblock(3, 'Время', 'Время окончания показано в местном часовом поясе.', timeBox, { id: 'pg-time' }),
    pblock(4, 'Награды за этапы', 'Редактируются только сохранённые включённые ветки. Этап 0 — дополнительная награда за прохождение всей линии, а не трофей.', giftsBox, { id: 'pg-gifts' }),
    note('Награды за этапы:', 'Заполнение из шаблона меняет только черновик. После сохранения или очистки' + restartHint), message, actions,
  ];
  const dirty = key => JSON.stringify(draft[key]) !== JSON.stringify(saved[key]);
  const changed = () => [G, T, B].filter(dirty);
  const enabled = () => !unknown && mode !== 'off' ? ids(saved[B]) : [];
  function update() {
    const keys = changed();
    for (const [i, key] of [[2, B], [3, T], [4, G]]) blocks[i].querySelector('.pblock-head .pill').textContent = keys.includes(key) ? 'Не сохранено' : 'Без изменений';
    saveBtn.disabled = busy || unknown || !keys.length;
    discard.disabled = busy || !keys.length;
    retry.hidden = !unknown;
    retry.disabled = busy;
    for (const box of [modeBox, branchBox, timeBox, giftsBox]) box.inert = busy || unknown;
    preview.textContent = JSON.stringify(draft[G], null, 2);
  }
  function reset() {
    draft = structuredClone(saved);
    rewardBase = rewardVersion(saved, mode);
    message.textContent = 'Изменения отменены.';
    draw();
  }
  // 单键接口：成功的键立即推进基线，后续键失败时仍可核对和重试剩余草稿。
  async function save() {
    if (busy || unknown) return;
    const keys = changed();
    if (dirty(T) && !(Number(draft[T]) > 0)) { message.textContent = 'Укажите корректное время окончания.'; return; }
    if (dirty(G)) {
      if (!enabled().length) { message.textContent = 'Сначала включите событие и сохраните ветки.'; return; }
      for (const [b, stages] of Object.entries(draft[G])) for (const [s, list] of Object.entries(stages)) {
        if (list.some(g => !validQty(g.qty))) { message.textContent = `Ветка ${b} этап ${s} : количество предмета должно быть 1–99 целым числом.`; return; }
      }
    }
    busy = true; update();
    try {
      // 先回读：上次写入可能已成功但响应丢失。已等于提交值的项按成功处理，
      // 仍等于原基线的项才重写，其余视为外部修改，整批不写。
      const actual = await api('/api/tunables'), now = snapshot(actual);
      const [baseG, baseB, baseMode] = JSON.parse(rewardBase);
      const todo = [], conflicts = [];
      for (const key of keys) {
        if (same(now[key], draft[key])) { saved[key] = structuredClone(draft[key]); continue; }
        (same(now[key], key === G ? baseG : saved[key]) ? todo : conflicts).push(key);
      }
      if (todo.includes(G) && (modeOf(actual) !== baseMode || !(same(now[B], baseB) || same(now[B], draft[B])))) {
        todo.splice(todo.indexOf(G), 1); conflicts.push(G);
      }
      if (conflicts.length) {
        message.textContent = `${conflicts.map(k => keyNames[k]).join(', ')}Уже изменено другим действием. Ничего не записано; скопируйте предпросмотр наград, обновите страницу и сверьте.`;
        return;
      }
      for (const key of todo) {
        const value = key !== G ? draft[key] : Object.keys(draft[G]).length ? JSON.stringify(draft[G], null, 2) : '';
        await post('/api/tunables', { key, value });
        saved[key] = structuredClone(draft[key]);
        if (key === G || key === B) rewardBase = rewardVersion(saved, mode);
      }
      await refresh(false, 'Сохранено и перечитано. ' + (keys.some(k => k !== G) ? eventTiming : restartHint));
    } catch (e) { message.textContent = `Не удалось сохранить: ${errText(e)}`; }
    finally { busy = false; update(); }
  }
  async function refresh(keepDraft, success = 'Настройки события перечитаны.') {
    busy = true; update();
    try {
      const actual = await api('/api/tunables');
      const keep = keepDraft ? Object.fromEntries(changed().map(k => [k, draft[k]])) : {};
      saved = snapshot(actual); draft = Object.assign(structuredClone(saved), keep);
      mode = modeOf(actual); unknown = false; message.textContent = success;
      if (!Object.hasOwn(keep, G)) rewardBase = rewardVersion(saved, mode);
    } catch (e) { unknown = true; message.textContent = `Не удалось перечитать, текущие настройки события требуют проверки: ${errText(e)}`; }
    finally { busy = false; draw(); }
  }
  async function switchMode(next) {
    if (busy || unknown || next === mode) return;
    if (changed().length && !await confirmDialog({ title: 'Есть несохранённые изменения', desc: 'При переключении события несохранённые ветки, время и награды будут потеряны.', confirm: 'Отменить и переключить' })) return;
    busy = true; update();
    try {
      if (next === 'off') {
        for (const k of ['newyear', 'anniversary']) await post('/api/tunables', { key: `event_${k}_enabled`, value: '0' });
      } else await post('/api/tunables', { key: `event_${next}_enabled`, value: '1' });
    } catch (e) { await refresh(true, `Не удалось переключить: ${errText(e)}`); return; }
    await refresh(false, 'Событие переключено. ' + eventTiming);
  }
  async function fill() {
    if (busy) return;
    const branches = enabled();
    const selected = PRESETS.filter(([id, , first]) => (preset === 'all' || preset === id) && [first, first + 1].some(b => branches.includes(String(b))));
    if (!selected.length) { message.textContent = 'Включённая ветка отсутствует в выбранном шаблоне.'; return; }
    busy = true; update();
    try {
      const files = await Promise.all(selected.map(loadPreset));
      let added = 0;
      for (const file of files) for (const b of branches) for (const [s, gifts] of Object.entries(file[b] || {})) {
        const stages = draft[G][b] ??= {};
        if (!stages[s]?.length) { stages[s] = gifts; added++; }
      }
      message.textContent = `Заполнено ${added} пустых этапов.` + (dirty(G) ? 'Награды ещё не сохранены.' : 'Изменений нет.');
    } catch (e) { message.textContent = `Не удалось прочитать шаблон, черновик не изменён: ${errText(e)}`; }
    finally { busy = false; drawGifts(); update(); }
  }
  function drawGifts() {
    const branches = enabled();
    if (!branches.length) {
      giftsBox.replaceChildren(empty(unknown ? 'Состояние события не получено' : mode === 'off' ? 'Событие ещё не включено' : 'Ветка события ещё не выбрана', 'Награды можно редактировать после включения события и сохранения хотя бы одной ветки.'));
      return;
    }
    if (!branches.includes(branch)) branch = branches.includes('13') ? '13' : branches[0];
    stage = Math.min(stage, stageCount(branch));
    const choose = (b, s) => {
      branch = b; stage = Math.min(Number(s), stageCount(b));
      try { sessionStorage.setItem('event-gift-selection', JSON.stringify([branch, stage])); } catch {}
      drawGifts();
    };
    const list = draft[G][branch]?.[stage] || [];
    const setList = next => {
      const stages = draft[G][branch] ??= {};
      if (next.length) stages[stage] = next; else delete stages[stage];
      if (!Object.keys(stages).length) delete draft[G][branch];
      message.textContent = ''; drawGifts(); update();
    };
    const rows = list.map((g, i) => {
      if (!names.has(g.item)) names.set(g.item, api('/api/catalog/items?limit=5&q=' + encodeURIComponent(g.item)).then(r => r.find(x => x.item_id === g.item)?.name || g.item).catch(() => g.item));
      const title = h('b', { text: g.item });
      Promise.resolve(names.get(g.item)).then(name => { title.textContent = name; });
      return h('div', { class: 'list-item' }, itemIcon(g.item), h('div', { class: 'grow' }, title, h('div', { class: 'sub mono', text: g.item })),
        h('label', {}, 'Количество', h('input', { class: 'input num', type: 'number', min: 1, max: 99, value: g.qty, style: { width: '72px' }, oninput: e => {
          g.qty = e.target.value === '' ? '' : Number(e.target.value); message.textContent = ''; update();
        } })), btn('Убрать', () => setList(list.filter((_, j) => i !== j)), 'ghost sm reward-remove', {
          icon: 'trash', 'aria-label': `Убрать предмет ${g.item}`, title: `Убрать из текущего этапа ${g.item}; вступит в силу после сохранения`,
        }));
    });
    const stageOptions = Array.from({ length: stageCount(branch) + 1 }, (_, s) => [s, s === 0 ? 'Этап 0 · награда за всю линию заданий' : `этап ${s}`]);
    const add = btn('Добавить предмет', () => pickItem({ title: 'Выберите предмет награды', completeOnly: true, onPick: x => {
      // 选择器打开期间，桌面主栏仍可切换阶段或放弃草稿。
      if (!add.isConnected || busy || unknown) return;
      names.set(x.item_id, x.name); setList([...list, { item: x.item_id, qty: 1 }]);
    } }), '', { icon: 'plus' });
    giftsBox.replaceChildren(h('div', { class: 'row' }, select('Шаблон наград', [['all', 'Все шаблоны'], ...PRESETS], preset, v => { preset = v; }), btn('Заполнить из выбранного шаблона', fill)),
      h('div', { class: 'row' }, select('Ветка наград', branches.map(b => [b, `${b} · ${labels[b]}`]), branch, b => choose(b, stage)), select('Этап наград', stageOptions, stage, s => choose(branch, s))),
      rows.length ? h('div', { class: 'list' }, rows) : empty('На этом этапе нет дополнительных наград'),
      h('div', { class: 'row' }, add,
        btn('Очистить награды необязательных веток', () => { for (const b of branches) delete draft[G][b]; message.textContent = 'Черновики наград необязательных веток очищены.'; drawGifts(); update(); }, 'ghost')), details);
  }
  function draw() {
    modeBox.replaceChildren(h('div', { class: 'seg event-mode-options', role: 'radiogroup', 'aria-label': 'Текущее событие' }, modes.map(([v, text]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(!unknown && mode === v), class: !unknown && mode === v ? 'on' : '', text, onclick: () => switchMode(v),
    }))));
    const chosen = new Set(ids(draft[B]));
    branchBox.replaceChildren(h('div', { class: 'event-branches' }, GROUPS.map(([year, id, ...names]) => h('fieldset', {}, h('legend', { text: year }), names.map((name, i) => {
      const b = String(id + i);
      return h('label', { class: 'branch-option' }, h('input', { type: 'checkbox', checked: chosen.has(b), onchange: e => {
        e.target.checked ? chosen.add(b) : chosen.delete(b);
        draft[B] = [...chosen].sort((a, b) => a - b).join(','); message.textContent = ''; update();
      } }), h('span', { text: name }));
    })))));
    timeBox.replaceChildren(h('label', {}, 'Время окончания события', h('input', { type: 'datetime-local', class: 'input', value: localDate(draft[T]), oninput: e => {
      draft[T] = e.target.value === localDate(saved[T]) ? saved[T] : e.target.value ? String(Date.parse(e.target.value) / 1000) : ''; message.textContent = ''; update();
    } })));
    drawGifts(); update();
  }
  draw();
  return { blocks, isDirty: () => changed().length > 0, busy: () => busy };
}
