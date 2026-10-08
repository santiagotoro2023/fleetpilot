// Library element "stats" (blueprint 1.1.1): big numbers with a label.
//   statTiles([{ value: 12, label: 'lessons done' }, { value: '1:24', label: 'best time', state: 'ok' }])
import { h } from '../core/ui.js';

export function statTiles(items) {
  return h('div', { class: 'stats' }, items.map(({ value, label, title, state }) =>
    h('div', { class: 'stat-tile' + (state ? ` ${state}` : ''), title }, h('b', {}, String(value)), h('span', {}, label))));
}
