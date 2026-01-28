# Zoom Layout Desynchronization: Issue Analysis & Fix

## 1. Issue Description
When zooming (via pinch logic), the canvas content (grid and ink) drifts away from the pointer's location, causing a feeling of "floating" or "layout mismatch". The grid lines do not stay "stuck" to the finger as expected in a native app.

## 2. Root Cause Analysis
The issue stems from a **Coordinate Space Mismatch** between the input event system and the canvas rendering system.

### A. The Input Perspective (NuanceCanvas.tsx)
The zoom logic in `NuanceCanvas.tsx` calculates the "center point" (`cx`, `cy`) of the pinch gesture using raw `ClientX/ClientY` coordinates:

```typescript
// NuanceCanvas.tsx (Current Logic)
const cx = (points[0].x + points[1].x) / 2; // Derived from e.clientX (Viewport Space)
const cy = (points[0].y + points[1].y) / 2;
// ...
rendererRef.current?.zoom(safeScale, cx, cy);
```

These `cx, cy` values are relative to the **Browser Viewport (Top-Left 0,0)**.

### B. The Renderer Perspective (geminiInkRenderer.ts)
The `zoom()` method in the renderer calculates the world position assuming that `screenX, screenY` are relative to the **Canvas Origin (Top-Left 0,0)**.

```typescript
// geminiInkRenderer.ts
const worldX = (screenX / this.camera.zoom) - this.camera.x;
```

### C. The Discrepancy
If the Canvas is NOT perfectly at `(0,0)` of the viewport (e.g., due to margins, borders, or parent container padding), then:
`ClientX != CanvasLocalX`

Even if `App.tsx` sets `top: 0, left: 0`, mobile browsers often have dynamic toolbars (Address bar) that shift the viewport or affect `ClientY`. Or if the parent div has `position: relative`, the offset might be miscalculated.

**Result**: The mathematical "pivot point" for the zoom is shifted by the offset of the canvas, causing the visual "drift".

## 3. Recommended Fix

We must transform the `ClientX/Y` coordinates into `CanvasLocalX/Y` before passing them to the zoom function.

### File: `src/components/NuanceCanvas.tsx`

**Locate**: `handlePointerMove` function, inside the "2 Finger Zoom" block.

**Change This**:
```typescript
const cx = (points[0].x + points[1].x) / 2;
const cy = (points[0].y + points[1].y) / 2;
```

**To This**:
```typescript
const rect = e.currentTarget.getBoundingClientRect(); // Get Canvas Position
const cx = ((points[0].x + points[1].x) / 2) - rect.left; // Subtract global offset
const cy = ((points[0].y + points[1].y) / 2) - rect.top;
```

## 4. Alternate Solution (Renderer Side)
Alternatively, update `geminiInkRenderer.ts` to accept Client inputs and perform the conversion internally. However, fixing it at the Input source (`NuanceCanvas`) is cleaner React practice.

## 5. Verification
After applying the fix:
1.  Open the app on a mobile device.
2.  Place two fingers on a specific grid intersection.
3.  Pinch to zoom in/out.
4.  **Success Condition**: The grid intersection should stay exactly between your fingers, without drifting away.
