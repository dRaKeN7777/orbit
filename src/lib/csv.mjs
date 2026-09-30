/**
 * Tolerant CSV parsing for watchlist import. Handles an optional header row,
 * quoted fields (including embedded delimiters and escaped quotes), and both
 * comma and semicolon delimiters — watchlists exported from spreadsheets in
 * Europe are frequently semicolon-separated.
 */

export const TARGET_COLUMNS = ['name', 'company', 'region', 'linkedin_url', 'title', 'email']

function detectDelimiter(line) {
  const commas = (line.match(/,/g) ?? []).length
  const semis = (line.match(/;/g) ?? []).length
  const tabs = (line.match(/\t/g) ?? []).length
  if (tabs > commas && tabs > semis) return '\t'
  return semis > commas ? ';' : ','
}

function splitLine(line, delim) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"'
        i++
      } else {
        quoted = !quoted
      }
    } else if (ch === delim && !quoted) {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur.trim())
  return out
}

/** @returns {Array<Record<string,string>>} */
export function parseCsv(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim())
  if (!lines.length) return []

  const delim = detectDelimiter(lines[0])
  const header = splitLine(lines[0], delim).map((h) =>
    h.toLowerCase().trim().replace(/\s+/g, '_'),
  )
  const hasHeader = header.some((h) => TARGET_COLUMNS.includes(h))

  // No recognisable header: assume the documented column order.
  const cols = hasHeader ? header : TARGET_COLUMNS
  const rows = hasHeader ? lines.slice(1) : lines

  return rows.map((line) => {
    const cells = splitLine(line, delim)
    const obj = {}
    cols.forEach((c, i) => {
      obj[c] = cells[i] ?? ''
    })
    return obj
  })
}

export default { parseCsv, TARGET_COLUMNS }
