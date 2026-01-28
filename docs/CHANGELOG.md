# Nuance Web - Changelog

## [v1.7] - IN DEVELOPMENT
### Added
- **Friction Engine** - Simulates paper friction when writing
  - Stroke resistance (slight lag for "dragging pen through paper" feel)
  - Enhanced haptic patterns based on velocity/pressure
  - Grain direction simulation

### Files
- `src/core/FrictionEngine.ts` (NEW)
- `src/core/HapticEngine.ts` (MODIFIED)
- `src/core/geminiInkRenderer.ts` (MODIFIED)

---

## [v1.6] - 2026-01-28
### Fixed
- Rendering stability (iPad/Safari fixes)
- Block redraw during active stroke
- Defer canvas resize during drawing
- Paper texture callback protection
- Coalesced events fallback for smoother pen input

### Changed
- Sound volume reduced (6.0x → 1.2x multiplier)
- Active drawing pointer tracking
- Lost pointer capture handler for iPad

### Known Issues
- iPad: Some visual stroke loss still occurring

---

## [v1.5] - 2026-01-28
### Added
- Haptic Engine with paper grain simulation
- Sound Engine with spatial audio
- Multiple brush profiles (pencil, charcoal, ballpoint, etc.)
- Glass Dock UI

### Initial Features
- Infinite canvas with zoom/pan
- Pressure-sensitive strokes
- Bezier curve smoothing

---

*Maintained by development team*
