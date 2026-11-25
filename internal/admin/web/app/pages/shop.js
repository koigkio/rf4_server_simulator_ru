// 商店：货架价格 / 库存。结构照演示页——hero + 二级页签 + 两栏（左表格右信息块）。
import { h, apiList, post, errText, pageHead, work, ib, h2s, h3s, hint, kv, pill, empty, btn, confirmDialog, replaceHash, pushHash, setCrumbTail } from '../core.js';

const plain = (c) => String(c / 100);
const effective = (x) => `${plain(x.silver)} 银 / ${plain(x.gold)} 金 / ${x.stock} 件`;

const STORE_KIND = [
  [/^fishing_?store/, '渔具店'], [/^food_?store/, '食品店'], [/^tool_store/, '工具店'], [/^workshop/, '工坊'], [/^boatstation/, '船坞'],
  [/^atm/, '取款机'], [/^admin/, '水域商店'], [/^monkeycola/, '饮料售货机'], [/^ny_?ba+za+r/i, '新年集市'], [/^cafestore/, '咖啡馆'],
  [/^bakery/, '面包店'], [/^craft_baits/, '饵料制作'], [/^craft_lures/, '拟饵制作'], [/^farmstore/, '农场商店'], [/^fishstore/, '鱼店'],
  [/^housestore/, '房屋商店'], [/^milkstore/, '乳品店'], [/^sawmill/, '锯木厂'], [/^mill/, '磨坊'], [/^paseka/, '养蜂场'],
  [/^rentbike/, '租车'], [/^tours/, '旅行社'], [/^arbuz/, '西瓜摊'],
];
const storeKind = (id) => (STORE_KIND.find(([re]) => re.test(id)) || [null, id])[1];

// 物品类别：真服 item_id 前缀本身就带品类，按前缀读，不猜。
const ITEM_KIND = [
  [/^rod_/, '鱼竿'], [/^reel_/, '渔线轮'], [/^line_/, '鱼线'], [/^bait_boil/, '饵料'], [/^bait_/, '饵料'],
  [/^lure_/, '拟饵'], [/^hook_/, '鱼钩'], [/^float_/, '浮漂'], [/^feeder/, '喂食器'], [/^container/, '容器'], [/^food_/, '食品'],
  [/^papermap|^map_/, '地图'], [/^spare_/, '备件'], [/^tool_/, '工具'],
];
const itemKind = (id) => (ITEM_KIND.find(([re]) => re.test(id || '')) || [null, ''])[1];

const tabs = { price: '货架价格', stock: '库存' };
const units = { silver: '银', gold: '金', stock: '件' };
const fieldName = { silver: '银价', gold: '金币价', stock: '库存' };
const LIMIT = 2000; // ListAdminStoreItems 先按 q 过滤，再截取 limit；没有 offset。
const storeLabel = (s) => (s.map_key || s.store_id).replace(/^level_\d+_?/, '') || s.map_key;
const label = (x) => `${x.name || x.item_id}（${x.item_id}）`;

export default function shop(params, scope) {
  // 旧控件曾把「店/页签」当成一个参数编码。
  if (params.length === 1 && /\/(price|stock)$/.test(params[0])) params = params[0].split('/');
  const tabOnly = params.length === 1 && Object.hasOwn(tabs, params[0]);
  let tab = (tabOnly ? params[0] : params[1]) === 'stock' ? 'stock' : 'price';
  let storeId = tabOnly ? '' : params[0]; // 默认店一旦选定，就不能在刷新时换成另一家。
  setCrumbTail(tabs[tab]);
  let stores = [], cur, items = [], query = '', water = params[2] || '', changedOnly = false, shown = 50;
  const hash = (id, tabKey) => '#shop/' + [id, tabKey, water].filter(Boolean).map(encodeURIComponent).join('/');
  let active = true, busy = false, loading = true, error = '';
  let generation = 0;
  // 每份草稿绑定本页的店和商品，不从当前表格位置或可见行反推写入目标。
  const drafts = new Map();
  const body = h('div'), aside = h('div'), tabBar = h('div', { id: 'tabs' });
  const report = h('p', { role: 'status', 'aria-live': 'polite' });
  scope.setLeaveGuard(() => busy || drafts.size > 0);
  scope.setPageCleanup(() => { active = false; body.inert = true; });

  const readItems = (q, filtered = false) => apiList('/api/stores/items?' + new URLSearchParams({ store_id: cur.store_id, q, limit: LIMIT, ...(filtered ? {overrides_only:'1'} : {}) }));
  const readItem = async (id) => {
    const x = (await readItems(id)).find(x => x.store_id === cur.store_id && x.item_id === id);
    if (!x) throw new Error('未取得该商品，无法核对');
    return x;
  };
  function follow(e, action) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault(); action();
  }
  function selectStore(id) {
    if (busy || !id || id === storeId) return;
    if (drafts.size && !window.confirm('切换店铺会放弃未保存的修改，确定切换吗？')) return;
    drafts.clear(); storeId = id; cur = stores.find(s => s.store_id === id);
    report.textContent = ''; shown = 50;
    pushHash(hash(id, tab)); syncNavigation(); drawAside(); reload();
  }
  const waterSelect = h('select', { 'aria-label': '按水域定位店铺', onchange: e => {
    water = e.target.value;
    if (storeId) replaceHash(hash(storeId, tab));
    syncStores(); syncNavigation();
  } });
  const storeSelect = h('select', { id: 'storeSel', onchange: e => {
    const id = e.target.value; e.target.value = cur?.store_id || ''; selectStore(id);
  } });
  const picker = h('div', { class:'storebar' }, h('label', {}, '水域 ', waterSelect), h('label', {}, ' 当前商店 ', storeSelect));
  function syncStores() {
    const options = stores.filter(s => !water || s.map_key === water);
    waterSelect.replaceChildren(h('option', {value:''}, '全部水域'), ...[...new Set(stores.map(s => s.map_key).filter(Boolean))].sort().map(k => h('option', {value:k}, k)));
    waterSelect.value = water;
    storeSelect.replaceChildren(h('option', {value:''}, '请选择店铺'),
      ...(cur && !options.includes(cur) ? [h('option', {value:cur.store_id}, `${cur.store_id}（当前编辑，不在所选水域）`)] : []),
      ...options.map(s => h('option', {value:s.store_id}, `${storeKind(s.store_id)} · ${storeLabel(s)} · ${s.store_id}`)));
    listSlot.replaceChildren(storesBlock());
  }
  function storesBlock() {
    const rows = stores.filter(s => !water || s.map_key === water);
    return h('div', {}, h3s(`店铺列表（${rows.length} 家）`), h('div', { class: 'tbl shops' }, h('table', {},
      h('thead', {}, h('tr', {}, ['店铺', '水域', '商品', '覆盖'].map(t => h('th', {}, t)))),
      h('tbody', {}, rows.map(s => h('tr', { dataset:{store:s.store_id}, onclick: e => { if (!e.target.closest('a')) selectStore(s.store_id); } },
        h('td', {}, h('a', { href: hash(s.store_id, tab), onclick:e => follow(e, () => selectStore(s.store_id)) }, s.store_id)),
        h('td', {}, storeLabel(s)), h('td', {}, s.item_count), h('td', {}, s.override_count)))))));
  }

  const save = btn('核对并保存', () => write(), 'primary');
  function syncSave() {
    save.disabled = busy || loading || !!error || !drafts.size;
    save.textContent = drafts.size ? `核对并保存（${drafts.size} 件）` : '核对并保存';
  }
  const display = (field, n) => field === 'stock' ? String(n) : plain(n);
  function cell(x, field) {
    const id = x.item_id, original = x.has_override ? display(field, x[field]) : '';
    const input = h('input', { class: 'input num', type: 'number', min: 0, step: field === 'stock' ? 1 : '0.01',
      'aria-label': `${x.name || id}覆盖${fieldName[field]}`, value: drafts.get(id)?.fields[field]?.raw ?? original,
      placeholder: display(field, x['base_' + field]), oninput: () => {
        const draft = drafts.get(id) || { name: label(x), fields: {} };
        if (input.validity.valid && input.value === original) delete draft.fields[field];
        else draft.fields[field] = { raw: input.value, valid: input.validity.valid };
        if (Object.keys(draft.fields).length) drafts.set(id, draft); else drafts.delete(id);
        syncSave();
      } });
    return h('span', { class: 'unit' }, input, h('i', {}, units[field]));
  }
  function table() {
    const rows = items, price = tab === 'price';
    return h('div', {}, hint(`本次查询显示 ${Math.min(shown, rows.length)} / ${rows.length} 件` + (items.length === LIMIT ? `；接口最多返回 ${LIMIT} 件，请缩小商品搜索范围。` : '')),
      h('div', { class: 'tbl shop' }, h('table', {},
        h('thead', {}, h('tr', {}, ['商品', '基础值', price ? '覆盖价格' : '覆盖库存', '当前生效', '操作'].map(t => h('th', {}, t)))),
        h('tbody', {}, rows.slice(0, shown).map(x => h('tr', {},
          h('td', {}, h('b', {}, x.name || x.item_id), h('div', { class: 'mono' }, x.item_id), itemKind(x.item_id)),
          h('td', { class: 'num' }, price ? `${plain(x.base_silver)} 银 / ${plain(x.base_gold)} 金` : `${x.base_stock} 件`),
          h('td', { class: 'num' }, price ? [cell(x, 'silver'), cell(x, 'gold')] : cell(x, 'stock')),
          h('td', {}, pill(x.has_override ? '覆盖' : '默认', x.has_override ? 'ok' : ''), h('div', {}, effective(x))),
          h('td', {}, x.has_override ? btn('恢复默认', () => write(x), 'ghost') : '—')))))),
      !rows.length ? empty('没有匹配的商品') : null,
      rows.length > shown ? btn('显示更多', () => { shown += 50; drawShelf(); }, 'ghost') : null);
  }

  async function write(resetItem) {
    if (!active || busy || loading || error) return;
    const batch = resetItem ? [[resetItem.item_id, { name: label(resetItem) }]] : [...drafts];
    if (!batch.length) return;
    if (!resetItem && batch.some(([,d]) => Object.entries(d.fields).some(([k,v]) => !v.valid || (v.raw !== '' && !Number.isSafeInteger(Math.round(Number(v.raw) * (k === 'stock' ? 1 : 100))))))) {
      report.textContent = '有无效数值：库存须为非负整数，价格最多两位小数。'; return;
    }
    busy = true; body.inert = true;
    try {
      const ok = await confirmDialog({ title: resetItem ? `恢复「${label(resetItem)}」的整件覆盖？` : `保存 ${batch.length} 件商品？`,
        desc: `${cur.store_id}：` + (resetItem ? '同时恢复银价、金币价和库存，并放弃这件商品的草稿。其他商品不变。'
          : batch.map(([,d]) => d.name + '：' + Object.entries(d.fields).map(([k,v]) => `${fieldName[k]} ${v.raw === '' ? '取当前基础值' : v.raw + units[k]}`).join('、')).join('；') + '。按整件保存，未编辑项取当前生效值，不支持单项动态继承。'),
        confirm: resetItem ? '恢复' : '保存' });
      if (!ok || !active) return;
      const saved = [], failed = [];
      for (const [id, draft] of batch) {
        if (!active) break;
        const target = { store_id: cur.store_id, item_id: id };
        try {
          if (resetItem) await post('/api/stores/items/reset', target);
          else {
            // 接口只能写整行。核对同店同 ID 的最新生效值，不能从可见表格补 0。
            const x = await readItem(id);
            if (!active) break;
            for (const field of Object.keys(units)) {
              const edit = draft.fields[field];
              target[field] = !edit ? x[field] : edit.raw === '' ? x['base_' + field] : Math.round(Number(edit.raw) * (field === 'stock' ? 1 : 100));
            }
            await post('/api/stores/items/update', target);
          }
          drafts.delete(id);
          try { const x = await readItem(id); saved.push(`${draft.name}：${effective(x)}（${x.has_override ? '覆盖' : '默认'}）`); }
          catch (e) { saved.push(`${draft.name}：已写入，回读失败（${errText(e)}）`); }
        } catch (e) { failed.push(`${draft.name}：${errText(e)}`); }
      }
      report.textContent = [saved.length && '成功：' + saved.join('；') + '（立即生效）', failed.length && '待重试：' + failed.join('；')].filter(Boolean).join('。');
      if (active) await reload(true);
    } finally { busy = false; body.inert = !active; syncSave(); }
  }

  const heading = h2s(tabs[tab]), shelf = h('div'), listSlot = h('div');
  const progress = h('span', {class:'hint', role:'status'});
  const search = h('input', {type:'search', 'aria-label':'搜索商品名称或 ID', placeholder:'商品名称或 ID'});
  const form = h('form', {class:'actions shop-filters', onsubmit:e => {
    e.preventDefault(); if (busy || !cur) return;
    query = search.value.trim(); shown = 50; reload();
  }}, search, h('button', {class:'ghost', type:'submit'}, '查询'),
    h('label', {}, h('input', {type:'checkbox', onchange:e => { changedOnly = e.target.checked; shown = 50; reload(); }}), '只看改过的'),
    btn('刷新', () => { if (!busy && !loading) reload(true); }, 'ghost'), progress);
  const footer = h('footer', {class:'actions'}, hint('货架价格和库存保存后立即生效。'),
    btn('放弃修改', () => { drafts.clear(); report.textContent = ''; drawShelf(); }, 'ghost'), save);
  const links = Object.entries(tabs).map(([k,t]) => h('a', {href:hash(storeId,k), dataset:{tab:k}, onclick:e => follow(e, () => {
    if (busy || k === tab) return;
    tab = k; pushHash(hash(storeId,tab)); setCrumbTail(t); syncNavigation();
    if (!loading) drawShelf();
  })}, t));
  tabBar.append(h('nav', {class:'tabs','aria-label':'二级分类'}, links));
  body.append(heading, picker, form, report, shelf, footer, listSlot);
  function syncNavigation() {
    heading.textContent = tabs[tab]; storeSelect.value = cur?.store_id || '';
    for (const link of links) {
      link.href = hash(storeId,link.dataset.tab);
      if (link.dataset.tab === tab) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current');
    }
    for (const row of listSlot.querySelectorAll('tr[data-store]')) {
      row.classList.toggle('on', row.dataset.store === storeId); row.querySelector('a').href = hash(row.dataset.store,tab);
    }
    form.hidden = footer.hidden = !cur;
  }
  function drawShelf() {
    if (!active || loading) return;
    shelf.replaceChildren(error ? h('div', {role:'alert'}, empty('读取失败', error), btn('重试读取', () => reload(true), 'ghost')) : cur ? table() : empty('请选择有效店铺', storeId ? `找不到店铺：${storeId}` : '未登记店铺'));
    syncSave();
  }
  function drawAside() {
    aside.replaceChildren(ib('正在编辑', cur ? `${storeKind(cur.store_id)} · ${storeLabel(cur)}` : '未选择商店', kv([['店 ID', cur?.store_id || '—'], ['货架条目', cur?.item_count ?? '—'], ['整件覆盖', cur?.override_count ?? '—']]),
      hint('没有整件覆盖时按默认值。保存任一项会同时写入银价、金币价和库存；清空已填项取当前基础值，不会随基础值变化。要重新继承请恢复整件。'),
      hint('填 0 是显式覆盖。库存为 0 时服务端会补至 1000 件，以回读值为准。')));
  }

  async function reload(refreshStores = false) {
    const id = ++generation;
    loading = true; error = ''; shelf.inert = true; shelf.setAttribute('aria-busy','true');
    progress.textContent = '正在读取货架…'; syncSave();
    try {
      if (refreshStores || !stores.length) {
        const list = await apiList('/api/stores');
        if (!active || id !== generation) return;
        storeId ||= list[0]?.store_id;
        stores = list; cur = stores.find(s => s.store_id === storeId);
        if (water && !stores.some(s => s.map_key === water)) water = '';
        if (cur && location.hash !== hash(storeId, tab)) replaceHash(hash(storeId, tab));
        syncStores(); syncNavigation(); drawAside();
      }
      const result = cur ? await readItems(query, changedOnly) : [];
      if (active && id === generation) items = result;
    } catch (e) { if (active && id === generation) error = errText(e); }
    finally {
      if (active && id === generation) {
        loading = false; progress.textContent = ''; shelf.inert = false; shelf.removeAttribute('aria-busy'); drawShelf();
      }
    }
  }
  syncNavigation(); shelf.append(empty('读取中…'));
  reload();
  return [pageHead('商店与库存', '按商店查看、调整商品价格和库存。', { facts: [['作用范围', '当前商店'], ['恢复范围', '整件商品']] }), tabBar, work(body, aside)];
}
