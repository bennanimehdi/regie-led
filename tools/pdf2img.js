// Régie LED — PDF → une image JPEG par page (macOS, sans dépendance).
//   osascript -l JavaScript tools/pdf2img.js <fichier.pdf> <préfixe de sortie> [plus grand côté en px] [nb max de pages]
// Écrit <préfixe>001.jpg, <préfixe>002.jpg… et affiche le nombre de pages écrites.
ObjC.import('AppKit');

function run(argv) {
  const src = argv[0], prefix = argv[1], maxSide = Math.max(256, Math.min(4096, +argv[2] || 1920)), maxPages = +argv[3] || 200;
  const data = $.NSData.dataWithContentsOfFile(src);
  if (!data || data.isNil()) throw new Error('PDF illisible');
  const rep = $.NSPDFImageRep.imageRepWithData(data);
  if (!rep || rep.isNil()) throw new Error('Ce fichier n\'est pas un PDF valide');
  const n = Math.min(rep.pageCount, maxPages);
  const props = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithDouble(0.92), $.NSImageCompressionFactor);
  for (let i = 0; i < n; i++) {
    rep.setCurrentPage(i);
    const b = rep.bounds, pw = Math.max(1, b.size.width), ph = Math.max(1, b.size.height), k = maxSide / Math.max(pw, ph);
    const w = Math.max(1, Math.round(pw * k)), h = Math.max(1, Math.round(ph * k));
    const bmp = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null, w, h, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
    const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(bmp);
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext(ctx);
    ctx.imageInterpolation = $.NSImageInterpolationHigh;
    $.NSColor.whiteColor.set;
    $.NSRectFill($.NSMakeRect(0, 0, w, h));
    rep.drawInRect($.NSMakeRect(0, 0, w, h));
    ctx.flushGraphics;
    $.NSGraphicsContext.restoreGraphicsState;
    const jpg = bmp.representationUsingTypeProperties($.NSBitmapImageFileTypeJPEG, props);
    const out = prefix + ('00' + (i + 1)).slice(-3) + '.jpg';
    if (!jpg.writeToFileAtomically(out, true)) throw new Error('Écriture impossible : ' + out);
  }
  return String(n);
}
