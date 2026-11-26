// 商店：货架价格 / 库存。结构照演示页——hero + 二级页签 + 两栏（左表格右信息块）。
import { h, apiList, post, errText, pageHead, work, ib, h2s, h3s, hint, kv, pill, empty, btn, confirmDialog, replaceHash, pushHash, setCrumbTail } from '../core.js';

const plain = (c) => String(c / 100);
const effective = (x) => `${plain(x.silver)} сер. / ${plain(x.gold)} зол. / ${x.stock} шт.`;

const STORE_KIND = [
  [/^fishing_?store/, 'Рыболовный магазин'], [/^food_?store/, 'Продуктовый магазин'], [/^tool_store/, 'Магазин инструментов'], [/^workshop/, 'Мастерская'], [/^boatstation/, 'Лодочная станция'],
  [/^atm/, 'Банкомат'], [/^admin/, 'Магазин водоёма'], [/^monkeycola/, 'Автомат с напитками'], [/^ny_?ba+za+r/i, 'Новогодняя ярмарка'], [/^cafestore/, 'Кафе'],
  [/^bakery/, 'Пекарня'], [/^craft_baits/, 'Изготовление насадок'], [/^craft_lures/, 'Изготовление приманок'], [/^farmstore/, 'Фермерский магазин'], [/^fishstore/, 'Рыбная лавка'],
  [/^housestore/, 'Магазин для дома'], [/^milkstore/, 'Молочная лавка'], [/^sawmill/, 'Лесопилка'], [/^mill/, 'Мельница'], [/^paseka/, 'Пасека'],
  [/^rentbike/, 'Прокат машин'], [/^tours/, 'Турагентство'], [/^arbuz/, 'Арбузный ларёк'],
];
const storeKind = (id) => (STORE_KIND.find(([re]) => re.test(id)) || [null, id])[1];

// 物品类别：真服 item_id 前缀本身就带品类，按前缀读，不猜。
const ITEM_KIND = [
  [/^rod_/, 'Удилища'], [/^reel_/, 'Катушки'], [/^line_/, 'Леска'], [/^bait_boil/, 'Наживка'], [/^bait_/, 'Наживка'],
  [/^lure_/, 'Приманки'], [/^hook_/, 'Крючок'], [/^float_/, 'Поплавки'], [/^feeder/, 'Кормушки'], [/^container/, 'Ёмкости'], [/^food_/, 'Еда'],
  [/^papermap|^map_/, 'Карты'], [/^spare_/, 'Запчасти'], [/^tool_/, 'Инструменты'],
];
const itemKind = (id) => (ITEM_KIND.find(([re]) => re.test(id || '')) || [null, ''])[1];

const tabs = { price: 'Цена на полке', stock: 'Наличие' };
const units = { silver: 'сер.', gold: 'зол.', stock: 'шт.' };
const fieldName = { silver: 'Цена в серебре', gold: 'Цена в золоте', stock: 'Наличие' };
const LIMIT = 2000; // ListAdminStoreItems 先按 q 过滤, 再截取 limit; 没有 offset. 
const storeLabel = (s) => (s.map_key || s.store_id).replace(/^level_\d+_?/, '') || s.map_key;
const label = (x) => `${x.name || x.item_id} (${x.item_id})`;

export default function shop(params, scope) {
  // 旧控件曾把「店/页签」当成一个参数编码。
  if (params.length === 1 && /\/(price|stock)$/.test(params[0])) params = params[0].split('/');
  const tabOnly = params.length === 1 && Object.hasOwn(tabs, params[0]);
  let tab = (tabOnly ? params[0] : params[1]) === 'stock' ? 'stock' : 'price';
  let storeId = tabOnly ? '' : params[0]; // 默认店一旦选定, 就不能在刷新时换成另一家. 
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
    if (!x) throw new Error('Товар не получен, сверить нельзя');
    return x;
  };
  function follow(e, action) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault(); action();
  }
  function selectStore(id) {
    if (busy || !id || id === storeId) return;
    if (drafts.size && !window.confirm('При смене магазина несохранённые изменения будут потеряны. Переключить?')) return;
    drafts.clear(); storeId = id; cur = stores.find(s => s.store_id === id);
    report.textContent = ''; shown = 50;
    pushHash(hash(id, tab)); syncNavigation(); drawAside(); reload();
  }
  const waterSelect = h('select', { 'aria-label': 'Найти магазин по водоёму', onchange: e => {
    water = e.target.value;
    if (storeId) replaceHash(hash(storeId, tab));
    syncStores(); syncNavigation();
  } });
  const storeSelect = h('select', { id: 'storeSel', onchange: e => {
    const id = e.target.value; e.target.value = cur?.store_id || ''; selectStore(id);
  } });
  const picker = h('div', { class:'storebar' }, h('label', {}, 'Водоём ', waterSelect), h('label', {}, ' Текущий магазин ', storeSelect));
  function syncStores() {
    const options = stores.filter(s => !water || s.map_key === water);
    waterSelect.replaceChildren(h('option', {value:''}, 'Все водоёмы'), ...[...new Set(stores.map(s => s.map_key).filter(Boolean))].sort().map(k => h('option', {value:k}, k)));
    waterSelect.value = water;
    storeSelect.replaceChildren(h('option', {value:''}, 'Выберите магазин'),
      ...(cur && !options.includes(cur) ? [h('option', {value:cur.store_id}, `${cur.store_id}(редактируется сейчас, не на выбранном водоёме)`)] : []),
      ...options.map(s => h('option', {value:s.store_id}, `${storeKind(s.store_id)} · ${storeLabel(s)} · ${s.store_id}`)));
    listSlot.replaceChildren(storesBlock());
  }
  function storesBlock() {
    const rows = stores.filter(s => !water || s.map_key === water);
    return h('div', {}, h3s(`Список магазинов (${rows.length} )`), h('div', { class: 'tbl shops' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Магазин', 'Водоём', 'Товар', 'Переопределение'].map(t => h('th', {}, t)))),
      h('tbody', {}, rows.map(s => h('tr', { dataset:{store:s.store_id}, onclick: e => { if (!e.target.closest('a')) selectStore(s.store_id); } },
        h('td', {}, h('a', { href: hash(s.store_id, tab), onclick:e => follow(e, () => selectStore(s.store_id)) }, s.store_id)),
        h('td', {}, storeLabel(s)), h('td', {}, s.item_count), h('td', {}, s.override_count)))))));
  }

  const save = btn('Проверить и сохранить', () => write(), 'primary');
  function syncSave() {
    save.disabled = busy || loading || !!error || !drafts.size;
    save.textContent = drafts.size ? `Проверить и сохранить (${drafts.size} шт.)` : 'Проверить и сохранить';
  }
  const display = (field, n) => field === 'stock' ? String(n) : plain(n);
  function cell(x, field) {
    const id = x.item_id, original = x.has_override ? display(field, x[field]) : '';
    const input = h('input', { class: 'input num', type: 'number', min: 0, step: field === 'stock' ? 1 : '0.01',
      'aria-label': `${x.name || id}: переопределение — ${fieldName[field]}`, value: drafts.get(id)?.fields[field]?.raw ?? original,
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
    return h('div', {}, hint(`Показано по этому запросу ${Math.min(shown, rows.length)} / ${rows.length} шт.` + (items.length === LIMIT ? `; сервер возвращает не более ${LIMIT} шт., уточните поиск товаров.` : '')),
      h('div', { class: 'tbl shop' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Товар', 'Базовое значение', price ? 'Своя цена' : 'Своё наличие', 'Действует сейчас', 'Действия'].map(t => h('th', {}, t)))),
        h('tbody', {}, rows.slice(0, shown).map(x => h('tr', {},
          h('td', {}, h('b', {}, x.name || x.item_id), h('div', { class: 'mono' }, x.item_id), itemKind(x.item_id)),
          h('td', { class: 'num' }, price ? `${plain(x.base_silver)} сер. / ${plain(x.base_gold)} зол.` : `${x.base_stock} шт.`),
          h('td', { class: 'num' }, price ? [cell(x, 'silver'), cell(x, 'gold')] : cell(x, 'stock')),
          h('td', {}, pill(x.has_override ? 'Переопределение' : 'По умолчанию', x.has_override ? 'ok' : ''), h('div', {}, effective(x))),
          h('td', {}, x.has_override ? btn('Сбросить цену', () => write(x), 'ghost') : '—')))))),
      !rows.length ? empty('Нет подходящих товаров') : null,
      rows.length > shown ? btn('Показать ещё', () => { shown += 50; drawShelf(); }, 'ghost') : null);
  }

  async function write(resetItem) {
    if (!active || busy || loading || error) return;
    const batch = resetItem ? [[resetItem.item_id, { name: label(resetItem) }]] : [...drafts];
    if (!batch.length) return;
    if (!resetItem && batch.some(([,d]) => Object.entries(d.fields).some(([k,v]) => !v.valid || (v.raw !== '' && !Number.isSafeInteger(Math.round(Number(v.raw) * (k === 'stock' ? 1 : 100))))))) {
      report.textContent = 'Есть неверные значения: наличие — целое неотрицательное число, цена — не более двух знаков после запятой.'; return;
    }
    busy = true; body.inert = true;
    try {
      const ok = await confirmDialog({ title: resetItem ? `Сбросить переопределение «${label(resetItem)}» целиком?` : `Сохранить ${batch.length} товаров?`,
        desc: `${cur.store_id}: ` + (resetItem ? 'Одновременно сбрасываются цена в серебре, в золоте и наличие, черновик этого товара отменяется. Остальные товары не меняются.'
          : batch.map(([,d]) => d.name + ': ' + Object.entries(d.fields).map(([k,v]) => `${fieldName[k]} ${v.raw === '' ? 'Взять текущее базовое значение' : v.raw + units[k]}`).join(', ')).join('; ') + '. Сохраняется целиком: непрошедшие правку поля берут текущее действующее значение; наследование отдельных полей не поддерживается.'),
        confirm: resetItem ? 'Сбросить' : 'Сохранить' });
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
          try { const x = await readItem(id); saved.push(`${draft.name}: ${effective(x)} (${x.has_override ? 'Переопределение' : 'По умолчанию'})`); }
          catch (e) { saved.push(`${draft.name}: записано, но перечитать не удалось (${errText(e)})`); }
        } catch (e) { failed.push(`${draft.name}: ${errText(e)}`); }
      }
      report.textContent = [saved.length && 'Успешно: ' + saved.join('; ') + ' (применено сразу)', failed.length && 'Ожидают повтора: ' + failed.join('; ')].filter(Boolean).join('. ');
      if (active) await reload(true);
    } finally { busy = false; body.inert = !active; syncSave(); }
  }

  const heading = h2s(tabs[tab]), shelf = h('div'), listSlot = h('div');
  const progress = h('span', {class:'hint', role:'status'});
  const search = h('input', {type:'search', 'aria-label':'Поиск по названию товара или ID', placeholder:'Название товара или ID'});
  const form = h('form', {class:'actions shop-filters', onsubmit:e => {
    e.preventDefault(); if (busy || !cur) return;
    query = search.value.trim(); shown = 50; reload();
  }}, search, h('button', {class:'ghost', type:'submit'}, 'Найти'),
    h('label', {}, h('input', {type:'checkbox', onchange:e => { changedOnly = e.target.checked; shown = 50; reload(); }}), 'Только изменённые'),
    btn('Обновить', () => { if (!busy && !loading) reload(true); }, 'ghost'), progress);
  const footer = h('footer', {class:'actions'}, hint('Цены и наличие применяются сразу после сохранения.'),
    btn('Отменить изменения', () => { drafts.clear(); report.textContent = ''; drawShelf(); }, 'ghost'), save);
  const links = Object.entries(tabs).map(([k,t]) => h('a', {href:hash(storeId,k), dataset:{tab:k}, onclick:e => follow(e, () => {
    if (busy || k === tab) return;
    tab = k; pushHash(hash(storeId,tab)); setCrumbTail(t); syncNavigation();
    if (!loading) drawShelf();
  })}, t));
  tabBar.append(h('nav', {class:'tabs','aria-label':'Подкатегория'}, links));
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
    shelf.replaceChildren(error ? h('div', {role:'alert'}, empty('Ошибка чтения', error), btn('Прочитать снова', () => reload(true), 'ghost')) : cur ? table() : empty('Выберите существующий магазин', storeId ? `Магазин не найден: ${storeId}` : 'Незарегистрированный магазин'));
    syncSave();
  }
  function drawAside() {
    aside.replaceChildren(ib('Редактируется', cur ? `${storeKind(cur.store_id)} · ${storeLabel(cur)}` : 'Магазин не выбран', kv([['Магазин ID', cur?.store_id || '—'], ['Позиции на полке', cur?.item_count ?? '—'], ['Переопределение целиком', cur?.override_count ?? '—']]),
      hint('Без переопределения действуют значения по умолчанию. При сохранении любого поля записываются сразу цена в серебре, в золоте и наличие; очищенное поле берёт текущее базовое значение и не следует за его изменениями. Чтобы снова наследовать, сбросьте товар целиком.'),
      hint('0 — это явное переопределение. При наличии 0 сервер пополняет до 1000 шт.; ориентируйтесь на перечитанное значение.')));
  }

  async function reload(refreshStores = false) {
    const id = ++generation;
    loading = true; error = ''; shelf.inert = true; shelf.setAttribute('aria-busy','true');
    progress.textContent = 'Чтение полки…'; syncSave();
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
  syncNavigation(); shelf.append(empty('Загрузка…'));
  reload();
  return [pageHead('Магазин и склад', 'Просмотр и настройка цен и наличия по магазинам.', { facts: [['Область действия', 'Текущий магазин'], ['Что сбрасывается', 'Товар целиком']] }), tabBar, work(body, aside)];
}
