/**
 * Decodes a length-prefixed H.264 Annex-B stream produced by the Swift
 * simulator bridge and renders it into a `<canvas>` via the WebCodecs
 * `VideoDecoder`. Hardware-accelerated decode + direct canvas draw gives
 * us 60 fps at a fraction of the CPU cost of the previous MJPEG-in-`<img>`
 * approach.
 *
 * Wire format (produced by `SimulatorBridge.swift`):
 *   [u32 BE length][Annex-B access unit bytes] …repeated
 *
 * Each access unit is a complete H.264 frame (SPS + PPS + IDR on every
 * keyframe, one or more VCL NAL units on delta frames).
 */

const NAL_UNIT_TYPE_IDR = 5;
const NAL_UNIT_TYPE_SPS = 7;

export interface H264StreamPlayerOptions {
  readonly canvas: HTMLCanvasElement;
  readonly streamUrl: string;
  readonly signal?: AbortSignal;
  readonly onFirstFrame?: () => void;
  readonly onError?: (error: Error) => void;
}

export interface H264StreamPlayerHandle {
  readonly stop: () => void;
}

export function isH264StreamPlayerSupported(): boolean {
  return typeof VideoDecoder !== "undefined" && typeof VideoFrame !== "undefined";
}

export function startH264StreamPlayer(options: H264StreamPlayerOptions): H264StreamPlayerHandle {
  const { canvas, streamUrl, signal, onFirstFrame, onError } = options;
  if (!isH264StreamPlayerSupported()) {
    const error = new Error("WebCodecs VideoDecoder is not available in this browser.");
    queueMicrotask(() => onError?.(error));
    return { stop: () => {} };
  }

  const context = canvas.getContext("2d");
  if (!context) {
    const error = new Error("Failed to acquire a 2D drawing context for the simulator canvas.");
    queueMicrotask(() => onError?.(error));
    return { stop: () => {} };
  }

  const controller = new AbortController();
  const fetchSignal = mergeAbortSignals(signal, controller.signal);
  // Wrapped in a ref-like object so the async pump can observe mutations
  // from the `stop()` closure without tripping the ESLint
  // `no-unmodified-loop-condition` rule.
  const lifecycle = { stopped: false };
  let firstFrameAnnounced = false;
  let configured = false;
  let decoder: VideoDecoder | null = null;

  const emitError = (error: unknown) => {
    if (lifecycle.stopped) {
      return;
    }
    onError?.(error instanceof Error ? error : new Error(String(error)));
  };

  const ensureDecoder = (): VideoDecoder => {
    if (decoder) {
      return decoder;
    }
    const created = new VideoDecoder({
      output: (frame) => {
        try {
          if (canvas.width !== frame.displayWidth) {
            canvas.width = frame.displayWidth;
          }
          if (canvas.height !== frame.displayHeight) {
            canvas.height = frame.displayHeight;
          }
          context.drawImage(frame, 0, 0);
          if (!firstFrameAnnounced) {
            firstFrameAnnounced = true;
            onFirstFrame?.();
          }
        } finally {
          frame.close();
        }
      },
      error: (error) => emitError(error),
    });
    decoder = created;
    return created;
  };

  (async () => {
    let response: Response;
    try {
      response = await fetch(streamUrl, { signal: fetchSignal, cache: "no-store" });
    } catch (error) {
      if (!lifecycle.stopped) {
        emitError(error);
      }
      return;
    }
    if (!response.ok || !response.body) {
      emitError(new Error(`Simulator stream HTTP ${response.status}`));
      return;
    }

    const reader = response.body.getReader();
    const framer = new LengthPrefixedFramer();
    let basePerformanceTime = 0;

    while (!lifecycle.stopped) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (!lifecycle.stopped) {
          emitError(error);
        }
        return;
      }
      if (chunk.done) {
        return;
      }
      if (!chunk.value || chunk.value.byteLength === 0) {
        continue;
      }

      framer.push(chunk.value);
      for (const accessUnit of framer.drain()) {
        const isKeyframe = accessUnitIsKeyframe(accessUnit);
        if (!configured) {
          if (!isKeyframe) {
            // Wait for the first keyframe so the decoder can lock onto
            // the SPS/PPS at the start of the Annex-B bitstream.
            continue;
          }
          try {
            ensureDecoder().configure({
              // `avc1.42e01e` = Baseline, Level 3.0 — matches the Swift
              // encoder's `kVTProfileLevel_H264_Baseline_AutoLevel`
              // setting. Omitting `description` tells the decoder to
              // expect Annex-B start codes and parse SPS/PPS inline.
              codec: "avc1.42e01e",
              optimizeForLatency: true,
              hardwareAcceleration: "prefer-hardware",
            });
            configured = true;
            basePerformanceTime = performance.now();
          } catch (error) {
            emitError(error);
            return;
          }
        }

        try {
          ensureDecoder().decode(
            new EncodedVideoChunk({
              type: isKeyframe ? "key" : "delta",
              // Microseconds — only used for output ordering, which we
              // don't care about since we never reorder.
              timestamp: Math.round((performance.now() - basePerformanceTime) * 1000),
              data: accessUnit,
            }),
          );
        } catch (error) {
          emitError(error);
          return;
        }
      }
    }
  })().catch((error) => emitError(error));

  return {
    stop: () => {
      if (lifecycle.stopped) {
        return;
      }
      lifecycle.stopped = true;
      controller.abort();
      if (decoder) {
        try {
          decoder.close();
        } catch {
          // The decoder may already be closed after an error; ignore.
        }
        decoder = null;
      }
    },
  };
}

function mergeAbortSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) {
    return b;
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([a, b]);
  }
  const combined = new AbortController();
  const forward = () => combined.abort();
  if (a.aborted || b.aborted) {
    combined.abort();
  }
  a.addEventListener("abort", forward, { once: true });
  b.addEventListener("abort", forward, { once: true });
  return combined.signal;
}

/**
 * Reassembles `[u32 BE length][payload]` records that may arrive split
 * across TCP chunks.
 */
class LengthPrefixedFramer {
  private buffer: Uint8Array = new Uint8Array(0);
  private expectedLength: number | null = null;

  push(chunk: Uint8Array): void {
    if (this.buffer.byteLength === 0) {
      this.buffer = chunk;
      return;
    }
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;
  }

  *drain(): Generator<Uint8Array> {
    while (true) {
      if (this.expectedLength === null) {
        if (this.buffer.byteLength < 4) {
          return;
        }
        this.expectedLength = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getUint32(
          0,
          false,
        );
        this.buffer = this.buffer.subarray(4);
      }
      if (this.buffer.byteLength < this.expectedLength) {
        return;
      }
      // Copy so the decoder owns an independent ArrayBuffer; otherwise a
      // later resize of `this.buffer` could invalidate it.
      const payload = this.buffer.slice(0, this.expectedLength);
      this.buffer = this.buffer.subarray(this.expectedLength);
      this.expectedLength = null;
      yield payload;
    }
  }
}

/**
 * Scans an Annex-B access unit for an IDR or SPS NAL unit. Either signals
 * a valid entry point for a fresh decoder configuration.
 */
function accessUnitIsKeyframe(accessUnit: Uint8Array): boolean {
  let index = 0;
  while (index + 3 < accessUnit.byteLength) {
    // Annex-B start codes are 0x000001 or 0x00000001.
    const startCodeLength = findStartCodeLength(accessUnit, index);
    if (startCodeLength === 0) {
      index += 1;
      continue;
    }
    const nalHeaderIndex = index + startCodeLength;
    if (nalHeaderIndex >= accessUnit.byteLength) {
      return false;
    }
    const nalType = accessUnit[nalHeaderIndex]! & 0x1f;
    if (nalType === NAL_UNIT_TYPE_IDR || nalType === NAL_UNIT_TYPE_SPS) {
      return true;
    }
    index = nalHeaderIndex + 1;
  }
  return false;
}

function findStartCodeLength(buffer: Uint8Array, index: number): number {
  if (
    index + 3 < buffer.byteLength &&
    buffer[index] === 0 &&
    buffer[index + 1] === 0 &&
    buffer[index + 2] === 0 &&
    buffer[index + 3] === 1
  ) {
    return 4;
  }
  if (
    index + 2 < buffer.byteLength &&
    buffer[index] === 0 &&
    buffer[index + 1] === 0 &&
    buffer[index + 2] === 1
  ) {
    return 3;
  }
  return 0;
}
