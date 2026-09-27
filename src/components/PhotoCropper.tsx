// Clear to Close — in-app photo crop editor (Sept 2026, Anuraj-approved).
//
// After the realtor picks a profile photo or banner, this editor opens BEFORE
// saving. Drag to position, pinch (or the zoom slider) to zoom. The frame
// shows exactly what clients will see: a circle for the profile photo, a
// wide ~2.5:1 rectangle for the banner. "Use photo / Use banner" crops the
// source at full resolution, downscales (long edge <= 1024px, JPEG ~0.8),
// and hands the result back; Cancel / Retake back out without saving.
//
// Geometry lives in src/lib/cropMath.ts (pure, unit-tested); this file only
// renders and wires touch gestures + expo-image-manipulator.

import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import {
  anchorOffset,
  clampOffset,
  coverScale,
  cropSourceRect,
  initialOffset,
  initialSliderValue,
  layoutCropFrame,
  outputSize,
  pinchScale,
  scaleToSlider,
  sliderToScale,
  type CropFrame,
  type CropKind,
} from '../lib/cropMath';

export type { CropKind };

interface PhotoCropperProps {
  visible: boolean;
  /** Raw picked image URI (not yet cropped or saved). */
  imageUri: string;
  /** Source dimensions from the picker; falls back to an Image.getSize lookup. */
  imageWidth?: number;
  imageHeight?: number;
  kind: CropKind;
  /** Called with the cropped + downscaled URI when the user taps Use. */
  onUse: (croppedUri: string) => void;
  /** Back out without saving. */
  onCancel: () => void;
  /** Re-open the image picker (parent re-launches it). */
  onRetake: () => void;
}

const AMBER = '#E3B95C';

interface TouchPoint {
  x: number;
  y: number;
}

export function PhotoCropper({
  visible,
  imageUri,
  imageWidth,
  imageHeight,
  kind,
  onUse,
  onCancel,
  onRetake,
}: PhotoCropperProps) {
  const { width: windowW } = useWindowDimensions();
  const [imgW, setImgW] = useState(imageWidth ?? 0);
  const [imgH, setImgH] = useState(imageHeight ?? 0);

  // Editor geometry (real layout, not assumed).
  const [editorW, setEditorW] = useState(0);
  const [editorH, setEditorH] = useState(0);

  // Interactive state; refs are the source of truth inside touch handlers.
  const [scale, setScale] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [slider, setSlider] = useState(initialSliderValue(kind));
  const [busy, setBusy] = useState(false);
  const [cropError, setCropError] = useState(false);

  const st = useRef({ scale: 1, offsetX: 0, offsetY: 0, slider: initialSliderValue(kind) });
  const editorRef = useRef<View | null>(null);
  const editorPage = useRef({ x: 0, y: 0 });
  const trackRef = useRef<View | null>(null);
  const trackW = useRef(0);
  const touches = useRef(new Map<number, TouchPoint>());
  const drag = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const pinch = useRef<{
    dist: number;
    scale: number;
    ox: number;
    oy: number;
    ax: number;
    ay: number;
  } | null>(null);

  // Reset per image.
  useEffect(() => {
    if (!visible) return;
    setBusy(false);
    setCropError(false);
    setSlider(initialSliderValue(kind));
    st.current.slider = initialSliderValue(kind);
    touches.current.clear();
    drag.current = null;
    pinch.current = null;
    if (imageWidth && imageHeight) {
      setImgW(imageWidth);
      setImgH(imageHeight);
    } else {
      Image.getSize(
        imageUri,
        (w, h) => {
          setImgW(w);
          setImgH(h);
        },
        () => {},
      );
    }
  }, [visible, imageUri, kind, imageWidth, imageHeight]);

  const frame: CropFrame | null =
    editorW > 0 && editorH > 0 ? layoutCropFrame(kind, editorW, editorH) : null;

  // Place the image once both the frame and the source size are known.
  useEffect(() => {
    if (!frame || imgW <= 0 || imgH <= 0) return;
    const cover = coverScale(imgW, imgH, frame.w, frame.h);
    const s = sliderToScale(st.current.slider, cover);
    const ox = initialOffset(frame.x, frame.w, imgW, s);
    const oy = initialOffset(frame.y, frame.h, imgH, s);
    st.current = { ...st.current, scale: s, offsetX: ox, offsetY: oy };
    setScale(s);
    setOffsetX(ox);
    setOffsetY(oy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame !== null, imgW, imgH]);

  const apply = (s: number, ox: number, oy: number, cover: number) => {
    const cs = Math.max(cover, s);
    const cx = clampOffset(ox, imgW * cs, frame!.x, frame!.w);
    const cy = clampOffset(oy, imgH * cs, frame!.y, frame!.h);
    st.current.scale = cs;
    st.current.offsetX = cx;
    st.current.offsetY = cy;
    st.current.slider = scaleToSlider(cs, cover);
    setScale(cs);
    setOffsetX(cx);
    setOffsetY(cy);
    setSlider(st.current.slider);
  };

  const dist = (a: TouchPoint, b: TouchPoint) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  const onEditorTouchStart = (e: any) => {
    if (busy || !frame) return;
    editorRef.current?.measureInWindow((px: number, py: number) => {
      editorPage.current = { x: px, y: py };
    });
    const changed: any[] = e.nativeEvent.changedTouches ?? [];
    for (const t of changed) {
      touches.current.set(t.identifier, { x: t.pageX, y: t.pageY });
    }
    const pts = [...touches.current.values()];
    if (pts.length === 2) {
      const midX = (pts[0].x + pts[1].x) / 2 - editorPage.current.x;
      const midY = (pts[0].y + pts[1].y) / 2 - editorPage.current.y;
      pinch.current = {
        dist: dist(pts[0], pts[1]),
        scale: st.current.scale,
        ox: st.current.offsetX,
        oy: st.current.offsetY,
        ax: midX,
        ay: midY,
      };
      drag.current = null;
    } else if (pts.length === 1) {
      drag.current = {
        startX: pts[0].x,
        startY: pts[0].y,
        ox: st.current.offsetX,
        oy: st.current.offsetY,
      };
      pinch.current = null;
    }
  };

  const onEditorTouchMove = (e: any) => {
    if (busy || !frame) return;
    const changed: any[] = e.nativeEvent.changedTouches ?? [];
    for (const t of changed) {
      if (touches.current.has(t.identifier)) {
        touches.current.set(t.identifier, { x: t.pageX, y: t.pageY });
      }
    }
    const cover = coverScale(imgW, imgH, frame.w, frame.h);
    const pts = [...touches.current.values()];
    if (pts.length === 2 && pinch.current) {
      const p = pinch.current;
      const ns = pinchScale(p.scale, p.dist, dist(pts[0], pts[1]), cover);
      const midX = (pts[0].x + pts[1].x) / 2 - editorPage.current.x;
      const midY = (pts[0].y + pts[1].y) / 2 - editorPage.current.y;
      const nx = anchorOffset(p.ox, p.scale, ns, midX);
      const ny = anchorOffset(p.oy, p.scale, ns, midY);
      apply(ns, nx, ny, cover);
    } else if (pts.length === 1 && drag.current) {
      const d = drag.current;
      apply(
        st.current.scale,
        d.ox + pts[0].x - d.startX,
        d.oy + pts[0].y - d.startY,
        cover,
      );
    }
  };

  const onEditorTouchEnd = (e: any) => {
    const changed: any[] = e.nativeEvent.changedTouches ?? [];
    for (const t of changed) touches.current.delete(t.identifier);
    if (touches.current.size < 2) pinch.current = null;
    if (touches.current.size === 0) drag.current = null;
  };

  // Zoom slider: tap or drag the track.
  const setSliderFromTrack = (e: any) => {
    if (busy || !frame || trackW.current <= 0) return;
    const locX: number =
      e.nativeEvent.locationX ??
      e.nativeEvent.pageX - editorPage.current.x;
    const v = 100 + (Math.min(trackW.current, Math.max(0, locX)) / trackW.current) * 200;
    const cover = coverScale(imgW, imgH, frame.w, frame.h);
    const s = sliderToScale(v, cover);
    // Zoom about the frame center so the slider feels anchored.
    const cx = frame.x + frame.w / 2;
    const cy = frame.y + frame.h / 2;
    apply(s, anchorOffset(st.current.offsetX, st.current.scale, s, cx),
      anchorOffset(st.current.offsetY, st.current.scale, s, cy), cover);
  };

  const onUsePress = async () => {
    if (busy || !frame || imgW <= 0 || imgH <= 0) return;
    setBusy(true);
    setCropError(false);
    try {
      const rect = cropSourceRect(imgW, imgH, st.current.offsetX, st.current.offsetY, st.current.scale, frame);
      const out = outputSize(rect.width, rect.height);
      const result = await manipulateAsync(
        imageUri,
        [
          {
            crop: {
              originX: rect.originX,
              originY: rect.originY,
              width: rect.width,
              height: rect.height,
            },
          },
          { resize: { width: out.width, height: out.height } },
        ],
        { compress: 0.8, format: SaveFormat.JPEG },
      );
      onUse(result.uri);
    } catch {
      setCropError(true);
    } finally {
      setBusy(false);
    }
  };

  const title = kind === 'photo' ? 'Profile photo' : 'Banner image';
  const hint =
    kind === 'photo'
      ? 'Drag to move · pinch or slide to zoom'
      : 'The frame shows exactly what appears in your banner';
  const useLabel = kind === 'photo' ? 'Use photo' : 'Use banner';

  const ready = frame !== null && imgW > 0 && imgH > 0;
  const scaledW = imgW * scale;
  const scaledH = imgH * scale;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      <View style={styles.root}>
        {/* Editor surface */}
        <View
          ref={editorRef}
          style={styles.editor}
          onLayout={(e) => {
            setEditorW(e.nativeEvent.layout.width);
            setEditorH(e.nativeEvent.layout.height);
          }}
          onTouchStart={onEditorTouchStart}
          onTouchMove={onEditorTouchMove}
          onTouchEnd={onEditorTouchEnd}
          onTouchCancel={onEditorTouchEnd}
        >
          {ready && (
            <Image
              source={{ uri: imageUri }}
              style={{
                position: 'absolute',
                left: offsetX,
                top: offsetY,
                width: scaledW,
                height: scaledH,
              }}
              resizeMode="stretch"
            />
          )}
          {/* Dimmed mask + frame */}
          {frame && (
            <View style={styles.mask} pointerEvents="none">
              <View style={[styles.shade, { left: 0, top: 0, width: editorW, height: frame.y }]} />
              <View
                style={[
                  styles.shade,
                  { left: 0, top: frame.y + frame.h, width: editorW, height: editorH - frame.y - frame.h },
                ]}
              />
              <View
                style={[styles.shade, { left: 0, top: frame.y, width: frame.x, height: frame.h }]}
              />
              <View
                style={[
                  styles.shade,
                  {
                    left: frame.x + frame.w,
                    top: frame.y,
                    width: editorW - frame.x - frame.w,
                    height: frame.h,
                  },
                ]}
              />
              <View
                style={[
                  styles.frame,
                  {
                    left: frame.x,
                    top: frame.y,
                    width: frame.w,
                    height: frame.h,
                    borderRadius: kind === 'photo' ? frame.w / 2 : 0,
                  },
                ]}
              />
            </View>
          )}
        </View>

        {/* Top bar */}
        <View style={styles.topbar} pointerEvents="box-none">
          <Pressable onPress={onCancel} accessibilityRole="button" accessibilityLabel="Cancel">
            <Text style={styles.topBtn}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>{title}</Text>
          <View style={{ width: 52 }} />
        </View>

        {/* Bottom controls */}
        <View style={styles.bottom}>
          <Text style={styles.hint}>{hint}</Text>
          <View style={styles.zoomRow}>
            <Text style={styles.zoomGlyph}>−</Text>
            <View
              ref={trackRef}
              style={styles.track}
              onLayout={(e) => {
                trackW.current = e.nativeEvent.layout.width;
              }}
              onTouchStart={setSliderFromTrack}
              onTouchMove={setSliderFromTrack}
            >
              <View style={styles.trackLine} />
              <View
                style={[
                  styles.thumb,
                  { left: `${((slider - 100) / 200) * 100}%` },
                ]}
              />
            </View>
            <Text style={styles.zoomGlyph}>+</Text>
          </View>
          {cropError ? (
            <Text style={styles.error}>Couldn’t crop that image. Try a different one.</Text>
          ) : null}
          <View style={styles.ctaRow}>
            <Pressable
              onPress={onRetake}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Retake"
              style={[styles.cta, styles.ctaGhost]}
            >
              <Text style={styles.ctaGhostText}>Retake</Text>
            </Pressable>
            <Pressable
              onPress={onUsePress}
              disabled={busy || !ready}
              accessibilityRole="button"
              accessibilityLabel={useLabel}
              style={[styles.cta, styles.ctaUse, (!ready || busy) && styles.ctaDisabled]}
            >
              {busy ? (
                <ActivityIndicator color="#211D17" />
              ) : (
                <Text style={styles.ctaUseText}>{useLabel}</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  editor: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  mask: {
    ...StyleSheet.absoluteFill,
  },
  shade: {
    position: 'absolute',
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  frame: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#fff',
    // Hairline dark edge so the white frame reads on light photos.
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 2,
  },
  topbar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 54,
    paddingBottom: 12,
  },
  topBtn: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  title: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 34,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  hint: {
    color: '#fff',
    textAlign: 'center',
    fontSize: 13.5,
    opacity: 0.9,
    marginBottom: 12,
  },
  zoomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
  },
  zoomGlyph: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    width: 22,
    textAlign: 'center',
  },
  track: {
    flex: 1,
    height: 28,
    justifyContent: 'center',
  },
  trackLine: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  thumb: {
    position: 'absolute',
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: AMBER,
    marginLeft: -13,
    top: 1,
  },
  error: {
    color: '#FF9D9D',
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 10,
  },
  ctaRow: {
    flexDirection: 'row',
    gap: 10,
  },
  cta: {
    flex: 1,
    paddingVertical: 15,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaUse: {
    backgroundColor: AMBER,
  },
  ctaUseText: {
    color: '#211D17',
    fontSize: 16,
    fontWeight: '700',
  },
  ctaGhost: {
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  ctaGhostText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  ctaDisabled: {
    opacity: 0.5,
  },
});
