// Screenshot on demand (never on a timer). The picture is taken in memory, cropped to the active window, scaled to ~1280 px, JPEG-encoded
// and returned to the caller; it is never written to disk. Refused when the window in front is private, or was private at any point
// between the request and the end of the capture.

const MIN_SIDE = 200

// Crop rectangle (in thumbnail pixels) for a window rectangle given in DIP, on a display whose bounds are in DIP. Null if it is not sane.
function cropRect(win, display, scale, thumbW, thumbH) {
  if (!win || !(win.width > 0) || !(win.height > 0)) return null
  const x0 = Math.max(0, Math.round((win.x - display.x) * scale))
  const y0 = Math.max(0, Math.round((win.y - display.y) * scale))
  const x1 = Math.min(thumbW, Math.round((win.x + win.width - display.x) * scale))
  const y1 = Math.min(thumbH, Math.round((win.y + win.height - display.y) * scale))
  if (x1 - x0 < MIN_SIDE || y1 - y0 < MIN_SIDE) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

function fitSize(w, h, maxSide) {
  const k = Math.min(1, maxSide / Math.max(w, h))
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function captureActiveWindow({ desktopCapturer, screen, tracker, privacy, scope = 'window', maxSide = 1280, quality = 70, hideOverlay, showOverlay }) {
  const t0 = Date.now()
  const before = tracker.latest()
  if (!before) return { ok: false, reason: 'failed' }
  if (before.private || privacy.isPrivate(before.app, before.title)) return { ok: false, reason: 'private' }

  hideOverlay && hideOverlay()                   // Nova's own window must not be in the picture
  try {
    await sleep(120)
    const phys = before.bounds
    const dip = phys && phys.width > 0 ? (screen.screenToDipRect ? screen.screenToDipRect(null, phys) : phys) : null
    const display = dip ? screen.getDisplayMatching(dip) : screen.getPrimaryDisplay()
    const sf = display.scaleFactor || 1
    const size = { width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
    const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0]
    if (!src || src.thumbnail.isEmpty()) return { ok: false, reason: 'failed' }

    // The foreground window may have changed while the picture was taken.
    const after = tracker.latest()
    if (!after || after.private || privacy.isPrivate(after.app, after.title)) return { ok: false, reason: 'private' }

    let img = src.thumbnail
    const ts = img.getSize()
    const crop = scope === 'window' && dip ? cropRect(dip, display.bounds, sf, ts.width, ts.height) : null
    if (crop) img = img.crop(crop)
    const s = img.getSize()
    const fit = fitSize(s.width, s.height, maxSide)
    if (fit.width !== s.width) img = img.resize({ ...fit, quality: 'good' })
    const jpeg = img.toJPEG(quality)
    return {
      ok: true, jpeg_b64: jpeg.toString('base64'), app: after.app, title: after.title || '', width: fit.width, height: fit.height,
      bytes: jpeg.length, cropped: !!crop, ms: Date.now() - t0, flashBounds: crop ? dip : display.bounds,
    }
  } catch (err) {
    return { ok: false, reason: 'failed', error: String(err && err.message || err) }
  } finally {
    showOverlay && showOverlay()
  }
}

module.exports = { captureActiveWindow, cropRect, fitSize }
