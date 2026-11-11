/**
 * S3b (resilience plan Appendix A.3): cross-delta A2UI tag scanner for
 * streaming text deltas. Streaming counterpart of the whole-frame finalizer
 * guard in broadcastAssistantText: never let `<a2ui-json>` tag content (or
 * the tags themselves) leak into the streamed chat preview — cards render
 * only from whole frames.
 *
 * Two bounded phases:
 *  - EXTERIOR (outside a tag): hold back the longest suffix of the pending
 *    text that is a proper prefix of the OPEN tag (split across deltas),
 *    forward everything else. On seeing a full OPEN tag, switch interior.
 *  - INTERIOR (inside a tag): suppress all text; detect the CLOSE tag with a
 *    rolling tail buffer that also survives the CLOSE tag itself being split
 *    across deltas. On a full CLOSE tag, switch back to exterior and continue
 *    forwarding any trailing text (through the same exterior rules).
 *
 * Buffers reset at content_block boundaries / message_stop / run terminal
 * (call reset()). Bounded memory: exterior ≤ len(OPEN)−1, interior ≤
 * len(CLOSE)−1 bytes.
 */
import { A2UI_OPEN_TAG, A2UI_CLOSE_TAG } from "./a2ui-parser.js";

/** Longest proper suffix of `s` that is a prefix of `tag` ("" when none). */
function splitSuffix(s: string, tag: string): string {
  const max = Math.min(s.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return s.slice(s.length - n);
  }
  return "";
}

export class A2UIDeltaScanner {
  private exteriorBuf = "";
  private inTag = false;
  private interiorTail = "";

  get insideTag(): boolean {
    return this.inTag;
  }

  reset(): void {
    this.exteriorBuf = "";
    this.inTag = false;
    this.interiorTail = "";
  }

  /**
   * Feed one text delta; returns the forwardable text ("" when everything
   * is withheld — inside a tag or a held split prefix).
   */
  feedText(delta: string): string {
    let out = "";
    let input = delta;

    // Transitions (open found / close found) re-process the remainder; the
    // no-match branches consume all input and terminate.
    for (let guard = 0; guard < 4; guard++) {
      if (!this.inTag) {
        const combined = this.exteriorBuf + input;
        this.exteriorBuf = "";
        input = "";
        const openIdx = combined.indexOf(A2UI_OPEN_TAG);
        if (openIdx >= 0) {
          out += combined.slice(0, openIdx);
          this.inTag = true;
          this.interiorTail = "";
          input = combined.slice(openIdx + A2UI_OPEN_TAG.length);
          continue;
        }
        const hold = splitSuffix(combined, A2UI_OPEN_TAG);
        if (hold) {
          this.exteriorBuf = hold;
          out += combined.slice(0, combined.length - hold.length);
        } else {
          out += combined;
        }
        break;
      } else {
        const combined = this.interiorTail + input;
        this.interiorTail = "";
        input = "";
        const closeIdx = combined.indexOf(A2UI_CLOSE_TAG);
        if (closeIdx >= 0) {
          this.inTag = false;
          input = combined.slice(closeIdx + A2UI_CLOSE_TAG.length);
          continue;
        }
        // No full close tag: retain only the tail that could be a split
        // prefix of the close tag; everything before it is suppressed.
        this.interiorTail = splitSuffix(combined, A2UI_CLOSE_TAG);
        break;
      }
    }
    return out;
  }
}
