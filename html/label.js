export const labelSize = { width: 50, height: 30, margin: 1.5 };

function xml(value) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[character]);
}

function wrap(value, columns, maximumLines) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const characters = Array.from(word);
    if (line && Array.from(line).length + characters.length + 1 > columns) {
      lines.push(line);
      line = '';
    }
    while (characters.length > columns) lines.push(characters.splice(0, columns).join(''));
    const tail = characters.join('');
    if (tail) line = line ? `${line} ${tail}` : tail;
  }
  if (line) lines.push(line);
  if (lines.length > maximumLines) {
    lines.length = maximumLines;
    lines[maximumLines - 1] = `${Array.from(lines[maximumLines - 1]).slice(0, columns - 3).join('')}...`;
  }
  return lines;
}

export function createLabelSvg(drawer) {
  if (!drawer || typeof drawer.number !== 'string' || !/^\d{3}$/.test(drawer.number) ||
      typeof drawer.position !== 'string' || !/^L\d+\/[1-5]$/.test(drawer.position) ||
      typeof drawer.title !== 'string' || typeof drawer.description !== 'string') {
    throw new Error('Select a valid drawer to create a label.');
  }
  for (const value of [drawer.title, drawer.description]) {
    if (/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(value)) {
      throw new Error('Label text contains a character that SVG cannot represent.');
    }
  }
  const title = wrap(drawer.title, 22, 2);
  const description = wrap(drawer.description, 27, 3);
  const spans = (lines, y, step) => lines.map((line, index) => `      <tspan x="1.5" y="${y + index * step}">${xml(line)}</tspan>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="30mm" viewBox="0 0 50 30">
  <title>Drawer ${xml(drawer.number)} - ${xml(drawer.title)}</title>
  <desc>Editable label draft. 50 x 30 mm with 1.5 mm margins. Number, position, title and description; long text is wrapped and truncated with three dots.</desc>
  <defs>
    <clipPath id="print-area"><rect x="1.5" y="1.5" width="47" height="27"/></clipPath>
  </defs>
  <g id="label" clip-path="url(#print-area)" fill="#000" font-family="DejaVu Sans Mono, monospace">
    <g id="header">
      <text id="drawer-number" x="1.5" y="7.5" font-size="6" font-weight="bold">${xml(drawer.number)}</text>
      <text id="drawer-position" x="48.5" y="5.5" text-anchor="end" font-size="3">${xml(drawer.position)}</text>
      <path id="divider" d="M 1.5 9.5 H 48.5" stroke="#000" stroke-width="0.2"/>
    </g>
    <text id="drawer-title" font-size="3.3" font-weight="bold">
${spans(title, 13.3, 4)}
    </text>
    <text id="drawer-description" font-size="2.8">
${spans(description, 21.5, 3)}
    </text>
  </g>
</svg>
`;
}
