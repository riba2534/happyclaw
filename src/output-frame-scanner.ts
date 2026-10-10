/**
 * Incremental extractor for `START {json} END` frames on a runner's stdout.
 *
 * The previous parser appended every chunk to one string and, per chunk,
 * re-ran indexOf(START) from the start of the buffer and re-scanned the
 * partial JSON object from its first brace. A frame of size n arriving in
 * chunks of size c therefore cost O(n²/c) (and flattened the concatenated
 * string each time). This scanner keeps resumable state instead: every input
 * character is examined a bounded number of times, and only the current
 * object's text (plus a marker-length tail) is retained.
 *
 * Semantics match the old parser:
 * - The object is delimited by brace matching that ignores braces and marker
 *   strings inside JSON strings, so payloads may quote both markers.
 * - After the object, everything up to the next END marker is skipped.
 * - A payload whose first non-whitespace character is not `{` is a broken
 *   frame: it is skipped up to its END marker, or up to a later START marker
 *   if that comes first (which then begins a new frame).
 */

export type OutputFrameEvent =
  | { kind: 'frame'; json: string }
  | { kind: 'broken'; reason: string }
  | { kind: 'overflow'; chars: number };

type Phase = 'seek_start' | 'after_start' | 'object' | 'seek_end' | 'broken';

function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

export class OutputFrameScanner {
  private phase: Phase = 'seek_start';
  /** Unmatched text that may still begin a marker (seek/broken phases). */
  private tail = '';
  /** Completed slices of the object being read. */
  private pieces: string[] = [];
  private objectChars = 0;
  private depth = 0;
  private inString = false;
  private escaped = false;
  /** Complete object waiting for its END marker. */
  private pendingJson = '';

  constructor(
    private readonly startMarker: string,
    private readonly endMarker: string,
    /** Drop an object that grows beyond this many chars (runaway output). */
    private readonly maxObjectChars = 64 * 1024 * 1024,
  ) {}

  /** Chars currently retained (object in progress plus marker tails). */
  get pendingChars(): number {
    return this.tail.length + this.objectChars + this.pendingJson.length;
  }

  push(chunk: string): OutputFrameEvent[] {
    const events: OutputFrameEvent[] = [];
    const text = chunk;
    let pos = 0;
    for (;;) {
      switch (this.phase) {
        case 'seek_start': {
          const after = this.findMarkerEnd(text, pos, this.startMarker);
          if (after === -1) {
            this.keepTail(text, pos, this.startMarker.length - 1);
            return events;
          }
          this.tail = '';
          pos = after;
          this.phase = 'after_start';
          break;
        }
        case 'after_start': {
          while (pos < text.length && isJsonWhitespace(text.charCodeAt(pos))) {
            pos++;
          }
          if (pos >= text.length) return events;
          if (text.charCodeAt(pos) === 0x7b /* { */) {
            this.resetObject();
            this.phase = 'object';
          } else {
            this.phase = 'broken';
          }
          break;
        }
        case 'object': {
          const start = pos;
          let end = -1;
          for (let i = pos; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if (this.inString) {
              if (this.escaped) this.escaped = false;
              else if (code === 0x5c /* \ */) this.escaped = true;
              else if (code === 0x22 /* " */) this.inString = false;
            } else if (code === 0x22) {
              this.inString = true;
            } else if (code === 0x7b) {
              this.depth++;
            } else if (code === 0x7d /* } */) {
              this.depth--;
              if (this.depth === 0) {
                end = i + 1;
                break;
              }
            }
          }
          if (end === -1) {
            if (start < text.length) {
              this.pieces.push(text.slice(start));
              this.objectChars += text.length - start;
            }
            if (this.objectChars > this.maxObjectChars) {
              events.push({ kind: 'overflow', chars: this.objectChars });
              this.resetObject();
              this.phase = 'seek_start';
            }
            return events;
          }
          this.pieces.push(text.slice(start, end));
          this.pendingJson = this.pieces.join('');
          this.resetObject();
          pos = end;
          this.phase = 'seek_end';
          break;
        }
        case 'seek_end': {
          const after = this.findMarkerEnd(text, pos, this.endMarker);
          if (after === -1) {
            this.keepTail(text, pos, this.endMarker.length - 1);
            return events;
          }
          this.tail = '';
          events.push({ kind: 'frame', json: this.pendingJson });
          this.pendingJson = '';
          pos = after;
          this.phase = 'seek_start';
          break;
        }
        case 'broken': {
          const endAfter = this.findMarkerEnd(text, pos, this.endMarker);
          const startAfter = this.findMarkerEnd(text, pos, this.startMarker);
          if (endAfter === -1 && startAfter === -1) {
            this.keepTail(
              text,
              pos,
              Math.max(this.startMarker.length, this.endMarker.length) - 1,
            );
            return events;
          }
          this.tail = '';
          events.push({
            kind: 'broken',
            reason:
              'Framed payload is not a JSON object, resyncing past broken frame',
          });
          // Whichever boundary begins first wins; compare marker starts.
          const endBegins =
            endAfter === -1 ? Infinity : endAfter - this.endMarker.length;
          const startBegins =
            startAfter === -1 ? Infinity : startAfter - this.startMarker.length;
          if (endBegins < startBegins) {
            pos = endAfter;
            this.phase = 'seek_start';
          } else {
            pos = startAfter;
            this.phase = 'after_start';
          }
          break;
        }
      }
    }
  }

  /**
   * Index in `text` just past the first `marker` at or after `pos`, also
   * matching a marker that began in the retained tail; -1 when absent. The
   * returned index may precede `pos + marker.length` for a tail-spanning
   * match. Does not modify the tail.
   */
  private findMarkerEnd(text: string, pos: number, marker: string): number {
    if (this.tail) {
      const bridge = this.tail + text.slice(pos, pos + marker.length - 1);
      const idx = bridge.indexOf(marker);
      if (idx !== -1) return pos + idx + marker.length - this.tail.length;
    }
    const idx = text.indexOf(marker, pos);
    return idx === -1 ? -1 : idx + marker.length;
  }

  /** Keep only the last `keep` chars of tail+text[pos..] (a marker prefix). */
  private keepTail(text: string, pos: number, keep: number): void {
    const remaining = text.length - pos;
    if (remaining >= keep) {
      this.tail = text.slice(text.length - keep);
    } else {
      const combined = this.tail + text.slice(pos);
      this.tail = combined.slice(Math.max(0, combined.length - keep));
    }
  }

  private resetObject(): void {
    this.pieces = [];
    this.objectChars = 0;
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
  }
}
