// Exercise the shipping SPA; the isolated API fixture stores whole-row overrides in temporary SQLite.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const web = path.join(__dirname, 'web'), origin = 'http://shop.test/';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'shop-ui-'));
  // Node 22.12 needs the sqlite flag. Keep the normal `node --test` invocation usable.
  const sql = (stmt, ...args) => JSON.parse(execFileSync(process.execPath, ['--no-warnings', '--experimental-sqlite', '-e', `
    const db = new (require('node:sqlite').DatabaseSync)(process.argv[1]);
    const [stmt,...args] = JSON.parse(require('node:fs').readFileSync(0));
    console.log(JSON.stringify(db.prepare(stmt).all(...args))); db.close();`, path.join(dir, 'overrides.db')],
    { input: JSON.stringify([stmt, ...args]), encoding: 'utf8' }));
  sql('CREATE TABLE overrides(store_id TEXT, item_id TEXT, silver INTEGER NOT NULL, gold INTEGER NOT NULL, stock INTEGER NOT NULL, PRIMARY KEY(store_id,item_id))');
  sql("INSERT INTO overrides VALUES('B','bait_1',700,80,31)");
  const saved = () => sql('SELECT * FROM overrides ORDER BY store_id,item_id');
  const row = (store_id, item_id, name, base_silver, base_gold, base_stock) => ({ store_id, item_id, name, base_silver, base_gold, base_stock });
  const shelves = {
    A: [row('A', 'bait_1', '甲店饵', 111, 10, 11)],
    B: [row('B', 'bait_1', '乙店饵', 230, 0, 27), row('B', 'bait_2', '乙店钩', 450, 34, 64),
      ...Array.from({ length: 2000 }, (_, i) => row('B', 'm' + i, '普通商品' + i, 100, 0, 20)),
      row('B', 'zz_rare', '远端浮漂', 910, 0, 72)],
  };
  const browser = await chromium.launch({ headless: true, executablePath: process.env.RF4_TEST_BROWSER });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  t.after(async () => {
    try { await page.unrouteAll({ behavior: 'wait' }); await browser.close(); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  page.setDefaultTimeout(6000);
  await page.addInitScript(() => localStorage.setItem('rf4_admin_token', 'fixture'));
  const errors = [], writes = [], reads = [], fail = new Set();
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname, q = url.searchParams;
    const json = (value, status = 200) => route.fulfill({ status, json: value });
    if (p === '/') return route.fulfill({ path: path.join(web, 'index.html'), contentType: 'text/html' });
    if (p.startsWith('/app/')) return route.fulfill({ path: path.join(web, p) });
    if (p === '/api/me') return json({ username: 'admin' });
    if (p === '/api/stores') {
      const overrides = saved();
      return json(Object.keys(shelves).map(id => ({ store_id: id, map_key: id === 'A' ? '甲湖' : '乙湖',
        item_count: shelves[id].length, override_count: overrides.filter(x => x.store_id === id).length })));
    }
    if (p === '/api/stores/items') {
      const id = q.get('store_id'), needle = q.get('q') || '', limit = +q.get('limit');
      reads.push({ id, needle });
      const overrides = saved();
      return json((shelves[id] || []).filter(x => x.name.includes(needle) || x.item_id.includes(needle))
        .filter(x => q.get('overrides_only') !== '1' || overrides.some(o => o.store_id===id && o.item_id===x.item_id))
        .slice(0, limit > 0 && limit <= 2000 ? limit : 500).map(x => {
          const o = overrides.find(o => o.store_id === id && o.item_id === x.item_id);
          return { ...x, silver: o?.silver ?? x.base_silver, gold: o?.gold ?? x.base_gold,
            stock: (o?.stock ?? x.base_stock) || 1000, has_override: !!o };
        }));
    }
    if (req.method() === 'POST') {
      const data = req.postDataJSON(); writes.push({ p, data });
      const { store_id, item_id, silver, gold, stock } = data;
      if (fail.delete(item_id)) return json({ error: '夹具写入失败' }, 500);
      if (!shelves[store_id]?.some(x => x.item_id === item_id)) return json({ error: '不在货架' }, 400);
      if (p === '/api/stores/items/update') sql('INSERT OR REPLACE INTO overrides VALUES(?,?,?,?,?)', store_id, item_id, silver, gold, stock);
      else if (p === '/api/stores/items/reset') sql('DELETE FROM overrides WHERE store_id=? AND item_id=?', store_id, item_id);
      else return json({ error: 'unknown write' }, 404);
      return json({ ok: true });
    }
    return json({});
  });
  const button = name => page.getByRole('button', { name, exact: typeof name === 'string' });
  const field = name => page.getByRole('spinbutton', { name, exact: true });
  const submit = async () => { await button(/核对并保存/).click(); await button('保存').click(); };
  const status = text => page.locator('.work [role=status]').filter({ hasText: text }).waitFor();
  const search = async text => { await page.getByRole('searchbox').fill(text); await button('查询').click(); };
  return { page, button, field, submit, status, search, saved, reads, writes, fail, errors };
}

test('active shop: store dropdown, water locator, stock bookmark, reload and invalid target', async t => {
  const { page, field, submit, status, saved, reads, writes, errors } = await fixture(t);
  await page.goto(origin + '#shop');
  await field('甲店饵覆盖银价').waitFor();
  assert.equal(new URL(page.url()).hash, '#shop/A/price');
  const stable = await page.evaluateHandle(() => [document.querySelector('#view h1'), document.querySelector('#storeSel'), document.querySelector('input[type=search]')]);
  await page.locator('#storeSel').selectOption('B');
  await field('乙店饵覆盖银价').waitFor();
  assert.equal(new URL(page.url()).hash, '#shop/B/price');
  assert.ok(await stable.evaluate(nodes => nodes.every(n => n?.isConnected)), '切店不能重建页头、选店器或搜索框');
  await page.getByRole('link', { name: 'A', exact: true }).click();
  await field('甲店饵覆盖银价').waitFor();
  await page.getByLabel('按水域定位店铺').selectOption('乙湖');
  assert.equal(await page.locator('.shops tbody tr').count(), 1);
  await page.getByRole('cell', { name: '乙湖', exact: true }).click();
  await field('乙店饵覆盖银价').waitFor();
  const water = page.getByLabel('按水域定位店铺');
  assert.equal(await water.inputValue(), '乙湖');
  await water.selectOption('甲湖');
  await page.locator('#storeSel').selectOption('A');
  await field('甲店饵覆盖银价').waitFor();
  assert.equal(await water.inputValue(), '甲湖');
  await water.selectOption('乙湖');
  await page.locator('#storeSel').selectOption('B');
  await field('乙店饵覆盖银价').waitFor();
  assert.equal(await water.inputValue(), '乙湖');
  const stockTab = page.getByRole('link', { name: '库存', exact: true });
  assert.equal(decodeURIComponent(await stockTab.getAttribute('href')), '#shop/B/stock/乙湖');
  const readCount = reads.length;
  await field('乙店饵覆盖银价').fill('8.88');
  await stockTab.click();
  await field('乙店饵覆盖库存').waitFor();
  assert.equal(reads.length, readCount, '库存和价格共享同一批货架数据');
  await page.getByRole('link', { name:'货架价格', exact:true }).click();
  assert.equal(await field('乙店饵覆盖银价').inputValue(), '8.88');
  await buttonDiscard();
  async function buttonDiscard() { await page.getByRole('button', {name:'放弃修改',exact:true}).click(); }
  await stockTab.click();
  assert.ok(await stable.evaluate(nodes => nodes.every(n => n.isConnected)));
  await page.reload();
  const stock = field('乙店饵覆盖库存'); await stock.waitFor();
  assert.equal(await water.inputValue(), '乙湖');
  assert.equal(await page.locator('.shops tbody tr').count(), 1);
  await water.selectOption('');
  assert.equal(await page.locator('.shops tbody tr').count(), 2);
  assert.equal(new URL(page.url()).hash, '#shop/B/stock');
  assert.equal(await page.locator('#storeSel').inputValue(), 'B');
  assert.equal(await stockTab.getAttribute('aria-current'), 'page');
  await stock.fill('0'); await submit();
  await status('7 银 / 0.8 金 / 1000 件（覆盖）（立即生效）');
  assert.deepEqual(writes, [{ p: '/api/stores/items/update', data: { store_id: 'B', item_id: 'bait_1', silver: 700, gold: 80, stock: 0 } }]);
  assert.deepEqual(saved(), [writes[0].data]);
  await stock.waitFor(); assert.equal(await stock.inputValue(), '1000');
  const before = reads.length;
  await page.goto(origin + '#shop/missing/stock');
  await page.getByText('找不到店铺：missing').waitFor();
  assert.equal(await page.locator('#storeSel').inputValue(), '');
  assert.equal(await page.getByRole('spinbutton').count(), 0);
  assert.equal(reads.length, before); assert.deepEqual(errors, []);
});

test('active shop: name search beyond API cap, hidden drafts, blank vs zero, partial success and retry', async t => {
  const { page, field, submit, status, search, saved, reads, writes, fail, errors } = await fixture(t);
  await page.goto(origin + '#shop/B/price');
  await field('乙店饵覆盖银价').waitFor();
  await page.getByLabel('只看改过的').check();
  await field('乙店钩覆盖银价').waitFor({state:'hidden'});
  await page.getByLabel('只看改过的').uncheck();
  await field('乙店饵覆盖银价').fill(''); // snapshot the base, not 0 or a reset
  await field('乙店钩覆盖银价').fill('0');
  assert.equal(await field('远端浮漂覆盖金币价').count(), 0);
  await search('远端');
  const gold = field('远端浮漂覆盖金币价'); await gold.waitFor();
  assert.equal(await gold.locator('..').innerText(), '金');
  assert.ok(reads.some(x => x.id === 'B' && x.needle === '远端'));
  assert.equal(await field('乙店饵覆盖银价').count(), 0);
  await gold.fill('1.23'); fail.add('zz_rare'); await submit();
  await status(/成功：乙店饵.*乙店钩.*待重试：远端浮漂/);
  const values = [
    { store_id: 'B', item_id: 'bait_1', silver: 230, gold: 80, stock: 31 },
    { store_id: 'B', item_id: 'bait_2', silver: 0, gold: 34, stock: 64 },
    { store_id: 'B', item_id: 'zz_rare', silver: 910, gold: 123, stock: 72 },
  ];
  assert.deepEqual(saved(), values.slice(0, 2));
  assert.deepEqual(writes.map(w => w.data), values);
  await gold.waitFor(); assert.equal(await gold.inputValue(), '1.23');
  await submit(); await status('9.1 银 / 1.23 金 / 72 件（覆盖）');
  assert.deepEqual(writes.map(w => w.data), [...values, values[2]]);
  assert.deepEqual(saved(), values); assert.deepEqual(errors, []);
  await search(''); await field('乙店饵覆盖银价').waitFor();
  await page.getByLabel('只看改过的').check(); await field('远端浮漂覆盖金币价').waitFor();
  assert.equal(await field('远端浮漂覆盖金币价').inputValue(),'1.23');
});

test('active shop: cancelling or confirming a whole-item reset preserves other drafts', async t => {
  const { page, button, field, submit, status, saved, writes, errors } = await fixture(t);
  await page.goto(origin + '#shop/B/price');
  const other = field('乙店钩覆盖金币价'); await other.fill('2.34');
  const reset = page.getByRole('row').filter({ hasText: '乙店饵' }).getByRole('button', { name: '恢复默认' });
  await reset.click(); await page.getByText(/同时恢复银价、金币价和库存/).waitFor();
  await button('取消').click(); assert.equal(writes.length, 0);
  await reset.click(); await button('恢复').click();
  await status('2.3 银 / 0 金 / 27 件（默认）'); await other.waitFor();
  assert.deepEqual(writes, [{ p: '/api/stores/items/reset', data: { store_id: 'B', item_id: 'bait_1' } }]);
  assert.deepEqual(saved(), []); assert.equal(await other.inputValue(), '2.34');
  await submit(); await status('4.5 银 / 2.34 金 / 64 件（覆盖）');
  assert.deepEqual(saved(), [{ store_id: 'B', item_id: 'bait_2', silver: 450, gold: 234, stock: 64 }]);
  assert.deepEqual(errors, []);
});
