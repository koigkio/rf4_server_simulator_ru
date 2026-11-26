// 发邮件：选人 → 写内容 → 加附件 → 发送。右边实时预览玩家看到的样子。
import { h, api, apiList, post, toast, errText, pageHead, work, ib, h2s, h3s, hint, kv, bullets, btn, empty, debounce, searchBox, badge, getToken, loginDialog, confirmDialog } from '../core.js';
import { itemIcon, pickItem } from '../widgets.js';

const TEMPLATES = [
  ['Компенсация', 'Компенсация от сервера', 'Приносим извинения за недавние неполадки сервера. В качестве компенсации — подарок во вложении.'],
  ['Награда за событие', 'Награда за событие', 'Спасибо за участие в событии! Награда приложена к письму.'],
  ['Приветствие', 'Добро пожаловать на рыбалку', 'Добро пожаловать на наш сервер! Желаем крупной рыбы.'],
];

export default async function mail(params, scope) {
  let to = null;
  const attach = [];
  let target = params[0] || '', targetError = '', expired = false, recipientQuery = '';
  const readTarget = async () => {
    if (!target || !getToken()) return;
    try { const p = await api('/api/players/detail?uid=' + encodeURIComponent(target), {preserveSession:true}); to = { uid: p.uid, name: p.name, level: p.level }; targetError = ''; }
    catch (e) { expired = e.status === 401; targetError = 'Не удалось прочитать получателя: ' + errText(e); }
  };
  await readTarget();
  if (!scope.isCurrent()) return [];
  const text = h('textarea', { class: 'textarea', rows: 9, placeholder: 'Текст для игрока. Можно отправить только вложения без текста.', oninput: () => preview() });
  scope.setLeaveGuard(() => !!(text.value.trim() || attach.length));

  // 收件人
  const toBox = h('div');
  const drawTo = () => {
    if (expired || !getToken()) { toBox.replaceChildren(hint(expired ? 'Сессия истекла, черновик письма сохранён.' : target ? `Сначала войдите, чтобы проверить получателя UID ${target}` : 'После входа можно искать игроков.'), btn('Вход в админ-панель', () => loginDialog(), 'primary')); return; }
    if (to) {
      toBox.replaceChildren(h('div', { class: 'row card', style: { padding: '10px 12px', background: 'var(--surface-2)' } },
        h('div', { class: 'avatar', text: (to.name || '?').slice(0, 1) }),
        h('div', { class: 'grow' }, h('b', { text: to.name }), h('div', { class: 'muted small', text: `UID ${to.uid}` + (to.level ? ` · ${to.level} ур.` : '') })),
        btn('Сменить', () => { target = ''; to = null; drawTo(); preview(); }, 'ghost sm')));
      return;
    }
    const results = h('div', { class: 'card', hidden: true, style: { marginTop: '6px', maxHeight: '240px', overflow: 'auto' } });
    const search = searchBox('Введите ник игрока или UID', debounce(async (q) => {
      if (!search.isConnected) return;
      recipientQuery = q;
      if (!q.trim()) { results.hidden = true; return; }
      let list;
      try { list = await apiList('/api/players?q=' + encodeURIComponent(q.trim()), {preserveSession:true}); }
      catch (e) {
        if (!search.isConnected || search.querySelector('input').value !== q) return;
        if (e.status === 401) { expired = true; drawTo(); return; }
        results.hidden = false; results.replaceChildren(empty('Ошибка поиска', errText(e))); return;
      }
      if (search.querySelector('input').value !== q) return;
      results.hidden = false;
      results.replaceChildren(list.length ? h('div', { class: 'list' }, list.slice(0, 20).map((p) => h('button', { type: 'button',
        class: 'list-item clickable', onclick: () => { to = { uid: p.uid, name: p.name, level: p.level }; target = String(p.uid); drawTo(); preview(); },
      }, h('div', { class: 'avatar', text: (p.name || '?').slice(0, 1) }), h('div', { class: 'grow' }, h('div', { class: 'title', text: p.name }), h('div', { class: 'sub', text: `UID ${p.uid} · ${p.level} ур.` })), p.online ? badge('Онлайн', 'ok', true) : null))) : empty('Ничего не найдено'));
    }, 250), recipientQuery);
    toBox.replaceChildren(...(targetError ? [hint(targetError)] : []), search, results);
    if (recipientQuery) search.querySelector('input').dispatchEvent(new Event('input'));
  };
  drawTo();
  const afterLogin = async () => { if (toBox.isConnected) { expired = false; await readTarget(); if (scope.isCurrent()) { drawTo(); preview(); } } };
  document.addEventListener('rf4:login', afterLogin);
  scope.setPageCleanup(() => document.removeEventListener('rf4:login', afterLogin));

  // 附件
  const attachBox = h('div');
  const drawAttach = () => {
    attachBox.replaceChildren(attach.length ? h('div', { class: 'card' }, h('div', { class: 'list' }, attach.map((a, i) => h('div', { class: 'list-item' },
      itemIcon(a.item_id), h('div', { class: 'grow' }, h('div', { class: 'title', text: a.name }), h('div', { class: 'sub mono', text: a.item_id })),
      h('label', { class: 'row small muted' }, 'Количество', h('input', { class: 'input num', type: 'number', min: 1, step: 1, style: { width: '80px', height: '30px' }, value: a.qty, oninput: e => { a.qty = e.target.value; preview(); } })),
      btn('', () => { attach.splice(i, 1); drawAttach(); preview(); }, 'ghost icon sm', { icon: 'x', 'aria-label': 'Убрать' }))))) : h('div', { class: 'muted small', text: 'Вложений нет.' }));
  };
  drawAttach();

  // 预览
  const pv = h('div');
  const recipient = h('span');
  function preview() {
    const lines = text.value.trim();
    recipient.textContent = to ? `${to.name} (UID ${to.uid})` : 'Не выбрано';
    pv.replaceChildren(h('div', { class: 'card', style: { padding: '18px', background: 'var(--surface-2)' } },
      h('div', { class: 'muted small', text: 'Получатель: ' + (to ? `${to.name} (UID ${to.uid})` : 'Не выбрано') }),
      h('div', { style: { margin: '12px 0', whiteSpace: 'pre-wrap', minHeight: '60px', color: lines ? 'var(--text)' : 'var(--faint)' }, text: lines || '(без текста)' }),
      attach.length ? h('div', { class: 'row', style: { gap: '10px', borderTop: '1px solid var(--line)', paddingTop: '12px' } }, attach.map((a) => h('div', { class: 'row', style: { gap: '6px' } }, itemIcon(a.item_id, 28), h('span', { class: 'small', text: `${a.name} ×${a.qty}` })))) : null));
  }
  preview();

  // 发送时会话过期：就地登录，收件人、正文和附件原样保留；登录后由管理员确认再发，不自动重放。
  const relogin = h('div', { class: 'row', role: 'alert', hidden: true, style: { gap: '8px', justifyContent: 'flex-end', margin: '14px 0 0' } },
    hint('Сессия истекла, письмо не отправлено. Получатель, текст и вложения сохранены — после входа нажмите «Отправить» ещё раз.'),
    btn('Вход в админ-панель', () => loginDialog({ onDone: () => { relogin.hidden = true; } }), 'ghost sm'));
  const send = btn('Отправить', async () => {
    if (expired || !getToken()) { loginDialog(); return; }
    relogin.hidden = true;
    if (!to) { toast('Сначала выберите получателя', 'bad'); return; }
    if (!text.value.trim() && !attach.length) { toast('Текст и вложения не могут быть одновременно пустыми', 'bad'); return; }
    if (attach.some(a => !/^\d+$/.test(String(a.qty)) || !Number.isSafeInteger(+a.qty) || +a.qty < 1)) { toast('Количество вложений должно быть положительным целым числом', 'bad'); return; }
    const payload = { uid: to.uid, text: text.value.trim(), items: attach.map(a => ({ item_id: a.item_id, qty: +a.qty })) };
    send.disabled = true;
    try {
      if (!(await confirmDialog({ title: `Отправить «${to.name}» (UID ${payload.uid})? `, desc: attach.length ? attach.map(a => `${a.name} ×${a.qty}`).join(', ') + '. Отправленное письмо нельзя отозвать.' : 'Отправленное письмо нельзя отозвать.', confirm: 'Отправить' }))) return;
      await post('/api/mail/send', payload);
      toast('Добавлено в очередь отправки');
      if (text.value.trim() === payload.text && JSON.stringify(attach.map(a => ({ item_id: a.item_id, qty: +a.qty }))) === JSON.stringify(payload.items)) { text.value = ''; attach.length = 0; drawAttach(); preview(); }
    } catch (e) {
      if (e.status === 401) { relogin.hidden = false; relogin.querySelector('button').focus(); }
      else toast('Ошибка отправки: ' + errText(e), 'bad');
    }
    finally { send.disabled = false; }
  }, 'primary lg', { icon: 'mail' });

  const aside = [
    ib('После отправки', null, bullets([
      'Доставку выполняет игровой сервис; постановка в очередь не означает доставку.',
      'Игрок получит письмо при следующем открытии почты.',
      'Предметы из вложения попадают в инвентарь, само письмо остаётся в почте.',
      'Отправленное письмо нельзя отозвать — сначала посмотрите предпросмотр.',
    ])),
    ib('История отправки', null, kv([['Пишется в аудит', 'Да'], ['Получатель', recipient]]),
      hint('Каждое письмо записывается в «Журнал аудита».')),
  ];
  return [
    pageHead('Почта', 'Отправьте игроку сообщение, можно с предметами. Игрок заберёт его в игровой почте.'),
    work([
      h2s('Кому'),
      hint('Найдите по нику или UID и щёлкните, чтобы выбрать.'),
      toBox,
      h3s('Текст'),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', margin: '0 0 8px' } },
        h('span', { class: 'hint', text: 'Шаблон' }),
        ...TEMPLATES.map(([label, title, body]) => btn(label, async () => { if (text.value.trim() && !(await confirmDialog({ title: 'Заменить текущий текст шаблоном?', confirm: 'Заменить' }))) return; text.value = title + '\n\n' + body; preview(); }, 'ghost sm'))),
      text,
      h3s('Вложения'),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '0 0 8px' } },
        hint('Предметы приходят вместе с письмом и попадают в инвентарь после получения.'), h('span', { style: { flex: '1 1 auto' } }),
        btn('Добавить предмет', () => pickItem({ title: 'Добавить вложение', onPick: (x) => { if (!attach.some((a) => a.item_id === x.item_id)) attach.push({ ...x, qty: 1 }); drawAttach(); preview(); } }), 'ghost sm')),
      attachBox,
      h3s('Предпросмотр'),
      pv,
      relogin,
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', margin: '14px 0 0' } }, send),
    ], aside),
  ];
}
