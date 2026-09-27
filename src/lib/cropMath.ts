// Clear to Close — photo cropper math (Sept 2026, Anuraj-approved sample).
//
// Pure functions behind the in-app crop editor (src/components/PhotoCropper).
// The editor shows the picked image in an editor box; the user drags to
// position and pinches/slides to zoom; a fixed frame (circle photo / wide
// banner rectangle) shows exactly what will be saved.
//
// Coordinate systems:
//   - editor space: points on screen (the Image is absolutely positioned at
//     (offsetX, offsetY) with scaled size imageSize * scale)
//   - source space: pixels of the picked image (what the manipulator crops)
//
// Kept pure so the whole geometry is unit-testable without RN.

/** 'photo' = circular profile crop (square frame); 'banner' = wide rectangle. */
export type CropKind = 'photo' | 'banner';

/** Banner crop aspect: the wide-rectangle frame from the approved sample. */
export const BANNER_CROP_ASPECT = 2.5;

/** Cropped output is downscaled so its long edge is at most this (auto, quiet). */
export const MAX_CROP_EDGE = 1024;

/** Zoom slider bounds (percent of the cover scale), per the approved sample. */
export const ZOOM_SLIDER_MIN = 100;
export const ZOOM_SLIDER_MAX = 300;

export interface CropFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropSourceRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/**
 * Minimum scale so the image fully covers the frame ("cover" semantics).
 * Below this the frame would show empty editor background.
 */
export function coverScale(
  imageW: number,
  imageH: number,
  frameW: number,
  frameH: number,
): number {
  if (imageW <= 0 || imageH <= 0 || frameW <= 0 || frameH <= 0) return 1;
  return Math.max(frameW / imageW, frameH / imageH);
}

/**
 * Clamp one axis of the image offset so the frame stays fully covered by
 * the image. frameStart/frameSize locate the frame on that axis;
 * offset/scaledSize locate the scaled image. When the image is smaller than
 * the frame (should not happen under coverScale, but be safe), center it.
 */
export function clampOffset(
  offset: number,
  scaledSize: number,
  frameStart: number,
  frameSize: number,
): number {
  if (scaledSize < frameSize) {
    return frameStart + (frameSize - scaledSize) / 2;
  }
  const min = frameStart + frameSize - scaledSize; // image must reach frame end
  const max = frameStart; // image must start at or before frame start
  return Math.min(max, Math.max(min, offset));
}

/** Clamp a raw slider value into the 100..300 zoom band. */
export function clampSlider(value: number): number {
  return Math.min(ZOOM_SLIDER_MAX, Math.max(ZOOM_SLIDER_MIN, value));
}

/** Slider value (100..300) -> display scale, relative to the cover scale. */
export function sliderToScale(sliderValue: number, cover: number): number {
  return cover * (clampSlider(sliderValue) / 100);
}

/** Display scale -> slider value (100..300). */
export function scaleToSlider(scale: number, cover: number): number {
  if (cover <= 0) return ZOOM_SLIDER_MIN;
  return clampSlider((scale / cover) * 100);
}

/**
 * Pinch zoom: new scale from the finger-distance ratio, never below the
 * cover scale (and never NaN on a zero start distance).
 */
export function pinchScale(
  prevScale: number,
  distStart: number,
  distNow: number,
  cover: number,
): number {
  if (distStart <= 0) return prevScale;
  return Math.max(cover, prevScale * (distNow / distStart));
}

/**
 * Reposition one axis of the image so the editor point `anchor` stays under
 * the same image pixel while the scale changes (pinch anchor).
 */
export function anchorOffset(
  offset: number,
  oldScale: number,
  newScale: number,
  anchor: number,
): number {
  if (oldScale <= 0) return offset;
  return anchor - (anchor - offset) * (newScale / oldScale);
}

/**
 * Map the visible frame back onto the picked image: the crop rectangle in
 * source pixels for the manipulator's crop action. Rounded and clamped to
 * the image bounds (at least 1px, so a pathological layout never errors).
 */
export function cropSourceRect(
  imageW: number,
  imageH: number,
  offsetX: number,
  offsetY: number,
  scale: number,
  frame: CropFrame,
): CropSourceRect {
  const originX = Math.round((frame.x - offsetX) / scale);
  const originY = Math.round((frame.y - offsetY) / scale);
  const width = Math.round(frame.w / scale);
  const height = Math.round(frame.h / scale);
  const x = Math.min(imageW - 1, Math.max(0, originX));
  const y = Math.min(imageH - 1, Math.max(0, originY));
  const w = Math.min(imageW - x, Math.max(1, width));
  const h = Math.min(imageH - y, Math.max(1, height));
  return { originX: x, originY: y, width: w, height: h };
}

/**
 * Downscale target for the cropped result: keep the frame's aspect, long
 * edge at most MAX_CROP_EDGE. Small crops are never upscaled.
 */
export function outputSize(
  cropW: number,
  cropH: number,
  maxEdge: number = MAX_CROP_EDGE,
): { width: number; height: number } {
  const longEdge = Math.max(cropW, cropH);
  if (longEdge <= 0) return { width: 1, height: 1 };
  const k = Math.min(1, maxEdge / longEdge);
  return {
    width: Math.max(1, Math.round(cropW * k)),
    height: Math.max(1, Math.round(cropH * k)),
  };
}

/**
 * Frame geometry inside an editor box of (editorW, editorH), matching the
 * approved sample: circle frame ~250px (photo) or wide rectangle ~2.5:1
 * (banner), horizontally centered and lifted slightly above center.
 */
export function layoutCropFrame(
  kind: CropKind,
  editorW: number,
  editorH: number,
): CropFrame {
  if (kind === 'banner') {
    const fw = Math.min(editorW - 32, 340);
    const fh = fw / BANNER_CROP_ASPECT;
    return {
      x: (editorW - fw) / 2,
      y: (editorH - fh) / 2 - 20,
      w: fw,
      h: fh,
    };
  }
  const d = Math.min(editorW - 48, 250);
  return {
    x: (editorW - d) / 2,
    y: (editorH - d) / 2 - 20,
    w: d,
    h: d,
  };
}

/** Initial zoom slider value, per the approved sample's defaults. */
export function initialSliderValue(kind: CropKind): number {
  return kind === 'photo' ? 130 : 110;
}

/**
 * Initial image offset: center the scaled image on the frame (same as the
 * approved sample's startup layout).
 */
export function initialOffset(
  frameStart: number,
  frameSize: number,
  imageSize: number,
  scale: number,
): number {
  return frameStart + frameSize / 2 - (imageSize * scale) / 2;
}
