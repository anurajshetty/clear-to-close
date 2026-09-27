// photo_cropper.test.ts — REGRESSION + geometry guard for the in-app crop
// editor (Anuraj-approved, Sept 2026).
//
// After the realtor picks a profile photo or banner, the crop editor opens
// BEFORE saving: drag to position, pinch/slide to zoom; the circular frame
// shows exactly what lands in the photo circle, the wide ~2.5:1 rectangle
// exactly what lands in the banner strip. RN components are not importable
// in the node suite, so this pins the pure geometry contract in
// src/lib/cropMath.ts (cover scale, clamp, slider/zoom mapping, pinch
// anchoring, editor->source crop rect, output size caps, frame layout).

import { assert, summary } from './assert';
import {
  BANNER_CROP_ASPECT,
  MAX_CROP_EDGE,
  anchorOffset,
  clampOffset,
  clampSlider,
  coverScale,
  cropSourceRect,
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

// Slider band.
assert(clampSlider(50) === 100, 'slider clamps up to 100');
assert(clampSlider(400) === 300, 'slider clamps down to 300');
assert(clampSlider(160) === 160, 'slider passes through in-band values');
assert(sliderToScale(100, 0.5) === 0.5, 'slider 100 = cover scale');
assert(sliderToScale(300, 0.5) === 1.5, 'slider 300 = 3x cover scale');
assert(sliderToScale(130, 0.5) === 0.65, 'slider 130 = 1.3x cover (photo default)');
assert(scaleToSlider(0.5, 0.5) === 100, 'cover scale maps back to 100');
assert(Math.abs(scaleToSlider(0.55, 0.5) - 110) < 1e-9, '1.1x cover maps back to 110 (banner default)');
assert(initialSliderValue('photo') === 130, 'photo starts at 130');
assert(initialSliderValue('banner') === 110, 'banner starts at 110');

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

summary('photo_cropper');
