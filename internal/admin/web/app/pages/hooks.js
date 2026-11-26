// 鱼钩：按型号微调咬口难易。真实物理数据只读。
import { h, api, post, toast, errText, pageHead, work, ib, h2s, hint, bullets, badge, btn, empty, loading, searchBox, debounce, sidePage, Form, fmt, replaceHash, render } from '../core.js';
import { itemIcon } from '../widgets.js';

const FAMILY = [['', '所有钩型'], ['classic', '普通钩'], ['carp', '鲤鱼钩'], ['treble', '三本钩'], ['jighead', '铅头钩'], ['offset', '曲柄钩'], ['marine', '海钓钩'], ['other', '其他']];
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
  const sizeSel = h('select', { class: 'select', 'aria-label': '钩号', style: { width: '130px' }, onchange: (e) => { SIZE = e.target.value; load(); } }, h('option', { value: '', text: '所有尺寸' }),
    Array.from({ length: 34 }, (_, size) => h('option', { value: size, text: '#' + size, selected: String(size) === SIZE })));
  const famSel = h('select', { class: 'select', style: { width: '140px' }, onchange: (e) => { FAM = e.target.value; load(); } }, FAMILY.map(([k, l]) => h('option', { value: k, text: l, selected: k === FAM })));
  let sequence = 0;
  const statDl = h('dl');
  async function load() {
    const request = ++sequence;
    count.textContent = '读取中'; statDl.replaceChildren();
    tbody.replaceChildren(h('tr', {}, h('td', { colspan: 7 }, loading(4))));
    try {
      const d = await api(`/api/hooks/profiles?limit=500&q=${encodeURIComponent(Q)}&size=${encodeURIComponent(SIZE)}&family=${encodeURIComponent(FAM)}`);
      if (request !== sequence) return;
      if (!Array.isArray(d.profiles) || !Number.isInteger(d.total)) throw new Error('型号列表不完整');
      const list = d.profiles;
      count.textContent = list.length < (d.total || 0) ? `找到 ${fmt(d.total)} 个，显示前 ${list.length} 个` : `${fmt(list.length)} 个型号`;
      statDl.replaceChildren(
        h('div', {}, h('dt', { text: '符合条件的' }), h('dd', { text: fmt(d.total || list.length) })),
        h('div', {}, h('dt', { text: '这页显示' }), h('dd', { text: fmt(list.length) })),
        h('div', {}, h('dt', { text: '本页非默认' }), h('dd', { text: fmt(list.filter((p) => !isDefault(p)).length) })));
      tbody.replaceChildren(...(list.length ? list.map((p) => h('tr', {},
        h('td', {}, h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, itemIcon(p.item_id, 32), h('div', {}, h('b', { text: p.name || p.brand || p.item_id }), h('span', { class: 'sub mono', text: p.item_id })))),
        h('td', { text: familyName(p.family) }),
        h('td', { class: 'num', text: '#' + p.size }),
        h('td', { class: 'num', text: Number(p.strength_kg).toFixed(1) + ' kg' }),
        h('td', { class: 'num', text: fmt(Math.round(p.entry_capacity_g)) + ' g' }),
        h('td', {}, isDefault(p) ? badge('默认') : null, h('span', { class: 'sub', text: `咬口 ×${p.solid_scale} · 保持 ×${p.hold_scale} · 小鱼下限 ${p.small_fish_floor} · 大鱼下限 ${p.over_capacity_hold_floor}` })),
        h('td', { class: 'num' }, btn('调整', () => edit(p, load), 'sm')))) : [h('tr', {}, h('td', { colspan: 7 }, empty('没有符合条件的鱼钩')))]));
    } catch (e) {
      if (request !== sequence) return;
      count.textContent = '未取得';
      tbody.replaceChildren(h('tr', {}, h('td', { colspan: 7 }, empty('读取失败', errText(e)), btn('重试', load))));
    }
  }
  const scheduleLoad = debounce(() => { if (tbody.isConnected) load(); }, 300);
  load();
  const aside = [
    ib('这一页管什么', '不同型号的鱼钩，咬口和中钩后的稳不稳可以单独调整', bullets([
      '不改鱼钩本身的强度、长度和适合鱼重。',
      '咬口难易 ×1 是默认；大于 1 更容易中鱼。',
      '中钩稳定 ×1 是默认；大于 1 搏鱼时更不容易脱钩。',
      '只影响这个型号，同钩型的其他尺寸各管各的。',
    ])),
    ib('搏鱼参数', null, h('a', { class: 'pill', href: '#hooks/fight', text: '游戏参数 → 玩法与钓组 → 鱼' })),
    ib('改过多少', null, statDl, hint('改完约 30 秒热加载，不用重启服务。')),
  ];
  return [
    pageHead('钩子手感', '不同型号的鱼钩，咬口和中钩后稳不稳可以单独调。不改变鱼钩本身的强度。'),
    work([
      h2s('鱼钩型号'),
      hint('按钩型、尺寸筛选；点「调整」可以单独改一个型号。'),
      h('div', { class: 'hooks-toolbar', style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', margin: '0 0 12px' } },
        h('div', { style: { flex: '1 1 200px', minWidth: '160px', maxWidth: '320px' } }, searchBox('搜索型号或品牌，如 simmons', v => { Q = v; scheduleLoad(); }, Q)),
        famSel, sizeSel, h('span', { style: { flex: '1 1 auto' } }), count),
      h('div', { class: 'tbl', style: { maxHeight: 'calc(100vh - 330px)', overflow: 'auto' } }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { text: '鱼钩' }), h('th', { text: '钩型' }), h('th', { class: 'num', text: '尺寸' }), h('th', { class: 'num', text: '强度' }),
          h('th', { class: 'num', title: '钩子大小能装下多大的鱼嘴', text: '适合鱼重' }), h('th', {}), h('th', { class: 'num', text: '调整' }))), tbody)),
    ], aside),
  ];

}

function edit(p, reload) {
  const form = new Form();
  const body = h('div', { class: 'stack' },
    h('dl', { class: 'kv small' },
      h('dt', { text: '钩型 / 尺寸' }), h('dd', { text: `${familyName(p.family)} · #${p.size}` }),
      h('dt', { text: '长度' }), h('dd', { text: Number(p.length_mm).toFixed(2) + ' mm' }),
      h('dt', { text: '强度' }), h('dd', { text: Number(p.strength_kg).toFixed(2) + ' kg' }),
      h('dt', { text: '适合鱼重' }), h('dd', { text: '约 ' + fmt(Math.round(p.entry_capacity_g)) + ' g 以下' })),
    h('div', {},
      form.row({ key: 'solid_scale', label: '咬口难易', help: '1 是默认。大于 1 更容易中鱼，小于 1 更难。', kind: 'float', min: 0, max: 3, def: '1', unit: '倍' }, p.solid_scale),
      form.row({ key: 'hold_scale', label: '中钩后稳不稳', help: '1 是默认。大于 1 搏鱼时不容易脱钩。', kind: 'float', min: 0, max: 3, def: '1', unit: '倍' }, p.hold_scale),
      h('details', { class: 'advanced' }, h('summary', {}, '进阶'), h('div', {},
        form.row({ key: 'small_fish_floor', label: '小鱼最低咬口', help: '鱼远小于钩子时，咬口至少保留这个比例。0–1。', kind: 'float', min: 0, max: 1, def: '0' }, p.small_fish_floor),
        form.row({ key: 'over_capacity_hold_floor', label: '大鱼最低稳定度', help: '鱼超过钩子适合的重量时，稳定度至少保留这个比例。0–1。', kind: 'float', min: 0, max: 1, def: '0' }, p.over_capacity_hold_floor)))));
  const advanced = body.querySelector('details');
  const error = h('p', { role: 'alert', hidden: true });
  body.append(error);
  sidePage({
    effect:'保存后主服热加载，约 30 秒内生效。',
    title: p.name || p.item_id, beforeClose: () => !form.isDirty() || confirm('放弃未保存的调整？'), isDirty: () => form.isDirty(), desc: p.item_id, body,
    actions: [
      { label: '恢复默认', kind: 'ghost', onClick: () => {
        for (const f of form.fields.values()) f.input.value = f.spec.def;
        advanced.open = true; error.hidden = true; form.validate([...form.fields.keys()]); form.refresh(); return true;
      } },
      { label: '取消', kind: 'ghost' },
      { label: '保存', kind: 'primary', onClick: async () => {
        const keys = ['solid_scale', 'hold_scale', 'small_fish_floor', 'over_capacity_hold_floor'];
        error.hidden = true;
        if (!form.validate(keys)) { advanced.open = true; body.querySelector('[aria-invalid="true"]')?.focus(); return true; }
        const v = form.values(keys);
        try {
          await post('/api/hooks/profiles', { item_id: p.item_id, solid_scale: +v.solid_scale, hold_scale: +v.hold_scale, small_fish_floor: +v.small_fish_floor, over_capacity_hold_floor: +v.over_capacity_hold_floor });
        } catch (e) { error.textContent = errText(e); error.hidden = false; return true; }
        toast('已保存，约 30 秒内生效'); reload();
      } },
    ],
  });
}
