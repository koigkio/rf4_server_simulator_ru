import { h, api, webURL, post, btn, note, pblock, empty, confirmDialog, errText } from '../core.js';
import { itemIcon, pickItem } from '../widgets.js';

const GROUPS = [
  ['2024 新年', 9, 'MMXXIV', 'MMXXIV EXTRA'], ['七周年', 11, 'VII', 'VII EXTRA'],
  ['2025 新年', 13, 'MMXXV', '2025 EXTRA'], ['八周年', 15, 'VIII', 'VIII EXTRA'],
  ['2026 新年', 17, 'MMXXVI', '2026 特别奖'], ['九周年', 19, 'IX', 'IX EXTRA'],
];
const labels = Object.fromEntries(GROUPS.flatMap(([year, id, a, b]) => [[id, `${year} · ${a}`], [id + 1, `${year} · ${b}`]]));
const PRESETS = [
  ['anniversary-2024', '七周年（2024）', 11], ['anniversary-2025', '八周年（2025）', 15],
  ['anniversary-2026', '九周年（2026）', 19], ['newyear-2025', '2025 新年', 13], ['newyear-2026', '2026 新年', 17],
];
const modes = [['off', '不开启'], ['newyear', '新年活动'], ['anniversary', '周年活动']];
const B = 'event_branches', T = 'event_anniversary_end_unix', G = 'event_stage_gifts';
const restartHint = '请重启游戏客户端并重新登录。';
const eventTiming = '服务端最多 30 秒生效；' + restartHint;
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
const keyNames = { [B]: '活动分支', [T]: '结束时间', [G]: '阶段奖励' };
const wide = () => h('div', { class: 'stack', style: { gridColumn: '1 / -1', minWidth: '0' } });
function select(label, options, value, change) {
  return h('label', {}, label, h('select', { class: 'select', onchange: e => change(e.target.value) },
    options.map(([v, name]) => h('option', { value: v, selected: String(v) === String(value), text: name }))));
}

async function loadPreset([id, name, first]) {
  const r = await fetch(webURL(`/event-reward-presets/${id}.json`));
  if (!r.ok) throw new Error(`${name}：HTTP ${r.status}`);
  const data = await r.json();
  for (const b of [first, first + 1]) for (let s = 0; s <= stageCount(b); s++) {
    const list = data?.[b]?.[s];
    if (!Array.isArray(list) || !list.length || !list.every(g => g?.item && validQty(g.qty))) throw new Error(`${name}：分支 ${b} 阶段 ${s} 的资源不完整`);
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
  const preview = h('pre', { 'aria-label': '奖励保存内容', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } });
  const details = h('details', {}, h('summary', { text: '预览奖励保存内容' }), preview);
  const saveBtn = btn('保存修改', save, 'primary'), discard = btn('放弃', reset, 'ghost');
  const retry = btn('重新读取活动', () => refresh(true), 'ghost');
  const actions = h('div', { class: 'row' }, discard, saveBtn, retry);
  const blocks = [
    note('活动开关、分支和结束时间：', eventTiming),
    pblock(1, '当前活动', '同一时间只能开一个活动，点击即提交切换。', modeBox),
    pblock(2, '活动分支', '勾选要下发的任务线；全部取消表示不下发任务。', branchBox, { id: 'pg-branch' }),
    pblock(3, '时间', '按本地时区显示结束时间。', timeBox, { id: 'pg-time' }),
    pblock(4, '阶段奖励', '只编辑已保存启用的分支。阶段 0 是整条任务线完成后的额外奖励，不是奖杯。', giftsBox, { id: 'pg-gifts' }),
    note('阶段奖励：', '填入预设只修改草稿。保存或清空后，' + restartHint), message, actions,
  ];
  const dirty = key => JSON.stringify(draft[key]) !== JSON.stringify(saved[key]);
  const changed = () => [G, T, B].filter(dirty);
  const enabled = () => !unknown && mode !== 'off' ? ids(saved[B]) : [];
  function update() {
    const keys = changed();
    for (const [i, key] of [[2, B], [3, T], [4, G]]) blocks[i].querySelector('.pblock-head .pill').textContent = keys.includes(key) ? '未保存' : '未改动';
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
    message.textContent = '已放弃修改。';
    draw();
  }
  // 单键接口：成功的键立即推进基线，后续键失败时仍可核对和重试剩余草稿。
  async function save() {
    if (busy || unknown) return;
    const keys = changed();
    if (dirty(T) && !(Number(draft[T]) > 0)) { message.textContent = '请填写有效的结束时间。'; return; }
    if (dirty(G)) {
      if (!enabled().length) { message.textContent = '请先开启活动并保存分支。'; return; }
      for (const [b, stages] of Object.entries(draft[G])) for (const [s, list] of Object.entries(stages)) {
        if (list.some(g => !validQty(g.qty))) { message.textContent = `分支 ${b} 阶段 ${s} 的物品数量须为 1–99 的整数。`; return; }
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
        message.textContent = `${conflicts.map(k => keyNames[k]).join('、')}已被其他操作修改。本次未写入；请复制奖励预览后刷新并核对。`;
        return;
      }
      for (const key of todo) {
        const value = key !== G ? draft[key] : Object.keys(draft[G]).length ? JSON.stringify(draft[G], null, 2) : '';
        await post('/api/tunables', { key, value });
        saved[key] = structuredClone(draft[key]);
        if (key === G || key === B) rewardBase = rewardVersion(saved, mode);
      }
      await refresh(false, '已保存并回读。' + (keys.some(k => k !== G) ? eventTiming : restartHint));
    } catch (e) { message.textContent = `保存失败：${errText(e)}`; }
    finally { busy = false; update(); }
  }
  async function refresh(keepDraft, success = '已回读活动设置。') {
    busy = true; update();
    try {
      const actual = await api('/api/tunables');
      const keep = keepDraft ? Object.fromEntries(changed().map(k => [k, draft[k]])) : {};
      saved = snapshot(actual); draft = Object.assign(structuredClone(saved), keep);
      mode = modeOf(actual); unknown = false; message.textContent = success;
      if (!Object.hasOwn(keep, G)) rewardBase = rewardVersion(saved, mode);
    } catch (e) { unknown = true; message.textContent = `无法回读，当前活动设置待确认：${errText(e)}`; }
    finally { busy = false; draw(); }
  }
  async function switchMode(next) {
    if (busy || unknown || next === mode) return;
    if (changed().length && !await confirmDialog({ title: '有修改还没保存', desc: '切换活动将放弃未保存的分支、时间和奖励。', confirm: '放弃并切换' })) return;
    busy = true; update();
    try {
      if (next === 'off') {
        for (const k of ['newyear', 'anniversary']) await post('/api/tunables', { key: `event_${k}_enabled`, value: '0' });
      } else await post('/api/tunables', { key: `event_${next}_enabled`, value: '1' });
    } catch (e) { await refresh(true, `切换失败：${errText(e)}`); return; }
    await refresh(false, '活动已切换。' + eventTiming);
  }
  async function fill() {
    if (busy) return;
    const branches = enabled();
    const selected = PRESETS.filter(([id, , first]) => (preset === 'all' || preset === id) && [first, first + 1].some(b => branches.includes(String(b))));
    if (!selected.length) { message.textContent = '已启用分支不在所选预设中。'; return; }
    busy = true; update();
    try {
      const files = await Promise.all(selected.map(loadPreset));
      let added = 0;
      for (const file of files) for (const b of branches) for (const [s, gifts] of Object.entries(file[b] || {})) {
        const stages = draft[G][b] ??= {};
        if (!stages[s]?.length) { stages[s] = gifts; added++; }
      }
      message.textContent = `已填入 ${added} 个空白阶段。` + (dirty(G) ? '奖励尚未保存。' : '没有改动。');
    } catch (e) { message.textContent = `预设读取失败，草稿未变：${errText(e)}`; }
    finally { busy = false; drawGifts(); update(); }
  }
  function drawGifts() {
    const branches = enabled();
    if (!branches.length) {
      giftsBox.replaceChildren(empty(unknown ? '活动状态未取得' : mode === 'off' ? '还没有开启活动' : '还没有选择活动分支', '开启活动并保存至少一个分支后才能编辑奖励。'));
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
        h('label', {}, '数量', h('input', { class: 'input num', type: 'number', min: 1, max: 99, value: g.qty, style: { width: '72px' }, oninput: e => {
          g.qty = e.target.value === '' ? '' : Number(e.target.value); message.textContent = ''; update();
        } })), btn('移除', () => setList(list.filter((_, j) => i !== j)), 'ghost sm reward-remove', {
          icon: 'trash', 'aria-label': `移除物品 ${g.item}`, title: `从当前阶段移除 ${g.item}，保存修改后生效`,
        }));
    });
    const stageOptions = Array.from({ length: stageCount(branch) + 1 }, (_, s) => [s, s === 0 ? '阶段 0 · 整条任务线完成奖励' : `阶段 ${s}`]);
    const add = btn('添加物品', () => pickItem({ title: '选择奖励物品', completeOnly: true, onPick: x => {
      // 选择器打开期间，桌面主栏仍可切换阶段或放弃草稿。
      if (!add.isConnected || busy || unknown) return;
      names.set(x.item_id, x.name); setList([...list, { item: x.item_id, qty: 1 }]);
    } }), '', { icon: 'plus' });
    giftsBox.replaceChildren(h('div', { class: 'row' }, select('奖励预设', [['all', '全部预设'], ...PRESETS], preset, v => { preset = v; }), btn('填入所选预设', fill)),
      h('div', { class: 'row' }, select('奖励分支', branches.map(b => [b, `${b} · ${labels[b]}`]), branch, b => choose(b, stage)), select('奖励阶段', stageOptions, stage, s => choose(branch, s))),
      rows.length ? h('div', { class: 'list' }, rows) : empty('这个阶段没有额外奖励'),
      h('div', { class: 'row' }, add,
        btn('清空可选分支奖励', () => { for (const b of branches) delete draft[G][b]; message.textContent = '已清空可选分支的奖励草稿。'; drawGifts(); update(); }, 'ghost')), details);
  }
  function draw() {
    modeBox.replaceChildren(h('div', { class: 'seg event-mode-options', role: 'radiogroup', 'aria-label': '当前活动' }, modes.map(([v, text]) => h('button', {
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
    timeBox.replaceChildren(h('label', {}, '活动结束时间', h('input', { type: 'datetime-local', class: 'input', value: localDate(draft[T]), oninput: e => {
      draft[T] = e.target.value === localDate(saved[T]) ? saved[T] : e.target.value ? String(Date.parse(e.target.value) / 1000) : ''; message.textContent = ''; update();
    } })));
    drawGifts(); update();
  }
  draw();
  return { blocks, isDirty: () => changed().length > 0, busy: () => busy };
}
