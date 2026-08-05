// Screenshot for the LLM, via desktopCapturer (main process).
// First call triggers the macOS Screen-Recording permission prompt for the app
// -- though main.js now pre-warms the capturer at boot, so that usually
// happens at launch rather than on the first Assist.
const { desktopCapturer, screen } = require('electron');
const { fitLongEdge } = require('./image-fit');

// The screenshot goes straight into an LLM request, so its size is latency:
// image prefill tokens scale with resolution, and a hi-DPI native capture is
// several times larger than any model needs to read a code editor. 1280px on
// the long edge keeps IDE and LeetCode text legible; JPEG at 80 is far smaller
// than PNG for screen content with no legibility cost that matters here.
//
// Note this does NOT make capture faster -- getSources costs the same ~620ms
// regardless of thumbnailSize. It cuts upload time and model prefill only.
const MAX_EDGE = 1280;
// 80 was empirically checked against dense monospace/code text at 1280px (a
// LeetCode problem statement, an IDE) and held up as legible. Treat this as a
// floor, not a starting point -- if file size ever needs trimming further,
// don't lower this without re-checking text legibility at that size first.
const JPEG_QUALITY = 80;

async function captureScreenshot() {
  // Capture the display under the cursor, not always the primary one — on a
  // multi-monitor setup the problem/meeting is usually wherever the user is.
  const target = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height } = target.size;
  const scale = target.scaleFactor || 1;
  // Still captured at native resolution: thumbnailSize is a bounding box whose
  // exact behavior varies across platforms and multi-monitor setups, and asking
  // for less buys nothing since capture cost is size-independent. Downscale
  // explicitly below instead, where the result is predictable.
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.floor(width * scale), height: Math.floor(height * scale) }
  });
  if (!sources.length) return null;
  const src = sources.find((s) => String(s.display_id) === String(target.id)) || sources[0];
  const img = src.thumbnail;
  if (!img || img.isEmpty()) return null;

  const size = img.getSize();
  const fit = fitLongEdge(size.width, size.height, MAX_EDGE);
  const sized = fit ? img.resize({ ...fit, quality: 'good' }) : img;
  return 'data:image/jpeg;base64,' + sized.toJPEG(JPEG_QUALITY).toString('base64');
}

module.exports = { captureScreenshot };
