/**
 * Diagram generation.
 *
 * Produces a single self-contained SVG schematic for a draft: a two-column
 * "where it breaks / what has to change" comparison, drawn from the topic
 * family rather than from stock art.
 *
 * Why SVG rather than a raster image: it needs no image library, no fonts to
 * embed, renders crisply at any size, can be edited by hand, and drops straight
 * into the website page as inline markup. LinkedIn's image upload expects
 * PNG/JPG, so `renderPngNote()` below documents that conversion step rather than
 * pretending SVG is directly postable.
 *
 * The visual language is deliberately "engineer's whiteboard": paper background,
 * a faint grid, monospace labels, thin rules. A polished marketing illustration
 * reads as vendor collateral; a schematic reads as someone's actual thinking.
 */

const WIDTH = 1200
const HEIGHT = 675

/** Per-topic-family content. Falls back to a generic presales schematic. */
const CONTENT = {
  'estimation-margin': {
    title: 'The quoted number, and what it was built from',
    breaks: [
      'Estimate assembled in a spreadsheet, disconnected from the scope that was sold',
      'Rate card changes mid-negotiation and nobody versions it',
      'Delivery assumptions never recorded at bid time',
    ],
    changes: [
      'One cost model that the proposal and the delivery plan both read from',
      'Catalogue versioned once; every quote pulls from that version',
      'Assumptions written against the deal, not into an email thread',
    ],
  },
  'proposal-rfp-response': {
    title: 'Assembling a bid from approved content',
    breaks: [
      'Approved answers live in documents nobody can search under deadline',
      'The same boilerplate is reformatted by hand for every customer template',
      'Version control is whoever emailed last',
    ],
    changes: [
      'Content library keyed to the framework clauses buyers actually ask about',
      'Proposal generated from approved blocks, then reviewed as one document',
      'Every submission traceable to the content version it used',
    ],
  },
  'presales-spreadsheet-chaos': {
    title: 'Presales as a process, not a memory',
    breaks: [
      'Deal state lives in one person\u2019s inbox and head',
      'Three people give three different answers about live bids',
      'Handover to delivery reconstructs what was promised',
    ],
    changes: [
      'One record per deal from first call to renewal',
      'Stage and owner visible without asking anyone',
      'Delivery receives the assumptions, not a summary of them',
    ],
  },
  'partner-vendor-catalogue': {
    title: 'One catalogue, many rate cards',
    breaks: [
      'Partner catalogues disagree on part numbers and pricing',
      'Quotes built from whichever sheet was open at the time',
      'Margin drift discovered at invoicing',
    ],
    changes: [
      'Partner and product data held once, referenced everywhere',
      'Quotes resolve against a dated catalogue version',
      'Margin visible before the bid goes out, not after',
    ],
  },
  'approval-governance': {
    title: 'Approvals that leave a trail',
    breaks: [
      'Approval routed by email, so the decision exists but the reasoning does not',
      'Nobody can say which route a given bid took',
      'Discount authorised verbally and reconstructed later',
    ],
    changes: [
      'Named approvers per deal size, recorded against the deal',
      'Every revision and decision timestamped',
      'The audit answer is a query, not an archaeology exercise',
    ],
  },
  'renewal-retention': {
    title: 'The renewal clock starts at signature',
    breaks: [
      'Renewal dates tracked in a calendar nobody owns',
      'True-up and co-term terms rediscovered at negotiation',
      'Uplift discussed the week the contract expires',
    ],
    changes: [
      'Renewal date and dependencies attached to the deal record',
      'Notice periods surfaced well ahead of the conversation',
      'Uplift modelled from the original estimate, not from scratch',
    ],
  },
  'pipeline-forecast-hygiene': {
    title: 'Pipeline that reflects reality',
    breaks: [
      'Stage changes are self-reported with no evidence attached',
      'Forecast assembled from memory the week before the board pack',
      'Qualification gaps invisible until the deal stalls',
    ],
    changes: [
      'Evidence required to advance a stage, not an opinion',
      'Forecast derived from deal records rather than a spreadsheet',
      'Gaps visible while there is still time to act on them',
    ],
  },
  'handover-to-delivery': {
    title: 'Handover without the margin leak',
    breaks: [
      'Delivery plan rebuilt from the proposal rather than from the estimate',
      'Two artefacts, one deal, no reconciliation',
      'Effort lost in the transition and never attributed',
    ],
    changes: [
      'Handover carries the costed assumptions, not a slide deck',
      'Mobilisation checks scope against what was sold',
      'Variance recorded while it can still be recovered',
    ],
  },
  'public-sector-procurement': {
    title: 'Framework bids are their own discipline',
    breaks: [
      'A proposal library built for direct deals fails a framework template',
      'Every deviation must be declared; hand assembly eventually misses one',
      'Below-threshold and full tenders run on different clocks',
    ],
    changes: [
      'Framework-specific templates held alongside the general library',
      'Deviations tracked as structured data, not prose',
      'Deadlines driven by the notice, not by a shared calendar',
    ],
  },
  'frameworks-in-bids': {
    title: 'Answering the framework question consistently',
    breaks: [
      'The same control answer exists in three documents, all different',
      'Responses written from scratch each time under deadline',
      'Evidence requested after submission and assembled in a hurry',
    ],
    changes: [
      'One approved answer per clause, reused and versioned',
      'Evidence attached to the answer rather than to the bid',
      'Consistency across bids is checkable, not hoped for',
    ],
  },
  'competitive-displacement': {
    title: 'Displacing an incumbent, on evidence',
    breaks: [
      'POC scoped before anyone understood the incumbent\u2019s commercial position',
      'Migration effort estimated from a slide rather than from discovery',
      'The only vendor without a costed transition plan loses the bake-off',
    ],
    changes: [
      'Commercial position of the incumbent mapped before the POC is scoped',
      'Migration costed from discovery output, not from a template',
      'Transition plan produced inside the evaluation window',
    ],
  },
  'mssp-managed-service-deals': {
    title: 'Costing a managed service you have to run',
    breaks: [
      'Recurring price built from a per-seat guess rather than a service model',
      'Service wrap added after the number was agreed',
      'Pass-through costs rediscovered at the first invoice',
    ],
    changes: [
      'Unit economics modelled once, reused across every managed bid',
      'Service wrap priced as part of the deal, not bolted on',
      'Pass-through and true-up terms stated before signature',
    ],
  },
  'crm-vs-presales-tooling': {
    title: 'The CRM is the system of record, not the whole record',
    breaks: [
      'Pipeline sits in the CRM; the estimate and the bid sit elsewhere',
      'Nobody can join the opportunity to the number that won it',
      'Two sources of truth reconciled by hand each quarter',
    ],
    changes: [
      'CRM stays the system of record for pipeline',
      'Estimate and proposal hang off the same opportunity record',
      'Reporting joins the two without a reconciliation exercise',
    ],
  },
  'ai-in-presales': {
    title: 'Where automation actually helps presales',
    breaks: [
      'Generated content that cannot be traced to an approved answer',
      'Time saved on drafting spent re-checking accuracy',
      'No record of what the model was given or produced',
    ],
    changes: [
      'Automation draws only from approved, versioned content',
      'Every generated block traceable to its source answer',
      'Drafting time falls without review time rising',
    ],
  },
  'presales-talent-enablement': {
    title: 'Ramping a presales hire without tribal knowledge',
    breaks: [
      'Ramp depends on sitting next to the right person',
      'Pricing logic and history live in individuals',
      'Answer quality varies by who is on the bid',
    ],
    changes: [
      'Catalogue, templates and pricing logic written down once',
      'A new hire can run a bid unaided inside a quarter',
      'Answer quality stops depending on tenure',
    ],
  },
  'land-and-expand': {
    title: 'Expansion you can actually forecast',
    breaks: [
      'Attach opportunities invisible until the client asks',
      'Footprint across business units tracked informally',
      'Uplift modelled from scratch each renewal',
    ],
    changes: [
      'Deployed footprint visible against the account record',
      'Expansion candidates surfaced from usage, not opinion',
      'Uplift modelled from the original estimate',
    ],
  },
  generic: {
    title: 'Where presales breaks, and what changes',
    breaks: [
      'Work spread across inboxes, spreadsheets and one person\u2019s memory',
      'No single record of what was assumed, quoted or promised',
      'The number cannot be reproduced when someone asks how it was reached',
    ],
    changes: [
      'One record per deal, from first call to handover',
      'Every figure traceable back to the inputs that produced it',
      'Review has something concrete to argue with',
    ],
  },
}

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/** Greedy wrap by approximate character width. Good enough for a schematic. */
function wrap(text, maxChars, maxLines = 3) {
  const words = String(text).split(/\s+/)
  const lines = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (next.length > maxChars && line) {
      lines.push(line)
      line = word
      if (lines.length === maxLines) break
    } else {
      line = next
    }
  }
  if (line && lines.length < maxLines) lines.push(line)
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length + 1) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/[.,;:]?$/, '') + '\u2026'
  }
  return lines
}

function textBlock(lines, x, y, { size = 14, fill = '#22302a', weight = 400, lh = 20, family = 'sans' } = {}) {
  return lines
    .map(
      (line, i) =>
        `<text x="${x}" y="${y + i * lh}" font-size="${size}" font-weight="${weight}" fill="${fill}" font-family="${family}">${esc(line)}</text>`,
    )
    .join('\n')
}

function panel({ x, y, w, h, label, accent, items }) {
  const parts = [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="#ffffff" stroke="#dcd7c8" stroke-width="1.5"/>`,
    `<line x1="${x}" y1="${y + 46}" x2="${x + w}" y2="${y + 46}" stroke="#eee9e0" stroke-width="1.5"/>`,
    `<circle cx="${x + 26}" cy="${y + 23}" r="5" fill="${accent}"/>`,
    `<text x="${x + 42}" y="${y + 28}" font-size="12.5" font-weight="700" letter-spacing="1.4" fill="${accent}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${esc(label)}</text>`,
  ]

  items.forEach((item, i) => {
    const top = y + 78 + i * 104
    parts.push(
      `<text x="${x + 26}" y="${top}" font-size="13" font-weight="700" fill="${accent}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${String(i + 1).padStart(2, '0')}</text>`,
    )
    parts.push(
      textBlock(wrap(item, Math.floor((w - 88) / 7.4)), x + 62, top, {
        size: 14.5,
        fill: '#26303d',
        lh: 20,
      }),
    )
  })

  return parts.join('\n')
}

/**
 * @param {{ topic?: {slug?:string,label?:string}, painPoint?: string, angle?: string,
 *           artifacts?: string[], company?: string, domain?: string }} input
 * @returns {{ svg:string, width:number, height:number, title:string }}
 */
export function buildDiagram(input = {}) {
  const slug = input.topic?.slug ?? 'generic'
  const content = CONTENT[slug] ?? CONTENT.generic
  const label = input.topic?.label ?? 'Presales operations'
  const company = input.company ?? 'Enhancing Security'
  const domain = input.domain ?? 'enhancingprofit.com'
  const artifacts = (input.artifacts ?? []).slice(0, 4)

  const title = content.title
  const subtitle = label

  const panelY = 150
  const panelH = 372
  const panelW = 488
  const leftX = 56
  const rightX = WIDTH - 56 - panelW

  const chips = artifacts
    .map((a, i) => {
      const x = 56 + i * 0
      return { a, x }
    })
    .map(({ a }, i) => {
      const cw = Math.min(240, 26 + String(a).length * 7.6)
      return { a, cw }
    })

  // Lay the artifact chips out left to right.
  let chipX = 56
  const chipMarkup = chips
    .map(({ a, cw }) => {
      const markup = `<rect x="${chipX}" y="${HEIGHT - 70}" width="${cw}" height="26" rx="13" fill="#efece0" stroke="#dcd7c8" stroke-width="1"/>` +
        `<text x="${chipX + cw / 2}" y="${HEIGHT - 52}" text-anchor="middle" font-size="12.5" fill="#5f6f66" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${esc(a)}</text>`
      chipX += cw + 10
      return markup
    })
    .join('\n')

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${esc(title)}">
<defs>
  <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
    <path d="M28 0H0V28" fill="none" stroke="#e7e2d4" stroke-width="1"/>
  </pattern>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0 0 L10 5 L0 10 z" fill="#8a9a90"/>
  </marker>
</defs>

<rect width="${WIDTH}" height="${HEIGHT}" fill="#f7f5ef"/>
<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#grid)" opacity="0.85"/>
<rect x="0" y="0" width="${WIDTH}" height="6" fill="#004530"/>

<text x="56" y="72" font-size="33" font-weight="700" fill="#10221a" font-family="-apple-system, Segoe UI, Roboto, sans-serif">${esc(title)}</text>
<text x="56" y="104" font-size="15" fill="#5f6f66" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${esc(subtitle)}</text>

<g>
  <path d="M${WIDTH - 56} 62 l-7 0 l3.5 -6 z" fill="#004530" opacity="0.85"/>
  <text x="${WIDTH - 56}" y="86" text-anchor="end" font-size="19" font-weight="600" fill="#004530"
        font-family="Georgia, 'Times New Roman', serif">Enhancing Security</text>
</g>

${panel({
  x: leftX,
  y: panelY,
  w: panelW,
  h: panelH,
  label: 'WHERE IT BREAKS',
  accent: '#a8402c',
  items: content.breaks,
})}

<line x1="${leftX + panelW + 22}" y1="${panelY + panelH / 2}" x2="${rightX - 22}" y2="${panelY + panelH / 2}" stroke="#8a9a90" stroke-width="2" marker-end="url(#arrow)"/>

${panel({
  x: rightX,
  y: panelY,
  w: panelW,
  h: panelH,
  label: 'WHAT HAS TO CHANGE',
  accent: '#004530',
  items: content.changes,
})}

<line x1="56" y1="${HEIGHT - 92}" x2="${WIDTH - 56}" y2="${HEIGHT - 92}" stroke="#e2ddd0" stroke-width="1.5"/>
${chipMarkup}
<text x="${WIDTH - 56}" y="${HEIGHT - 52}" text-anchor="end" font-size="13" fill="#7c8b81" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${esc(company)} \u00b7 ${esc(domain)}</text>
</svg>`

  return { svg, width: WIDTH, height: HEIGHT, title }
}

/** LinkedIn's image upload accepts PNG/JPG, not SVG. */
export const renderPngNote =
  'LinkedIn accepts PNG/JPG. Convert this SVG with any rasteriser (rsvg-convert, ' +
  'sharp, or a headless browser) before attaching it to a post.'

export default { buildDiagram, renderPngNote, CONTENT }
