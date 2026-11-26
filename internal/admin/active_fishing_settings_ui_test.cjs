const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

async function fixture(t, handler) {
  const browser = await chromium.launch({ executablePath: process.env.RF4_TEST_BROWSER });
  t.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(() => localStorage.setItem('rf4_admin_token', 'fixture'));
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname === '/' || url.pathname.startsWith('/app/')) {
      return route.fulfill({ path: path.join(__dirname, 'web', url.pathname === '/' ? 'index.html' : url.pathname) });
    }
    if (!url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, body: '' });
    const response = handler(url, req) || { json: url.pathname === '/api/me' ? { username: 'admin' } : {} };
    return route.fulfill(response);
  });
  return page;
}
const go = (page, hash) => page.goto('http://localhost/#' + hash);
const button = (root, name) => root.getByRole('button', { name, exact: true });
const values = inputs => inputs.evaluateAll(nodes => nodes.map(n => Number(n.value)));

test('R1: grade draft, factory reset, all-zero check and retry only unconfirmed keys', async t => {
  const keys = ['below', 'qualified', 'trophy', 'super'].map(k => 'grade_pct_' + k);
  const saved = [10, 50, 30, 10];
  const settings = Object.fromEntries(keys.map((k, i) => [k, String(saved[i])]));
  const writes = [];
  const page = await fixture(t, (url, req) => {
    if (req.method() === 'POST') {
      const { key, value } = req.postDataJSON(); writes.push(key || url.pathname);
      if (writes.length === 2) return { status: 500, json: { error: 'fixture failure' } };
      settings[key] = value;
    }
    return { json: url.pathname === '/api/tunables' ? settings : {} };
  });
  await go(page, 'rules/grade');
  const inputs = page.getByRole('spinbutton'), sliders = page.locator('.grade-slider');
  await inputs.first().fill('12.5');
  await page.getByRole('link', { name: 'Выдача рыбы и трофеи', exact: true }).click();
  await page.getByRole('link', { name: 'Прочее', exact: true }).click();
  await button(page.getByRole('dialog'), 'Отмена').click();
  assert.equal(await page.locator('#tabs [aria-current]').innerText(), 'Выдача рыбы и трофеи');
  await page.getByRole('button', { name: /Четыре этапа охоты/ }).click();
  await button(page.getByRole('dialog'), 'Отмена').click();
  assert.equal(await inputs.first().inputValue(), '12.5');
  await button(page, 'Сбросить всю группу к заводским').click();
  assert.deepEqual(await values(inputs), [3, 87.5, 9, 0.5]);
  await button(page, 'Отменить').click();
  assert.deepEqual(await values(inputs), saved);
  assert.deepEqual(await values(sliders), saved);
  assert.deepEqual(await page.locator('.grade-ratio-track > div > div').evaluateAll(nodes => nodes.map(n => parseFloat(n.style.width))), saved);
  for (const input of await inputs.all()) await input.fill('0');
  await button(page, 'Сохранить изменения').click();
  await page.getByText(/суммарный вес не может быть 0/, { exact: true }).waitFor();
  assert.deepEqual(writes, []);
  await button(page, 'Сбросить всю группу к заводским').click();
  await button(page, 'Сохранить изменения').click();
  await page.getByText(/Сохранение подтверждено: Доли четырёх категорий · Незачётная; ожидают повтора: Доли четырёх категорий · Зачётная/).waitFor();
  await button(page, 'Сохранить изменения').click();
  await page.locator('.savebar.on').waitFor({ state: 'hidden' });
  assert.deepEqual(writes, [keys[0], keys[1], ...keys.slice(1)]);
});

test('W1: failed and expired targets are read-only; filtered saves only upsert matched rows', async t => {
  const setting = { bite_probability: 1, bite_delay_fixed: 0, bite_delay_scale: 1, bite_delay_max: 20, bite_delay_lure_max: 6 };
  const fish = [{ fish_key: 'red', name_zh: '红鱼', enabled: true, weight: 4, base_weight: 4, weight_source: 'official', bait_enabled: true,
    bait_groups: [['甲'], ['乙']], bait_rotate_mode: 'strict', bait_rotate_sec: 600 }, { fish_key: 'blue', name_zh: '蓝鱼', enabled: true, weight: 1, base_weight: 1, weight_source: 'static' }];
  const reads = [], posts = [];
  let outcome = 'failure';
  const page = await fixture(t, (url, req) => {
    if (url.pathname === '/api/fish/areas') return { json: ['甲湖', '乙湖'].map(loc => ({ loc, fish_count: 2 })) };
    if (url.pathname === '/api/fish/zones') return { json: { zones: [] } };
    if (url.pathname === '/api/bait/prefs') return { json: { rows: [{ fish_key: 'red', rotation: { enabled: true, active: 0, next_switch: 1800000000 } }] } };
    if (req.method() === 'POST') {
      const body = req.postDataJSON(); posts.push([url.pathname, body]);
      if (url.pathname === '/api/fish/config') for (const f of body.fish) Object.assign(fish.find(r => r.fish_key === f.fish_key), f, { weight_source: 'manual' });
      if (url.pathname === '/api/fish/config/reset') Object.assign(fish[0], { enabled: true, weight_source: 'official' });
      return { json: {} };
    }
    if (url.pathname === '/api/fish/config') {
      const loc = url.searchParams.get('loc'); reads.push(loc);
      if (outcome === 'failure') return { status: 500, json: { error: 'failed' } };
      return { json: { area: outcome === 'mismatch' ? '甲湖' : loc, setting, fish: outcome === 'empty' ? [] : fish } };
    }
  });
  await go(page, 'waters/过期');
  await page.getByText(/Водоём «过期» больше недоступен/).waitFor();
  assert.deepEqual(reads, []);
  await button(page, '乙湖').click();
  await page.getByText('Не удалось прочитать настройки водоёма').waitFor();
  for (const action of ['Добавить вид', 'Сбросить']) assert.equal(await button(page, action).count(), 0);
  outcome = 'mismatch';
  await button(page, 'Повторить').click();
  await page.waitForFunction(() => document.querySelector('#view')?.inert === false);
  assert.equal(await button(page, 'Сбросить').count(), 0);
  outcome = 'empty'; await button(page, 'Повторить').click();
  await page.locator('tbody').getByText('Список видов пуст').waitFor();
  outcome = 'ok'; await page.reload();
  await page.getByText('Недельная статистика', { exact: true }).waitFor();
  await page.getByText(/Ротация 2 групп · Строгий · При чтении — группа № 1 · следующая смена/).click();
  await page.getByText('№ 2: 乙').waitFor();
  assert.equal(await button(page, 'Убрать').count(), 0);
  const search = page.getByPlaceholder('Фильтр по названию рыбы');
  await search.fill('Нет подходящих рыб');
  assert.equal(await button(page, 'Отключить подходящие (0)').isDisabled(), true);
  await search.fill('红'); await button(page, 'Отключить подходящие (1)').click();
  assert.equal(await page.getByLabel('Включено 红鱼').isChecked(), false);
  assert.deepEqual(posts, []);
  outcome = 'failure'; // Save succeeds, but its readback fails.
  await button(page, 'Сохранить изменения').click();
  await page.getByText('Не удалось прочитать настройки водоёма').waitFor();
  assert.equal(await page.locator('.savebar.on').count(), 0);
  outcome = 'ok'; await button(page, 'Повторить').click();
  await page.getByText('Ручное переопределение', { exact: true }).waitFor();
  assert.deepEqual(posts, [['/api/fish/config', { area: '乙湖', setting, fish: [{ fish_key: 'red', weight: 4, enabled: false }] }]]);
  assert.equal(await page.getByLabel('Включено 蓝鱼').isChecked(), true);
  await button(page, 'Сбросить').click();
  const dialog = page.getByRole('dialog'); await dialog.getByText(/настройки клёва и ручные веса видов/).waitFor();
  await button(dialog, 'Сбросить').click();
  await page.getByText('Недельная статистика', { exact: true }).waitFor();
  assert.deepEqual(posts[1], ['/api/fish/config/reset', { area: '乙湖' }]);
  assert.equal(await page.getByLabel('Включено 红鱼').isChecked(), true);
  assert.ok(reads.length >= 6 && reads.every(loc => loc === '乙湖'));
});

test('H1: size survives searches and navigation; reset, invalid input and failed save stay in model dialog', async t => {
  const profile = { item_id: 'ultra33', family: 'treble', brand: 'ultra', size: 33, strength_kg: 1, length_mm: 1, entry_capacity_g: 100,
    solid_scale: 1.2, hold_scale: 1, small_fish_floor: 0.2, over_capacity_hold_floor: 0.3 };
  const queries = [], posts = [];
  const page = await fixture(t, (url, req) => {
    if (url.pathname !== '/api/hooks/profiles') return;
    if (req.method() === 'POST') {
      posts.push(req.postDataJSON());
      if (posts.length === 1) return { status: 500, json: { error: '保存中断' } };
      Object.assign(profile, posts[1]); return { json: {} };
    }
    const size = url.searchParams.get('size'), q = url.searchParams.get('q'); queries.push([size, q]);
    return { json: size === '33' ? { total: 1, profiles: [profile] } : { total: 501, profiles: [{ ...profile, item_id: 'first', size: 1 }] } };
  });
  await go(page, 'hooks');
  await page.getByText('first', { exact: true }).waitFor();
  await page.getByLabel('Номер крючка').selectOption('33');
  await page.getByPlaceholder(/Поиск модели/).fill('ultra');
  await page.waitForRequest(r => r.url().includes('q=ultra'));
  await page.getByRole('link', { name: 'Параметры игры → Ловля → Рыба' }).click();
  await page.locator('#pg-fish').waitFor();
  assert.equal(new URL(page.url()).hash, '#tuning/gameplay');
  await page.waitForFunction(() => Math.abs(document.getElementById('pg-fish').getBoundingClientRect().top) < 120);
  await page.goBack();
  await page.getByText('ultra33', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Номер крючка').inputValue(), '33');
  assert.equal(await page.getByPlaceholder(/Поиск модели/).inputValue(), 'ultra');
  assert.deepEqual(queries.at(-1), ['33', 'ultra']);
  await page.getByText(/Минимум для мелкой рыбы ×?0.2 · Минимум для крупной рыбы ×?0.3/).waitFor();
  await button(page, 'Настроить').click();
  const dialog = page.locator('.side-page'), inputs = dialog.getByRole('textbox');
  await button(dialog, 'Сбросить').click();
  assert.deepEqual(await values(inputs), [1, 1, 0, 0]);
  await inputs.last().fill('invalid');
  await button(dialog, 'Сохранить').click();
  await dialog.getByText('Введите число').waitFor(); assert.deepEqual(posts, []);
  await inputs.last().fill('0.4'); await button(dialog, 'Сохранить').click();
  await dialog.getByRole('alert').waitFor();
  assert.equal(await inputs.last().inputValue(), '0.4');
  await button(dialog, 'Сохранить').click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText(/Минимум для мелкой рыбы ×?0 · Минимум для крупной рыбы ×?0.4/).waitFor();
  assert.deepEqual(posts, Array(2).fill({ item_id: 'ultra33', solid_scale: 1, hold_scale: 1, small_fish_floor: 0, over_capacity_hold_floor: 0.4 }));
});
