const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright');

test('同名玩家分别标明 UID 和在线状态，名单失效不误报离线', async t => {
  const browser = await chromium.launch({executablePath: process.env.RF4_TEST_BROWSER});
  t.after(() => browser.close());
  const page = await browser.newPage({reducedMotion:'reduce'});
  await page.clock.install();
  await page.addInitScript(() => localStorage.setItem('rf4_admin_token','fixture'));
  const list = [1,2].map(uid => ({uid,name:'同名'.repeat(45),level:1,online_known:true,online:uid===1,banned:uid===2}));
  await page.route('**/*', route => {
    const p = new URL(route.request().url()).pathname;
    if (p==='/' || p.startsWith('/app/')) return route.fulfill({path:path.join(__dirname,'web',p==='/'?'index.html':p.slice(1))});
    return route.fulfill({json:({'/api/me':{username:'test'},'/api/players':list,'/api/players/detail':list.find(player=>player.uid===Number(new URL(route.request().url()).searchParams.get('uid')))})[p]||{}});
  });
  await page.goto('http://fixture.test/#players/1/profile');
  const row = page.locator('.whorow');
  await row.getByRole('button',{name:/UID 1.*在线/,pressed:true}).waitFor();
  const other = row.getByRole('button',{name:/UID 2.*离线.*已封禁/});
  for (const width of [320,1280]) {
    await page.setViewportSize({width,height:800});
    const geometry = await other.evaluate(button => {
      const bounds = el => el.getBoundingClientRect();
      const [identity,level,state,mark] = Array.from(button.children,bounds);
      return {width:bounds(button).width, viewport:innerWidth,height:bounds(button).height,aligned:identity.right<=level.left && level.right<=state.left && state.right<=mark.left && mark.right<=bounds(button).right};
    });
    assert.ok(geometry.aligned && geometry.width<=width && geometry.height>=44,JSON.stringify(geometry));
  }
  for (const theme of ['light','dark']) {
    const colors = await row.evaluate((el,theme) => {
      document.documentElement.dataset.theme = theme;
      const [selected,other] = el.querySelectorAll('button');
      const swatch = document.createElement('span'); el.append(swatch);
      const token = name => { swatch.style.backgroundColor = `var(--${name})`; return getComputedStyle(swatch).backgroundColor; };
      const result = { selected:getComputedStyle(selected).backgroundColor, other:getComputedStyle(other).backgroundColor,
        accent:token('accent'), paper:token('raise'), sameRow:Math.abs(selected.offsetTop-other.offsetTop)<12 };
      swatch.remove(); return result;
    },theme);
    assert.equal(colors.selected,colors.accent); assert.notEqual(colors.selected,colors.other);
    if (theme==='light') assert.equal(colors.other,colors.paper);
    assert.ok(colors.sameRow,JSON.stringify(colors));
  }
  await other.focus();
  list[0].online = false; list[1].online = true;
  await page.clock.fastForward(8100);
  await page.locator('.player-heading').getByText('离线',{exact:true}).waitFor();
  assert.ok(await row.getByRole('button',{name:/UID 2.*在线/}).evaluate(el=>el===document.activeElement));
  list.forEach(p=>{p.online=false;p.online_known=false;});
  await page.clock.fastForward(8100);
  await page.locator('.player-heading').getByText('状态未上报').waitFor();
  assert.equal(await row.getByText('状态未上报',{exact:true}).count(),2);
  await other.or(row.getByRole('button',{name:/UID 2.*状态未上报/})).press('Enter');
  await page.locator('.player-heading').getByText(/UID 2/).waitFor();
  await row.getByRole('button',{name:/UID 2/,pressed:true}).waitFor();
});

test('登录重试保留邮件，确认 UID 后入队，改昵称只提交该字段', async t => {
  const browser = await chromium.launch({executablePath: process.env.RF4_TEST_BROWSER});
  t.after(() => browser.close());
  const page = await browser.newPage({reducedMotion:'reduce'});
  page.setDefaultTimeout(5000);
  const writes = [], errors = [];
  let attempts = 0;
  page.on('pageerror', e => errors.push(e.message));
  const player = {uid:42, name:'夹具角色', level:3, silver:5100, xp:200, membership:0};
  await page.route('**/*', async route => {
    const req = route.request(), p = new URL(req.url()).pathname;
    if (p === '/' || p.startsWith('/app/')) return route.fulfill({path:path.join(__dirname, 'web', p === '/' ? 'index.html' : p.slice(1))});
    if (p === '/api/login') return ++attempts === 1 ? route.fulfill({status:401,json:{}}) : route.fulfill({json:{token:'fixture'}});
    if (req.method() === 'POST') { writes.push([p,req.postDataJSON()]); return route.fulfill({json:{queued:true}}); }
    return route.fulfill({json:({'/api/me':{username:'test'},'/api/players/detail':player,'/api/players':[{...player,online:true}]})[p] || {}});
  });
  await page.goto('http://fixture.test/#mail/42');
  await page.locator('textarea').fill('未发送的正文');
  await page.locator('#view').getByRole('button',{name:'登录管理后台'}).click();
  const login = page.getByRole('dialog',{name:'登录管理后台'});
  await login.getByRole('button',{name:'登录',exact:true}).click();
  await login.getByRole('alert').waitFor();
  await login.getByLabel('密码').fill('fixture');
  await login.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('button',{name:'换一个'}).waitFor();
  assert.equal(await page.locator('textarea').inputValue(),'未发送的正文');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByRole('dialog',{name:/UID 42/}).getByRole('button',{name:'发送'}).click();
  await page.getByText('已加入发送队列',{exact:true}).waitFor();
  await page.goto('http://fixture.test/#players/42/profile');
  const nickname = page.locator('#view label').filter({has:page.getByText('昵称',{exact:true})}).locator('input');
  await nickname.fill('新昵称');
  player.silver = 6100;
  await page.getByRole('button',{name:'保存修改'}).click();
  await page.getByText('已保存。在线玩家立即收到刷新。',{exact:true}).waitFor();
  assert.deepEqual(writes,[['/api/mail/send',{uid:42,text:'未发送的正文',items:[]}],['/api/players/update',{uid:42,name:'新昵称'}]]);
  assert.deepEqual(errors,[]);
});
