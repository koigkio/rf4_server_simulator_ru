const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright');

for (const [width,reducedMotion] of [[1440,'reduce'], [390,'reduce'], [1440,'no-preference'], [390,'no-preference']]) test(`鱼饵侧页: 贴边, 返回选饵, 草稿保护 ${width}px ${reducedMotion}`, async t => {
  const browser = await chromium.launch({executablePath:process.env.RF4_TEST_BROWSER});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width,height:800}, reducedMotion});
  page.setDefaultTimeout(5000);
  const writes = [];
  await page.route('**/*', route => {
    const p = new URL(route.request().url()).pathname;
    if (p==='/' || p.startsWith('/app/')) return route.fulfill({path:path.join(__dirname,'web',p==='/'?'index.html':p.slice(1))});
    if (route.request().method() !== 'GET') writes.push(p);
    return route.fulfill({json:({'/api/fish/areas':[], '/api/bait/prefs':{rules_enabled:true,rows:[{name_zh:'测试鱼',fish_key:'fixture',allow:['红虫']}]}, '/api/bait/items':{rows:[{name_zh:'蚯蚓',item_id:'worm'}]}})[p] || {}});
  });
  await page.goto('http://fixture.test/#bait');
  const trigger = page.getByRole('button',{name:'Изменить'});
  await trigger.click();
  const editor = page.getByRole('region',{name:'测试鱼',exact:true});
  await editor.waitFor();
  await editor.evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));
  await editor.locator('footer').getByText(/не позже чем через 30 секунд после сохранения, перезапускать клиент не нужно/).waitFor();
  const r = await editor.boundingBox();
  assert.equal(r.x+r.width,width); assert.equal(r.y,0); assert.equal(r.height,800);
  assert.equal(await page.locator('.overlay').count(),0);
  if (width>700) { assert.ok(r.x>0); await trigger.click({trial:true}); }
  else { assert.equal(r.x,0); assert.ok(await page.locator('#app').evaluate(el=>el.inert)); }
  await editor.getByRole('button',{name:'Добавить',exact:true}).first().click();
  const picker = page.getByRole('region',{name:'Добавить в «Любит»'});
  await picker.waitFor(); assert.ok(await editor.isHidden());
  await picker.getByRole('button',{name:'Назад'}).click();
  await editor.getByRole('button',{name:'Добавить',exact:true}).first().click();
  await picker.getByRole('button',{name:/蚯蚓/}).click();
  await editor.getByRole('button',{name:'Убрать 蚯蚓'}).waitFor();
  page.once('dialog',d=>d.dismiss()); await page.keyboard.press('Escape');
  assert.ok(await editor.isVisible());
  page.once('dialog',d=>d.accept());
  const exit = await editor.evaluate(el=>{
    el.querySelector('.panel-dismiss').click();
    return {mounted:el.isConnected,inert:el.inert,to:el.getAnimations()[0]?.effect.getKeyframes().at(-1).transform};
  });
  if (reducedMotion==='reduce') assert.equal(exit.mounted,false);
  else assert.deepEqual(exit,{mounted:true,inert:true,to:'translateX(100%)'});
  await page.waitForFunction(()=>!document.querySelector('.side-page'));
  await editor.waitFor({state:'hidden'}); assert.deepEqual(writes,[]);
  assert.ok(await trigger.evaluate(el=>el===document.activeElement));
});

test('侧页动画: 柔和起步, 与工作区同步, 中途关闭不跳位', async t => {
  const browser = await chromium.launch({executablePath:process.env.RF4_TEST_BROWSER});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:1440,height:800}, reducedMotion:'no-preference'});
  await page.route('**/*', route => {
    const p = new URL(route.request().url()).pathname;
    if (p==='/' || p.startsWith('/app/')) return route.fulfill({path:path.join(__dirname,'web',p==='/'?'index.html':p.slice(1))});
    return route.fulfill({json:p==='/api/bait/prefs' ? {rules_enabled:true,rows:[{name_zh:'测试鱼',fish_key:'fixture',allow:['红虫']}]} : {}});
  });
  await page.goto('http://fixture.test/#bait');
  const trigger = page.getByRole('button',{name:'Изменить'});
  await trigger.waitFor();
  // Sample real browser geometry at fixed animation times instead of sleeping between frames.
  for (const interrupted of [false,true]) {
    const result = await trigger.evaluate((el, interrupted) => {
      el.focus(); el.click();
      const panel = document.querySelector('.side-page');
      const sample = () => ({panelX:panel.getBoundingClientRect().x,mainRight:document.querySelector('main').getBoundingClientRect().right});
      const enter = [...panel.getAnimations(),...document.body.getAnimations()];
      enter.forEach(a => { a.pause(); a.currentTime = 80; });
      const early = sample(), width = panel.getBoundingClientRect().width;
      if (!interrupted) enter.forEach(a => a.finish());
      const before = sample();
      panel.querySelector('.panel-dismiss').click();
      const after = sample();
      const exit = [...panel.getAnimations(),...document.body.getAnimations()];
      exit.forEach(a => a.pause());
      const duration = Math.max(...exit.map(a => a.effect.getComputedTiming().duration));
      const samples = [0,.25,.5,.75,1].map(fraction => {
        exit.forEach(a => a.currentTime = duration * fraction);
        return sample();
      });
      exit.forEach(a => a.finish());
      return {width,early,before,after,samples};
    }, interrupted);
    const progress = (1440-result.early.panelX)/result.width;
    assert.ok(progress>.15 && progress<.6, `起步不应在 80ms 内走完大半距离: ${progress}`);
    assert.ok(Math.abs(result.before.panelX-result.after.panelX)<1, '关闭瞬间位置应连续');
    for (const sample of [result.early,result.before,result.after,...result.samples]) {
      assert.ok(Math.abs(sample.panelX-sample.mainRight)<1, JSON.stringify(sample));
    }
    for (let i=1;i<result.samples.length;i++) assert.ok(result.samples[i].panelX>=result.samples[i-1].panelX);
    await page.waitForFunction(() => !document.querySelector('.side-page'));
    assert.ok(await trigger.evaluate(el => el===document.activeElement));
  }
});
