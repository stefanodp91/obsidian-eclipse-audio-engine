// A stopped source gives its buffer back before it is detached.
//
// WebKit on iOS 26 never finishes an `AudioBufferSourceNode` that is stopped
// and disconnected in the same turn: the node stays alive for the life of the
// page, and so does the buffer it was playing. For music that buffer is the
// whole decoded track, and a transport that decodes a new track at every change
// and stops the old one this way leaks one track per change.
//
// Measured on an iPhone 13 with iOS 26, 2026-09-22, in a host application: one
// looping AAC track decoded to 17.6 MB, played for 0.2 s and stopped, eighty
// times in a row. Stopped and disconnected at once, the web content process was
// killed after 60, 65 and 71 decodes in three runs. Decoded and never played,
// all eighty ran in 2.5 s. With the buffer set to null after `stop()`, all
// eighty ran; with the disconnect deferred to `onended`, all eighty ran too.
//
// Setting the buffer to null is always allowed, and a stopped source plays
// nothing either way. The node itself may still outlive its use, but it no
// longer holds the track.
export function releaseStoppedSource(source: AudioBufferSourceNode): void {
    try {
        source.buffer = null;
    } catch {
        /* a platform that refuses null keeps the old behavior */
    }
}
