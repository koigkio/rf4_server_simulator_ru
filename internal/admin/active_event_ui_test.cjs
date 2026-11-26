// Default admin entry, production modules/styles/presets, isolated tunables API.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const web = path.join(__dirname, 'web');
const presets = ['anniversary-2024', 'anniversary-2025', 'anniversary-2026', 'newyear-2025', 'newyear-2026'];
const resource = id => JSON.parse(fs.readFileSync(path.join(web, 'event-reward-presets', id + '.json')));
const item = (item, qty) => [{ item, qty }];
const initial = { 11: { 0: item('untouched', 3) }, 19: { 0: item('completion', 4) } };
const G = 'event_stage_gifts';
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.RF4_TEST_BROWSER }); });
after(async () => { await browser?.close(); });

async function open(t, overrides = {}) {
  const values = { event_newyear_enabled: '0', event_anniversary_enabled: '1', event_branches: '19,20', [G]: JSON.stringify(initial), ...overrides };
  const writes = [], files = [], errors = [], requests = [], faults = {};
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', timezoneId: 'UTC' });
  await context.addInitScript(() => localStorage.setItem('rf4_admin_token', 'fixture'));
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.on('pageerror', err => errors.push(err.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  await page.route('**/*', route => {
    const req = route.request(), { pathname: p, searchParams } = new URL(req.url());
    const json = (value, status = 200) => route.fulfill({ json: value, status });
    if (req.method() !== 'GET') {
      const body = req.postDataJSON();
      writes.push([p, body]);
      if (p !== '/admin/api/tunables' || req.method() !== 'POST') return json({ error: 'unexpected write' }, 400);
      requests.push('POST:' + body.key);
      if (faults.lost === body.key) {
        delete faults.lost; values[body.key] = body.value;
        return json({ error: '响应丢失' }, 500);
      }
      if (faults.write === body.key) {
        Object.assign(values, faults.actual || {});
        return json({ error: '写入故障' }, 500);
      }
      values[body.key] = body.value;
      if (body.key === 'event_newyear_enabled' && body.value === '1') values.event_anniversary_enabled = '0';
      if (body.key === 'event_anniversary_enabled' && body.value === '1') values.event_newyear_enabled = '0';
      return json({ ok: true });
    }
    if (p === '/admin/api/tunables') { requests.push('GET'); return json(values); }
    if (p === '/admin/api/me') return json({ username: 'admin' });
    if (p === '/admin/api/catalog/items') return json(searchParams.get('complete_only') === '1' ? [{ item_id: 'coffee', name: '测试咖啡' }] : []);
    if (p.startsWith('/admin/api/')) return json({});
    if (p.startsWith('/admin/event-reward-presets/')) {
      const id = path.basename(p, '.json'); files.push(id);
      if (!presets.includes(id)) return json({}, 404);
      if (faults.file === id) return json({}, 503);
      return json(resource(id));
    }
    if (p === '/admin/' || p.startsWith('/admin/app/')) {
      const file = path.join(web, p.slice(7) || 'index.html');
      if (fs.existsSync(file)) return route.fulfill({ path: file });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://127.0.0.1:19214/admin/#tuning/event');
  await page.getByRole('heading', { name: '游戏参数', exact: true }).waitFor();
  const button = name => page.getByRole('button', { name, exact: true });
  const status = text => page.locator('#view [role=status]').filter({ hasText: text }).waitFor();
  const preview = async () => JSON.parse(await page.getByLabel('奖励保存内容', { exact: true }).textContent());
  const select = (label, value) => page.getByRole('combobox', { name: new RegExp(label) }).selectOption(value);
  return { page, values, writes, files, requests, faults, button, status, preview, select };
}

test('活动分支在宽窄屏均紧邻标签，点击文字及键盘切换只修改草稿', async t => {
  const { page, writes } = await open(t);
  for (const width of [1920, 1280, 768, 320]) {
    await page.setViewportSize({ width, height: 800 });
    const bounds = await page.locator('#pg-branch label').evaluateAll(labels => labels.map(label => {
      const input = label.querySelector('input').getBoundingClientRect();
      const text = document.createRange(); text.selectNodeContents(label.querySelector('span'));
      const rect = text.getBoundingClientRect();
      return {gap:rect.left-input.right, lines:text.getClientRects().length, right:rect.right, limit:label.getBoundingClientRect().right};
    }));
    assert.equal(bounds.length, 12);
    for (const b of bounds) assert.ok(b.gap >= 4 && b.gap <= 12 && b.lines === 1 && b.right <= Math.min(width,b.limit)+1, JSON.stringify({width,...b}));
  }
  const group = page.getByRole('group',{name:'2024 新年',exact:true});
  const extra = group.getByRole('checkbox',{name:'MMXXIV EXTRA',exact:true});
  await group.getByText('MMXXIV EXTRA',{exact:true}).click();
  assert.ok(await extra.isChecked());
  await extra.press('Space');
  assert.ok(!await extra.isChecked());
  assert.deepEqual(writes, []);
});

test('奖励基线已变时保留草稿且不覆盖另一个编辑器的保存', async t => {
  const { values, writes, button, status, preview } = await open(t);
  await button('填入所选预设').click();
  await status('已填入 15 个空白阶段');
  const draft = await preview();
  values[G] = JSON.stringify({19:{1:item('external', 3)}});
  await button('保存修改').click();
  await status('本次未写入');
  assert.deepEqual(writes, []);
  assert.deepEqual(await preview(), draft);
});

test('九周年只补 14 个空阶段，再补 0；草稿、禁用分支及阶段 0 保存回读', async t => {
  const { page, values, writes, requests, button, status, preview, select } = await open(t);
  await button('添加物品').click();
  await page.getByPlaceholder(/输入物品名称或 ID/).fill('coffee');
  await page.getByText('测试咖啡', { exact: true }).click();
  await page.getByLabel('数量', { exact: true }).fill('7');
  await page.getByText('预览奖励保存内容', { exact: true }).click();
  await button('填入所选预设').click(); await status('已填入 14 个空白阶段');
  const expected = resource('anniversary-2026');
  expected[11] = initial[11]; expected[19][0] = initial[19][0]; expected[19][1] = item('coffee', 7);
  assert.deepEqual(await preview(), expected);
  await button('填入所选预设').click(); await status('已填入 0 个空白阶段');
  assert.deepEqual(await preview(), expected);
  assert.deepEqual(writes, []);
  assert.deepEqual(JSON.parse(values[G]), initial);
  await select('奖励分支', '20'); await select('奖励阶段', '0');
  await button('保存修改').click(); await status('已保存并回读。请重启游戏客户端并重新登录。');
  assert.deepEqual(requests.slice(-2), ['POST:' + G, 'GET']);
  assert.deepEqual(writes.map(([p, w]) => [p, w.key, JSON.parse(w.value)]), [['/admin/api/tunables', G, expected]]);
  assert.equal(await page.getByLabel(/奖励分支/).inputValue(), '20');
  assert.equal(await page.getByLabel(/奖励阶段/).inputValue(), '0');
  assert.equal(await page.getByLabel('数量', { exact: true }).inputValue(), '1');
  await page.reload(); await page.locator('#pg-gifts').waitFor();
  assert.equal(await page.getByLabel(/奖励阶段/).inputValue(), '0');
  assert.deepEqual(await preview(), expected);
  await button('清空可选分支奖励').click();
  assert.deepEqual(await preview(), { 11: initial[11] });
  await button('放弃').click(); assert.deepEqual(await preview(), expected);
  assert.equal(writes.length, 1);
});

test('五套资源单独填入；全部预设遇到读取失败时一项也不填', async t => {
  const { page, faults, files, writes, button, preview, select, status } = await open(t, { event_branches: '9,10,11,13,15,17,18,19', [G]: '{}' });
  // Independent selection and counts (disabled extra branches must stay absent).
  const selected = [['11'], ['15'], ['19'], ['13'], ['17', '18']];
  const all = {};
  for (const [i, id] of presets.entries()) {
    await select('奖励预设', id);
    await button('填入所选预设').click(); await status(`已填入 ${i === 4 ? 19 : 8} 个空白阶段`);
    const file = resource(id), expected = Object.fromEntries(selected[i].map(b => [b, file[b]]));
    Object.assign(all, expected);
    assert.deepEqual(await preview(), expected);
    assert.equal(files.at(-1), id);
    await button('放弃').click(); assert.deepEqual(await preview(), {});
  }
  await select('奖励分支', '18');
  assert.equal(await page.getByLabel(/奖励阶段/).locator('option').count(), 11);
  await select('奖励预设', 'all');
  faults.file = 'newyear-2026';
  await button('填入所选预设').click(); await status('预设读取失败');
  assert.deepEqual(await preview(), {});
  delete faults.file;
  await button('填入所选预设').click(); await status('已填入 51 个空白阶段');
  assert.deepEqual(await preview(), all);
  assert.deepEqual(files.slice(-5).sort(), [...presets].sort());
  assert.deepEqual(writes, []);
});

test('数量、移除、时间及分支均可放弃；切页和切换活动保护草稿，失败按实际模式回显', async t => {
  const { page, writes, requests, values, faults, button, select, preview, status } = await open(t);
  const date = page.getByLabel('活动结束时间'), box = page.getByRole('checkbox', { name: 'VIII', exact: true });
  const originalDate = await date.inputValue();
  const rewardTab = page.getByRole('link', { name: '收益与通知', exact: true });
  await select('奖励阶段', '0'); await page.getByLabel('数量').fill('8');
  await rewardTab.click(); await button('取消').click();
  assert.equal(await page.getByRole('link', { name: '限时活动', exact: true }).getAttribute('aria-current'), 'page');
  assert.equal(new URL(page.url()).hash, '#tuning/event');
  assert.equal((await preview())[19][0][0].qty, 8);
  const remove = button('移除物品 completion');
  assert.equal(await remove.innerText(), '移除');
  const glyph = await remove.locator('svg').boundingBox();
  assert.ok(glyph && glyph.width >= 16 && glyph.height >= 16);
  await remove.click(); assert.deepEqual(await preview(), { 11: initial[11] }); assert.deepEqual(writes, []);
  await box.check(); await date.fill('2028-01-12T10:30');
  await button('放弃').click();
  assert.equal(await box.isChecked(), false); assert.equal(await date.inputValue(), originalDate);
  assert.deepEqual(await preview(), initial); assert.ok(await button('保存修改').isDisabled());
  await box.check(); await date.fill('2028-01-12T10:30'); await page.getByLabel('数量').fill('9');
  const next = page.getByRole('radio', { name: '新年活动' });
  await next.click(); await button('取消').click();
  assert.deepEqual(writes, []); assert.equal((await preview())[19][0][0].qty, 9);
  await button('保存修改').click(); await status('已保存并回读。服务端最多 30 秒生效；请重启游戏客户端并重新登录。');
  assert.equal(values.event_branches, '15,19,20');
  assert.equal(values.event_anniversary_end_unix, String(Date.UTC(2028, 0, 12, 10, 30) / 1000));
  assert.equal(JSON.parse(values[G])[19][0][0].qty, 9);
  assert.equal(writes.length, 3); assert.ok(await box.isChecked());
  // Simulate server-side mode changing even though this POST failed: do not
  // leave the optimistic selection, or just roll back to the old local mode.
  faults.write = 'event_newyear_enabled'; faults.actual = { event_anniversary_enabled: '0' };
  await next.click(); await status('切换失败');
  assert.deepEqual(requests.slice(-2), ['POST:event_newyear_enabled', 'GET']);
  assert.ok(await page.getByRole('radio', { name: '不开启' }).isChecked());
  assert.equal(await next.isChecked(), false); await page.getByText('还没有开启活动', { exact: true }).waitFor();
  assert.equal(await button('填入所选预设').count(), 0); assert.ok(await button('保存修改').isDisabled());
  await box.uncheck(); await rewardTab.click(); await button('放弃并切换').click();
  await page.getByText('经验与奖励', { exact: true }).first().waitFor();
  assert.equal(new URL(page.url()).hash, '#tuning/reward');
  await page.getByRole('link', { name: '限时活动', exact: true }).click();
  await box.waitFor(); assert.ok(await box.isChecked()); assert.equal(writes.length, 4);
});

test('显式空分支不可编辑奖励；只保存分支后才出现奖励编辑器', async t => {
  const { page, writes, button, select, status } = await open(t, { event_branches: '' });
  await page.getByText('还没有选择活动分支', { exact: true }).waitFor();
  assert.equal(await button('添加物品').count(), 0);
  assert.equal(await button('填入所选预设').count(), 0);
  await page.getByRole('checkbox', { name: 'IX', exact: true }).check();
  assert.equal(await button('添加物品').count(), 0);
  await button('保存修改').click(); await status('已保存并回读');
  await select('奖励阶段', '0'); assert.equal(await page.getByLabel('数量').inputValue(), '4');
  assert.deepEqual(writes, [['/admin/api/tunables', { key: 'event_branches', value: '19' }]]);
});

test('切换失败回读后仍用奖励草稿的原始基线检查冲突', async t => {
  const base = {19:{1:item('A',1)}};
  const {page,button,faults,writes,values,status,preview} = await open(t,{[G]:JSON.stringify(base)});
  await page.getByLabel('数量',{exact:true}).fill('5');
  const external = {19:{0:item('external',1),1:item('A',1)}};
  faults.write = 'event_newyear_enabled'; faults.actual = {[G]:JSON.stringify(external)};
  await page.getByRole('radio',{name:'新年活动'}).click(); await button('放弃并切换').click();
  await status('切换失败'); await button('保存修改').click(); await status('本次未写入');
  assert.deepEqual(await preview(),{19:{1:item('A',5)}});
  assert.deepEqual(JSON.parse(values[G]),external); assert.equal(writes.length,1);
  await button('放弃').click(); assert.deepEqual(await preview(),external);
});

test('选物品期间切到另一阶段，过期选择不修改任何阶段', async t => {
  const base = {19:{1:item('A',1),2:item('B',2)}};
  const {page,button,select,writes,preview} = await open(t,{[G]:JSON.stringify(base)});
  await button('添加物品').click(); await page.getByPlaceholder(/输入物品名称或 ID/).fill('coffee');
  await select('奖励阶段','2'); await page.getByText('测试咖啡',{exact:true}).click();
  assert.deepEqual(await preview(),base); assert.deepEqual(writes,[]);
});

test('读取 null 奖励时显示空阶段且不回写', async t => {
  const {page,writes,preview,button} = await open(t,{[G]:'null'});
  await page.getByText('这个阶段没有额外奖励',{exact:true}).waitFor();
  assert.deepEqual(await preview(),{}); assert.ok(await button('保存修改').isDisabled()); assert.deepEqual(writes,[]);
});

test('保存失败留下待重试项，不重复写入已经成功的奖励', async t => {
  const { page, faults, writes, button, select, status } = await open(t);
  const extra = page.getByRole('checkbox', { name: 'VIII', exact: true });
  await select('奖励阶段', '0'); await page.getByLabel('数量').fill('12'); await extra.check();
  faults.write = 'event_branches';
  await button('保存修改').click(); await status('保存失败');
  assert.ok(await extra.isChecked()); assert.ok(await button('保存修改').isEnabled());
  assert.equal(await page.getByLabel('数量').inputValue(), '12');
  delete faults.write;
  await button('保存修改').click(); await status('已保存并回读');
  assert.deepEqual(writes.map(([, w]) => w.key), [G, 'event_branches', 'event_branches']);
  assert.equal(await page.getByLabel(/奖励阶段/).inputValue(), '0');
  assert.ok(await button('保存修改').isDisabled());
});

test('写入成功但响应丢失：重试先回读，已生效项不当成外部冲突、也不重写', async t => {
  const { page, faults, writes, button, select, status } = await open(t);
  const extra = page.getByRole('checkbox', { name: 'VIII', exact: true });
  await select('奖励阶段', '0'); await page.getByLabel('数量').fill('12'); await extra.check();
  faults.lost = 'event_branches';
  await button('保存修改').click(); await status('保存失败');
  await button('保存修改').click(); await status('已保存并回读');
  assert.deepEqual(writes.map(([, w]) => w.key), [G, 'event_branches']);
  assert.ok(await button('保存修改').isDisabled());
});

test('奖励写入响应丢失后只重试仍等于原基线的剩余项', async t => {
  const { page, faults, writes, button, select, status } = await open(t);
  const extra = page.getByRole('checkbox', { name: 'VIII', exact: true });
  await select('奖励阶段', '0'); await page.getByLabel('数量').fill('12'); await extra.check();
  faults.lost = G;
  await button('保存修改').click(); await status('保存失败');
  assert.deepEqual(writes.map(([, w]) => w.key), [G]);
  await button('保存修改').click(); await status('已保存并回读');
  assert.deepEqual(writes.map(([, w]) => w.key), [G, 'event_branches']);
});
