/**
 * markdown.js — deliberately minimal markdown renderer (~40 lines, no library).
 * Supports: ATX headings, unordered lists, bold, inline code, links and paragraphs.
 * The source is HTML-escaped *before* any markup is generated, so a scraped or
 * model-authored body can never inject markup.
 */
import { escapeHtml, trust } from './ui.js';

function inline(escaped) {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) =>
      /^https?:\/\//i.test(href)
        ? '<a href="' + href + '" target="_blank" rel="noopener">' + label + '</a>'
        : label);
}

export function renderMarkdown(source) {
  const raw = String(source === null || source === undefined ? '' : source).replace(/\r\n/g, '\n');
  let front = '';
  let body = raw;
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    front = fm[1];
    body = raw.slice(fm[0].length);
  }

  const out = [];
  let inList = false;
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    out.push('<p>' + inline(escapeHtml(para.join(' '))) + '</p>');
    para = [];
  };
  const closeList = () => {
    if (!inList) return;
    out.push('</ul>');
    inList = false;
  };

  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) { flushPara(); closeList(); continue; }
    const heading = t.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara(); closeList();
      const level = heading[1].length;
      out.push('<h' + level + '>' + inline(escapeHtml(heading[2])) + '</h' + level + '>');
      continue;
    }
    const item = t.match(/^[-*+]\s+(.*)$/);
    if (item) {
      flushPara();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + inline(escapeHtml(item[1])) + '</li>');
      continue;
    }
    para.push(t);
  }
  flushPara();
  closeList();

  const meta = front ? '<div class="fm">' + escapeHtml(front) + '</div>' : '';
  return trust(meta + out.join('\n'));
}
