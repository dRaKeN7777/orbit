/**
 * Minimal Markdown -> HTML for generated insight pages.
 *
 * Deliberately small: the generator only ever emits headings, paragraphs,
 * bullet lists, bold/italic and the occasional link. Everything is escaped
 * first, so no untrusted markup can reach the page.
 */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** Inline spans, applied to already-escaped text. */
function inline(text) {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

/**
 * @param {string} md
 * @returns {string} HTML
 */
export function mdToHtml(md) {
  const lines = esc(md).split(/\r?\n/)
  const out = []
  let para = []
  let list = null

  const flushPara = () => {
    if (!para.length) return
    out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }
  const flushList = () => {
    if (!list) return
    out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`)
    list = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()

    if (!line.trim()) {
      flushPara()
      flushList()
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushPara()
      flushList()
      const level = Math.min(heading[1].length, 6)
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`)
      continue
    }

    // Horizontal rule / frontmatter fence — skip rather than render literally.
    if (/^([-*_])\1{2,}$/.test(line.trim()) || line.trim() === '---') continue

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      flushPara()
      if (!list) list = []
      list.push(bullet[1].trim())
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      flushPara()
      flushList()
      out.push(`<blockquote>${inline(quote[1].trim())}</blockquote>`)
      continue
    }

    flushList()
    para.push(line.trim())
  }

  flushPara()
  flushList()
  return out.join('\n')
}

export default { mdToHtml }
