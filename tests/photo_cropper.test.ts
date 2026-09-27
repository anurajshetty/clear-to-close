// photo_cropper.test.ts — REGRESSION + geometry guard for the in-app crop
// editor (Anuraj-approved, Sept 2026).
//
// After the realtor picks a profile photo or banner, the crop editor opens
// BEFORE saving: drag to position, pinch/slide to zoom; the circular frame
// shows exactly what lands in the photo circle, the wide ~2.5:1 rectangle
// exactly what lands in the banner strip. The profile photo opens ZOOMED
// OUT at the cover scale (maximum of the picture visible; the user zooms
// in to choose) while the banner keeps its approved starting zoom; the
// zoom slider maps logarithmically so the motion is smooth. RN components
// are not importable in the node suite, so this pins the pure geometry
// contract in src/lib/cropMath.ts (cover scale, clamp, slider/zoom mapping,
// pinch anchoring, editor->source crop rect, output size caps, frame
// layout, initial zoom).

import { assert, summary } from './assert';
import {
  BANNER_CROP_ASPECT,
  DRAG_START_THRESHOLD,
  MAX_CROP_EDGE,
  anchorOffset,
  clampOffset,
  clampSlider,
  coverScale,
  cropSourceRect,
  dragExceeded,
  initialOffset,
  initialSliderValue,
  layoutCropFrame,
  outputSize,
  pinchScale,
  scaleToSlider,
  sliderToScale,
} from '../src/lib/cropMath';

// coverScale: image must fully cover the frame.
assert(coverScale(1000, 500, 200, 200) === 0.4, 'square frame on wide image: height drives cover');
assert(coverScale(500, 1000, 200, 200) === 0.4, 'square frame on tall image: width drives cover');
assert(coverScale(1200, 800, 340, 136) === 340 / 1200, 'banner frame cover scale');
assert(coverScale(0, 800, 340, 136) === 1, 'zero-size image falls back to 1');
assert(coverScale(800, 600, 0, 136) === 1, 'zero-size frame falls back to 1');

// clampOffset: the frame must stay covered — no empty editor background.
assert(clampOffset(150, 600, 100, 300) === 100, 'offset right of frame start clamps to frame start');
assert(clampOffset(100, 600, 100, 300) === 100, 'offset exactly at frame start stays');
assert(clampOffset(-350, 600, 100, 300) === -200, 'offset leaving a gap clamps to reach the frame end');
assert(clampOffset(-50, 600, 100, 300) === -50, 'offset inside the legal band is untouched');
assert(clampOffset(0, 200, 100, 300) === 100 + (300 - 200) / 2, 'undersized image centers on the frame');

// Slider band + logarithmic zoom mapping: equal slider steps multiply the
// scale by a constant ratio, so the zoom motion feels smooth and continuous
// across the whole range (no jumps at either end).
assert(clampSlider(50) === 100, 'slider clamps up to 100');
assert(clampSlider(400) === 300, 'slider clamps down to 300');
assert(clampSlider(160) === 160, 'slider passes through in-band values');
assert(sliderToScale(100, 0.5) === 0.5, 'slider 100 = cover scale');
assert(sliderToScale(300, 0.5) === 1.5, 'slider 300 = 3x cover scale');
assert(
  Math.abs(sliderToScale(200, 0.5) - 0.5 * Math.sqrt(3)) < 1e-9,
  'slider mid-point is the geometric mean, not the arithmetic mean',
);
{
  // Smoothness: every equal slider step multiplies the scale by the same
  // ratio, so there is no fast/slow wonkiness anywhere in the band.
  const step = 25;
  const ratio = (a: number, b: number) => sliderToScale(b, 0.5) / sliderToScale(a, 0.5);
  const expected = Math.pow(3, step / 200);
  for (let v = 100; v < 300; v += step) {
    assert(
      Math.abs(ratio(v, v + step) - expected) < 1e-9,
      `slider ${v}->${v + step} multiplies the scale by 3^(25/200) (got ${ratio(v, v + step)})`,
    );
  }
}
{
  // Monotonic and jump-free: strictly increasing, and no single slider
  // unit ever multiplies the scale by more than 1% (3^(1/200) is ~1.0055).
  let prev = sliderToScale(100, 0.5);
  for (let v = 101; v <= 300; v++) {
    const s = sliderToScale(v, 0.5);
    assert(s > prev, `slider is strictly increasing at ${v}`);
    assert(s / prev < 1.01, `no zoom jump at slider ${v}`);
    prev = s;
  }
}
{
  // scaleToSlider is the exact inverse, so pinch/drag zoom stays in sync
  // with the slider thumb.
  for (const v of [100, 110, 150, 200, 250, 300]) {
    const back = scaleToSlider(sliderToScale(v, 0.5), 0.5);
    assert(Math.abs(back - v) < 1e-9, `slider -> scale -> slider round-trips at ${v} (got ${back})`);
  }
}
assert(scaleToSlider(0.5, 0.5) === 100, 'cover scale maps back to 100');

// Initial zoom: the profile photo opens ZOOMED OUT at the cover scale (the
// user sees the maximum of the picture, then zooms in and drags to select
// the part they want). The banner keeps its approved starting zoom.
assert(initialSliderValue('photo') === 100, 'photo starts at 100 (cover scale)');
assert(initialSliderValue('banner') === 110, 'banner keeps its 110 starting zoom');
assert(
  sliderToScale(initialSliderValue('photo'), 0.5) === 0.5,
  'photo initial scale equals the cover scale',
);
assert(
  Math.abs(sliderToScale(initialSliderValue('banner'), 0.5) - 0.5 * Math.pow(3, 10 / 200)) < 1e-9,
  'banner initial scale unchanged from its 110 zoom',
);

// Pinch: distance ratio drives the scale, never below cover.
assert(pinchScale(1, 100, 150, 0.4) === 1.5, 'pinch out scales up');
assert(pinchScale(1.5, 150, 100, 0.4) === 1, 'pinch in scales down');
assert(pinchScale(1, 150, 50, 0.8) === 0.8, 'pinch never goes below the cover scale');
assert(pinchScale(1, 0, 50, 0.8) === 1, 'zero start distance keeps the scale');

// anchorOffset: the point under the fingers stays put while zooming.
assert(anchorOffset(0, 1, 2, 100) === -100, 'doubling scale about x=100 moves the origin to -100');
assert(anchorOffset(0, 2, 1, 100) === 50, 'halving scale about x=100 moves the origin to 50');
assert(anchorOffset(-40, 1, 1, 100) === -40, 'no scale change keeps the offset');

// cropSourceRect: editor frame -> source pixels at full resolution.
{
  // 1200x800 source shown at scale 0.5, image origin at editor (-60, -20).
  const rect = cropSourceRect(1200, 800, -60, -20, 0.5, { x: 140, y: 110, w: 250, h: 250 });
  assert(rect.originX === 400, `crop originX maps to source pixels (got ${rect.originX})`);
  assert(rect.originY === 260, `crop originY maps to source pixels (got ${rect.originY})`);
  assert(rect.width === 500, `crop width maps to source pixels (got ${rect.width})`);
  assert(rect.height === 500, `crop height maps to source pixels (got ${rect.height})`);
  assert(rect.width === rect.height, 'photo crop is square (circle frame)');
}
{
  // A frame hanging off the image edge clamps into the image, never empty.
  const rect = cropSourceRect(1200, 800, 900, 600, 0.5, { x: 0, y: 0, w: 250, h: 250 });
  assert(rect.originX === 0 && rect.originY === 0, 'out-of-bounds origin clamps to 0,0');
  assert(rect.width >= 1 && rect.height >= 1, 'crop is never empty');
  assert(rect.originX + rect.width <= 1200, 'crop stays inside the image width');
  assert(rect.originY + rect.height <= 800, 'crop stays inside the image height');
}
{
  // Banner frame keeps the ~2.5:1 aspect in source pixels.
  const rect = cropSourceRect(2000, 1000, -300, -80, 0.8, { x: 20, y: 100, w: 340, h: 136 });
  const aspect = rect.width / rect.height;
  assert(Math.abs(aspect - 2.5) < 0.02, `banner crop keeps the 2.5:1 frame aspect (got ${aspect.toFixed(3)})`);
}

// outputSize: downscale so the long edge is at most ~1024px, never upscale.
assert(outputSize(2000, 2000).width === MAX_CROP_EDGE, 'large square crop shrinks to 1024');
assert(outputSize(2000, 2000).height === MAX_CROP_EDGE, 'large square crop stays square');
{
  const out = outputSize(2560, 1024);
  assert(out.width === 1024, 'banner long edge shrinks to 1024');
  assert(Math.abs(out.height - 410) < 1, `banner short edge keeps 2.5:1 (got ${out.height})`);
}
{
  const out = outputSize(340, 136);
  assert(out.width === 340 && out.height === 136, 'small crops are never upscaled');
}
{
  const out = outputSize(1024, 410);
  assert(out.width === 1024 && out.height === 410, '1024-edge crop is not shrunk');
}

// layoutCropFrame: the frame geometry the editor actually shows.
assert(BANNER_CROP_ASPECT === 2.5, 'banner frame aspect is 2.5:1');
{
  const f = layoutCropFrame('photo', 390, 560);
  assert(f.w === f.h && f.w === 250, `photo frame is a 250px square (got ${f.w})`);
  assert(f.x === (390 - 250) / 2, 'photo frame horizontally centered');
}
{
  const f = layoutCropFrame('banner', 390, 560);
  assert(Math.abs(f.w / f.h - 2.5) < 0.001, 'banner frame is exactly 2.5:1');
  assert(f.x === (390 - f.w) / 2, 'banner frame horizontally centered');
  assert(f.y >= 0 && f.y + f.h <= 560, 'banner frame sits inside the editor');
}
{
  // Narrow editor: the frame shrinks to fit, keeping its aspect.
  const f = layoutCropFrame('banner', 300, 560);
  assert(f.w === 300 - 32, 'banner frame shrinks to fit a narrow editor');
  assert(Math.abs(f.w / f.h - 2.5) < 0.001, 'aspect survives the shrink');
}

// initialOffset: the image starts centered on the frame.
assert(initialOffset(100, 250, 1200, 0.5) === 100 + 125 - 300, 'image centers on the frame at start');

// ---------------------------------------------------------------------------
// Gesture logic (Anuraj, Sept 2026): tap must not move the image — panning
// arms only after real drag travel; slider touches zoom only and never move
// the screen.
// ---------------------------------------------------------------------------

// dragExceeded: the tap/drag threshold contract.
assert(DRAG_START_THRESHOLD === 8, 'drag threshold is 8pt');
assert(dragExceeded(0, 0) === false, 'no travel is a tap');
assert(dragExceeded(5, 5) === false, '7.07px diagonal travel is still a tap');
assert(dragExceeded(8, 0) === true, '8px horizontal travel arms the drag');
assert(dragExceeded(0, -8) === true, '8px vertical travel arms the drag (any direction)');
assert(dragExceeded(6, 6) === true, '8.49px diagonal travel arms the drag');
assert(dragExceeded(100, 100) === true, 'large travel arms the drag');
assert(dragExceeded(4, 4, 10) === false, 'custom threshold respected (below)');
assert(dragExceeded(7, 7, 10) === false, 'custom threshold respected (9.9px < 10)');
assert(dragExceeded(8, 8, 10) === true, 'custom threshold respected (above)');

// Component gesture wiring (static source pins — RN is not importable here;
// globals are declared the same way tests/celebration_redesign.test.ts
// declares them).
declare const process: { env: Record<string, string | undefined> };
declare const require: any;
const fs: { readFileSync(p: string, enc: string): string } = require('fs');
const path: { join(...parts: string[]): string } = require('path');
const ROOT = process.env.CTC_REPO_ROOT ?? '';
assert(ROOT.length > 0, 'CTC_REPO_ROOT is set (tests/run.sh exports it)');
const cropper = fs.readFileSync(path.join(ROOT, 'src/components/PhotoCropper.tsx'), 'utf8');

// 1. Tap must not move the image: the drag arms only past the threshold,
// and below it the move handler returns before applying any offset.
assert(cropper.includes('dragExceeded('), 'editor gates panning on dragExceeded');
assert(cropper.includes('started: false'), 'drag starts disarmed on touch start');
assert(
  /if \(!dragExceeded\(dx, dy\)\) return;/.test(cropper),
  'sub-threshold travel returns before the offset is applied (tap = no-op)',
);

// 2. Slider touches must not move the screen: the slider isolates its
// touches, the editor ignores touches that began on the bottom controls,
// and the browser is told never to scroll from the editor or the slider.
assert(
  cropper.includes('evt.preventDefault?.()') && cropper.includes('evt.stopPropagation?.()'),
  'slider handler calls preventDefault/stopPropagation',
);
assert(cropper.includes('controlTouches'), 'editor tracks touches that began on the bottom controls');
assert(
  cropper.includes('controlTouches.current.has(t.identifier)'),
  'editor ignores touches that started on the slider/bottom controls',
);
{
  const trackBlock = cropper.slice(cropper.indexOf('track: {'), cropper.indexOf('track: {') + 400);
  assert(trackBlock.includes("touchAction: 'none'"), 'slider track sets touchAction none (web)');
}
{
  const editorBlock = cropper.slice(cropper.indexOf('editor: {'), cropper.indexOf('editor: {') + 400);
  assert(editorBlock.includes("touchAction: 'none'"), 'editor surface sets touchAction none (web)');
}

summary('photo_cropper');
