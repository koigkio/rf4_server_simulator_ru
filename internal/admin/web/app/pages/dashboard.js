import { h, api, apiList, fmt, tsNum, timeText, clockText, icon, navigate, empty, pageHead, work, ib, h2s, h3s, hint, note, kv, bullets, pill, brief, tbl, logsBlock, startGrid, searchBox, btn, render } from '../core.js';
import { auditLabel } from '../labels.js';
import { updateBanner, buildLabel, themeMenu } from '../main.js';

// 演示页的「从这里开始」是一条一条完整流程：看现状 → 改 → 核对。
const STARTS = [
  ['rules', 'hook', 'Скорость клёва', 'Время до поклёвки, поплавок и сход настраиваются отдельно'],
  ['waters', 'water', 'Рыба на водоёмах', 'Какая рыба и сколько её на каждом водоёме'],
  ['bait', 'bait', 'Предпочтения наживки', 'Что сейчас ест каждая рыба — после изменения обновите'],
  ['shop', 'store', 'Цены в магазине', 'Правьте цены и наличие по одному товару, до сохранения можно отменить'],
  ['players', 'users', 'Игроки', 'Профиль, имущество, садок, навыки, почта'],
];
const RULES = [
  ['fish_bait_rules_enabled', 'Рыба выбирает наживку'], ['fish_distribution_enabled', 'Распределение стай'], ['fish_weather_enabled', 'Погода и температура воды'],
  ['fish_ecology_enabled', 'Повадки рыб'], ['bite_gate_enabled', 'Подходящая наживка'], ['happy_hour_enabled', 'Счастливый час'],
];

export default async function dashboard() {
  const [d, audits, tuns, mode, stores] = await Promise.all([
    api('/api/dashboard'),
    apiList('/api/audit?limit=24').catch(() => []),
    api('/api/tunables').catch(() => ({})),
    api('/api/fish/bite_mode').catch(() => ({})),
    apiList('/api/stores').catch(() => []),
  ]);

  const modeName = { realistic: 'Реальный клёв', legacy: 'Полностью случайно (старый режим)', mixed: 'Своё' }[mode.mode] || 'Нет данных';
  const on = (k) => (tuns[k] === undefined ? k === 'happy_hour_enabled' : tuns[k] === '1');
  const enabled = RULES.filter(([k]) => on(k)).map(([, n]) => n);
  const overrideCount = stores.reduce((n, s) => n + (s.override_count || 0), 0);
  const pg = d.pg || '';
  const port = location.port || '9500';

  const updates = [...audits]
    .sort((a, b) => tsNum(b.TS ?? b.ts) - tsNum(a.TS ?? a.ts))
    .map((e) => ({
      ts: e.TS ?? e.ts,
      admin: e.Admin ?? e.admin ?? '',
      what: auditLabel(e.Action ?? e.action),
      target: (e.Target ?? e.target) || '',
      detail: (e.Detail ?? e.detail) || '',
    }));

  // 关键口径：只写能从接口读出来的东西，读不到就不出现。
  const canons = [];
  canons.push(['Режим выдачи рыбы', mode.spawn_mode === 'tier' ? 'Соотношение категорий' : (mode.spawn_mode || modeName), 'rules']);
  if (tuns.grade_pct_qualified !== undefined) {
    canons.push(['Доли четырёх категорий', `Незачётная ${tuns.grade_pct_below || '0'}% · Зачётная ${tuns.grade_pct_qualified}% · Трофей ${tuns.grade_pct_trophy || '0'}% · Синяя корона ${tuns.grade_pct_super || '0'}%`, 'rules']);
  }
  if (tuns.bite_delay_max !== undefined) {
    canons.push(['Ритм клёва', `Обычный предел ${tuns.bite_delay_max} с${tuns.bite_delay_lure_max ? ' / Предел для наживки ' + tuns.bite_delay_lure_max + ' с' : ''}`, 'rules']);
  }
  canons.push(['Переключатели игры', enabled.length ? enabled.join(' · ') : 'Всё выключено', 'rules']);
  if (stores.length) canons.push(['Переопределения магазина', overrideCount ? `${overrideCount} товаров с изменённой ценой` : 'Переопределений нет, все по базовой цене', 'shop']);
  canons.push(['Подходящая наживка', on('bite_gate_enabled') ? 'Вкл: на неподходящую наживку не клюёт' : 'Выкл: клюёт, если наживка помещается в рот', 'bait']);

  const search = { q: '' };
  const logsBox = h('div', {});
  const drawLogs = () => {
    const q = search.q.trim().toLowerCase();
    const rows = updates.filter((u) => !q || (u.what + u.target + u.admin + u.detail).toLowerCase().includes(q)).slice(0, 12);
    logsBox.replaceChildren(rows.length
      ? logsBlock(rows.map((u) => ({ time: clockText(u.ts), who: u.admin || 'system', text: `${u.what} ${u.target}` })))
      : empty('Нет подходящих записей', 'Смените ключевое слово или нажмите «Обновить», чтобы заново загрузить журнал аудита.'));
  };
  drawLogs();

  const updSlot = h('div', {});
  updateBanner(d.update, updSlot);

  return [
    pageHead('Обзор', 'Что сейчас с сервером, какой набор параметров действует и что недавно менялось.',
      h('a', {
        class: 'btn primary home-link',
        href: '/',
        target: '_top',
        title: 'Центр управления: начать игру, остановить сервисы, состояние процессов и журналы',
      }, 'Центр управления →'),
      themeMenu()),
    work([
      updSlot,
      brief([
        [fmt(d.sessions), 'Игроки онлайн'],
        [fmt(d.players), 'Профили'],
        [fmt(d.tunables), 'Настраиваемые параметры'],
        [fmt(d.items), 'Предметы'],
      ]),
      h2s('С чего начать'),
      hint('Каждый пункт — целый сценарий: смотрите, что сейчас, правьте, проверяйте и сохраняйте.'),
      startGrid(STARTS.map(([r, ic, t, s]) => ({
        icon: ic, title: t, sub: s, href: '#' + r,
        onClick: (e) => { e.preventDefault(); navigate(r); },
      }))),
      h3s('Журнал работы'),
      hint('Последние записи журнала аудита; можно фильтровать по действию, объекту или администратору.', { margin: '0 0 8px' }),
      h('div', { class: 'search logs-toolbar' },
        searchBox('Поиск по действию, объекту или админу', (v) => { search.q = v; drawLogs(); }),
        btn('Обновить', () => render(), 'ghost')),
      logsBox,
      note('Источник журнала.', 'Здесь читается журнал аудита админки, а не stdout игровых процессов: кто, когда и что изменил — всё здесь.'),
      h3s('Ключевые действующие параметры'),
      tbl(['Пункт', 'Сейчас', ''], canons.map(([k, v, r]) => [
        k,
        v,
        h('a', { class: 'pill', href: '#' + r, text: '→', title: 'Изменить', 'aria-label': 'Изменить', onclick: (e) => { e.preventDefault(); navigate(r); } }),
      ]), { cls: 'canon' }),
    ], [
      ib('Обзор сервера', 'Актуальные значения, прочитанные этой страницей.', [
        kv([
          ['Адрес сервиса', location.host || '127.0.0.1:' + port],
          ['База данных', pg === 'up' ? 'Подключено' : (pg || 'Нет данных')],
          ['Игроки онлайн', fmt(d.sessions)],
          ['Созданные персонажи', fmt(d.players)],
          ['Всего предметов', fmt(d.items)],
          ['Настраиваемые параметры', fmt(d.tunables) + ' шт.'],
          ['Записей аудита', fmt(d.audits) + ' шт.'],
          ['Версия интерфейса', buildLabel()],
        ]),
      ]),
      ib('Последние изменения', 'Сначала новые, только несколько последних.', [
        updates.length
          ? kv(updates.slice(0, 5).map((u) => [clockText(u.ts), h('span', {}, h('b', { text: u.what }), u.target ? h('span', { class: 'mono', text: ' · ' + u.target }) : null)]))
          : empty('Изменений пока нет'),
        h('p', { class: 'hint' }, h('a', { href: '#audit', text: 'Весь журнал аудита →', onclick: (e) => { e.preventDefault(); navigate('audit'); } })),
      ]),
      ib('Данные на этой странице', 'Никаких выдуманных чисел: если значение не прочитано, пишем «Нет данных».', bullets([
        h('span', {}, 'Онлайн, профили, предметы и количество параметров берутся из ', h('b', { text: '/api/dashboard' }), '. '),
        h('span', {}, 'Ключевые параметры берутся из ', h('b', { text: '/api/tunables' }), ' и ', h('b', { text: '/api/fish/bite_mode' }), '. '),
        h('span', {}, 'Журнал берётся из таблицы аудита ', h('b', { text: '/api/audit' }), ', а не из журналов процессов.'),
      ])),
    ]),
  ];
}
