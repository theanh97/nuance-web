# Friction Engine - Feature Documentation

> **Status**: IN DEVELOPMENT
> **Version Target**: v1.7
> **Author**: Claude AI + Jack
> **Created**: 2026-01-28
> **Last Updated**: 2026-01-28

---

## 1. Overview

### Goal
Tạo cảm giác **ma sát thực** khi viết trên màn hình, khiến người dùng cảm nhận như đang viết trên giấy thật.

### Why This Matters
- Đây là **blue ocean** - ít app nào làm được
- Tạo differentiation mạnh so với Procreate, GoodNotes, Samsung Notes
- Tăng immersive experience đáng kể

---

## 2. Technical Approach

```
┌─────────────────────────────────────────────────────────────────┐
│                    FRICTION ENGINE                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  INPUT ──▶ FRICTION PROCESSOR ──▶ OUTPUT                       │
│                                                                 │
│  • Position      ┌──────────────────┐     • Adjusted Position  │
│  • Pressure      │  1. Resistance   │     • Modified Stroke    │
│  • Velocity      │  2. Texture      │     • Haptic Pattern     │
│  • Direction     │  3. Grain Sim    │     • Sound Modulation   │
│                  └──────────────────┘                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Components

| Component | File | Description |
|-----------|------|-------------|
| FrictionEngine | `src/core/FrictionEngine.ts` | Main friction calculation |
| HapticEngine | `src/core/HapticEngine.ts` | Enhanced haptic patterns |
| SoundEngine | `src/core/SoundEngine.ts` | Friction-aware sound |
| geminiInkRenderer | `src/core/geminiInkRenderer.ts` | Integration point |

---

## 3. Feature Details

### 3.1 Stroke Resistance
**Concept**: Tạo slight lag giữa pen position và stroke position, giống như bút "kéo" qua giấy.

```typescript
// Pseudo-code
const resistanceFactor = calculateResistance(pressure, velocity, surfaceType);
const adjustedPosition = {
    x: lastPosition.x + (targetPosition.x - lastPosition.x) * (1 - resistanceFactor),
    y: lastPosition.y + (targetPosition.y - lastPosition.y) * (1 - resistanceFactor)
};
```

**Parameters**:
- `baseResistance`: 0.0 - 1.0 (default: 0.15)
- `pressureMultiplier`: Higher pressure = more resistance
- `velocityDamping`: Faster = less resistance (momentum)

### 3.2 Texture Haptic
**Concept**: Micro-vibrations thay đổi theo:
- Speed (nhanh = vibration dày đặc hơn)
- Pressure (mạnh = vibration mạnh hơn)
- Direction (horizontal vs vertical = pattern khác)

**Pattern Types**:
- `grain`: Simulates paper grain (subtle, frequent)
- `scratch`: Simulates pencil scratch (irregular)
- `smooth`: Simulates marker on glossy paper (minimal)

### 3.3 Grain Direction Simulation
**Concept**: Giấy có thớ (grain). Khi vẽ theo thớ = mượt, vẽ ngược thớ = rít.

```
Paper Grain Direction: →→→→→→→→→
Drawing ↓ (perpendicular) = More friction, stronger haptic
Drawing → (parallel) = Less friction, softer haptic
```

---

## 4. Implementation Plan

### Phase 1: FrictionEngine Core (Current)
- [ ] Create `FrictionEngine.ts`
- [ ] Implement basic resistance calculation
- [ ] Integrate with geminiInkRenderer
- [ ] Test on Samsung + iPad

### Phase 2: Enhanced Haptic
- [ ] Add texture-based haptic patterns
- [ ] Implement grain direction detection
- [ ] Variable vibration intensity

### Phase 3: Advanced Features
- [ ] Surface type presets (paper, canvas, glass)
- [ ] User-adjustable friction level
- [ ] Per-brush friction profiles

---

## 5. Files Modified

| File | Changes |
|------|---------|
| `src/core/FrictionEngine.ts` | NEW - Main friction logic |
| `src/core/HapticEngine.ts` | ADD texture patterns |
| `src/core/geminiInkRenderer.ts` | INTEGRATE FrictionEngine |
| `src/components/NuanceCanvas.tsx` | ADD friction controls (optional) |

---

## 6. Testing Checklist

- [ ] Samsung Galaxy Tab + S Pen
- [ ] iPad + Apple Pencil
- [ ] Desktop + Mouse (should feel different)
- [ ] Performance impact < 5ms per frame
- [ ] Battery impact acceptable

---

## 7. Known Issues / Risks

| Risk | Mitigation |
|------|------------|
| Too much lag feels sluggish | Keep resistance < 0.3, add "catch-up" when pen stops |
| Haptic drains battery | Rate-limit vibrations, user toggle |
| Conflicts with smoothing | Friction applies BEFORE smoothing |

---

## 8. References

- Current smoothing: `config.streamline` in geminiInkRenderer
- Haptic API: `navigator.vibrate()` - limited pattern control
- Sound integration: Already uses velocity for volume

---

*Document maintained by development team. Update when making changes.*
