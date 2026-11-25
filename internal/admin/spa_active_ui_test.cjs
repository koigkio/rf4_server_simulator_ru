// Active SPA smoke test: serve ES modules from disk and inject nullable list responses.
const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const webRoot=path.join(__dirname,'web');

test('active admin SPA tolerates empty lists and shows four QQ groups',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.RF4_TEST_BROWSER});
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(()=>localStorage.setItem('rf4_admin_token','fixture'));
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:fs.readFileSync(path.join(webRoot,'index.html'),'utf8')});
   if(url.pathname.startsWith('/app/')){
    const file=path.join(webRoot,url.pathname.replace(/^\//,''));
    if(fs.existsSync(file))return route.fulfill({contentType:file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8',body:fs.readFileSync(file)});
    return route.fulfill({status:404,body:''});
   }
   if(url.pathname==='/api/me')return route.fulfill({contentType:'application/json',body:JSON.stringify({username:'admin'})});
   if(url.pathname==='/api/dashboard')return route.fulfill({contentType:'application/json',body:JSON.stringify({sessions:0,players:0,items:0,audits:0})});
   if(url.pathname==='/api/tunables')return route.fulfill({contentType:'application/json',body:'{}'});
   if(url.pathname==='/api/fish/bite_mode')return route.fulfill({contentType:'application/json',body:'{}'});
   if(url.pathname==='/api/audit'||url.pathname==='/api/players')return route.fulfill({contentType:'application/json',body:'null'});
   return route.fulfill({contentType:'application/json',body:'{}'});
  });
  await page.goto('http://127.0.0.1:19214/#players');
  await page.getByRole('heading',{name:'玩家管理',exact:true}).waitFor();
  await page.getByText('还没有玩家登录过').waitFor();
  const notice=await page.locator('.notice-bar').innerText();
  for(const group of ['379233540','225460820','1128152596','1134665746'])assert.ok(notice.includes(group),group);
  await page.getByRole('navigation',{name:'总类导航'}).getByRole('link',{name:/总览/}).click();
  await page.getByRole('heading',{name:'总览',exact:true}).waitFor();
  await page.getByText('还没有修改记录').waitFor();
  assert.equal(await page.getByText('页面加载失败').count(),0);
  assert.deepEqual(errors,[]);
  await context.close();
 }finally{await browser.close()}
});


test('active skill gain UI switches mode through one endpoint',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.RF4_TEST_BROWSER});
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(()=>localStorage.setItem('rf4_admin_token','fixture'));
  const page=await context.newPage(),errors=[];let mode='native';
  page.on('pageerror',e=>errors.push(e.message));
  const pctKeys=['skill_gain_pct_1','skill_gain_pct_2','skill_gain_pct_3','skill_gain_pct_11','skill_gain_pct_4','skill_gain_pct_6','skill_gain_pct_5','skill_gain_pct_8'];
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:fs.readFileSync(path.join(webRoot,'index.html'),'utf8')});
   if(url.pathname.startsWith('/app/')){
    const file=path.join(webRoot,url.pathname.replace(/^\//,''));
    if(fs.existsSync(file))return route.fulfill({contentType:file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8',body:fs.readFileSync(file)});
    return route.fulfill({status:404,body:''});
   }
   if(url.pathname==='/api/me')return route.fulfill({contentType:'application/json',body:JSON.stringify({username:'admin'})});
   if(url.pathname==='/api/tunables'){const data={skill_gain_mode:mode};for(const key of pctKeys)data[key]='0';return route.fulfill({contentType:'application/json',body:JSON.stringify(data)})}
   if(url.pathname==='/api/skill_gain_mode'&&route.request().method()==='POST'){mode=route.request().postDataJSON().mode;return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,mode})})}
   return route.fulfill({contentType:'application/json',body:'{}'});
  });
  await page.goto('http://127.0.0.1:19214/#tuning/reward');
  await page.getByRole('heading',{name:'游戏参数',exact:true}).waitFor();
  await page.locator('#pg-skill').getByText('技能升级概率',{exact:true}).waitFor();
  for(const label of ['原版概率','百分百','自定义'])assert.equal(await page.getByRole('radio',{name:label,exact:true}).count(),1);
  await page.getByRole('radio',{name:'自定义',exact:true}).click();
  await page.getByText('浮子钓鱼',{exact:true}).waitFor();
  assert.equal(await page.locator('input[id^="f_skill_gain_pct_"]').count(),8);
  assert.deepEqual(errors,[]);
  await context.close();
 }finally{await browser.close()}
});

test('active grade gain UI renders four multiplier inputs and saves them',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.RF4_TEST_BROWSER});
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(()=>localStorage.setItem('rf4_admin_token','fixture'));
  const page=await context.newPage(),errors=[],writes=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:fs.readFileSync(path.join(webRoot,'index.html'),'utf8')});
   if(url.pathname.startsWith('/app/')){
    const file=path.join(webRoot,url.pathname.replace(/^\//,''));
    if(fs.existsSync(file))return route.fulfill({contentType:file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8',body:fs.readFileSync(file)});
    return route.fulfill({status:404,body:''});
   }
   if(url.pathname==='/api/me')return route.fulfill({contentType:'application/json',body:JSON.stringify({username:'admin'})});
   if(url.pathname==='/api/tunables'){
    if(route.request().method()==='POST'){
     const body=route.request().postDataJSON();
     writes.push(body);
     return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true})});
    }
    return route.fulfill({contentType:'application/json',body:JSON.stringify({skill_grade_mult_1:'1',skill_grade_mult_2:'1',skill_grade_mult_3:'1',skill_grade_mult_4:'1'})});
   }
   return route.fulfill({contentType:'application/json',body:'{}'});
  });
  await page.goto('http://127.0.0.1:19214/#tuning/reward');
  // 档位倍数是「技能升级概率」区块内的第二段，不另起区块。
  await page.locator('#pg-skill').getByText('按鱼获档位加成',{exact:true}).waitFor();
  for(const label of ['未达标鱼','合格鱼','奖杯鱼','蓝冠鱼'])assert.equal(await page.locator('#pg-skill').getByText(label,{exact:true}).count(),1);
  assert.equal(await page.locator('input[id^="f_skill_grade_mult_"]').count(),4);
  assert.equal(await page.locator('#pg-skill-grade').count(),0);
  await page.locator('input[id^="f_skill_grade_mult_4_"]').fill('8');
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  const saved=writes.find(w=>w&&w.key==='skill_grade_mult_4');
  assert.ok(saved,'应保存 skill_grade_mult_4');
  assert.equal(saved.value,'8');
  assert.deepEqual(errors,[]);
  await context.close();
 }finally{await browser.close()}
});

test('active rules page exposes and saves the marine layer switch',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.RF4_TEST_BROWSER});
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(()=>localStorage.setItem('rf4_admin_token','fixture'));
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  // 官方鱼汛六开、其余默认关；读默认值不应写库。
  const values={bite_gate_enabled:'0',fish_ecology_enabled:'0',fish_weather_enabled:'0',fish_distribution_enabled:'0',fish_bait_rules_enabled:'0',marine_layer_enabled:'0',happy_hour_enabled:'1'};
  const writes=[];
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   const json=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
   if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:fs.readFileSync(path.join(webRoot,'index.html'),'utf8')});
   if(url.pathname.startsWith('/app/')){
    const file=path.join(webRoot,url.pathname.replace(/^\//,''));
    if(fs.existsSync(file))return route.fulfill({contentType:file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8',body:fs.readFileSync(file)});
    return route.fulfill({status:404,body:''});
   }
   if(url.pathname==='/api/me')return json({username:'admin'});
   if(url.pathname==='/api/tunables'){
    if(route.request().method()==='POST'){
     const body=route.request().postDataJSON();
     writes.push({key:body.key,value:String(body.value)});
     values[body.key]=String(body.value);
     return json({ok:true});
    }
    return json(values);
   }
   if(url.pathname==='/api/fish/bite_mode')return json({mode:'legacy'});
   return json({});
  });
  await page.goto('http://127.0.0.1:19214/#rules');
  await page.getByRole('heading',{name:'钓场与鱼口',exact:true}).waitFor();

  // 七项规则全在：海钓水层是后加的那一项，默认关。
  assert.equal(await page.locator('input[type="checkbox"][id^="f_"]').count(),7);
  const marine=page.locator('input[id^="f_marine_layer_enabled_"]');
  await marine.waitFor();
  assert.equal(await marine.isChecked(),false);
  assert.equal(writes.length,0,'只读默认值不应写库');

  // 打开海钓水层 -> 保存：只提交这一项，写库后勾选状态保留。
  await marine.click();
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('input[id^="f_marine_layer_enabled_"]').closest('.row').classList.contains('changed'));
  assert.deepEqual(writes,[{key:'marine_layer_enabled',value:'1'}]);
  assert.equal(values.marine_layer_enabled,'1');

  // 重新加载后从 tunables 读回，仍是打开状态。
  await page.reload();
  await page.getByRole('heading',{name:'钓场与鱼口',exact:true}).waitFor();
  assert.equal(await page.locator('input[id^="f_marine_layer_enabled_"]').isChecked(),true);

  // 关闭并保存，确认可以来回切换。
  await page.locator('input[id^="f_marine_layer_enabled_"]').click();
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('input[id^="f_marine_layer_enabled_"]').checked===false);
  assert.deepEqual(writes.at(-1),{key:'marine_layer_enabled',value:'0'});
  assert.equal(values.marine_layer_enabled,'0');
  assert.deepEqual(errors,[]);
  await context.close();
 }finally{await browser.close()}
});
