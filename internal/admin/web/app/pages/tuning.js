// 数值调整：所有可调数字按主题分组。开关类玩法在「玩法规则」页。
import { h, api, post, toast, errText, pageHead, pageTabs, work, ib, pblock, h2s, h3s, hint, note, kv, bullets, pill, section, callout, badge, btn, Form, savebar, replaceHash, render, confirmDialog, segmented, empty, icon, setCrumbTail, navigate } from '../core.js';
import { eventView } from './event-gifts.js';

// [key, 标签, 说明, 默认值, 类型, 单位, 最小, 最大]
const G = {
  bite: {
    title: '咬钩', desc: '鱼多久咬一次钩。',
    main: [
      ['bite_probability', '每次抛竿有鱼的概率', '1 表示每竿必有鱼咬；0.5 表示一半的抛竿会空等。', 1, 'float', '', 0, 1],
      ['bite_delay_scale', '咬钩速度', '整体调快或调慢。0.5 = 快一倍，2 = 慢一倍。', 1, 'float', '倍'],
      ['bite_delay_max', '最长等待', '等这么久一定会有鱼咬（路亚除外）。开启「饵效控速」后本项无效：底钓/浮钓的等待上限改由下方「好饵/差饵等待上下限」接管，海钓由进阶里的「海钓等待上下限」接管。', 20, 'float', '秒'],
      ['bite_delay_lure_max', '路亚最长等待', '路亚钓法的最长等待时间。开启「饵效控速」后只约束好档（饵与动作都对口），路亚中/差档改由下方「路亚中档/差档等待上下限」接管。', 6, 'float', '秒'],
      ['pace_good_min', '好饵等待下限（饵效控速）', '对口饵的等待区间下限秒。需在「玩法规则」里开启「饵效控速」。', 6, 'float', '秒', 0, 600],
      ['pace_good_max', '好饵等待上限（饵效控速）', '对口饵的等待区间上限秒；好饵在 下限~上限 秒内随机来鱼。', 60, 'float', '秒', 0, 600],
      ['pace_bad_min', '差饵等待下限（饵效控速）', '不对口饵的等待区间下限秒。', 20, 'float', '秒', 0, 600],
      ['pace_bad_max', '差饵等待上限（饵效控速）', '不对口饵的等待区间上限秒；差饵同时受低开口率（见进阶）压制，表现为偶发慢口。', 60, 'float', '秒', 0, 600],
      ['pace_lure_min', '路亚好档等待下限（饵效控速）', '饵与动作都对口时路亚轮的等待下限秒。默认 1.5 对齐原版收线短窗，拉大可能导致鱼在收线之后才到，一般别动。', 1.5, 'float', '秒', 0, 600],
      ['pace_lure_max', '路亚好档等待上限（饵效控速）', '饵与动作都对口时路亚轮的等待上限秒；好档在此区间内必来鱼（开口率见进阶）。', 6, 'float', '秒', 0, 600],
      ['pace_lure_mid_min', '路亚中档等待下限（饵效控速）', '饵或动作一般时路亚轮的等待下限秒，默认与底钓中饵同区间；动作变好会立即重排进好档短窗。', 10, 'float', '秒', 0, 600],
      ['pace_lure_mid_max', '路亚中档等待上限（饵效控速）', '饵或动作一般时路亚轮的等待上限秒，不受上面「路亚最长等待」约束。', 60, 'float', '秒', 0, 600],
      ['pace_lure_bad_min', '路亚差档等待下限（饵效控速）', '差饵或明显不对口的动作下路亚轮的等待下限秒，默认与底钓差饵同区间。', 20, 'float', '秒', 0, 600],
      ['pace_lure_bad_max', '路亚差档等待上限（饵效控速）', '差饵或明显不对口的动作下路亚轮的等待上限秒，不受「路亚最长等待」约束。', 60, 'float', '秒', 0, 600],
    ],
    adv: [
      ['bite_delay_fixed', '固定咬钩时间', '填 0 表示随机；填了数字后每次都在这个时间咬钩。', 0, 'float', '秒'],
      ['bite_empty_retry_scale', '没鱼时重试快慢', '这一轮没有合适的鱼时，下一轮等待时间的倍数。0.25 表示很快重试。', 1, 'float', '倍'],
      ['bite_gate_pity_rounds', '连续空杆保底', '连续空杆这么多轮后，放宽环境条件保证有一口。0 表示关闭。', 0, 'int', '轮'],
      ['pace_score_good', '好饵线（饵效控速）', '钩上饵对本水域的「对口分」达到这个值算好饵。', 0.75, 'float', '', 0, 1],
      ['pace_score_mid', '中饵线（饵效控速）', '对口分达到这个值算中饵，低于算差饵。没有任何证据的饵按 0.30 计（差饵但不判死）。', 0.45, 'float', '', 0, 1],
      ['pace_mid_min', '中饵等待下限（饵效控速）', '中等对口饵的等待区间下限秒。', 10, 'float', '秒', 0, 600],
      ['pace_mid_max', '中饵等待上限（饵效控速）', '中等对口饵的等待区间上限秒。', 60, 'float', '秒', 0, 600],
      ['pace_factor_mid', '中饵分布乘数（饵效控速）', '在区间内微调中饵等待分布的倍数，1.6 把样本整体拉慢 60%。一般不用动，直接改上面的等待区间即可。', 1.6, 'float', '倍'],
      ['pace_factor_bad', '差饵分布乘数（饵效控速）', '在区间内微调差饵等待分布的倍数。一般不用动。', 3, 'float', '倍'],
      ['pace_prob_good', '好饵开口率·底钓（饵效控速）', '底钓/浮钓每轮判定开口的概率，1 表示好饵每轮必有口。', 1, 'float', '', 0, 1],
      ['pace_prob_mid', '中饵开口率·底钓（饵效控速）', '', 0.5, 'float', '', 0, 1],
      ['pace_prob_bad', '差饵开口率·底钓（饵效控速）', '0.12 表示差饵大部分轮次空等，一分钟内大概率无口。', 0.12, 'float', '', 0, 1],
      ['pace_lure_prob_good', '好档开口率·路亚（饵效控速）', '饵与动作都对口时每轮判定开口的概率，1 表示好档窗口（1.5~6 秒）内必来鱼。', 1, 'float', '', 0, 1],
      ['pace_lure_prob_mid', '中档开口率·路亚（饵效控速）', '', 0.5, 'float', '', 0, 1],
      ['pace_lure_prob_bad', '差档开口率·路亚（饵效控速）', '0.12 表示差档大部分轮次空等，表现与底钓差饵一致。', 0.12, 'float', '', 0, 1],
      ['pace_marine_min', '海钓等待下限·pace', '海底钓族（非路亚）在 pace 模式下的等待下限秒；海钓窗不分档位。', 3, 'float', '秒', 0, 600],
      ['pace_marine_max', '海钓等待上限·pace', '海底钓族（非路亚）在 pace 模式下的等待上限秒。', 30, 'float', '秒', 0, 600],
      ['pace_groundbait_floor', '打窝地板·pace', '满窝时底层杆等待压向这个秒数；死窝不加速，路亚豁免。', 3, 'float', '秒', 0, 600],
      ['pace_groundbait_gain', '打窝压缩力度·pace', '越大压得越狠：压缩系数 = 1 − 力度 × 窝强度 × 过量概率。', 0.62, 'float', '', 0, 1],
      ['pace_groundbait_min_factor', '打窝压缩下限·pace', '满窝最多把等待压到原来的这个比例，0.35 = 压到 35%。', 0.35, 'float', '', 0, 1],
    ],
  },
  bait: {
    title: '饵料与对口', desc: '饵料对鱼的吸引力，以及「饵要对口」规则的细节。',
    main: [
      ['bait_pref_scale', '饵料影响力', '0 表示鱼完全不看饵；1 是标准效果；大于 1 让对口鱼更集中。', 1, 'float', '倍'],
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
    title: '经验与奖励', desc: '经验、掉落、礼包和技能熟练度。',
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
// 与演示页一致的三个二级页签；每个页签下面按主题拼多个 .pblock
const CATS = [['gameplay', '玩法与钓组'], ['reward', '收益与通知'], ['event', '限时活动']];
const TAB_GROUPS = { gameplay: ['bite', 'bait', 'fish', 'wear'], reward: ['reward', 'chat'], event: ['event'] };
const TAB_DESC = {
  gameplay: '玩法手感、钩型咬口、电轮与磨损、负载与角色状态。改完最多 30 秒生效，不用重启服务。',
  reward: '经验、熟练度与聊天提示。改完最多 30 秒生效；技能概率模式切换是独立保存的。',
  event: '新年与周年活动。玩家须重启游戏客户端并重新登录，才能看到活动变化。',
};
// 旧地址兼容：#tuning/bite 之类的老链接落到对应页签
const OLD_TAB = { bite: 'gameplay', bait: 'gameplay', fish: 'gameplay', wear: 'gameplay', chat: 'reward' };
const SKILL_GAIN_KEYS = [
  ['skill_gain_pct_1', '浮子钓鱼', '手竿、博洛尼亚竿等浮钓熟练度。'],
  ['skill_gain_pct_2', '纺车钓鱼', '纺车竿与枪柄竿共用的路亚熟练度。'],
  ['skill_gain_pct_3', '底钓', '喂食器、鲤鱼竿等底钓熟练度。'],
  ['skill_gain_pct_11', '海洋钓鱼', '船钓、海钓熟练度。'],
  ['skill_gain_pct_4', '饵料制作', '挖饵和制作鱼饵共用熟练度。'],
  ['skill_gain_pct_5', '配置诱饵', '混合诱饵/窝料制作熟练度。'],
  ['skill_gain_pct_6', '烹饪', '烹饪制作熟练度。'],
  ['skill_gain_pct_8', '制作拟饵', '路亚手工制作熟练度。'],
];
const SKILL_GAIN_MODES = [['native', '原版概率'], ['fixed100', '百分百'], ['custom', '自定义']];
// 鱼获档位对熟练度增量的倍数。1..4 对应 grade 枚举；填 1 表示该档位不加成。
const SKILL_GRADE_KEYS = [
  ['skill_grade_mult_1', '未达标鱼', '协议里的 grade 1。填 1 = 不加成。'],
  ['skill_grade_mult_2', '合格鱼', '协议里的 grade 2，绝大多数渔获是这一档。'],
  ['skill_grade_mult_3', '奖杯鱼', '协议里的 grade 3，即「上星」的鱼。'],
  ['skill_grade_mult_4', '蓝冠鱼', '协议里的 grade 4，超级稀有。'],
];
let CAT = 'gameplay';

function skillGainModeOf(t) {
  const saved = String(t.skill_gain_mode ?? '');
  if (SKILL_GAIN_MODES.some(([mode]) => mode === saved)) return saved;
  const values = SKILL_GAIN_KEYS.map(([key]) => Number(t[key] ?? 0) || 0);
  if (values.every((v) => v === 0)) return 'native';
  if (values.every((v) => v === 100)) return 'fixed100';
  return 'custom';
}

function skillGainSection(form, t, val, no = 90) {
  const mode = skillGainModeOf(t);
  const pick = async (next) => {
    if (next === mode) return;
    if (form.isDirty() && !(await confirmDialog({ title: '有修改还没保存', desc: '切换技能概率模式会放弃当前未保存的数值。', confirm: '放弃并切换' }))) return;
    try {
      await post('/api/skill_gain_mode', { mode: next });
      toast('技能升级概率已切换，约 30 秒内生效');
      render();
    } catch (e) { toast(errText(e), 'bad'); }
  };
  const buttons = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': '技能升级概率模式' }, SKILL_GAIN_MODES.map(([key, label]) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(key === mode), class: key === mode ? 'on' : '', onclick: () => pick(key),
  }, label)));
  const fields = mode === 'custom' ? h('div', { class: 'stack', style: { marginTop: '14px' } }, SKILL_GAIN_KEYS.map(([key, label, help]) =>
    form.row({ key, label, help, kind: 'float', min: 0, max: 100, unit: '%', def: 0 }, val(key, 0)))) : null;
  // 鱼获档位倍数作为本区块的第二段：它同样按「涨多少」调节熟练度，
  // 和上面的「涨不涨」是同一件事的两个维度，不另起一个区块。
  const gradeFields = SKILL_GRADE_KEYS.map(([key, label, help]) =>
    form.row({ key, label, help, kind: 'float', min: 0, max: 20, unit: '倍', def: 1 }, val(key, 1)));
  return pblock(no, '技能升级概率', '一键切换全部技能：原版概率、全部百分百，或逐项自定义。0=原版公式，100=必定增长。',
    [h('div', { class: 'span-2', style: { gridColumn: '1 / -1' } }, buttons,
      h('p', { class: 'hint', style: { margin: '8px 0 0' }, text: '百分百模式会让每次符合条件的钓获、挖饵或制作都获得熟练度；固定百分比模式不叠加欢乐时光对原版概率的修正。' })),
    ...(fields ? [...fields.childNodes] : []),
    h('div', { class: 'span-2', style: { gridColumn: '1 / -1', marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--line)' } },
      h('p', { style: { margin: '0 0 2px', fontWeight: '600' }, text: '按鱼获档位加成' }),
      h('p', { class: 'hint', style: { margin: '0 0 8px' }, text: '钓到越稀有的鱼，单次熟练度涨得越多。倍数只放大增量，不改变上面「这次涨不涨」的概率，两种模式都叠加。基础增量是 0.1 或 0.2，乘以倍数后四舍五入到 0.1——建议用 1/2/4/8 这类整数倍，避免 0.15 被进位成 0.2。填 0 让该档完全不涨。制作和挖饵没有鱼档位，始终按 1 倍。' })),
    ...gradeFields], { id: 'pg-skill' });
}

export default async function tuning(params, scope) {
  if (params[0]) {
    const want = OLD_TAB[params[0]] || params[0];
    if (CATS.some(([k]) => k === want)) CAT = want;
  }
  const t = await api('/api/tunables');
  if (!scope.isCurrent()) return [];
  const val = (k, d) => (t[k] === undefined || t[k] === '' ? String(d) : t[k]);
  const form = new Form();
  const event = CAT === 'event' ? eventView(t) : null;
  if (!event) savebar(form, {
    effect:'服务端最多 30 秒生效。',
    onSave: async (values) => {
      for (const [key, value] of Object.entries(values)) await post('/api/tunables', { key, value: String(value) });
      render();
    },
  });
  const isDirty = event ? event.isDirty : () => form.isDirty();
  scope.setLeaveGuard(isDirty);
  const spec = ([key, label, help, def, kind, unit, min, max]) => ({ key, label, help, def: kind === 'bool' ? String(def) : def, kind, unit, min, max });
  const rows = (list) => list.map((d) => form.row(spec(d), val(d[0], d[3])));

  // 饵效控速未开启时不渲染 pace_* 行：这些参数只在开关打开后才参与计算，
  // 关闭时全部走 legacy/中性通路。
  const paceOn = String(t.bite_pace_enabled ?? '0') === '1';
  const paceVisible = (d) => paceOn || !d[0].startsWith('pace_');
  let body;
  if (event) body = event.blocks;
  else {
    // 一个页签 = 若干主题，每个主题一个 01/02/03… 的 .pblock，页面才不会只有一屏
    const out = [];
    let no = 0;
    for (const key of TAB_GROUPS[CAT] || []) {
      const g = G[key];
      if (!g) continue;
      const advRows = (g.adv || []).filter(paceVisible);
      const mainKids = [
        ...rows(g.main.filter(paceVisible)),
        key === 'bite' && !paceOn
          ? h('p', { class: 'hint', style: { gridColumn: '1 / -1', margin: '4px 0 0' }, text: '「饵效控速」未开启（开关在「玩法规则 → 其他」）：开启后这里才会出现好饵/差饵/路亚等待区间等设置项；未开启时这些参数不参与任何计算。' })
          : null,
        advRows.length
          ? h('div', { class: 'advanced', style: { gridColumn: '1 / -1', marginTop: '6px' } },
            h('p', { class: 'hint', style: { margin: '0 0 2px' } }, '进阶 ', h('small', { text: `（${advRows.length} 项，一般不用改）` })),
            h('div', { class: 'two gapped' }, ...rows(advRows)))
          : null,
      ].filter(Boolean);
      out.push(pblock(++no, g.title, g.desc, mainKids, { id: 'pg-' + key }));
      for (const [title, desc, list] of (g.groups || [])) out.push(pblock(++no, title, desc, rows(list), { id: 'pg-' + key + '-' + (out.length + 1) }));
    }
    if (CAT === 'reward') out.push(skillGainSection(form, t, val, ++no));
    body = out;
  }
  const blocks = Array.isArray(body) ? body : [body];
  const tabsEl = pageTabs(CATS, CAT, async (k) => {
    if (k === CAT) return;
    if (event?.busy() || (isDirty() && !(await confirmDialog({ title: '有修改还没保存', desc: '切换分类会放弃这些修改。', confirm: '放弃并切换' })))) {
      // pageTabs 在点击时先高亮目标；取消后仍应标记实际页签。
      queueMicrotask(() => tabsEl.querySelectorAll('a').forEach((a) => {
        if (a.hash === '#tuning/' + CAT) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      }));
      return;
    }
    CAT = k; replaceHash('#tuning/' + k); render();
  });
  setCrumbTail((CATS.find(([k]) => k === CAT) || [])[1] || '');
  const anchors = blocks.filter((b) => b && b.classList && b.classList.contains('pblock')).map((b) => ({
    id: b.id,
    no: (b.querySelector('.pno') || {}).textContent || '',
    title: b.querySelector('.ptitle > b') ? b.querySelector('.ptitle > b').textContent : '',
    n: b.querySelectorAll('.row').length,
  }));
  const aside = [
    ib('这一页的分组', '点名字滚到那一组，不切页',
      h('div', { class: 'pills', style: { flexDirection: 'column', alignItems: 'stretch', gap: '6px' } },
        ...anchors.map((a) => h('button', {
          class: 'pill', type: 'button',
          onclick: () => { const el = document.getElementById(a.id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
        }, h('b', { text: a.no }), h('span', {}, h('span', { text: a.title }), h('em', { style: { display: 'block', fontStyle: 'normal', fontSize: '12.4px', color: 'var(--muted)', marginTop: '2px' }, text: `${a.n} 项` }))))),
      hint('只滚动主栏，不改地址栏，所以不会丢掉还没保存的草稿。', { margin: '10px 0 0' })),
    ib('生效说明', null,
      kv([['作用范围', '全服'], ['服务端更新', '最多 30 秒'], ...(event ? [['客户端更新', '重启游戏客户端并重新登录']] : [['已改动项', String(form.dirtyKeys().length)]]), ['参数总数', String(Object.keys(t).length)]]),
      h3s('相关页面'),
      h('div', { class: 'pills' }, h('a', { class: 'pill', href: '#hooks/fight', text: '定位到玩法与钓组的搏鱼参数' }))),
  ];
  return [
    pageHead('游戏参数', TAB_DESC[CAT] || TAB_DESC.gameplay),
    tabsEl,
    work(blocks, aside),
  ];
}
