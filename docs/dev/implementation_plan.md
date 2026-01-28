# Implementation Plan - Phase 3: The "Alive" Ink

## Goal
To implement the "Micro-Physics" and "Visual Haptics" features defined in the `01_Sensory_Physics_Engine.md` spec, creating a sensation that the ink is a living fluid rather than static pixels.

## User Review Required
> [!IMPORTANT]
> **Manual Code Preservation**: I noticed you manually added **Spatial Audio Panning** and **Pivot Zoom** logic. This plan explicitly preserves those changes and builds upon them.

> [!NOTE]
> **Performance Impact**: Simulating fluid dynamics (Ink Bleed) requires a tick loop even when the pen is static. This may have a minor battery impact on mobile devices.

## Proposed Changes

### 1. Ink Bleed (Micro-Fluid dynamics)
**Feature**: When the pen pauses on the paper (Velocity $\approx$ 0, Pressure > 0), the ink should slowly "bleed" or spread outward, simulating absorption.
- **Files**:
    - `src/core/geminiInkRenderer.ts`: Add a "Wet Ink" simulation loop.
    - `src/components/NuanceCanvas.tsx`: Update render loop to support active wet states.

### 2. Paper Texture (Visual Friction)
**Feature**: Apply a subtle grain texture to the canvas. Pencil strokes should appear "rougher" (breaking up) on this texture vs. Ink strokes.
- **Files**:
    - `src/components/NuanceCanvas.tsx`: Add a CSS mult-blend overlay for paper grain.
    - `src/core/geminiInkRenderer.ts`: Modulate opacity/width based on a noise function for "Pencil" and "Charcoal" profiles.

### 3. Refined Spatial Audio (Building on your work)
**Feature**: You added basic panning. I will refine it to be "Binaural" for headphones - moving the pen left/right shifts the scratching sound presence accurately.
- **Files**:
    - `src/core/SoundEngine.ts`: Fine-tune the `PannerNode` logic you added.

## Verification Plan

### Manual Verification
1.  **Bleed Test**:
    - Select **Fountain Pen**.
    - Press and hold the pen in one spot without moving.
    - **Expectation**: The ink dot should slowly grow diameter by ~20-30% over 2 seconds.
2.  **Texture Test**:
    - Select **Pencil** or **Charcoal**.
    - Draw lightly.
    - **Expectation**: The stroke edges should look "rough" or "grainy", not perfect computer-smooth lines.
3.  **Spatial Test**:
    - Wear headphones.
    - Draw from left edge to right edge.
    - **Expectation**: Sound moves continuously from Left Ear -> Right Ear.
