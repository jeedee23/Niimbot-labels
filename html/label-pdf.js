import { PDFDocument, rgb, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { labelContent, labelSize } from './label.js';

const mm = value => value * 72 / 25.4;

async function loadFont(name) {
  const response = await fetch(new URL(`./fonts/${name}.ttf`, import.meta.url));
  if (!response.ok) throw new Error(`Could not load ${name} font (HTTP ${response.status}). Reload and try again.`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function createLabelsPdf(drawers, fontBytes) {
  if (!Array.isArray(drawers) || drawers.length === 0) throw new Error('Select at least one drawer to create labels.');
  const labels = drawers.map(labelContent);
  const [regularBytes, boldBytes] = fontBytes || await Promise.all([
    loadFont('NotoSansMono-Regular'), loadFont('NotoSansMono-Bold')
  ]);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });
  const supported = new Set(regular.getCharacterSet());
  const boldSupported = new Set(bold.getCharacterSet());
  pdf.setTitle('Drawer labels');
  pdf.setCreator('Workshop drawer inventory');
  for (const label of labels) {
    const page = pdf.addPage([mm(labelSize.width), mm(labelSize.height)]);
    page.drawRectangle({ x: 0, y: 0, width: mm(50), height: mm(30), color: rgb(1, 1, 1) });
    page.pushOperators(pushGraphicsState(), rectangle(mm(1.5), mm(1.5), mm(47), mm(27)), clip(), endPath());
    const text = (value, x, baseline, size, font, align = 'left') => {
      for (const character of value) {
        const code = character.codePointAt(0);
        if (!(font === bold ? boldSupported : supported).has(code)) {
          throw new Error(`Drawer ${label.number}: Noto Sans Mono does not support "${character}". Edit the label text before exporting.`);
        }
      }
      const width = font.widthOfTextAtSize(value, mm(size));
      const offset = align === 'center' ? width / 2 : align === 'right' ? width : 0;
      page.drawText(value, { x: mm(x) - offset, y: mm(30 - baseline), size: mm(size), font, color: rgb(0, 0, 0) });
    };
    page.drawRectangle({ x: mm(2), y: mm(19), width: mm(46), height: mm(9), borderColor: rgb(0, 0, 0), borderWidth: 0.25 });
    label.title.forEach((line, index) => text(line, 25, 6 + index * 4, 4.233333, bold, 'center'));
    label.description.forEach((line, index) => text(line, 2, 16 + index * 3, 2.8, regular));
    text(label.number, 2, 28, 8.466667, bold);
    text(label.position, 48, 27, 3, regular, 'right');
    page.pushOperators(popGraphicsState());
  }
  return pdf.save();
}
