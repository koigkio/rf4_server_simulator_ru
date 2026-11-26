// 跨页面复用的业务组件
import { h, api, apiList, sidePage, debounce, icon, webURL, empty, loading, errText } from './core.js';

export function itemIcon(id, size = 36) {
  const img = h('img', {
    src: webURL('/icons/items/' + encodeURIComponent(String(id || '').toLowerCase()) + '.webp'),
    alt: '', loading: 'lazy', width: size, height: size,
    style: { width: size + 'px', height: size + 'px', objectFit: 'contain', borderRadius: '6px', background: 'var(--surface-2)', border: '1px solid var(--line)', flex: 'none' },
  });
  img.onerror = () => { img.style.display = 'none'; };
  return img;
}

// 物品挑选：搜索 + 分类筛选，选中后回调 {item_id, name}
export function pickItem({ title = 'Выберите предмет', completeOnly = false, onPick }) {
  const results = h('div', { class: 'card', style: { maxHeight: '420px', overflow: 'auto', marginTop: '12px' } }, empty('Начните вводить название'));
  const input = h('input', { class: 'input', placeholder: 'Введите название или ID предмета, например червь,Simmons' });
  const group = h('select', { class: 'select', style: { width: '170px' } }, h('option', { value: '', text: 'Все категории' }));
  let seq = 0;
  const search = async () => {
    const q = input.value.trim();
    if (!q && !group.value) { results.replaceChildren(empty('Начните вводить название')); return; }
    const my = ++seq;
    results.replaceChildren(h('div', { style: { padding: '14px' } }, loading(3)));
    try {
      const qs = new URLSearchParams({ q, limit: '80' });
      if (completeOnly) qs.set('complete_only', '1');
      if (group.value) qs.set('group', group.value);
      const list = await apiList('/api/catalog/items?' + qs);
      if (my !== seq) return;
      results.replaceChildren(list.length ? h('div', { class: 'list' }, list.map((x) => h('button', {type:'button',
        class: 'list-item clickable', onclick: () => { close(); onPick({ item_id: x.item_id, name: x.name || x.item_id }); },
      }, itemIcon(x.item_id), h('div', { class: 'grow' }, h('div', { class: 'title', text: x.name || x.item_id }), h('div', { class: 'sub mono', text: x.item_id })),
      h('span', { class: 'muted small', text: x.group || x.kind || '' })))) : empty('Ничего не найдено', 'Попробуйте другое ключевое слово.'));
    } catch (e) { results.replaceChildren(empty('Ошибка поиска', errText(e))); }
  };
  const run = debounce(search, 250);
  input.addEventListener('input', run);
  group.addEventListener('change', search);
  api('/api/catalog/groups' + (completeOnly ? '?complete_only=1' : '')).then((gs) => {
    for (const g of (Array.isArray(gs) ? gs : gs.groups || [])) group.append(h('option', { value: g.key, text: (g.name || g.key) + (g.count ? ` (${g.count})` : '') }));
  }).catch(() => {});
  const { close } = sidePage({ title, body: h('div', {}, h('div', { class: 'row' }, h('div', { class: 'grow search' }, icon('search'), input), group), results) });
}
