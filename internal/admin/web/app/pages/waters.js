// 水域与鱼种：每个水域出哪些鱼、各占多少、咬钩快慢。
import { zonesEditor } from './zones.js';
import {
  h, api, apiList, post, toast, errText, pageHead, pageTabs, work, ib, h2s, h3s, hint, note, kv, bullets, pill, badge, btn, empty, loading,
  searchBox, debounce, sidePage, confirmDialog, navigate, Form, savebar, render, webURL, fmt, setCrumbTail,
} from '../core.js';

const ORDER = ['克马羚诺也湖', '埃尔克湖', '惟有诺克河', '旧奥斯特罗格湖', '白河', '廓里湖', '梅德韦杰湖', '沃尔霍夫河', '北顿涅茨河', '苏拉河', '拉多加湖', '琥珀湖', '拉多加湖群岛', '阿赫图巴河', '铜湖', '下通古斯卡河', '亚马河', '挪威海'];

export function fishIcon(key, w = 64) {
  const img = h('img', { src: webURL('/icons/fish/' + encodeURIComponent(String(key || '').toLowerCase().replace(/\./g, '_')) + '.png'), alt: '', loading: 'lazy', style: { width: w + 'px', height: (w / 2) + 'px', objectFit: 'contain', flex: 'none' } });
  img.onerror = () => { img.style.display = 'none'; };
  return img;
}

export default async function waters(params, scope) {
  const routeHash = location.hash;
  const head = pageHead('水域与鱼种', '每个水域出哪些鱼、各占多少。');
  let areas;
  try {
    areas = await api('/api/fish/areas');
    if (!Array.isArray(areas)) throw new Error('水域列表格式不完整');
  } catch (e) { return [head, work([empty('水域读取失败', errText(e)), btn('重试', render)])]; }
  if (!scope.isCurrent()) return [];
  const list = areas.slice().sort((a, b) => {
    const ia = ORDER.indexOf(a.loc), ib = ORDER.indexOf(b.loc);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const loc = params[0] || list[0]?.loc;
  const tab = params[1] === 'zones' ? 'zones' : 'fish';
  const TABS = [['fish', '鱼种'], ['zones', '鱼群区域']];
  setCrumbTail((TABS.find(([k]) => k === tab) || [])[1]);
  const tabsEl = pageTabs(TABS, tab, k => { if (k !== tab) navigate('waters', loc, k); });
  const area = list.find(a => a.loc === loc);
  const seg = h('div', { class: 'seg areas' }, list.map(a => h('button', {
    type: 'button', class: a.loc === loc ? 'on' : '', onclick: () => { if (a.loc !== loc) navigate('waters', a.loc, tab); },
  }, a.loc)));
  if (!area) return [head, work([empty(params[0] ? `水域「${loc}」已失效，请重新选择` : '水域列表为空'), seg, btn('重新读取', render)])];
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
    return [head, tabsEl, work([h2s(loc), seg, empty('水域配置读取失败', '未取得当前水域的完整配置，不能编辑。'), btn('重试', render)])];
  }
  if (tab === 'zones') {
    const picker = h('select', { class: 'select', 'aria-label': '选择水域', onchange: e => navigate('waters', e.target.value, tab) },
      list.map(a => h('option', { value: a.loc, text: a.loc + (a.map_kind === 'sea' ? '（海图）' : ''), selected: a.loc === loc })));
    return [head, tabsEl, work([picker, zonesEditor({ area, zones, roster: cfg.fish }, scope)])];
  }
  const baitByKey = Object.fromEntries((prefs?.rows || []).map(r => [r.fish_key, r]));
  const saved = cfg.fish.filter(f => f.enabled && Number(f.weight) > 0);
  const sum = saved.reduce((n, f) => n + Number(f.weight), 0);

  const aside = [
    ib('已保存权重', saved.length ? null : cfg.fish.length ? '名册中没有启用且权重大于零的鱼种' : '鱼种名册为空', saved.length ? h('dl', {},
      ...saved.slice(0, 10).map((f) => h('div', {}, h('dt', { text: f.name_zh || f.fish_key }), h('dd', { text: `${fmt(f.weight)} · ${(Number(f.weight) / sum * 100).toFixed(1)}%` })))) : null,
      h3s('水域名册'), h('div', { class: 'pills' }, ...list.slice(0, 8).map((a) => h('span', { class: 'pill', text: a.loc + (Number.isInteger(a.fish_count) ? ` ${a.fish_count} 种` : '') })))),
    ib('这一页管什么', '只影响当前水域', bullets([
      '出现：取消勾选等于这个水域不出这种鱼。',
      '权重：相对值，占比列是换算结果。',
      '爱吃的饵：来自「鱼饵偏好」，这里只读。',
    ]), hint(zones ? `已划鱼群区域：${zones.length} 个。` : '鱼群区域数量未取得。')),
  ];

  return [
    pageHead('水域与鱼种', '每个水域出哪些鱼、各占多少；鱼群区域在这里画。'),
    tabsEl,
    work([h2s(loc), hint(`${cfg.fish.length} 种鱼 · 仅影响此水域`), seg, !prefs ? hint('鱼饵偏好读取失败，轮换快照未取得。') : null, fishView(cfg, baitByKey, scope)], aside),
  ];
}

// ---------- 鱼种名册 ----------
// 爱吃的饵：静态规则来自鱼饵偏好；轮换只认名册行里后端给的 bait_groups / bait_rotate_sec
function baitLine(row, pref) {
  const allow = (pref && pref.allow) || [];
  const groups = (row.bait_groups || []).filter((g) => g && g.length);
  const state = pref?.rotation;
  const txt = allow.length
    ? '吃 ' + allow.slice(0, 3).join('、') + (allow.length > 3 ? ` 等 ${allow.length} 种` : '')
    : '';
  if (!groups.length) return txt ? hint(txt) : null;
  const mode = { strict: '严格', soft: '宽松' }[row.bait_rotate_mode] || '模式未取得';
  const stateText = !row.bait_enabled ? '规则未启用' : state?.enabled ? `读取时第 ${state.active + 1} 组 · 下次切换：${new Date(state.next_switch * 1000).toLocaleString()}` : state ? '未轮换' : '下次切换未取得';
  return h('details', {}, h('summary', {}, `轮换 ${groups.length} 组 · ${mode} · ${stateText}`), hint(txt),
    hint(`间隔 ${row.bait_rotate_sec} 秒`), ...groups.map((g, i) => hint(`第 ${i + 1} 组：${g.join('、')}`)));
}

function fishView(cfg, baitByKey, scope) {
  const fish = cfg.fish.map((f) => ({ ...f }));
  const s = cfg.setting || {};
  const form = new Form();
  const original = new Map(cfg.fish.map(f => [f.fish_key, f]));
  const changed = f => { const old = original.get(f.fish_key); return !old || old.enabled !== f.enabled || old.weight !== f.weight; };
  const isDirty = () => form.isDirty();
  const bar = h('div', { class: 'savebar', role: 'status' });
  savebar(form, { inline: bar, effect:'本水域名册和咬钩设置立即生效。',
    onSave: async () => {
      if (!form.validate([...form.fields.keys()])) throw new Error('请检查咬钩参数');
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
  const matching = () => fish.filter(f => !q || `${f.fish_key} ${f.name_zh}`.toLowerCase().includes(q));
  const bulk = [true, false].map(enabled => btn('', () => { matching().forEach(f => { f.enabled = enabled; }); touch(); draw(); }, 'ghost sm'));
  const draw = () => {
    const sum = total();
    const rows = matching();
    bulk.forEach((b, i) => { b.textContent = `${i ? '停用' : '启用'}${q ? '匹配' : '全部'} ${rows.length} 种`; b.disabled = !rows.length; });
    tbody.replaceChildren(...(rows.length ? rows.map((f) => {
      const on = h('input', { type: 'checkbox', 'aria-label': '启用 ' + f.name_zh, onchange: (e) => { f.enabled = e.target.checked; touch(); draw(); } });
      on.checked = !!f.enabled;
      const w = h('input', { class: 'input num', 'aria-label': f.name_zh + '权重', style: { width: '90px', height: '30px' }, value: f.weight, onchange: (e) => {
        const raw = e.target.value.trim(), n = Number(raw);
        if (!raw || !Number.isFinite(n) || n < 0) { e.target.value = f.weight; toast('权重必须为非负数，已保留原值', 'bad'); return; }
        f.weight = n; touch(); draw();
      } });
      const pct = f.enabled && Number(f.weight) > 0 ? (Number(f.weight) / sum * 100) : 0;
      return h('tr', { style: { opacity: f.enabled ? 1 : 0.5 } },
        h('td', {}, on),
        h('td', {}, h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, fishIcon(f.fish_key, 42),
          h('div', { style: { minWidth: 0 } }, h('b', { text: f.name_zh }), h('div', { class: 'mono', style: { fontSize: '11.6px', color: 'var(--muted)' }, text: f.fish_key }),
            baitLine(f, baitByKey[f.fish_key])))),
        h('td', {}, w, h('span', { class: 'sub', text: '默认 ' + f.base_weight })),
        h('td', { style: { width: '148px' } }, h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'nowrap' } },
          h('div', { style: { flex: '0 0 84px', height: '6px', borderRadius: '3px', background: 'var(--line-soft)', overflow: 'hidden' } }, h('div', { style: { width: Math.min(100, pct) + '%', height: '100%', background: 'var(--accent)' } })),
          h('span', { class: 'hint', style: { width: '46px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }, text: pct ? pct.toFixed(1) + '%' : '—' }))),
        h('td', {}, badge(({ official: '周档统计', manual: '人工覆盖', static: '静态' })[f.weight_source] || (original.has(f.fish_key) ? '未取得' : '新增')), changed(f) ? badge('未保存', 'warn') : null));
    }) : [h('tr', {}, h('td', { colspan: 5 }, empty(fish.length ? '没有匹配的鱼' : '鱼种名册为空')))]));
  };
  draw();

  const params = h('div', {},
    form.row({ key: 'bite_probability', label: '每次抛竿有鱼的概率', help: '1 表示每竿必有鱼咬。', kind: 'float', min: 0, max: 1, def: '1' }, s.bite_probability),
    form.row({ key: 'bite_delay_scale', label: '咬钩速度', help: '0.5 = 快一倍，2 = 慢一倍。', kind: 'float', min: 0, unit: '倍', def: '1' }, s.bite_delay_scale),
    form.row({ key: 'bite_delay_max', label: '最长等待', help: '普通钓法等这么久一定有鱼咬。', kind: 'float', min: 1, unit: '秒', def: '20' }, s.bite_delay_max),
    form.row({ key: 'bite_delay_lure_max', label: '路亚最长等待', kind: 'float', min: 0.5, unit: '秒', def: '6' }, s.bite_delay_lure_max),
    form.row({ key: 'bite_delay_fixed', label: '固定咬钩时间', help: '0 表示随机；填了数字后每次都在这个时间咬钩。', kind: 'float', min: 0, unit: '秒', def: '0' }, s.bite_delay_fixed));

  const editor = h('div', { class: 'stack' }, bar,
    h('details', { class: 'advanced', style: { borderTop: 0, marginTop: '-6px' } }, h('summary', {}, '这个水域的咬钩快慢 ', h('small', { text: `（现在：${Number(s.bite_delay_fixed) > 0 ? '固定 ' + s.bite_delay_fixed + ' 秒' : '最长 ' + s.bite_delay_max + ' 秒'}）` })), params),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', margin: '0 0 10px' } },
      h('div', { style: { flex: '1 1 200px', minWidth: '150px', maxWidth: '320px' } }, searchBox('筛选鱼名', (v) => { q = v.toLowerCase(); draw(); })),
      ...bulk,
      btn('恢复默认', async () => {
        if (!(await confirmDialog({ title: `把「${cfg.area}」恢复默认？`, desc: '立即清除此水域的咬钩设置和人工鱼种权重，并放弃本页草稿。有周档基线时恢复周档，否则使用静态权重。', confirm: '恢复默认', danger: true }))) return;
        try { await post('/api/fish/config/reset', { area: cfg.area }); toast('已恢复默认，立即生效'); if (tbody.isConnected) render(); } catch (e) { toast(errText(e), 'bad'); }
      }, 'ghost sm'),
      btn('添加鱼种', () => addFish(fish, () => { touch(); draw(); }), 'sm', { icon: 'plus' })),
    h('p', { class: 'muted small', text: '「权重」决定这种鱼出现的多少：权重越大越常见，右边的百分比是换算后的占比。关闭或权重填 0 表示这里不出这种鱼。' }),
    h('div', { class: 'tbl', style: { maxHeight: 'calc(100vh - 360px)', overflow: 'auto' } }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: '出现' }), h('th', { text: '鱼' }), h('th', { class: 'num', text: '权重' }), h('th', { class: 'num', text: '占比' }), h('th', { text: '已保存来源' }))), tbody)));
  return editor;
}

function addFish(fish, done) {
  const results = h('div', { class: 'card', style: { maxHeight: '400px', overflow: 'auto' } }, empty('输入鱼名开始搜索'));
  const search = debounce(async (q) => {
    const list = await apiList('/api/fish/pool?limit=80&q=' + encodeURIComponent(q)).catch(() => []);
    results.replaceChildren(list.length ? h('div', { class: 'list' }, list.map((x) => {
      const has = fish.some((f) => f.fish_key === x.fish_key);
      return h('div', { class: 'list-item' + (has ? '' : ' clickable'), style: { opacity: has ? 0.5 : 1 }, onclick: has ? null : () => {
        fish.push({ fish_key: x.fish_key, name_zh: x.name_zh, base_weight: 0, weight: 1, enabled: true, has_override: true });
        close(); done(); toast(`已加入「${x.name_zh}」，记得保存`);
      } }, fishIcon(x.fish_key), h('div', { class: 'grow' }, h('div', { class: 'title', text: x.name_zh }), h('div', { class: 'sub mono', text: x.fish_key })),
      has ? badge('已在名单里') : h('span', { class: 'muted small', text: `${fmt(x.min_g)}–${fmt(x.max_g)} g` }));
    })) : empty('没有找到'));
  }, 250);
  const { close } = sidePage({ title: '添加鱼种', body: h('div', { class: 'stack' }, searchBox('输入鱼名，如 狗鱼', search), results) });
}
