const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require('playwright');
const origin='https://control.fixture.test';
async function fixture(t){
  const browser=await chromium.launch({executablePath:process.env.RF4_TEST_BROWSER});t.after(()=>browser.close());
  const page=await browser.newPage();page.setDefaultTimeout(6500);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
  const st={admin_ready:false,hosts:'local',game_path:'fixture.exe',last_error:'gateway fixture failure',procs:[
    {name:'gameserver',state:'running',pid:1,uptime_s:123,running_build:{version:'v17',source:'/build/custom/test-src'},exe_changed:true},
    {name:'gateway',state:'failed'}]};
  const f={page,st,failNext:false,loads:0,posts:[],logReqs:[],logDelay:0,logs:{gameserver:['level=INFO msg=logic-only'],gateway:Array.from({length:100},(_,i)=>`level=INFO msg=gateway-${i}`).concat('level=ERROR msg=fixture-error')}};
  await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{if(window.denyCopy)throw Error('denied');window.copied=text;}}}));
  await page.route('**/*',r=>{
    const u=new URL(r.request().url());if(u.origin!==origin)return r.abort();
    if(r.request().method()==='POST')f.posts.push(u.pathname);
    switch(u.pathname){
      case '/':return r.fulfill({path:path.join(__dirname,'panel.html')});
      case '/admin/':f.loads++;return r.fulfill({contentType:'text/html',body:'<label>Draft<input></label>'});
      case '/api/status':if(f.failNext){f.failNext=false;return r.abort('connectionreset');}return r.fulfill({json:st});
      case '/api/overview':return r.fulfill({json:{ready:false}});
      case '/api/logs':{const name=u.searchParams.get('name');f.logReqs.push(name);const lines=f.logs[name];
        return f.logDelay?new Promise(ok=>setTimeout(ok,f.logDelay)).then(()=>r.fulfill({json:{lines}})):r.fulfill({json:{lines}});}
      case '/api/admin/retry':st.admin_ready=true;st.admin_error='';return r.fulfill({json:{ok:true}});
      case '/api/game/launch':return r.fulfill({json:{ok:true}});
      default:return r.fulfill({status:404});
    }
  });return f;
}
test('admin gate can return home or retry; one interrupted poll preserves its live document',async t=>{
  const f=await fixture(t),{page,st}=f;await page.goto(origin+'/#admin');
  const gate=page.locator('#adminGate');await gate.getByText('存档初始化完成后会自动打开。').waitFor();
  await gate.getByRole('button',{name:'重试'}).click();assert.deepEqual(f.posts,[]);
  await gate.getByRole('button',{name:'返回首页'}).click();assert.equal(new URL(page.url()).hash,'#control');
  st.admin_error='fixture init failure';await page.getByRole('tab',{name:'管理后台'}).click();await gate.getByText(st.admin_error).waitFor();
  await gate.getByRole('button',{name:'重试'}).click();const draft=page.frameLocator('#adminFrame').getByRole('textbox');await draft.fill('未保存的草稿');
  f.failNext=true;await page.locator('#frameNotice').waitFor();assert.equal(await draft.inputValue(),'未保存的草稿');
  await page.locator('#frameNotice').waitFor({state:'hidden'});assert.equal(await draft.inputValue(),'未保存的草稿');
  assert.equal(f.loads,1);assert.deepEqual(f.posts,['/api/admin/retry']);
});
test('component and fault controls show stdout; log scroll, copy, build warning and keyboard focus survive polling',async t=>{
  const f=await fixture(t),{page,st}=f;await page.setViewportSize({width:390,height:800});await page.goto(origin+'/');
  const table=page.locator('#wkBody');await table.getByText('磁盘程序已替换，重启后生效').waitFor();
  assert.match(await table.innerText(),/v17 · 来源：custom\/test-src/);await table.getByText('可调参数',{exact:true}).waitFor();
  assert.doesNotMatch(await table.innerText(),/已加载|failed/);assert.match(await table.getByRole('row').filter({hasText:'管理后台'}).innerText(),/未就绪/);
  const log=table.getByRole('row').filter({hasText:'gameserver'}).getByRole('button',{name:'日志'});await log.focus();st.procs[0].running_build.version='v18';
  await table.getByText(/v18/).waitFor();assert.equal(await log.evaluate(el=>document.activeElement===el),true);
  assert.equal(await page.locator('.workbench').evaluate(el=>el.clientWidth<el.scrollWidth&&el.getBoundingClientRect().right<=innerWidth),true);
  await log.press('Enter');await page.locator('#logs').getByText('logic-only').waitFor();
  await page.getByRole('button',{name:'查看日志'}).click();const logs=page.locator('#logs');await logs.getByText('gateway-0',{exact:true}).waitFor();
  assert.equal(await page.locator('#logTabGateway').getAttribute('aria-selected'),'true');assert.equal(await page.locator('#view-admin').isVisible(),false);
  await logs.hover();await page.mouse.wheel(0,-100000);await page.waitForFunction(()=>document.getElementById('logs').scrollTop===0);
  f.logs.gateway.push('level=INFO msg=newest');await logs.getByText('newest').waitFor();assert.equal(await logs.evaluate(el=>el.scrollTop),0);
  await page.getByLabel('只看警告和错误').check();assert.equal(await logs.getByText('newest').count(),0);
  await page.getByRole('button',{name:'复制筛选结果'}).click();assert.equal(await page.evaluate(()=>window.copied),'level=ERROR msg=fixture-error');
  await page.getByRole('button',{name:'复制全部'}).click();assert.equal(await page.evaluate(()=>window.copied),f.logs.gateway.join('\n'));
  await page.evaluate(()=>window.denyCopy=true);await page.getByRole('button',{name:'复制全部'}).click();await page.getByText(/复制失败/).waitFor();
});
test('restart and stop warn before acting; client-only action does not start a service',async t=>{
  const f=await fixture(t),{page}=f;await page.goto(origin+'/');
  const proc=page.locator('#wkBody tr').filter({hasText:'gameserver'}),warnings=[];
  page.on('dialog',async dialog=>{warnings.push(dialog.message());await dialog.dismiss();});
  for(const name of ['重启','停止'])await proc.getByRole('button',{name,exact:true}).click();
  assert.equal(warnings.length,2);assert.ok(warnings.every(text=>text.includes('掉线')));assert.deepEqual(f.posts,[]);
  await page.locator('#serverMenuBtn').click();await page.getByRole('button',{name:'只启动游戏客户端'}).click();await page.getByText(/游戏已启动/).waitFor();
  assert.deepEqual(f.posts,['/api/game/launch']);
});
test('slow logs keep one request per component; only a component switch drops a stale response',async t=>{
  const f=await fixture(t),{page}=f;await page.goto(origin+'/');
  const logs=page.locator('#logs');await logs.getByText('logic-only').waitFor();
  f.logDelay=4500;f.logReqs.length=0;f.logs.gameserver=['level=INFO msg=slow-fresh'];
  await logs.getByText('slow-fresh').waitFor({timeout:9000});
  assert.ok(f.logReqs.filter(n=>n==='gameserver').length<=2);
  f.logs.gameserver=['level=INFO msg=stale-gameserver'];f.logReqs.length=0;
  while(!f.logReqs.includes('gameserver'))await new Promise(r=>setTimeout(r,100));
  f.logDelay=0;await page.locator('#logTabGateway').click();
  await logs.getByText('gateway-0',{exact:true}).waitFor();
  await new Promise(r=>setTimeout(r,5000));
  assert.equal(await logs.getByText('stale-gameserver').count(),0);
});
