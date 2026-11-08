import { NiimbotSerialClient, ImageEncoder, PageColorType, LabelType, PrinterModel } from '@mmote/niimbluelib';
import { labelContent, labelSize } from './label.js';

export { NiimbotSerialClient };

export const printGeometry = { dpi: 300, headPixels: 567, width: 560, height: Math.round(30 * 300 / 25.4) };
const fontFamily = 'DrawerLabelMono';
let fontsReady;

async function loadFonts() {
  if (!fontsReady) {
    fontsReady = Promise.all([
      new FontFace(fontFamily, 'url("./fonts/NotoSansMono-Regular.ttf")', { weight: '400' }).load(),
      new FontFace(fontFamily, 'url("./fonts/NotoSansMono-Bold.ttf")', { weight: '700' }).load()
    ]).then(fonts => {
      for (const font of fonts) document.fonts.add(font);
    }).catch(error => {
      fontsReady = undefined;
      throw new Error(`Could not load label fonts: ${error.message}`);
    });
  }
  await fontsReady;
}

export function renderLabelCanvas(drawer, canvas = document.createElement('canvas')) {
  const label = labelContent(drawer);
  canvas.width = printGeometry.width;
  canvas.height = printGeometry.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('The browser could not create a label canvas.');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  const pixelsPerMm = printGeometry.dpi / 25.4;
  // Byte-aligned print width fits the head; crop only the existing white side margins, not the artwork.
  context.translate(-(labelSize.width * pixelsPerMm - canvas.width) / 2, 0);
  context.scale(pixelsPerMm, pixelsPerMm);
  context.beginPath();
  context.rect(labelSize.margin, labelSize.margin, labelSize.width - 2 * labelSize.margin, labelSize.height - 2 * labelSize.margin);
  context.clip();
  context.fillStyle = '#000';
  context.strokeStyle = '#000';
  context.lineWidth = 0.088194;
  context.strokeRect(2, 2, 46, 9);
  const text = (value, x, y, size, weight = 400, align = 'left') => {
    context.font = `${weight} ${size}px ${fontFamily}`;
    context.textAlign = align;
    context.textBaseline = 'alphabetic';
    context.fillText(value, x, y);
  };
  label.title.forEach((line, index) => text(line, 25, 6 + index * 4, 4.233333, 700, 'center'));
  label.description.forEach((line, index) => text(line, 2, 16 + index * 3, 2.8));
  text(label.number, 2, 28, 8.466667, 700);
  text(label.position, 48, 27, 3, 400, 'right');
  context.restore();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < image.data.length; index += 4) {
    const value = (image.data[index] + image.data[index + 1] + image.data[index + 2]) / 3 < 128 ? 0 : 255;
    image.data[index] = image.data[index + 1] = image.data[index + 2] = value;
    image.data[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

export function validatePrinter(client) {
  if (!client?.isConnected()) throw new Error('Connect the USB printer before printing.');
  const metadata = client.getModelMetadata();
  if (metadata?.model !== PrinterModel.M2_H || metadata.dpi !== printGeometry.dpi || metadata.printheadPixels !== printGeometry.headPixels) {
    throw new Error('This test supports only the M2-H at 300 DPI. Disconnect and select the M2-H USB serial port.');
  }
}

export function validatePrintSelection(client, drawers) {
  if (!Array.isArray(drawers) || drawers.length === 0) throw new Error('Select at least one drawer to print.');
  validatePrinter(client);
  drawers.forEach(labelContent);
}

export async function waitForPrintCompletion(client, totalPages, report) {
  const deadline = Date.now() + Math.max(60_000, totalPages * 15_000);
  while (Date.now() < deadline) {
    if (!client.isConnected()) throw new Error('The USB printer disconnected during printing.');
    const status = await client.protocol.getPrintStatus();
    report(`Printer: ${status.page}/${totalPages} labels, print ${status.pagePrintProgress}%, feed ${status.pageFeedProgress}%...`);
    if (status.page === totalPages && status.pagePrintProgress === 100 && status.pageFeedProgress === 100) return;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('Timed out waiting for the printer to finish. Check paper, lid and printer status.');
}

export async function printSelectedLabels(client, drawers, report = () => {}) {
  validatePrintSelection(client, drawers);
  report('Loading fonts and preparing labels...');
  await loadFonts();
  const images = drawers.map(drawer => ImageEncoder.encodeCanvas(renderLabelCanvas(drawer), PageColorType.SingleColor, 'top'));
  const task = client.protocol.newPrintTask('B1', {
    totalPages: images.length,
    density: 3,
    labelType: LabelType.WithGaps,
    pageColor: PageColorType.SingleColor,
    statusPollIntervalMs: 300,
    statusTimeoutMs: 15_000,
    pageTimeoutMs: 15_000
  });
  let printError;
  try {
    await task.printInit();
    for (let index = 0; index < images.length; index++) {
      report(`Sending drawer ${drawers[index].number}: label ${index + 1}/${images.length}...`);
      await task.printPage(images[index], 1);
      await task.waitForPageFinished();
    }
    report('Waiting for the printer to finish...');
    await waitForPrintCompletion(client, images.length, report);
  } catch (error) {
    printError = error;
  } finally {
    try {
      if (!await task.printEnd()) throw new Error('The printer did not acknowledge print end.');
    } catch (error) {
      if (printError) throw new AggregateError([printError, error], `${printError.message} Also could not end the print job: ${error.message}`);
      throw error;
    }
  }
  if (printError) throw printError;
}
