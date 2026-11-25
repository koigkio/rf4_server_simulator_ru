// 发邮件：选人 → 写内容 → 加附件 → 发送。右边实时预览玩家看到的样子。
import { h, api, apiList, post, toast, errText, pageHead, work, ib, h2s, h3s, hint, kv, bullets, btn, empty, debounce, searchBox, badge, getToken, loginDialog, confirmDialog } from '../core.js';
import { itemIcon, pickItem } from '../widgets.js';

const TEMPLATES = [
  ['补偿', '服务器补偿', '因为最近服务器的问题给你带来了不便，特此补偿，请查收附件。'],
  ['活动奖励', '活动奖励', '感谢参与本次活动！奖励已随邮件附上。'],
  ['欢迎', '欢迎来钓鱼', '欢迎来到我们的服务器！祝你钓到大鱼。'],
];

export default async function mail(params, scope) {
  let to = null;
  const attach = [];
  let target = params[0] || '', targetError = '', expired = false, recipientQuery = '';
  const readTarget = async () => {
    if (!target || !getToken()) return;
    try { const p = await api('/api/players/detail?uid=' + encodeURIComponent(target), {preserveSession:true}); to = { uid: p.uid, name: p.name, level: p.level }; targetError = ''; }
    catch (e) { expired = e.status === 401; targetError = '收件人读取失败：' + errText(e); }
  };
  await readTarget();
  if (!scope.isCurrent()) return [];
  const text = h('textarea', { class: 'textarea', rows: 9, placeholder: '写给玩家的话。可以只发附件、不写内容。', oninput: () => preview() });
  scope.setLeaveGuard(() => !!(text.value.trim() || attach.length));

  // 收件人
  const toBox = h('div');
  const drawTo = () => {
    if (expired || !getToken()) { toBox.replaceChildren(hint(expired ? '会话已过期，邮件草稿已保留。' : target ? `请先登录核对收件人 UID ${target}` : '登录后可查询玩家。'), btn('登录管理后台', () => loginDialog(), 'primary')); return; }
    if (to) {
      toBox.replaceChildren(h('div', { class: 'row card', style: { padding: '10px 12px', background: 'var(--surface-2)' } },
        h('div', { class: 'avatar', text: (to.name || '?').slice(0, 1) }),
        h('div', { class: 'grow' }, h('b', { text: to.name }), h('div', { class: 'muted small', text: `UID ${to.uid}` + (to.level ? ` · ${to.level} 级` : '') })),
        btn('换一个', () => { target = ''; to = null; drawTo(); preview(); }, 'ghost sm')));
      return;
    }
    const results = h('div', { class: 'card', hidden: true, style: { marginTop: '6px', maxHeight: '240px', overflow: 'auto' } });
    const search = searchBox('输入玩家昵称或 UID', debounce(async (q) => {
      if (!search.isConnected) return;
      recipientQuery = q;
      if (!q.trim()) { results.hidden = true; return; }
      let list;
      try { list = await apiList('/api/players?q=' + encodeURIComponent(q.trim()), {preserveSession:true}); }
      catch (e) {
        if (!search.isConnected || search.querySelector('input').value !== q) return;
        if (e.status === 401) { expired = true; drawTo(); return; }
        results.hidden = false; results.replaceChildren(empty('查询失败', errText(e))); return;
      }
      if (search.querySelector('input').value !== q) return;
      results.hidden = false;
      results.replaceChildren(list.length ? h('div', { class: 'list' }, list.slice(0, 20).map((p) => h('button', { type: 'button',
        class: 'list-item clickable', onclick: () => { to = { uid: p.uid, name: p.name, level: p.level }; target = String(p.uid); drawTo(); preview(); },
      }, h('div', { class: 'avatar', text: (p.name || '?').slice(0, 1) }), h('div', { class: 'grow' }, h('div', { class: 'title', text: p.name }), h('div', { class: 'sub', text: `UID ${p.uid} · ${p.level} 级` })), p.online ? badge('在线', 'ok', true) : null))) : empty('没有找到'));
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
      h('label', { class: 'row small muted' }, '数量', h('input', { class: 'input num', type: 'number', min: 1, step: 1, style: { width: '80px', height: '30px' }, value: a.qty, oninput: e => { a.qty = e.target.value; preview(); } })),
      btn('', () => { attach.splice(i, 1); drawAttach(); preview(); }, 'ghost icon sm', { icon: 'x', 'aria-label': '移除' }))))) : h('div', { class: 'muted small', text: '没有附件。' }));
  };
  drawAttach();

  // 预览
  const pv = h('div');
  const recipient = h('span');
  function preview() {
    const lines = text.value.trim();
    recipient.textContent = to ? `${to.name}（UID ${to.uid}）` : '还没选';
    pv.replaceChildren(h('div', { class: 'card', style: { padding: '18px', background: 'var(--surface-2)' } },
      h('div', { class: 'muted small', text: '收件人：' + (to ? `${to.name}（UID ${to.uid}）` : '还没选') }),
      h('div', { style: { margin: '12px 0', whiteSpace: 'pre-wrap', minHeight: '60px', color: lines ? 'var(--text)' : 'var(--faint)' }, text: lines || '（没有正文）' }),
      attach.length ? h('div', { class: 'row', style: { gap: '10px', borderTop: '1px solid var(--line)', paddingTop: '12px' } }, attach.map((a) => h('div', { class: 'row', style: { gap: '6px' } }, itemIcon(a.item_id, 28), h('span', { class: 'small', text: `${a.name} ×${a.qty}` })))) : null));
  }
  preview();

  // 发送时会话过期：就地登录，收件人、正文和附件原样保留；登录后由管理员确认再发，不自动重放。
  const relogin = h('div', { class: 'row', role: 'alert', hidden: true, style: { gap: '8px', justifyContent: 'flex-end', margin: '14px 0 0' } },
    hint('会话已过期，本次未发送。收件人、正文和附件都已保留，登录后请再点「发送」。'),
    btn('登录管理后台', () => loginDialog({ onDone: () => { relogin.hidden = true; } }), 'ghost sm'));
  const send = btn('发送', async () => {
    if (expired || !getToken()) { loginDialog(); return; }
    relogin.hidden = true;
    if (!to) { toast('请先选择收件人', 'bad'); return; }
    if (!text.value.trim() && !attach.length) { toast('正文和附件不能都为空', 'bad'); return; }
    if (attach.some(a => !/^\d+$/.test(String(a.qty)) || !Number.isSafeInteger(+a.qty) || +a.qty < 1)) { toast('附件数量须为正整数', 'bad'); return; }
    const payload = { uid: to.uid, text: text.value.trim(), items: attach.map(a => ({ item_id: a.item_id, qty: +a.qty })) };
    send.disabled = true;
    try {
      if (!(await confirmDialog({ title: `发给「${to.name}」（UID ${payload.uid}）？`, desc: attach.length ? attach.map(a => `${a.name} ×${a.qty}`).join('、') + '。发出后不能撤回。' : '发出后不能撤回。', confirm: '发送' }))) return;
      await post('/api/mail/send', payload);
      toast('已加入发送队列');
      if (text.value.trim() === payload.text && JSON.stringify(attach.map(a => ({ item_id: a.item_id, qty: +a.qty }))) === JSON.stringify(payload.items)) { text.value = ''; attach.length = 0; drawAttach(); preview(); }
    } catch (e) {
      if (e.status === 401) { relogin.hidden = false; relogin.querySelector('button').focus(); }
      else toast('发送失败：' + errText(e), 'bad');
    }
    finally { send.disabled = false; }
  }, 'primary lg', { icon: 'mail' });

  const aside = [
    ib('发出去之后', null, bullets([
      '提交后由游戏服务投递，入队不等于已送达。',
      '玩家下次打开邮箱就能领取。',
      '附件物品会进背包，邮件本身留在邮箱里。',
      '发出后不能撤回，写之前先看一眼预览。',
    ])),
    ib('发信记录', null, kv([['写入审计', '是'], ['收件人', recipient]]),
      hint('每一封都会写进「审计日志」。')),
  ];
  return [
    pageHead('邮件', '给一个玩家发消息，可以附带物品。玩家在游戏的邮箱里领取。'),
    work([
      h2s('发给谁'),
      hint('搜昵称或 UID，点一下选中。'),
      toBox,
      h3s('写点什么'),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', margin: '0 0 8px' } },
        h('span', { class: 'hint', text: '模板' }),
        ...TEMPLATES.map(([label, title, body]) => btn(label, async () => { if (text.value.trim() && !(await confirmDialog({ title: '用模板替换现有正文？', confirm: '替换' }))) return; text.value = title + '\n\n' + body; preview(); }, 'ghost sm'))),
      text,
      h3s('附件'),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '0 0 8px' } },
        hint('物品会和邮件一起送达，玩家领取后进背包。'), h('span', { style: { flex: '1 1 auto' } }),
        btn('添加物品', () => pickItem({ title: '添加附件', onPick: (x) => { if (!attach.some((a) => a.item_id === x.item_id)) attach.push({ ...x, qty: 1 }); drawAttach(); preview(); } }), 'ghost sm')),
      attachBox,
      h3s('预览'),
      pv,
      relogin,
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', margin: '14px 0 0' } }, send),
    ], aside),
  ];
}
