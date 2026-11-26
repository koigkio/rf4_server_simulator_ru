// 玩法规则：决定钓鱼「玩起来是什么感觉」。数值微调在「数值调整」页。
import { h, api, post, icon, toast, errText, pageHead, pageTabs, work, ib, pblock, h2s, h3s, hint, note, kv, bullets, pill, callout, badge, Form, savebar, confirmDialog, render, replaceHash, setCrumbTail, navigate } from '../core.js';

const STYLES = [
  ['realistic', '真实鱼汛', '鱼按习性、天气、位置和饵料决定咬不咬。要研究钓点、选对饵，更接近真实钓鱼。', '下面七项规则中，除欢乐时光外全部开启'],
  ['legacy', '全随机', '任何鱼都可能咬任何饵，出鱼完全随机。轻松，适合随便玩玩。', '下面七项规则中，除欢乐时光外全部关闭'],
];
export const RULE_SWITCHES = [
  ['bite_gate_enabled', '饵要对口', '拟饵按鱼种食性筛选。浮钓落点有水深数据时，饵离活动水层越远，该鱼的权重越低。', '0'],
  ['fish_ecology_enabled', '鱼种习性', '252 种鱼各按习性决定咬不咬：水层、昼夜、季节、天气、水底环境、拟饵动作都有影响。', '0'],
  ['fish_weather_enabled', '天气与水温', '游戏里的气温和天气会影响鱼口；底钓、浮钓时鱼会断断续续地试口。', '0'],
  ['fish_distribution_enabled', '鱼群分布', '每种鱼只在地图的特定区域出没，每 4 个游戏小时重新分布一次。', '0'],
  ['marine_layer_enabled', '海钓水层影响', '开启后海钓钓组按海钓状态机修正水层：下沉按相对进度过渡，贴底为 0.93；关闭时回到旧的拟饵实时水层/固定贴底。', '0'],
  ['fish_bait_rules_enabled', '鱼会挑饵', '根据钩上挂的饵决定会来哪些鱼。每种鱼爱吃什么在「鱼饵偏好」里设置。', '0'],
  ['happy_hour_enabled', '欢乐时光', '会员在线钓鱼时：经验 +50%、鱼口 +10%、熟练度提升机会 +25%，没有每日时长限制。', '1'],
];
const SPAWN = [
  ['grade_ratio', '按比例出鱼', '直接设定未达标、合格、奖杯、蓝冠四档鱼各占多少。最直观。'],
  ['fish_hunt', '鱼猎四阶段', '淡水按「日常 → 聚鱼 → 发窝 → 巨物」四个阶段逐步出好鱼，海钓和路亚同样适用。'],
  ['two_stage', '日常 / 打窝两档', '底钓、浮钓只有「日常」和「打窝后」两档，各自设定比例。海钓、路亚仍按四阶段。'],
];
const GRADES = [['below', '未达标', '#7f8b9a'], ['qualified', '合格', '#4cb3d4'], ['trophy', '奖杯', '#e0a743'], ['super', '蓝冠', '#9d7cf0']];
const GRADE_SETS = {
  grade_ratio: [{ prefix: 'grade_pct_', title: '四档比例', defs: [3, 87.5, 9, 0.5] }],
  two_stage: [
    { prefix: 'two_stage_daily_', title: '日常（没打窝）', defs: [10, 86.5, 3, 0.5] },
    { prefix: 'two_stage_baited_', title: '打窝后', defs: [1, 92, 6, 1] },
  ],
};
const OTHER = [
  ['condition_health_enabled', '饥饿和寒冷会掉血', '关闭后生命值始终是满的，药品也不会消耗。', '1'],
  ['condition_fishing_pause_enabled', '钓鱼时精力不恢复', '竿在水里时精力暂停恢复，收竿后再恢复。关闭则一直正常恢复。', '1'],
  ['hook_nibble_enabled', '鱼会先嘬饵', '鱼咬钩前先轻嘬几下，抬竿太早会钓空。关闭后第一次抬竿不会判嘬饵。', '0'],
  ['bite_pace_enabled', '饵效控速', '开启后来鱼快慢由饵与动作共同决定：底钓/浮钓看饵对不对口；路亚/海钓铁板还看收线动作对不对口——饵与动作都对口时 1.5~6 秒内来鱼，动作不对口像差饵一样长时间才有鱼。只控节奏，不改出什么鱼。', '0'],
];

export default async function rules(params, scope) {
  const [t, mode] = await Promise.all([api('/api/tunables'), api('/api/fish/bite_mode').catch(() => ({}))]);
  if (!scope.isCurrent()) return [];
  const val = (k, d) => (t[k] === undefined || t[k] === '' ? d : t[k]);
  const form = new Form();
  const status = h('p', { class: 'hint', role: 'status', hidden: true });
  let saving = false;
  savebar(form, {
    effect:'服务端最多 30 秒生效，无需重新登录。',
    onSave: async (values) => {
      for (const set of GRADE_SETS[spawnMode] || []) {
        const keys = GRADES.map(([g]) => set.prefix + g);
        if (form.fields.has(keys[0]) && !keys.some(k => Number(form.value(k)) > 0)) throw new Error(`${set.title}的总权重不能为 0`);
      }
      // 逐键 API：先写正权重，避免换档时短暂出现整组为零。
      const entries = Object.entries(values).sort((a, b) => (Number(a[1]) === 0) - (Number(b[1]) === 0));
      const applied = [];
      saving = true;
      try {
        for (const [key, value] of entries) {
          await post('/api/tunables', { key, value: String(value) });
          form.commit({ [key]: value });
          applied.push(form.fields.get(key).spec.label);
        }
      } catch (e) {
        const pending = form.dirtyKeys().map(k => form.fields.get(k).spec.label);
        status.hidden = false;
        status.textContent = `已确认保存：${applied.join('、') || '无'}；待重试：${pending.join('、')}。${errText(e)}`;
        throw e;
      } finally { saving = false; }
      if (status.isConnected && !form.isDirty()) render();
    },
  });
  scope.setLeaveGuard(() => form.isDirty());

  // 玩法风格
  const cur = mode.mode;
  const styleCards = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: '10px' } }, STYLES.map(([m, title, desc, note]) => {
    const on = cur === m;
    return h('button', {
      type: 'button', class: 'stylecard' + (on ? ' on' : ''), style: { cursor: on ? 'default' : 'pointer' },
      onclick: async () => {
        if (on || saving) return;
        const ok = await confirmDialog({ title: `切换到「${title}」？`, desc: `${note}，欢乐时光保持不变。${form.isDirty() ? '未保存的修改会被放弃。' : ''}约 30 秒内生效。`, confirm: '切换' });
        if (!ok) return;
        try { await post('/api/fish/bite_mode', { mode: m }); toast(`已切换到「${title}」，最多 30 秒生效`); render(); } catch (e) { toast(errText(e), 'bad'); }
      },
    }, h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '10px', borderBottom: '0', padding: '0' } }, h('b', { text: title }), on ? badge('当前', 'accent') : null),
    h('p', { class: 'hint', style: { margin: '4px 0 0' }, text: desc }));
  }));

  // 出鱼方式
  const spawnMode = val('grade_ratio_enabled', '1') === '1' ? 'grade_ratio' : val('two_stage_hunt_enabled', '0') === '1' ? 'two_stage' : val('fish_hunt_enabled', '0') === '1' ? 'fish_hunt' : '';
  const spawnCards = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: '10px' } }, SPAWN.map(([m, title, desc]) => {
    const on = spawnMode === m;
    return h('button', {
      type: 'button', class: 'stylecard' + (on ? ' on' : ''), style: { cursor: on ? 'default' : 'pointer' },
      onclick: async () => {
        if (on || saving) return;
        if (form.isDirty() && !(await confirmDialog({ title: '有修改还没保存', desc: '切换出鱼方式会刷新页面，没保存的修改会丢失。', confirm: '继续切换' }))) return;
        try { await post('/api/fish/spawn_mode', { mode: m }); toast(`已切换到「${title}」，约 30 秒内生效`); render(); } catch (e) { toast(errText(e), 'bad'); }
      },
    }, h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '10px', borderBottom: '0', padding: '0' } }, h('b', { text: title }), on ? badge('当前', 'accent') : null),
    h('p', { class: 'hint', style: { margin: '4px 0 0' }, text: desc }));
  }));

  // 三个二级页签，和演示页「钓场与鱼口」的拆法一致
  const TABS = [['switches', '玩法开关'], ['grade', '出鱼与奖杯'], ['other', '其他']];
  let SUB = 'switches';
  if (params[0] && TABS.some(([k]) => k === params[0])) SUB = params[0];
  const tabsEl = pageTabs(TABS, SUB, async (k) => {
    if (k === SUB) return;
    if (saving || (form.isDirty() && !(await confirmDialog({ title: '有修改还没保存', desc: '切换页签会放弃本页草稿。', confirm: '放弃并切换' })))) {
      queueMicrotask(() => tabsEl.querySelectorAll('a').forEach(a => {
        if (a.hash === '#rules/' + SUB) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      }));
      return;
    }
    replaceHash('#rules/' + k); render();
  });
  setCrumbTail((TABS.find(([k]) => k === SUB) || [])[1] || '');

  const DESC = {
    switches: '决定钓鱼玩起来是什么感觉。上面两种是官方预设，下面七项可以单独改。',
    grade: '决定钓到的鱼里，好鱼（奖杯、蓝冠）占多少。三选一，点卡片切换。',
    other: '活着、精力和鱼钩大小这类杂项。',
  };
  let blocks = [];
  if (SUB === 'switches') {
    blocks = [
      h2s('玩法开关'),
      hint(DESC.switches),
      h3s('玩法风格'),
      styleCards,
      hint((cur === 'mixed' ? '当前为自定义组合。' : STYLES.some(([k]) => k === cur) ? `当前预设：${STYLES.find(([k]) => k === cur)[1]}。` : '当前预设未取得。') + '预设覆盖前六项；欢乐时光独立。'),
      h3s('七项规则（各自独立）'),
      ...RULE_SWITCHES.map(([k, l, d, def]) => form.row({ key: k, label: l, help: d, kind: 'bool', def }, val(k, def))),
    ];
  } else if (SUB === 'grade') {
    blocks = [
      pblock(1, '出鱼方式', '决定钓到的鱼里，好鱼占多少。三选一，点卡片切换。', spawnCards, { id: 'pg-spawn' }),
      ...(GRADE_SETS[spawnMode] || []).map((set, i) => pblock(i + 2, set.title, '填相对数量，会自动换算成百分比。', gradeEditor(form, set, t, spawnMode === 'grade_ratio'), { id: 'pg-grade-' + i })),
      spawnMode === 'fish_hunt' ? note('鱼猎四阶段没有要设置的比例。', '它按玩家打窝、聚鱼的进度自动推进。') : null,
      !spawnMode ? note('还没有选择出鱼方式。', '目前按旧版规则出鱼。') : null,
    ].filter(Boolean);
  } else {
    blocks = [
      pblock(1, '其他', '活得久不久、精力怎么恢复、鱼钩大小怎么影响出鱼。', [
        ...OTHER.map(([k, l, d, def]) => form.row({ key: k, label: l, help: d, kind: 'bool', def }, val(k, def))),
        form.row({ key: 'hook_spawn_match_strength', label: '鱼钩大小影响出鱼', help: '0 表示不影响；1 表示大钩更容易钓到大鱼、小钩更容易钓到小鱼；2 更明显。选「按比例出鱼」时不起作用。', kind: 'float', min: 0, max: 2, def: '0' }, val('hook_spawn_match_strength', '0')),
      ], { id: 'pg-other' }),
      pblock(2, '出鱼档位与等待时间', '这两类在别的页签里。', bullets([
        '四档比例换算、奖杯线：本页「出鱼与奖杯」。',
        '咬钩等待、路亚等待：游戏参数 › 玩法与钓组。',
        '水域出哪些鱼：钓场与鱼口。',
      ]), { id: 'pg-links' }),
    ];
  }
  const aside = [
    ib('当前是什么组合', '两种预设之一，或自定义', kv([
      ['预设', cur === 'mixed' ? '自定义组合' : (STYLES.find(([m]) => m === cur) || [])[1] || '—'],
      ['开着的规则', String(RULE_SWITCHES.filter(([k, , , d]) => val(k, d) === '1').length) + ' / ' + RULE_SWITCHES.length],
      ['出鱼方式', (SPAWN.find(([m]) => m === spawnMode) || [])[1] || '旧版规则'],
    ]), hint('预设只覆盖饵要对口、鱼种习性、天气与水温、鱼群分布、海钓水层影响、鱼会挑饵六项。欢乐时光独立。')),
    ib('相关页面', null, h('div', { class: 'pills' },
      h('a', { class: 'pill', href: '#bait', text: '每种鱼吃什么' }),
      h('a', { class: 'pill', href: '#tuning/gameplay', text: '咬钩快慢在游戏参数' }),
      h('a', { class: 'pill', href: '#waters', text: '水域出哪些鱼' }))),
    ib('生效方式', null, hint('保存后约 30 秒热加载，不用重启服务，也不用玩家重登。')),
  ];
  return [
    pageHead('钓场与鱼口', DESC[SUB] || DESC.switches),
    tabsEl,
    work([status, ...blocks], aside),
  ];
}
// 四档比例编辑：输入相对权重，实时显示换算后的百分比
function gradeEditor(form, set, t, interactive) {
  const bar = h('div', { style: { display: 'flex', height: '10px', borderRadius: '6px', overflow: 'hidden', background: 'var(--line-soft)' } });
  const legend = h('div', { class: 'row small', style: { gap: '16px', borderBottom: '0', padding: '0', flexWrap: 'wrap' } });
  const fields = GRADES.map(([g, label], i) => {
    const key = set.prefix + g;
    return { key, label, f: form.field({ key, label: set.title + ' · ' + label, kind: 'float', min: 0, max: 100 }, t[key] ?? String(set.defs[i])) };
  });
  const track = h('div', { class: interactive ? 'grade-ratio-track' : null }, bar);
  const hint = h('span', { class: 'muted small' });
  const readWeights = () => fields.map(({ key }) => Math.max(0, Number(form.value(key)) || 0));
  const handles = interactive ? GRADES.slice(1).map((_, i) =>
    ratioHandle(i, fields, readWeights, track, () => form.refresh())) : [];
  track.append(...handles);
  const update = () => {
    const list = readWeights();
    const sum = list.reduce((a, b) => a + b, 0) || 1;
    const valid = fields.every(({ key }) => {
      const raw = form.value(key), n = Number(raw);
      return raw !== '' && Number.isFinite(n) && n >= 0 && n <= 100;
    });
    let cumulative = 0;
    handles.forEach((handle, i) => {
      cumulative += list[i] / sum * 100;
      track.style.setProperty('--boundary-' + i, cumulative + '%');
      const pair = list[i] + list[i + 1];
      const min = Math.max(0, pair - 100), max = Math.min(100, pair);
      handle.disabled = !valid || min >= max;
      handle.setAttribute('aria-valuemin', min);
      handle.setAttribute('aria-valuemax', max);
      handle.setAttribute('aria-valuenow', list[i]);
      handle.setAttribute('aria-valuetext', GRADES[i][1] + ' ' + (list[i] / sum * 100).toFixed(1) + '%');
    });
    hint.textContent = list.every(n => n === 0) ? '总权重不能为 0' : interactive ? '可拖动分界线或键入权重' : '可拖动滑块或键入权重';
    bar.replaceChildren(...list.map((n, i) => h('div', { style: { width: (n / sum * 100) + '%', background: GRADES[i][2] } })));
    legend.replaceChildren(...list.map((n, i) => h('span', {}, h('span', { style: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', background: GRADES[i][2], marginRight: '6px' } }),
      GRADES[i][1] + ' ', h('b', { text: (n / sum * 100).toFixed(1) + '%' }))));
    fields.forEach(({ f }, i) => {
      if (f.slider) f.slider.value = String(list[i]);
      if (f.pct) f.pct.textContent = '占比 ' + (list[i] / sum * 100).toFixed(1) + '%';
    });
  };
  const inputs = h('div', { class: 'grid-4' }, fields.map(({ label, f }) => {
    f.input = h('input', { type: 'number', class: 'input num', min: 0, max: 100, step: 'any', value: f.original, 'aria-label': label + '权重', oninput: () => form.refresh() });
    f.slider = h('input', { type: 'range', class: 'grade-slider', min: 0, max: 100, step: '0.01', 'aria-label': label + '滑杆', oninput: () => { f.input.value = f.slider.value; form.refresh(); } });
    f.errEl = h('div', { class: 'help', hidden: true });
    f.pct = h('span', { class: 'grade-percent' });
    f.row = h('div', { class: 'field' }, h('label', {}, label, f.input), f.slider, f.pct, f.errEl);
    return f.row;
  }));
  const previous = form.onChange;
  form.onChange = () => { previous(form); update(); };
  const reset = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => {
    fields.forEach(({ f }, i) => { f.input.value = set.defs[i]; }); form.refresh();
  } }, '整组恢复出厂');
  update();
  return h('div', {}, h('div', { class: 'row' }, hint, reset), inputs,
    h('div', { style: { margin: interactive ? '18px 0 12px' : '12px 0 6px' } }, track), legend);
}

// Each gesture uses the starting weights so rounding never accumulates across moves.
function ratioHandle(i, fields, readWeights, track, refresh) {
  const label = GRADES[i][1] + ' / ' + GRADES[i + 1][1];
  const handle = h('button', { type: 'button', class: 'grade-ratio-handle', role: 'slider',
    'aria-label': label, title: label + '（拖动或按左右方向键调整）' });
  function transfer(weights, delta) {
    const left = weights[i], pair = left + weights[i + 1];
    const next = Math.max(0, pair - 100, Math.min(100, pair, left + delta));
    [next, pair - next].forEach((v, j) => {
      const f = fields[i + j].f;
      f.slider.value = Number(v.toPrecision(15)); f.input.value = f.slider.value;
    });
    refresh();
  }
  let drag;
  handle.onpointerdown = e => {
    if (!e.isPrimary || e.button !== 0 || drag) return;
    drag = { id: e.pointerId, x: e.clientX, width: track.getBoundingClientRect().width, weights: readWeights() };
    handle.setPointerCapture(e.pointerId);
  };
  handle.onpointermove = e => {
    if (drag?.id !== e.pointerId || !drag.width) return;
    const total = drag.weights.reduce((a, b) => a + b, 0);
    const tenths = Math.round((e.clientX - drag.x) / drag.width * 1000);
    transfer(drag.weights, total * tenths / 1000);
  };
  handle.onlostpointercapture = () => { drag = null; };
  handle.onkeydown = e => {
    const weights = readWeights();
    const step = weights.reduce((a, b) => a + b, 0) / 100;
    const deltas = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step,
      Home: -weights[i], End: weights[i + 1] };
    if (!Object.hasOwn(deltas, e.key)) return;
    e.preventDefault();
    transfer(weights, deltas[e.key]);
  };
  return handle;
}
