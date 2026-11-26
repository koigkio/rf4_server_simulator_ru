const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright');

async function fixture(t, api, {signedIn = true, width = 1280} = {}) {
  const browser = await chromium.launch({executablePath:process.env.RF4_TEST_BROWSER});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width,height:800}, reducedMotion:'reduce'});
  page.setDefaultTimeout(5000);
  if (signedIn) await page.addInitScript(() => localStorage.setItem('rf4_admin_token','old'));
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname.startsWith('/icons/')) return route.fulfill({status:404,body:''});
    if (!url.pathname.startsWith('/api/')) return route.fulfill({path:path.join(__dirname,'web',url.pathname==='/'?'index.html':url.pathname.slice(1))});
    if (url.pathname === '/api/me') return route.fulfill({json:{username:'fixture'}});
    if (url.pathname === '/api/login') return route.fulfill({json:{token:'renewed'}});
    const result = await api(url.pathname, req);
    return route.fulfill(result || {json:{}});
  });
  return page;
}
const verifyLogin = async page => {
  const dialog = page.getByRole('dialog',{name:'登录管理后台'});
  await dialog.getByLabel('密码').fill('fixture');
  await dialog.getByRole('button',{name:'登录',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
};

test('收件人查询 401 后原地续登，保留正文、附件和搜索条件', async t => {
  const sent = [];
  const page = await fixture(t, (p, req) => {
    if (p === '/api/catalog/items') return {json:[{name:'测试物品',item_id:'fixture_item'}]};
    if (p === '/api/players') return req.headers().authorization === 'Bearer renewed' ? {json:[{uid:7,name:'测试角色',level:1}]} : {status:401,json:{}};
    if (p === '/api/mail/send') { sent.push(req.postDataJSON()); return {json:{queued:true}}; }
  });
  await page.goto('http://fixture.test/#mail');
  await page.locator('textarea').fill('待发送正文');
  await page.getByRole('button',{name:'添加物品'}).click();
  await page.getByPlaceholder(/输入物品名称或 ID/).fill('fixture');
  await page.getByRole('button',{name:/测试物品/}).click();
  await page.getByPlaceholder('输入玩家昵称或 UID').fill('测试');
  await page.getByText('会话已过期，邮件草稿已保留。').waitFor();
  await page.getByRole('button',{name:'登录管理后台',exact:true}).click(); await verifyLogin(page);
  await page.getByRole('button',{name:/测试角色.*UID 7/}).click();
  assert.equal(await page.locator('textarea').inputValue(),'待发送正文');
  assert.deepEqual(sent,[]);
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'发送',exact:true}).click();
  await page.getByText('已加入发送队列',{exact:true}).waitFor();
  assert.deepEqual(sent,[{uid:7,text:'待发送正文',items:[{item_id:'fixture_item',qty:1}]}]);
});

test('慢邮件详情不能接管当前商店的草稿保护', async t => {
  let release, started;
  const gate = new Promise(r => { release = r; }), request = new Promise(r => { started = r; });
  const page = await fixture(t, async p => {
    if (p === '/api/players/detail') { started(); await gate; return {json:{uid:7,name:'旧玩家'}}; }
    if (p === '/api/stores') return {json:[{store_id:'A',map_key:'湖'}]};
    if (p === '/api/stores/items') return {json:[{store_id:'A',item_id:'fixture',name:'夹具',silver:1,gold:0,stock:1,base_silver:1,base_gold:0,base_stock:1}]};
  });
  await page.goto('http://fixture.test/#mail/7'); await request;
  await page.locator('#rail a[href="#shop"]').click();
  const field = page.getByRole('spinbutton',{name:'夹具覆盖银价'});
  await field.fill('9');
  const finished = page.waitForEvent('requestfinished',req=>req.url().includes('/api/players/detail'));
  release(); await finished;
  // Allow the renderer to consume the response before testing its leave guard.
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const confirmation = page.waitForEvent('dialog',{timeout:5000}).then(async d=>{assert.match(d.message(),/没保存/);await d.dismiss();});
  await Promise.all([confirmation,page.locator('#rail a[href="#audit"]').click()]);
  assert.equal(await field.inputValue(),'9'); assert.ok(page.url().endsWith('#shop/A/price'));
});

test('390px 未登录鱼钩侧页可登录并重试保存，原值不丢', async t => {
  const attempts = [];
  const page = await fixture(t,(p,req) => {
    if (p !== '/api/hooks/profiles') return;
    if (req.method()==='GET') return {json:{total:1,profiles:[{item_id:'fixture',name:'测试钩',family:'carp',size:2,solid_scale:1,hold_scale:1,small_fish_floor:0,over_capacity_hold_floor:0}]}};
    attempts.push([req.headers().authorization,req.postDataJSON()]);
    return req.headers().authorization==='Bearer renewed'?{json:{ok:true}}:{status:401,json:{}};
  },{width:390,signedIn:false});
  await page.goto('http://fixture.test/#hooks'); await page.getByRole('button',{name:'调整',exact:true}).click();
  const panel = page.getByRole('region',{name:'测试钩'}), value = panel.getByRole('textbox').first();
  await value.fill('1.7'); await panel.getByRole('button',{name:'保存',exact:true}).click();
  await panel.getByRole('alert').waitFor();
  await panel.getByRole('button',{name:'登录管理后台'}).click(); await verifyLogin(page);
  assert.equal(await value.inputValue(),'1.7'); assert.equal(attempts.length,1);
  await panel.getByRole('button',{name:'保存',exact:true}).click(); await panel.waitFor({state:'hidden'});
  assert.equal(attempts.length,2); assert.equal(attempts[1][0],'Bearer renewed'); assert.equal(attempts[1][1].solid_scale,1.7);
});

test('切页后旧页面迟到的保存失败不会重新点亮保存条或再次提交', async t => {
  const posts = [];
  let release, started;
  const gate = new Promise(r => { release = r; }), request = new Promise(r => { started = r; });
  const page = await fixture(t, async (p, req) => {
    if (p === '/api/tunables' && req.method() === 'POST') { posts.push(req.postDataJSON()); started(); await gate; return {status:500,json:{error:'迟到的失败'}}; }
    if (p === '/api/tunables') return {json:{bite_gate_enabled:'0'}};
  });
  await page.goto('http://fixture.test/#rules');
  await page.getByRole('checkbox',{name:/饵要对口/}).check();
  const bar = page.locator('.savebar');
  await bar.getByRole('button',{name:'保存修改'}).click(); await request;
  page.once('dialog', d => d.accept());
  await page.locator('#rail a[href="#mail"]').click();
  await page.getByRole('heading',{name:'邮件'}).first().waitFor();
  const finished = page.waitForEvent('requestfinished',req=>req.method()==='POST');
  release(); await finished;
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  assert.equal(await page.locator('.savebar.on').count(),0);
  await bar.getByRole('button',{name:'保存修改'}).evaluate(b => b.click());
  assert.equal(posts.length,1);
});

test('选好收件人后发送遇到 401：原地登录，收件人、正文和附件保留，确认后才重发', async t => {
  const sent = [];
  const page = await fixture(t, (p, req) => {
    if (p === '/api/catalog/items') return {json:[{name:'测试物品',item_id:'fixture_item'}]};
    if (p === '/api/players/detail') return {json:{uid:7,name:'测试角色',level:3}};
    if (p === '/api/mail/send') { sent.push([req.headers().authorization, req.postDataJSON()]); return req.headers().authorization === 'Bearer renewed' ? {json:{queued:true}} : {status:401,json:{}}; }
  });
  await page.goto('http://fixture.test/#mail/7');
  await page.getByText('UID 7 · 3 级').waitFor();
  await page.locator('textarea').fill('待发送正文');
  await page.getByRole('button',{name:'添加物品'}).click();
  await page.getByPlaceholder(/输入物品名称或 ID/).fill('fixture');
  await page.getByRole('button',{name:/测试物品/}).click();
  const send = page.getByRole('button',{name:'发送',exact:true});
  await send.click(); await page.getByRole('dialog').getByRole('button',{name:'发送',exact:true}).click();
  const alert = page.getByRole('alert').filter({hasText:'会话已过期，本次未发送'});
  await alert.waitFor();
  await alert.getByRole('button',{name:'登录管理后台'}).click(); await verifyLogin(page);
  await alert.waitFor({state:'hidden'});
  assert.equal(sent.length,1);
  assert.equal(await page.locator('textarea').inputValue(),'待发送正文');
  await page.getByText('UID 7 · 3 级').waitFor();
  await page.getByText('测试物品',{exact:true}).first().waitFor();
  await send.click(); await page.getByRole('dialog').getByRole('button',{name:'发送',exact:true}).click();
  await page.getByText('已加入发送队列',{exact:true}).waitFor();
  assert.equal(sent.length,2); assert.equal(sent[1][0],'Bearer renewed');
  assert.deepEqual(sent[1][1],{uid:7,text:'待发送正文',items:[{item_id:'fixture_item',qty:1}]});
});

test('「刷新本页」先确认桌面侧页里未保存的修改', async t => {
  const page = await fixture(t, (p, req) => {
    if (p === '/api/hooks/profiles' && req.method()==='GET') return {json:{total:1,profiles:[{item_id:'fixture',name:'测试钩',family:'carp',size:2,solid_scale:1,hold_scale:1,small_fish_floor:0,over_capacity_hold_floor:0}]}};
  });
  await page.goto('http://fixture.test/#hooks'); await page.getByRole('button',{name:'调整',exact:true}).click();
  const panel = page.getByRole('region',{name:'测试钩'}), value = panel.getByRole('textbox').first();
  await value.fill('1.7');
  await page.evaluate(() => { window.stillHere = true; });
  const asked = page.waitForEvent('dialog').then(async d => { assert.match(d.message(),/放弃未保存的调整/); await d.dismiss(); });
  await Promise.all([asked, page.getByRole('button',{name:'刷新本页'}).click()]);
  assert.equal(await page.evaluate(() => window.stillHere),true);
  assert.equal(await value.inputValue(),'1.7');
});
