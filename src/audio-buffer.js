// Appends a PCM chunk to a buffer list in place, capping total buffered bytes
// so a slow/stuck STT provider can't grow mic/system-audio buffers forever.
// Drops the oldest bytes first, keeping the most recent audio.

const DEFAULT_MAX_BYTES = 16000 * 2 * 30; // ~30s of 16kHz mono 16-bit PCM

function totalBytes(chunks) {
  return chunks.reduce((sum, c) => sum + c.length, 0);
}

function pushCapped(chunks, chunk, maxBytes = DEFAULT_MAX_BYTES) {
  chunks.push(chunk);
  while (totalBytes(chunks) > maxBytes && chunks.length) {
    const excess = totalBytes(chunks) - maxBytes;
    const oldest = chunks[0];
    if (oldest.length <= excess) {
      chunks.shift();
    } else {
      chunks[0] = oldest.subarray(excess);
      break;
    }
  }
  return chunks;
}

module.exports = { pushCapped, totalBytes, DEFAULT_MAX_BYTES };
