// 玩法规则：决定钓鱼「玩起来是什么感觉」。数值微调在「数值调整」页。
import { h, api, post, icon, toast, errText, pageHead, pageTabs, work, ib, pblock, h2s, h3s, hint, note, kv, bullets, pill, callout, badge, Form, savebar, confirmDialog, render, replaceHash, setCrumbTail, navigate } from '../core.js';

const STYLES = [
  ['realistic', 'Реальный клёв', 'Клюёт ли рыба, зависит от повадок, погоды, места и наживки. Нужно изучать точки и подбирать наживку — ближе к настоящей рыбалке.', 'Из семи правил ниже включены все, кроме счастливого часа'],
  ['legacy', 'Полностью случайно', 'Любая рыба может клюнуть на любую наживку, выдача рыбы полностью случайна. Просто — для неспешной игры.', 'Из семи правил ниже выключены все, кроме счастливого часа'],
];
export const RULE_SWITCHES = [
  ['bite_gate_enabled', 'Подходящая наживка', 'Искусственные приманки фильтруются по питанию рыбы. Если для точки заброса поплавка есть данные о глубине, чем дальше наживка от горизонта обитания, тем ниже вес этой рыбы.', '0'],
  ['fish_ecology_enabled', 'Повадки рыб', '252 видов рыб решают, клевать ли, по своим повадкам: влияют горизонт, время суток, сезон, погода, дно и анимация приманки.', '0'],
  ['fish_weather_enabled', 'Погода и температура воды', 'Температура воздуха и погода в игре влияют на клёв; на донке и поплавке рыба пробует наживку с перерывами.', '0'],
  ['fish_distribution_enabled', 'Распределение стай', 'Каждая рыба держится только в определённых зонах карты, распределение меняется каждые 4 игровых часа.', '0'],
  ['marine_layer_enabled', 'Влияние горизонта в морской ловле', 'Если включено, морские оснастки корректируют горизонт по состоянию морской ловли: погружение плавно по относительному прогрессу, у дна — 0,93; если выключено — старый режим (реальный горизонт приманки / фиксированно у дна).', '0'],
  ['fish_bait_rules_enabled', 'Рыба выбирает наживку', 'Какая рыба подойдёт, зависит от наживки на крючке. Что любит каждая рыба, задаётся в «Предпочтениях наживки».', '0'],
  ['happy_hour_enabled', 'Счастливый час', 'Премиум при ловле онлайн: опыт +50%, клёв +10%, шанс роста мастерства +25%, без дневного ограничения по времени.', '1'],
];
const SPAWN = [
  ['grade_ratio', 'Выдача по долям', 'Напрямую задаёт доли четырёх категорий: незачётная, зачётная, трофей, синяя корона. Самый наглядный вариант.'],
  ['fish_hunt', 'Четыре этапа охоты', 'В пресной воде хорошая рыба выходит постепенно по четырём этапам: «обычный → сбор рыбы → прикормка → гиганты». Для морской ловли и спиннинга тоже.'],
  ['two_stage', 'Два режима: обычный / с прикормкой', 'Для донки и поплавка только два режима — «обычный» и «после прикормки», у каждого свои доли. Для моря и спиннинга — по-прежнему четыре этапа.'],
];
const GRADES = [['below', 'Незачётная', '#7f8b9a'], ['qualified', 'Зачётная', '#4cb3d4'], ['trophy', 'Трофей', '#e0a743'], ['super', 'Синяя корона', '#9d7cf0']];
const GRADE_SETS = {
  grade_ratio: [{ prefix: 'grade_pct_', title: 'Доли четырёх категорий', defs: [3, 87.5, 9, 0.5] }],
  two_stage: [
    { prefix: 'two_stage_daily_', title: 'Обычный (без прикормки)', defs: [10, 86.5, 3, 0.5] },
    { prefix: 'two_stage_baited_', title: 'После прикормки', defs: [1, 92, 6, 1] },
  ],
};
// 咬断线组：与「张力超过承力」的常规断线是两条独立通路，默认关。
const BITE_OFF = [
  ['bite_off_enabled', 'Рыба перекусывает поводок', 'Хищники вроде щуки, тайменя, панцирника и сельдевой акулы могут перекусить поводок при вываживании. Если выключено, обрыв только от обычной перегрузки.', '0'],
  ['bite_off_over_pct', 'Вероятность, если рыба тяжелее поводка', 'Вероятность перекуса при каждом рывке. Официальное значение 20%.', '20', 'float', '%', 0, 100],
  ['bite_off_under_pct', 'Вероятность, если рыба легче поводка', 'Даже если вес рыбы меньше нагрузки поводка, остаётся небольшой шанс перекуса. Официальное значение 4%.', '4', 'float', '%', 0, 100],
  ['bite_off_sprint_seconds', 'Интервал проверки рывков', 'Минимальный интервал между двумя бросками на перекус при вываживании. Официальный «рывок» — локальный манёвр клиента; сервер приближает его этим тактом.', '10', 'float', 'с', 1, 120],
];
const OTHER = [
  ['condition_health_enabled', 'Голод и холод отнимают здоровье', 'Если выключено, здоровье всегда полное, а лекарства не расходуются.', '1'],
  ['condition_fishing_pause_enabled', 'Во время ловли энергия не восстанавливается', 'Пока снасть в воде, восстановление энергии приостановлено и продолжается после вытаскивания. Если выключено — восстанавливается всегда.', '1'],
  ['hook_nibble_enabled', 'Рыба сначала пробует наживку', 'Перед поклёвкой рыба несколько раз слегка трогает наживку; слишком ранняя подсечка — пустая. Если выключено, первая подсечка не считается пробой.', '0'],
  ['bite_pace_enabled', 'Скорость клёва от наживки', 'Если включено, скорость подхода рыбы зависит и от наживки, и от анимации: для донки/поплавка — подходит ли наживка; для спиннинга/морского пилкера — ещё и подходит ли проводка. Если подходят и наживка, и проводка, рыба приходит за 1,5–6 с; при неподходящей проводке — долго, как при плохой наживке. Влияет только на ритм, не на то, какая рыба ловится.', '0'],
];

export default async function rules(params, scope) {
  const [t, mode] = await Promise.all([api('/api/tunables'), api('/api/fish/bite_mode').catch(() => ({}))]);
  if (!scope.isCurrent()) return [];
  const val = (k, d) => (t[k] === undefined || t[k] === '' ? d : t[k]);
  const form = new Form();
  const status = h('p', { class: 'hint', role: 'status', hidden: true });
  let saving = false;
  savebar(form, {
    effect:'На сервере вступает в силу не позже чем через 30 секунд, перезаходить не нужно.',
    onSave: async (values) => {
      for (const set of GRADE_SETS[spawnMode] || []) {
        const keys = GRADES.map(([g]) => set.prefix + g);
        if (form.fields.has(keys[0]) && !keys.some(k => Number(form.value(k)) > 0)) throw new Error(`${set.title}: суммарный вес не может быть 0`);
      }
      // 逐键 API：先写正权重，避免换档时短暂出现整组为零。
      const entries = Object.entries(values).sort((a, b) => (Number(a[1]) === 0) - (Number(b[1]) === 0));
      const applied = [];
      saving = true;
      try {
        for (const [key, value] of entries) {
          await post('/api/tunables', { key, value: String(value) });
          form.commit({ [key]: value });
          applied.push(form.fields.get(key).spec.label);
        }
      } catch (e) {
        const pending = form.dirtyKeys().map(k => form.fields.get(k).spec.label);
        status.hidden = false;
        status.textContent = `Сохранение подтверждено: ${applied.join(', ') || 'нет'}; ожидают повтора: ${pending.join(', ')}. ${errText(e)}`;
        throw e;
      } finally { saving = false; }
      if (status.isConnected && !form.isDirty()) render();
    },
  });
  scope.setLeaveGuard(() => form.isDirty());

  // 玩法风格
  const cur = mode.mode;
  const styleCards = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: '10px' } }, STYLES.map(([m, title, desc, note]) => {
    const on = cur === m;
    return h('button', {
      type: 'button', class: 'stylecard' + (on ? ' on' : ''), style: { cursor: on ? 'default' : 'pointer' },
      onclick: async () => {
        if (on || saving) return;
        const ok = await confirmDialog({ title: `Переключить на «${title}»? `, desc: `${note}, счастливый час не меняется.${form.isDirty() ? 'Несохранённые изменения будут потеряны.' : ''}Вступит в силу примерно через 30 секунд.`, confirm: 'Переключить' });
        if (!ok) return;
        try { await post('/api/fish/bite_mode', { mode: m }); toast(`Переключено на «${title}», вступит в силу не позже чем через 30 секунд`); render(); } catch (e) { toast(errText(e), 'bad'); }
      },
    }, h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '10px', borderBottom: '0', padding: '0' } }, h('b', { text: title }), on ? badge('Текущая', 'accent') : null),
    h('p', { class: 'hint', style: { margin: '4px 0 0' }, text: desc }));
  }));

  // 出鱼方式
  const spawnMode = val('grade_ratio_enabled', '1') === '1' ? 'grade_ratio' : val('two_stage_hunt_enabled', '0') === '1' ? 'two_stage' : val('fish_hunt_enabled', '0') === '1' ? 'fish_hunt' : '';
  const spawnCards = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: '10px' } }, SPAWN.map(([m, title, desc]) => {
    const on = spawnMode === m;
    return h('button', {
      type: 'button', class: 'stylecard' + (on ? ' on' : ''), style: { cursor: on ? 'default' : 'pointer' },
      onclick: async () => {
        if (on || saving) return;
        if (form.isDirty() && !(await confirmDialog({ title: 'Есть несохранённые изменения', desc: 'Смена режима выдачи рыбы перезагрузит страницу, несохранённые изменения будут потеряны.', confirm: 'Всё равно переключить' }))) return;
        try { await post('/api/fish/spawn_mode', { mode: m }); toast(`Переключено на «${title}», вступит в силу примерно через 30 секунд`); render(); } catch (e) { toast(errText(e), 'bad'); }
      },
    }, h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '10px', borderBottom: '0', padding: '0' } }, h('b', { text: title }), on ? badge('Текущая', 'accent') : null),
    h('p', { class: 'hint', style: { margin: '4px 0 0' }, text: desc }));
  }));

  // 三个二级页签，和演示页「钓场与鱼口」的拆法一致
  const TABS = [['switches', 'Переключатели игры'], ['grade', 'Выдача рыбы и трофеи'], ['other', 'Прочее']];
  let SUB = 'switches';
  if (params[0] && TABS.some(([k]) => k === params[0])) SUB = params[0];
  const tabsEl = pageTabs(TABS, SUB, async (k) => {
    if (k === SUB) return;
    if (saving || (form.isDirty() && !(await confirmDialog({ title: 'Есть несохранённые изменения', desc: 'При переключении вкладки черновик этой страницы будет потерян.', confirm: 'Отменить и переключить' })))) {
      queueMicrotask(() => tabsEl.querySelectorAll('a').forEach(a => {
        if (a.hash === '#rules/' + SUB) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      }));
      return;
    }
    replaceHash('#rules/' + k); render();
  });
  setCrumbTail((TABS.find(([k]) => k === SUB) || [])[1] || '');

  const DESC = {
    switches: 'Определяет ощущения от ловли. Два верхних варианта — официальные пресеты, семь правил ниже настраиваются по отдельности.',
    grade: 'Определяет, какая доля пойманной рыбы будет хорошей (трофеи, синие короны). Выберите один из трёх вариантов щелчком по карточке.',
    other: 'Прочее: выживание, энергия и размер крючка.',
  };
  let blocks = [];
  if (SUB === 'switches') {
    blocks = [
      h2s('Переключатели игры'),
      hint(DESC.switches),
      h3s('Стиль игры'),
      styleCards,
      hint((cur === 'mixed' ? 'Сейчас используется своя комбинация.' : STYLES.some(([k]) => k === cur) ? `Текущий пресет: ${STYLES.find(([k]) => k === cur)[1]}. ` : 'Текущий пресет не получен.') + 'Пресет перекрывает первые шесть правил; счастливый час — отдельно.'),
      h3s('Семь правил (независимые)'),
      ...RULE_SWITCHES.map(([k, l, d, def]) => form.row({ key: k, label: l, help: d, kind: 'bool', def }, val(k, def))),
    ];
  } else if (SUB === 'grade') {
    blocks = [
      pblock(1, 'Режим выдачи рыбы', 'Определяет, какая доля пойманной рыбы будет хорошей. Выберите один из трёх вариантов щелчком по карточке.', spawnCards, { id: 'pg-spawn' }),
      ...(GRADE_SETS[spawnMode] || []).map((set, i) => pblock(i + 2, set.title, 'Укажите относительные количества — они автоматически пересчитаются в проценты.', gradeEditor(form, set, t, spawnMode === 'grade_ratio'), { id: 'pg-grade-' + i })),
      spawnMode === 'fish_hunt' ? note('У четырёх этапов охоты нет настраиваемых долей.', 'Этапы сменяются автоматически по мере прикармливания и сбора рыбы игроком.') : null,
      !spawnMode ? note('Режим выдачи рыбы ещё не выбран.', 'Сейчас рыба выдаётся по старым правилам.') : null,
    ].filter(Boolean);
  } else {
    blocks = [
      pblock(1, 'Прочее', 'Сколько живёт персонаж, как восстанавливается энергия и как размер крючка влияет на улов.', [
        ...OTHER.map(([k, l, d, def]) => form.row({ key: k, label: l, help: d, kind: 'bool', def }, val(k, def))),
        ...BITE_OFF.map(([k, l, d, def, kind, unit, min, max]) => form.row(
          kind ? { key: k, label: l, help: d, kind, unit, min, max, def } : { key: k, label: l, help: d, kind: 'bool', def }, val(k, def))),
        form.row({ key: 'hook_spawn_match_strength', label: 'Размер крючка влияет на улов', help: '0 — без влияния; 1 — на большой крючок легче поймать крупную рыбу, на маленький — мелкую; 2 — сильнее. Не действует в режиме «Выдача по долям».', kind: 'float', min: 0, max: 2, def: '0' }, val('hook_spawn_match_strength', '0')),
      ], { id: 'pg-other' }),
      pblock(2, 'Категории рыбы и время ожидания', 'Эти две настройки — на других вкладках.', bullets([
        'Пересчёт долей четырёх категорий, граница трофея: вкладка «Выдача рыбы и трофеи».',
        'Ожидание клёва, ожидание на спиннинге: Параметры игры › Ловля.',
        'Какая рыба на водоёмах: Ловля и клёв.',
      ]), { id: 'pg-links' }),
    ];
  }
  const aside = [
    ib('Какая сейчас комбинация', 'Один из двух пресетов или своя', kv([
      ['Пресет', cur === 'mixed' ? 'Своя комбинация' : (STYLES.find(([m]) => m === cur) || [])[1] || '—'],
      ['Включённые правила', String(RULE_SWITCHES.filter(([k, , , d]) => val(k, d) === '1').length) + ' / ' + RULE_SWITCHES.length],
      ['Режим выдачи рыбы', (SPAWN.find(([m]) => m === spawnMode) || [])[1] || 'Старые правила'],
    ]), hint('Пресет перекрывает только шесть правил: подходящая наживка, повадки рыб, погода и температура воды, распределение стай, горизонт в морской ловле, выбор наживки рыбой. Счастливый час — отдельно.')),
    ib('Связанные страницы', null, h('div', { class: 'pills' },
      h('a', { class: 'pill', href: '#bait', text: 'Что ест каждая рыба' }),
      h('a', { class: 'pill', href: '#tuning/gameplay', text: 'Скорость клёва — в параметрах игры' }),
      h('a', { class: 'pill', href: '#waters', text: 'Какая рыба на водоёмах' }))),
    ib('Как применяется', null, hint('После сохранения правила подгружаются примерно через 30 секунд — перезапускать сервер или перезаходить игрокам не нужно.')),
  ];
  return [
    pageHead('Ловля и клёв', DESC[SUB] || DESC.switches),
    tabsEl,
    work([status, ...blocks], aside),
  ];
}
// 四档比例编辑：输入相对权重，实时显示换算后的百分比
function gradeEditor(form, set, t, interactive) {
  const bar = h('div', { style: { display: 'flex', height: '10px', borderRadius: '6px', overflow: 'hidden', background: 'var(--line-soft)' } });
  const legend = h('div', { class: 'row small', style: { gap: '16px', borderBottom: '0', padding: '0', flexWrap: 'wrap' } });
  const fields = GRADES.map(([g, label], i) => {
    const key = set.prefix + g;
    return { key, label, f: form.field({ key, label: set.title + ' · ' + label, kind: 'float', min: 0, max: 100 }, t[key] ?? String(set.defs[i])) };
  });
  const track = h('div', { class: interactive ? 'grade-ratio-track' : null }, bar);
  const hint = h('span', { class: 'muted small' });
  const readWeights = () => fields.map(({ key }) => Math.max(0, Number(form.value(key)) || 0));
  const handles = interactive ? GRADES.slice(1).map((_, i) =>
    ratioHandle(i, fields, readWeights, track, () => form.refresh())) : [];
  track.append(...handles);
  const update = () => {
    const list = readWeights();
    const sum = list.reduce((a, b) => a + b, 0) || 1;
    const valid = fields.every(({ key }) => {
      const raw = form.value(key), n = Number(raw);
      return raw !== '' && Number.isFinite(n) && n >= 0 && n <= 100;
    });
    let cumulative = 0;
    handles.forEach((handle, i) => {
      cumulative += list[i] / sum * 100;
      track.style.setProperty('--boundary-' + i, cumulative + '%');
      const pair = list[i] + list[i + 1];
      const min = Math.max(0, pair - 100), max = Math.min(100, pair);
      handle.disabled = !valid || min >= max;
      handle.setAttribute('aria-valuemin', min);
      handle.setAttribute('aria-valuemax', max);
      handle.setAttribute('aria-valuenow', list[i]);
      handle.setAttribute('aria-valuetext', GRADES[i][1] + ' ' + (list[i] / sum * 100).toFixed(1) + '%');
    });
    hint.textContent = list.every(n => n === 0) ? 'Суммарный вес не может быть 0' : interactive ? 'Перетащите границу или введите вес' : 'Перетащите ползунок или введите вес';
    bar.replaceChildren(...list.map((n, i) => h('div', { style: { width: (n / sum * 100) + '%', background: GRADES[i][2] } })));
    legend.replaceChildren(...list.map((n, i) => h('span', {}, h('span', { style: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', background: GRADES[i][2], marginRight: '6px' } }),
      GRADES[i][1] + ' ', h('b', { text: (n / sum * 100).toFixed(1) + '%' }))));
    fields.forEach(({ f }, i) => {
      if (f.slider) f.slider.value = String(list[i]);
      if (f.pct) f.pct.textContent = 'Доля ' + (list[i] / sum * 100).toFixed(1) + '%';
    });
  };
  const inputs = h('div', { class: 'grid-4' }, fields.map(({ label, f }) => {
    f.input = h('input', { type: 'number', class: 'input num', min: 0, max: 100, step: 'any', value: f.original, 'aria-label': label + 'Вес', oninput: () => form.refresh() });
    f.slider = h('input', { type: 'range', class: 'grade-slider', min: 0, max: 100, step: '0.01', 'aria-label': label + 'Ползунок', oninput: () => { f.input.value = f.slider.value; form.refresh(); } });
    f.errEl = h('div', { class: 'help', hidden: true });
    f.pct = h('span', { class: 'grade-percent' });
    f.row = h('div', { class: 'field' }, h('label', {}, label, f.input), f.slider, f.pct, f.errEl);
    return f.row;
  }));
  const previous = form.onChange;
  form.onChange = () => { previous(form); update(); };
  const reset = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => {
    fields.forEach(({ f }, i) => { f.input.value = set.defs[i]; }); form.refresh();
  } }, 'Сбросить всю группу к заводским');
  update();
  return h('div', {}, h('div', { class: 'row' }, hint, reset), inputs,
    h('div', { style: { margin: interactive ? '18px 0 12px' : '12px 0 6px' } }, track), legend);
}

// Each gesture uses the starting weights so rounding never accumulates across moves.
function ratioHandle(i, fields, readWeights, track, refresh) {
  const label = GRADES[i][1] + ' / ' + GRADES[i + 1][1];
  const handle = h('button', { type: 'button', class: 'grade-ratio-handle', role: 'slider',
    'aria-label': label, title: label + '(перетаскивайте или используйте стрелки влево/вправо)' });
  function transfer(weights, delta) {
    const left = weights[i], pair = left + weights[i + 1];
    const next = Math.max(0, pair - 100, Math.min(100, pair, left + delta));
    [next, pair - next].forEach((v, j) => {
      const f = fields[i + j].f;
      f.slider.value = Number(v.toPrecision(15)); f.input.value = f.slider.value;
    });
    refresh();
  }
  let drag;
  handle.onpointerdown = e => {
    if (!e.isPrimary || e.button !== 0 || drag) return;
    drag = { id: e.pointerId, x: e.clientX, width: track.getBoundingClientRect().width, weights: readWeights() };
    handle.setPointerCapture(e.pointerId);
  };
  handle.onpointermove = e => {
    if (drag?.id !== e.pointerId || !drag.width) return;
    const total = drag.weights.reduce((a, b) => a + b, 0);
    const tenths = Math.round((e.clientX - drag.x) / drag.width * 1000);
    transfer(drag.weights, total * tenths / 1000);
  };
  handle.onlostpointercapture = () => { drag = null; };
  handle.onkeydown = e => {
    const weights = readWeights();
    const step = weights.reduce((a, b) => a + b, 0) / 100;
    const deltas = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step,
      Home: -weights[i], End: weights[i + 1] };
    if (!Object.hasOwn(deltas, e.key)) return;
    e.preventDefault();
    transfer(weights, deltas[e.key]);
  };
  return handle;
}
