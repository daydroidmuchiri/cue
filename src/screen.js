// Full-resolution screenshot via desktopCapturer (main process).
// First call triggers the macOS Screen-Recording permission prompt for the app.
const { desktopCapturer, screen } = require('electron');

async function captureScreenshot() {
  // Capture the display under the cursor, not always the primary one — on a
  // multi-monitor setup the problem/meeting is usually wherever the user is.
  const target = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height } = target.size;
  const scale = target.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.floor(width * scale), height: Math.floor(height * scale) }
  });
  if (!sources.length) return null;
  const src = sources.find((s) => String(s.display_id) === String(target.id)) || sources[0];
  const img = src.thumbnail;
  if (!img || img.isEmpty()) return null;
  return img.toDataURL(); // data:image/png;base64,...
}

module.exports = { captureScreenshot };
