/**
 * icons.js — every icon is hand-written inline SVG. No icon fonts, no external
 * sprite, no image requests. Icons render with `currentColor` so they inherit the
 * surrounding text colour.
 */
import { html, trust } from './ui.js';

/* The icon path bodies below are authored in this file, never server data, so they
   are marked trusted markup instead of being escaped. */
function rawSvg(body) { return trust(body); }

const PATHS = {
  search: '<circle cx="11" cy="11" r="7"></circle><path d="M16.5 16.5L21 21"></path>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.3"></path><path d="M20 5v6h-6"></path>',
  copy: '<rect x="9" y="9" width="11" height="12" rx="2"></rect><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2"></path>',
  check: '<path d="M4 12.5l5 5L20 6.5"></path>',
  alert: '<path d="M12 3l9.5 16.5H2.5L12 3z"></path><path d="M12 9.5v4.2"></path><circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none"></circle>',
  close: '<path d="M6 6l12 12M18 6L6 18"></path>',
  external: '<path d="M14 4h6v6"></path><path d="M20 4l-9 9"></path><path d="M18.5 14.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7A1.5 1.5 0 0 1 5 5.5h4.5"></path>',
  play: '<path d="M6 4.5l13 7.5-13 7.5z"></path>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M3 10h18M8 3v4M16 3v4"></path>',
  link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 4.8l-1.4 1.4"></path><path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 19.2l1.4-1.4"></path>',
  text: '<path d="M4 6h16M4 12h16M4 18h10"></path>',
  trendUp: '<path d="M4 16l6-6 4 4 6-6"></path><path d="M20 8h-4M20 8v4"></path>',
  trendDown: '<path d="M4 8l6 6 4-4 6 6"></path><path d="M20 16h-4M20 16v-4"></path>',
  trendFlat: '<path d="M4 12h16"></path>',
  dot: '<circle cx="12" cy="12" r="4"></circle>',
  reaction: '<path d="M12 20s-7.5-4.4-7.5-9.3A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7.5 2.7C19.5 15.6 12 20 12 20z"></path>',
  comment: '<path d="M20 12.5c0 3.6-3.6 6.5-8 6.5-1 0-2-.15-2.9-.42L4.5 20l.9-3.4A6.6 6.6 0 0 1 4 12.5C4 8.9 7.6 6 12 6s8 2.9 8 6.5z"></path>',
  share: '<path d="M9 15l6-6"></path><path d="M14.5 4.5l5 5-5 5"></path><path d="M4.5 19.5v-4a5 5 0 0 1 5-5h5"></path>',
  inbox: '<path d="M4 13.5L6.5 5h11L20 13.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"></path><path d="M4 13.5h4l1 2h6l1-2h4"></path>',
  file: '<path d="M6 3.5h7.5L19 9v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5z"></path><path d="M13 3.5V9h5.5"></path>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"></path><circle cx="12" cy="12" r="3"></circle>',
  code: '<path d="M9 7L4 12l5 5M15 7l5 5-5 5"></path>',
  send: '<path d="M21 3L10.5 13.5"></path><path d="M21 3l-7 18-3.5-7.5L3 10z"></path>',
  trash: '<path d="M4 7h16"></path><path d="M9.5 7V4.8h5V7"></path><path d="M6.5 7l.9 12a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"></path>',
  bolt: '<path d="M13 3L5.5 13.5H11l-1 7.5L18.5 10H13z"></path>',
  chevronLeft: '<path d="M14.5 6l-6 6 6 6"></path>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"></path>',
  gear: '<circle cx="12" cy="12" r="3"></circle><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M18 6l-1.4 1.4M7.4 16.6L6 18"></path>',
  radar: '<circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="4.5"></circle><path d="M12 12l6.5-4.3"></path>',
  list: '<path d="M4 6.5h16M4 12h16M4 17.5h10"></path>',
};

/**
 * @param {string} name key from PATHS
 * @param {number} [size] px, default 16
 * @param {string} [cls] extra class names
 */
export function icon(name, size, cls) {
  const body = PATHS[name] || PATHS.dot;
  const s = size || 16;
  return html`<svg class="ic ${cls || ''}" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${rawSvg(body)}</svg>`;
}
