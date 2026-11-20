// 数值调整：所有可调数字按主题分组。开关类玩法在「玩法规则」页。
import { h, api, post, toast, errText, pageHead, section, callout, badge, btn, Form, savebar, setLeaveGuard, render, confirmDialog, segmented, empty, icon } from '../core.js';
import { itemIcon, pickItem } from '../widgets.js';

// [key, 标签, 说明, 默认值, 类型, 单位, 最小, 最大]
const G = {
  bite: {
    title: '咬钩', desc: '鱼多久咬一次钩。',
    main: [
      ['bite_probability', '每次抛竿有鱼的概率', '1 表示每竿必有鱼咬；0.5 表示一半的抛竿会空等。', 1, 'float', '', 0, 1],
      ['bite_delay_scale', '咬钩速度', '整体调快或调慢。0.5 = 快一倍，2 = 慢一倍。', 1, 'float', '倍'],
      ['bite_delay_max', '最长等待', '等这么久一定会有鱼咬（路亚除外）。', 20, 'float', '秒'],
      ['bite_delay_lure_max', '路亚最长等待', '路亚钓法的最长等待时间。', 6, 'float', '秒'],
    ],
    adv: [
      ['bite_delay_fixed', '固定咬钩时间', '填 0 表示随机；填了数字后每次都在这个时间咬钩。', 0, 'float', '秒'],
      ['bite_empty_retry_scale', '没鱼时重试快慢', '这一轮没有合适的鱼时，下一轮等待时间的倍数。0.25 表示很快重试。', 1, 'float', '倍'],
      ['bite_gate_pity_rounds', '连续空杆保底', '连续空杆这么多轮后，放宽环境条件保证有一口。0 表示关闭。', 0, 'int', '轮'],
    ],
  },
  bait: {
    title: '饵料与对口', desc: '饵料对鱼的吸引力，以及「饵要对口」规则的细节。',
    main: [
      ['bait_pref_scale', '饵料影响力', '0 表示鱼完全不看饵；1 是标准效果。', 1, 'float', '倍'],
      ['bait_pref_weight_shift', '好饵钓大鱼', '数值越大，好饵越容易吸引大个体。', 1, 'float', '倍'],
    ],
    adv: [
      ['bite_gate_lure_diet_min', '拟饵门槛', '鱼的「吃拟饵」倾向低于这个值就不攻拟饵（泥鳅约 0.2、狗鱼约 2）。需开启「饵要对口」。', 0.3, 'float', '', 0, 1],
      ['bite_gate_diet_min', '天然饵门槛', '鱼对某类天然饵的喜好达到这个值才算「爱吃」。需开启「饵要对口」。', 0.25, 'float', '', 0, 1],
      ['bite_gate_diet_floor', '勉强吃的概率', '只有一方面证据显示鱼吃这种饵时，咬口打几折。', 0.05, 'float', '', 0, 1],
      ['bite_gate_layer_floor', '钓层不对时的概率', '钓层偏离鱼的栖息水层时，咬口打几折。0 表示完全不咬。', 0.01, 'float', '', 0, 1],
    ],
  },
  fish: {
    title: '鱼', desc: '鱼的大小和搏鱼的难度。',
    main: [
      ['fish_weight_scale', '鱼的体重', '全图鱼重整体缩放，2 表示都变成两倍重。', 1, 'float', '倍'],
      ['fight_power_scale', '鱼的挣扎力度', '越低鱼越好拉、越不容易断线。1 是原版。', 1, 'float', '倍'],
      ['fish_weight_cap', '鱼不超过钓具承重', '打开后，超过钓具负重的鱼会被截到上限。', 0, 'bool'],
    ],
    adv: [
      ['fish_pull_ln_slope', '大鱼额外拉力', '体重越大拉力增加得越快。官方样本约 0.3–0.4。', 0.35, 'float'],
      ['fish_pull_fallback_k', '未测鱼种的拉力', '没有实测数据的鱼，每公斤体重的基础拉力。', 17.5, 'float', 'N/kg'],
      ['fish_initial_stamina_ratio', '未测鱼种的耐力', '越大越不容易累。只影响没有实测数据的淡水鱼。', 0.5628, 'float', '', 0, 1],
    ],
  },
  wear: {
    title: '装备磨损', desc: '搏鱼时渔线轮、鱼竿和前导的损耗速度。默认值对齐官服实测，一般不需要改。',
    main: [
      ['electric_locked_multiplier', '电动轮锁轮力量', '电动轮锁轮时能承受的力量倍数。', 3, 'float', '倍'],
      ['electric_motor_kg_per_power', '电机功率换算', '电机每单位功率折算成多少公斤承力。', 1, 'float'],
    ],
    adv: [
      ['reel_slip_wear', '泄力打滑磨损', '鱼拉得比泄力大、线在打滑时，摩擦片的损耗系数。', 0.0001, 'float', '', 1e-12, 1],
      ['reel_slip_calibration_seconds', '打滑磨损换算', '数值越大，同样打滑时长损耗越少。41.7 对齐官服。', 41.7, 'float', '秒', 0.01, 3600],
      ['reel_slip_deadband_ratio', '打滑判定余量', '拉力不超过泄力的这个倍数时，不算打滑。', 1.05, 'float', '倍', 1, 10],
      ['wear_stress_oil_per_s', '润滑油', '每秒受力扣多少寿命。0 表示不磨损。', 0.0004, 'float', '%/秒', 0, 0.01],
      ['wear_stress_gear_per_s', '主齿轮', '', 0.0004, 'float', '%/秒', 0, 0.01],
      ['wear_stress_bearing_per_s', '轴承', '', 0.00012, 'float', '%/秒', 0, 0.01],
      ['wear_stress_spool_per_s', '线杯', '', 0.00012, 'float', '%/秒', 0, 0.01],
      ['wear_stress_guides_per_s', '导环', '', 0.0004, 'float', '%/秒', 0, 0.01],
      ['wear_stress_rodblank_per_s', '竿身', '', 0.00003, 'float', '%/秒', 0, 0.01],
      ['wear_leader_per_stress_sec', '前导线', '', 0.00005, 'float', '%/秒', 0, 0.01],
      ['reel_load_tick_seconds', '受力计时起点', '第一次受力上报没有上一次时间时，按这个秒数计算。', 1.9, 'float', '秒', 0.01, 600],
      ['reel_load_max_tick_seconds', '受力计时上限', '两次受力上报之间最多算多少秒，防止延迟上报一次扣太多。', 5, 'float', '秒', 0.01, 600],
    ],
  },
  reward: {
    title: '经验与奖励', desc: '修改后只影响之后钓到的鱼。',
    main: [
      ['xp_gain', '经验倍率', '1.5 表示多拿 50% 经验。', 1, 'float', '倍'],
      ['release_xp_ratio', '放生拿多少经验', '放生时获得收进护鱼网经验的几成。0.5 = 一半。', 0.5, 'float', '', 0, 1],
    ],
    groups: [
      ['钓鱼掉卡', '每钓到一条鱼抽一次。', [
        ['card_drop_normal', '普通鱼', '0.001 表示 0.1%。', 0.001, 'float', '', 0, 1],
        ['card_drop_star', '星级鱼', '', 0.5, 'float', '', 0, 1],
        ['card_drop_blue', '蓝冠鱼', '', 0.8, 'float', '', 0, 1],
        ['card_drop_rare_scale', '稀有鱼打折', '稀有、超稀有鱼的掉卡率再乘这个系数。', 0.25, 'float', '', 0, 1],
      ]],
      ['钓鱼开礼包', '钓到鱼时按概率开一个礼包，奖励直接进背包。', [
        ['loot_box_enabled', '开启钓鱼礼包', '', 0, 'bool'],
        ['loot_box_chance', '开礼包的概率', '每条鱼开礼包的概率，0.05 表示 5%。', 0.05, 'float', '', 0, 1],
        ['loot_box_trophy_guarantee', '奖杯鱼必开礼包', '钓到奖杯或蓝冠鱼时一定开一个。', 1, 'bool'],
      ]],
    ],
  },
  chat: {
    title: '聊天提示', desc: '钓鱼时在聊天栏里显示的提示。',
    main: [
      ['fish_escape_taunt', '跑鱼时调侃一句', '关闭后显示官方的「鱼脱钩了」。', 1, 'bool'],
      ['fish_hooked_chat', '中鱼时提示鱼种和重量', '鱼挂上钩时，只给自己显示竿号、鱼种和重量。', 0, 'bool'],
    ],
  },
};
const CATS = [['bite', '咬钩'], ['bait', '饵料与对口'], ['fish', '鱼'], ['wear', '装备磨损'], ['reward', '经验与奖励'], ['chat', '聊天提示'], ['event', '限时活动']];
let CAT = 'bite';

export default async function tuning(params) {
  if (params[0] && CATS.some(([k]) => k === params[0])) CAT = params[0];
  const t = await api('/api/tunables');
  const val = (k, d) => (t[k] === undefined || t[k] === '' ? String(d) : t[k]);
  const form = new Form();
  savebar(form, {
    onSave: async (values) => {
      for (const [key, value] of Object.entries(values)) await post('/api/tunables', { key, value: String(value) });
      toast(CAT === 'event' ? '已保存。玩家需要完全退出游戏再登录才能看到变化。' : '已保存，约 30 秒内生效');
      render();
    },
  });
  setLeaveGuard(() => form.isDirty());
  const spec = ([key, label, help, def, kind, unit, min, max]) => ({ key, label, help, def: kind === 'bool' ? String(def) : def, kind, unit, min, max });
  const rows = (list) => list.map((d) => form.row(spec(d), val(d[0], d[3])));
  const sub = h('nav', { class: 'subnav' }, CATS.map(([k, l]) => h('button', {
    type: 'button', class: k === CAT ? 'on' : '',
    onclick: async () => {
      if (k === CAT) return;
      if (form.isDirty() && !(await confirmDialog({ title: '有修改还没保存', desc: '切换分类会放弃这些修改。', confirm: '放弃并切换' }))) return;
      CAT = k; history.replaceState(null, '', '#tuning/' + k); render();
    },
  }, l)));

  let body;
  if (CAT === 'event') body = eventView(form, t, val);
  else {
    const g = G[CAT];
    body = h('div', {},
      section({
        title: g.title, desc: g.desc,
        body: h('div', {}, rows(g.main), g.adv ? h('details', { class: 'advanced' }, h('summary', {}, '进阶 ', h('small', { text: `（${g.adv.length} 项，一般不用改）` })), h('div', {}, rows(g.adv))) : null),
      }),
      (g.groups || []).map(([title, desc, list]) => section({ title, desc, body: h('div', {}, rows(list)) })));
  }
  return h('div', { class: 'page' },
    pageHead('数值调整', '微调钓鱼手感、经验和奖励。每一项都标了默认值，改坏了可以对照改回来。'),
    h('div', { class: 'subnav-layout' }, sub, body));
}

// ---------- 限时活动 ----------
const BRANCHES = [
  ['2024 新年', [[9, 'MMXXIV'], [10, 'MMXXIV EXTRA']]], ['7 周年', [[11, 'VII'], [12, 'VII EXTRA']]],
  ['2025 新年', [[13, 'MMXXV'], [14, '2025 EXTRA']]], ['8 周年', [[15, 'VIII'], [16, 'VIII EXTRA']]],
  ['2026 新年', [[17, 'MMXXVI'], [18, '2026 特别奖']]], ['9 周年', [[19, 'IX'], [20, 'IX EXTRA']]],
];
const BRANCH_NAME = Object.fromEntries(BRANCHES.flatMap(([y, list]) => list.map(([id, n]) => [id, y + ' · ' + n])));
const DEFAULT_BRANCHES = '9,10,11,12,13,14,15,16,17,18,19,20';
const stageCount = (b) => ([14, 18].includes(Number(b)) ? 10 : 7);

function eventView(form, t, val) {
  const ny = val('event_newyear_enabled', 1) === '1', an = val('event_anniversary_enabled', 0) === '1';
  const which = ny ? 'newyear' : an ? 'anniversary' : 'off';
  const mode = segmented([['off', '不开启'], ['newyear', '新年活动'], ['anniversary', '周年活动']], which, async (v) => {
    try {
      if (v === 'off') { await post('/api/tunables', { key: 'event_newyear_enabled', value: '0' }); await post('/api/tunables', { key: 'event_anniversary_enabled', value: '0' }); }
      else await post('/api/tunables', { key: v === 'newyear' ? 'event_newyear_enabled' : 'event_anniversary_enabled', value: '1' });
      toast('已切换。玩家需要完全退出游戏再登录。');
      render();
    } catch (e) { toast(errText(e), 'bad'); }
  });

  // 分支：用勾选代替手填逗号列表
  const branchField = form.field({ key: 'event_branches', label: '活动分支', kind: 'string' }, val('event_branches', DEFAULT_BRANCHES));
  const chosen = new Set(String(branchField.original).split(',').map((x) => Number(x.trim())).filter(Boolean));
  branchField.input = h('input', { type: 'hidden', value: branchField.original });
  const syncBranches = () => { branchField.input.value = [...chosen].sort((a, b) => a - b).join(','); form.refresh(); };
  const branchGrid = h('div', { class: 'grid-3', style: { gap: '10px' } }, BRANCHES.map(([year, list]) => h('div', { class: 'card', style: { padding: '12px 14px', background: 'var(--surface-2)' } },
    h('b', { class: 'small', text: year }),
    list.map(([id, name]) => {
      const box = h('input', { type: 'checkbox', onchange: (e) => { e.target.checked ? chosen.add(id) : chosen.delete(id); syncBranches(); } });
      box.checked = chosen.has(id);
      return h('label', { class: 'row small', style: { marginTop: '6px', cursor: 'pointer' } }, box, name);
    }))));
  branchField.row = h('div', {}, branchGrid, branchField.input);

  // 结束时间：本地时间选择，存 UTC 秒
  const endField = form.field({ key: 'event_anniversary_end_unix', label: '结束时间', kind: 'string' }, val('event_anniversary_end_unix', 1825632000));
  const toLocal = (ts) => { const d = new Date(Number(ts) * 1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  const picker = h('input', { type: 'datetime-local', class: 'input', value: toLocal(endField.original), style: { width: '260px' } });
  endField.input = h('input', { type: 'hidden', value: endField.original });
  picker.addEventListener('change', () => { const ts = Math.floor(new Date(picker.value).getTime() / 1000); if (ts > 0) { endField.input.value = String(ts); form.refresh(); } });
  endField.row = h('div', { class: 'setting' },
    h('div', {}, h('div', { class: 's-label', text: '活动结束时间' }), h('div', { class: 's-help', text: '新年和周年活动面板上的倒计时终点。按你电脑的时区显示。' })),
    h('div', { class: 's-control' }, picker, endField.input));

  return h('div', {},
    callout('info', '活动设置只在玩家重新登录时下发。改完之后，玩家需要完全退出游戏再登录才能看到变化。'),
    h('div', { style: { height: '16px' } }),
    section({ title: '当前活动', desc: '同一时间只能开一个活动。点击立即切换。', body: mode }),
    section({ title: '活动分支', desc: '选择活动面板里出现哪些任务线。都不选表示不下发任何活动任务。', body: branchField.row }),
    section({ title: '时间', body: endField.row }),
    giftsSection(t, [...chosen], which !== 'off'));
}

// 阶段奖励：按分支、阶段配置额外奖励物品
function giftsSection(t, branches, active) {
  let data = {};
  try { data = JSON.parse(t.event_stage_gifts || '{}') || {}; } catch (e) { data = {}; }
  const names = {};
  let branch = branches.includes(13) ? 13 : branches[0];
  let stage = 1;
  let dirty = false;
  const box = h('div');
  const saveBtn = btn('保存阶段奖励', async () => {
    for (const [b, stages] of Object.entries(data)) for (const [s, gifts] of Object.entries(stages)) {
      if (!gifts.length) delete data[b][s];
    }
    for (const b of Object.keys(data)) if (!Object.keys(data[b]).length) delete data[b];
    try {
      await post('/api/tunables', { key: 'event_stage_gifts', value: Object.keys(data).length ? JSON.stringify(data, null, 2) : '' });
      dirty = false;
      toast('已保存。玩家需要重启游戏并重新登录才能看到。');
      draw();
    } catch (e) { toast(errText(e), 'bad'); }
  }, 'primary');
  const gifts = () => ((data[branch] || {})[stage] || []);
  const setGifts = (list) => { data[branch] = data[branch] || {}; data[branch][stage] = list; dirty = true; draw(); };
  const hydrate = async () => {
    const ids = new Set();
    for (const st of Object.values(data)) for (const list of Object.values(st)) for (const g of list) if (!names[g.item]) ids.add(g.item);
    for (const id of ids) {
      try { const r = await api('/api/catalog/items?limit=5&q=' + encodeURIComponent(id)); const hit = r.find((x) => x.item_id === id); names[id] = hit ? hit.name : id; } catch (e) { names[id] = id; }
    }
    if (ids.size) draw();
  };
  function draw() {
    if (!active || !branches.length) {
      box.replaceChildren(empty(!active ? '还没有开启活动' : '还没有选择活动分支', !active ? '先在上面选择新年或周年活动。' : '先在上面勾选至少一个分支并保存。'));
      return;
    }
    const branchSel = h('select', { class: 'select', style: { width: '240px' }, onchange: (e) => { branch = Number(e.target.value); stage = 1; draw(); } },
      branches.map((b) => h('option', { value: b, text: BRANCH_NAME[b] || b, selected: b === branch })));
    const stageTabs = h('div', { class: 'seg' }, Array.from({ length: stageCount(branch) }, (_, i) => {
      const n = i + 1, count = ((data[branch] || {})[n] || []).length;
      return h('button', { type: 'button', class: n === stage ? 'on' : '', onclick: () => { stage = n; draw(); } }, '阶段 ' + n, count ? h('span', { class: 'muted', text: ' · ' + count }) : null);
    }));
    const list = gifts();
    const rows = list.length ? h('div', { class: 'card' }, h('div', { class: 'list' }, list.map((g, i) => h('div', { class: 'list-item' },
      itemIcon(g.item), h('div', { class: 'grow' }, h('div', { class: 'title', text: names[g.item] || g.item }), h('div', { class: 'sub mono', text: g.item })),
      h('label', { class: 'row small muted' }, '数量', h('input', { class: 'input num', style: { width: '72px', height: '30px' }, value: g.qty, oninput: (e) => { g.qty = Math.max(1, Math.min(99, Math.round(Number(e.target.value) || 1))); dirty = true; } })),
      btn('', () => setGifts(list.filter((_, j) => j !== i)), 'ghost icon sm', { icon: 'trash', 'aria-label': '移除' })))))
      : empty('这个阶段没有额外奖励', '完成这个阶段时只发游戏自带的奖励。');
    box.replaceChildren(h('div', { class: 'stack' },
      h('div', { class: 'row' }, branchSel, h('div', { style: { overflowX: 'auto', maxWidth: '100%' } }, stageTabs)),
      rows,
      h('div', { class: 'row' }, btn('添加物品', () => pickItem({ title: '选择奖励物品', completeOnly: true, onPick: (x) => { names[x.item_id] = x.name; setGifts([...list, { item: x.item_id, qty: 1 }]); } }), '', { icon: 'plus' }),
        h('span', { class: 'spacer' }), saveBtn)));
  }
  draw();
  hydrate();
  return section({ title: '阶段奖励', desc: '完成活动某个阶段时，额外发放的物品。', body: box });
}
