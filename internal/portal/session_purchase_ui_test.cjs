const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs'),os=require('node:os'),{execFileSync}=require('node:child_process');
const {chromium}=require('playwright');

test('expired sessions can re-enter and confirm the original debited order with insufficient gold',async t=>{
  const dir=fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR||os.tmpdir(),'portal-ui-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  // Node 22.12 gates SQLite behind a flag; keep the ordinary node --test entry point.
  const sql=(stmt,...params)=>JSON.parse(execFileSync(process.execPath,['--experimental-sqlite','--no-warnings','-e',`
    const db=new(require('node:sqlite').DatabaseSync)(process.argv[1]);
    const [stmt,...params]=JSON.parse(require('node:fs').readFileSync(0));
    console.log(JSON.stringify(db.prepare(stmt).all(...params)));db.close();`,path.join(dir,'fixture.db')],{input:JSON.stringify([stmt,...params]),encoding:'utf8'}));
  sql('create table wallet(gold integer)');sql('insert into wallet values (100)');sql('create table receipt(id text primary key, plan text)');
  sql('create trigger debit after insert on receipt begin update wallet set gold=gold-100; end');
  const browser=await chromium.launch({executablePath:process.env.RF4_TEST_BROWSER});t.after(()=>browser.close());
  const page=await browser.newPage();page.setDefaultTimeout(5000);
  const requests=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
  let expired=false,session=0,uid=42;const origin='https://portal.fixture.test';
  const gold=()=>sql('select gold from wallet')[0].gold;
  const membership=()=>({plans:[{id:'one',name:'一日会员',priceGold:100},{id:'two',name:'二日会员',priceGold:200}],balance:{gold:gold(),silver:1000},membership:{active:gold()===0}});
  await page.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url());if(u.origin!==origin)return route.abort();
    const key=u.pathname.replace('/portal/api/','');
    if(key===u.pathname){const file=path.basename(u.pathname.endsWith('/')?'index.html':u.pathname);if(!/^(index\.html|local\.js|(?:portal|framework|reference-ui|local)\.css)$/.test(file))return route.fulfill({status:404});return route.fulfill({path:path.join(__dirname,'web',file)});}
    if(key==='session'&&req.method()==='POST'){assert.equal(req.headers().authorization,undefined);expired=false;return route.fulfill({json:{token:'fixture-'+(++session)}});}
    assert.equal(req.headers().authorization,'Bearer fixture-'+session);
    if(expired)return route.fulfill({status:401,body:'expired'});
    if(key==='profile')return route.fulfill({json:{userId:uid,nickname:'Игрок'+uid,username:'fixture',level:1,goldMinor:gold(),silverMinor:1000}});
    if(key==='membership')return route.fulfill({json:membership()});
    if(key==='membership/purchase'){
      const body=req.postDataJSON();requests.push(body);assert.equal(uid,42);
      if(!sql('select id from receipt where id=?',body.requestID).length){
        sql('insert into receipt values (?,?)',body.requestID,body.planID);
        return route.abort('connectionreset'); // The debit committed, but the response did not arrive.
      }
      return route.fulfill({json:{...membership(),purchase:{replayed:true}}});
    }
    throw Error('Unexpected request: '+req.method()+' '+key);
  });
  const login=async()=>{
    const enter=page.getByRole('button',{name:'Войти в личный кабинет',exact:true});await enter.focus();await page.keyboard.press('Enter');
    const submit=page.getByRole('button',{name:'Войти',exact:true});await submit.focus();await page.keyboard.press('Space');
    await page.getByRole('heading',{name:'Игрок'+uid}).waitFor();
  };
  await page.goto(origin+'/portal/');await login();await page.getByRole('link',{name:'Личный кабинет',exact:true}).click();
  await page.getByRole('heading',{name:'Игрок42'}).waitFor();assert.equal(session,1);
  await page.getByRole('button',{name:'Купить премиум',exact:true}).click();
  const retry=page.getByRole('button',{name:'Проверить квитанцию заказа'});
  await page.waitForFunction(()=>[...document.querySelectorAll('#local-plans button')].some(b=>!b.disabled&&b.textContent==='Проверить квитанцию заказа'));
  assert.equal(await page.locator('.local-plan button').nth(1).isDisabled(),true);
  await page.getByRole('button',{name:'Обновить аккаунт'}).click();await page.waitForFunction(()=>account_gold_score.textContent==='0.00');
  assert.equal(await retry.isEnabled(),true);assert.equal(requests.length,1);
  expired=true;await page.getByRole('button',{name:'Обновить аккаунт'}).click();await page.getByText('Сессия истекла, войдите в личный кабинет снова.',{exact:true}).waitFor();
  assert.equal(await page.locator('#account_gold_score').textContent(),'—');assert.equal(await retry.count(),0);
  uid=77;await login();assert.equal(await retry.count(),0);
  expired=true;await page.getByRole('button',{name:'Выйти',exact:true}).focus();await page.keyboard.press('Space');
  await page.getByText('Сессия истекла, войдите в личный кабинет снова.',{exact:true}).waitFor();
  uid=42;await login();await retry.click();await page.getByText('Покупка уже обработана, повторного списания нет.').waitFor();
  assert.deepEqual(requests,[{planID:'one',requestID:requests[0].requestID},{planID:'one',requestID:requests[0].requestID}]);assert.ok(requests[0].requestID);
  assert.equal(gold(),0);assert.equal(sql('select count(*) n from receipt')[0].n,1);assert.deepEqual(errors,[]);
});
