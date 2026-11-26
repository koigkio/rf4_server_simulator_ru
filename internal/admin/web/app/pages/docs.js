import { h, api, pageHead, work, ib, h2s, hint, note, kv, bullets, pill, empty, btn, errText } from '../core.js';
import { markdownHTML, ABOUT_REPO } from '../markdown.js';

function docPage(title, desc, path, emptyText, actions) {
  return async () => {
    let body;
    try {
      const d = await api(path);
      body = d.content ? h('div', { class: 'md', html: markdownHTML(d.content) }) : empty(emptyText);
    } catch (e) {
      body = empty('Ошибка чтения', errText(e) + '. Если вы запускаете из исходников, отсутствие файлов из сборки — это нормально.');
    }
    const aside = [
      ib('Что это за страница', null, bullets([
        'Содержимое берётся из файлов документации, поставляемых с сервером; интерфейс только отображает их.',
        'При запуске из исходников файлов из сборки может не быть — тогда ошибка чтения нормальна.',
        'Здесь ничего нельзя редактировать, изменения ни на что не повлияют.',
      ])),
      ib('Связанное', null, h('div', { class: 'pills' },
        h('a', { class: 'pill', href: '#about', text: 'Об этом проекте' }),
        h('a', { class: 'pill', href: '#release', text: 'Обновления версий' }),
        h('a', { class: 'pill', href: '#audit', text: 'Журнал аудита' }))),
    ];
    const inner = [h('div', { class: 'md-wrap' }, body)];
    if (actions) inner.push(h('div', { style: { marginTop: '18px' } }, actions));
    return [pageHead(title, desc), work(inner, aside)];
  };
}

export const changelog = docPage('Список изменений', 'Что добавлено и исправлено в этой версии.', '/api/release-notes', 'Списка изменений нет');
export const about = docPage('О проекте', 'Бесплатный локальный сервер RF4 с открытым кодом. Ниже — описание проекта.', '/api/about', 'Описания проекта нет',
  h('a', { class: 'btn', href: ABOUT_REPO, target: '_blank', rel: 'noreferrer', text: 'Открыть на GitHub' }));
