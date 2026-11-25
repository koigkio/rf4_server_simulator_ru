// L1: published assets, isolated API fixtures, real launcher iframe. No game writes.
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.join(__dirname, 'web');
const origin = 'http://layout.test';
const widths = [320, 390, 1024, 1259, 1260, 1280, 1366, 1440, 1920];
let browser;
before(async () => { browser = await chromium.launch({executablePath: process.env.RF4_TEST_BROWSER}); });
after(async () => { await browser?.close(); });

async function fixture(t, width) {
  const page = await browser.newPage({viewport: {width, height: 800}, reducedMotion: 'reduce'});
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/') return route.fulfill({path: path.join(__dirname, '../../cmd/launcher/panel.html')});
    if (url.pathname === '/admin/') return route.fulfill({path: path.join(root, 'index.html')});
    if (url.pathname.startsWith('/admin/app/')) return route.fulfill({path: path.join(root, url.pathname.slice(7))});
    const api = url.pathname.replace(/^\/admin\//, '/');
    if (route.request().method() !== 'GET') writes.push([api, route.request().postDataJSON()]);
    const data = {
      '/api/status': {admin_ready: true, procs: []}, '/api/me': {username: 'fixture'}, '/api/login': {token: 'layout-fixture'},
      '/api/dashboard': {sessions: 2, players: 100, items: 180, audits: 2}, '/api/audit': [], '/api/players': [],
      '/api/tunables': {event_newyear_enabled: '0', event_anniversary_enabled: '1', event_branches: '19,20'},
      '/api/stores': [{store_id:'fishing_store_fixture', map_key:'level_01_fixture', item_count:1, override_count:1}],
      '/api/stores/items': [{store_id:'fishing_store_fixture', item_id:'rod_fixture', name:'夹具商品', has_override:true,
        base_silver:200, base_gold:0, base_stock:20, silver:300, gold:1, stock:30}],
    };
    return route.fulfill({json: data[api] ?? {}});
  });
  return {page, writes};
}

// Browser rectangles, not screenshot snapshots. Include hit tests for the last link and the task control.
async function geometry(frame) {
  return frame.locator('#work').evaluate(async work => {
    await document.fonts.ready;
    const rect = el => el.getBoundingClientRect();
    const hit = el => { const b = rect(el); return el.contains(document.elementFromPoint(b.x+b.width/2, b.y+b.height/2)); };
    const nav = document.querySelector('#rail'), links = [...nav.querySelectorAll('a')];
    const section = work.querySelector(':scope > section'), aside = work.querySelector(':scope > aside');
    const control = section.querySelector('button:not([disabled]), a[href], input:not([disabled])');
    return {width: innerWidth, pageWidth: document.documentElement.scrollWidth, rail: rect(nav.parentElement).width,
      navWidth: rect(nav).width, count: links.length, linksInView: links.every(hit), rowHeights: links.map(a => rect(a).height),
      titleBottom: rect(document.querySelector('h1')).bottom, firstControl: control && hit(control),
      controlBottom: control && rect(control).bottom, edit: rect(section).width, help: aside && rect(aside).width,
      sideBySide: aside && rect(aside).left >= rect(section).right - 1};
  });
}

for (const embedded of [false, true]) {
  test(`L1 ${embedded ? 'launcher iframe' : 'standalone'}: task width and navigation`, async t => {
    const {page, writes} = await fixture(t, 1280);
    let frame = page;
    if (embedded) {
      await page.goto(origin);
      await page.getByRole('tab', {name: '管理后台'}).click();
      frame = page.frameLocator('#adminFrame');
    } else await page.goto(origin + '/admin/');
    await frame.getByRole('heading', {name: '总览', exact: true}).waitFor();
    for (const route of ['dashboard', 'event']) {
      if (route === 'event') {
        await frame.getByRole('navigation', {name:'总类导航'}).getByRole('link', {name:'游戏参数'}).click();
        await frame.getByRole('link', {name:'限时活动', exact:true}).click();
        await frame.locator('#pg-gifts').waitFor();
      }
      let previous;
      for (const width of widths) {
        await page.setViewportSize({width, height:800});
        const g = await geometry(frame), label = `${route} ${width}: ${JSON.stringify(g)}`;
        assert.ok(g.pageWidth <= g.width + 1, label);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), label);
        if (width <= 390) {
          assert.equal(g.navWidth, 0, label);
          assert.ok(g.titleBottom > 0 && g.titleBottom < 800 && g.firstControl, label);
        } else {
          assert.ok(g.rail >= 216 && g.rail <= 224, label);
          assert.equal(g.count, 12, label);
          assert.ok(g.linksInView && g.rowHeights.every(h => h >= 38 && h <= 44), label);
        }
        if (route === 'event') {
          if (width === 1260) assert.ok(g.edit >= previous.edit * .95, label);
          if (width === 1280) assert.ok(g.edit >= 640 && g.edit > g.help, label);
          if (width === 1920) assert.ok(g.sideBySide && g.edit > g.help, label);
        }
        previous = g;
      }
    }
    // Keep the viewport wide but constrain only the host's content area. A viewport breakpoint fails here.
    await frame.locator('main').evaluate(el => el.style.maxWidth = '1000px');
    const narrow = await geometry(frame);
    assert.ok(!narrow.sideBySide && narrow.edit >= 850, JSON.stringify(narrow));
    assert.deepEqual(writes, []);
  });
}

test('desktop rail collapses without navigating, persists and leaves the mobile menu independent', async t => {
  const {page} = await fixture(t, 1280);
  await page.goto(origin + '/admin/#tuning/event');
  const rail = page.locator('#workspaceRail'), main = page.locator('main'), toggle = page.locator('#railToggle');
  await page.locator('#pg-gifts').waitFor();
  const before = await main.boundingBox();
  await toggle.press('Enter');
  assert.equal(await toggle.getAttribute('aria-label'), '展开侧边栏');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(await rail.isHidden());
  assert.ok((await main.boundingBox()).width >= before.width + 210);
  assert.ok(page.url().endsWith('#tuning/event'));
  await page.reload(); await toggle.waitFor(); assert.ok(await rail.isHidden());
  await page.setViewportSize({width:390,height:800});
  assert.ok(await toggle.isHidden()); await page.locator('#navToggle').click();
  await page.locator('#rail a').first().waitFor();
  await page.setViewportSize({width:1280,height:800});
  await toggle.click(); assert.ok(await rail.isVisible());
  assert.equal(await toggle.getAttribute('aria-expanded'),'true');
  assert.equal((await main.boundingBox()).width,before.width);
});

test('mobile: all links by Tab; theme arrows, cancel, commit and persist; account actions', async t => {
  const {page, writes} = await fixture(t, 320);
  await page.goto(origin + '/admin/');
  const toggle = page.getByRole('button', {name:'菜单', exact:true});
  await toggle.waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await toggle.evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  const nav = page.getByRole('navigation', {name:'总类导航'});
  const names = ['总览','玩家管理','商店与库存','钓场与鱼口','水域与鱼种','钩子手感','鱼饵偏好','邮件','游戏参数','发布说明','关于','审计日志'];
  for (const name of names) {
    await page.keyboard.press('Tab');
    assert.ok(await nav.getByRole('link', {name, exact:true}).evaluate(el => el === document.activeElement && getComputedStyle(el).outlineStyle !== 'none'), name);
  }
  const theme = page.locator('#themeBtn');
  await theme.focus();
  await page.keyboard.press('ArrowDown');
  const current = (await theme.locator('#themeNow').textContent()).trim();
  assert.equal((await page.locator(':focus').textContent()).trim(), current);
  await page.keyboard.press('Escape');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await theme.getAttribute('aria-expanded'), 'false');
  assert.equal((await theme.locator('#themeNow').textContent()).trim(), current);
  await theme.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.reload();
  assert.equal((await theme.locator('#themeNow').textContent()).trim(), '深色 · 墨黑');
  await theme.click();
  assert.equal((await page.getByRole('option', {selected:true}).textContent()).trim(), '深色 · 墨黑');
  await page.keyboard.press('Escape');
  await toggle.click();
  await page.keyboard.press('Escape');
  assert.ok(await toggle.evaluate(el => el === document.activeElement && el.getAttribute('aria-expanded') === 'false'));
  await toggle.press('Enter');
  await nav.getByRole('link', {name:'玩家管理', exact:true}).press('Enter');
  await page.getByRole('heading', {name:'玩家管理', exact:true}).waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#mobilePage').innerText(), '玩家管理');
  await toggle.click();
  const account = page.locator('#railFoot');
  await account.getByRole('button', {name:'登录', exact:true}).click();
  await page.getByLabel('密码', {exact:true}).fill('fixture-password');
  await page.locator('.overlay').getByRole('button', {name:'登录', exact:true}).click();
  await page.waitForFunction(() => localStorage.getItem('rf4_admin_token') === 'layout-fixture' && document.querySelector('.who-out')?.textContent === '退出登录');
  await toggle.click();
  await account.getByRole('button', {name:'退出登录'}).click();
  await page.waitForFunction(() => !localStorage.getItem('rf4_admin_token') && document.querySelector('.who-out')?.textContent === '登录');
  await toggle.click();
  await account.getByRole('button', {name:'登录', exact:true}).waitFor();
  assert.deepEqual(writes, [['/api/login', {username:'admin', password:'fixture-password'}]]);
});

test('320px form labels stay readable and wide shelves scroll to the action column locally', async t => {
  const {page, writes} = await fixture(t, 320);
  await page.goto(origin + '/admin/#tuning/gameplay');
  const row = page.locator('.pblock .row:has(.lab):has(.ctrl)').first();
  await row.waitFor();
  assert.ok((await row.locator('.lab').boundingBox()).width > 160);
  assert.ok((await geometry(page)).firstControl);
  await page.getByRole('button', {name:'菜单'}).click();
  await page.getByRole('navigation', {name:'总类导航'}).getByRole('link', {name:'商店与库存'}).click();
  const table = page.locator('.tbl.shop');
  await table.locator('tbody tr').first().waitFor();
  const last = table.locator('tbody tr').first().locator('td').last();
  await last.scrollIntoViewIfNeeded();
  assert.ok(await table.evaluate(el => el.scrollLeft > 0 && el.scrollWidth > el.clientWidth));
  assert.ok(await last.evaluate(el => el.getBoundingClientRect().right <= innerWidth + 1));
  assert.ok(await page.evaluate(() => scrollX === 0 && document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(writes, []);
});
