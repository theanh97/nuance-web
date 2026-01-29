import { useRef, forwardRef, useImperativeHandle, useEffect, useState } from 'react';
import { GeminiInkRenderer, type GridType, type SerializedDrawing } from '../core/geminiInkRenderer';
import { type SoundProfile } from '../core/SoundEngine';

export interface NuanceCanvasHandle {
    exportImage: () => Promise<string>;
    exportStrokes: () => SerializedDrawing | null;
    loadStrokes: (data: SerializedDrawing) => void;
    undo: () => boolean;
    redo: () => boolean;
    canUndo: () => boolean;
    canRedo: () => boolean;
    clearAll: () => void;
    setRawMode: (enabled: boolean) => void;
    setSurfaceTexture: (texture: number) => void;
    // v2.0: Selection tool
    setToolMode: (mode: 'draw' | 'select') => void;
    deleteSelected: () => boolean;
    changeSelectedColor: (color: string) => boolean;
    clearSelection: () => void;
    // v2.1: Grid types
    setGridType: (type: GridType) => void;
}

interface NuanceCanvasProps {
    brushSize: number;
    penOnly: boolean;
    soundProfile: SoundProfile;
    soundVolume: number;
    strokeColor: string;
    smoothing?: number;
    hapticEnabled?: boolean;
    surfaceTexture?: number;
    // v2.0: Selection tool
    onSelectionChange?: (count: number) => void;
    multiSelectMode?: boolean;
    selectionType?: 'rect' | 'lasso';
    interactionMode?: 'edit' | 'view';
}

export const NuanceCanvas = forwardRef<NuanceCanvasHandle, NuanceCanvasProps>(({ brushSize, penOnly: _penOnly, soundProfile, soundVolume, strokeColor, smoothing, hapticEnabled = false, surfaceTexture = 0.4, onSelectionChange, multiSelectMode = false, selectionType = 'lasso', interactionMode = 'edit' }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rendererRef = useRef<GeminiInkRenderer | null>(null);

    useImperativeHandle(ref, () => ({
        exportImage: async () => {
            if (rendererRef.current) {
                return await rendererRef.current.exportImage();
            }
            return '';
        },
        exportStrokes: () => {
            if (rendererRef.current) {
                return rendererRef.current.exportStrokes();
            }
            return null;
        },
        loadStrokes: (data: SerializedDrawing) => {
            if (rendererRef.current) {
                rendererRef.current.loadStrokes(data);
            }
        },
        undo: () => {
            if (rendererRef.current) {
                return rendererRef.current.undo();
            }
            return false;
        },
        redo: () => {
            if (rendererRef.current) {
                return rendererRef.current.redo();
            }
            return false;
        },
        canUndo: () => {
            if (rendererRef.current) {
                return rendererRef.current.canUndo();
            }
            return false;
        },
        canRedo: () => {
            if (rendererRef.current) {
                return rendererRef.current.canRedo();
            }
            return false;
        },
        clearAll: () => {
            if (rendererRef.current) {
                rendererRef.current.clearAll();
            }
        },
        setRawMode: (enabled: boolean) => {
            if (rendererRef.current) {
                rendererRef.current.setRawMode(enabled);
            }
        },
        setSurfaceTexture: (texture: number) => {
            if (rendererRef.current) {
                rendererRef.current.setSurfaceTexture(texture);
            }
        },
        // v2.0: Selection tool
        setToolMode: (mode: 'draw' | 'select') => {
            if (rendererRef.current) {
                rendererRef.current.setToolMode(mode);
            }
        },
        deleteSelected: () => {
            if (rendererRef.current) {
                return rendererRef.current.deleteSelected();
            }
            return false;
        },
        changeSelectedColor: (color: string) => {
            if (rendererRef.current) {
                return rendererRef.current.changeSelectedColor(color);
            }
            return false;
        },
        clearSelection: () => {
            if (rendererRef.current) {
                rendererRef.current.clearSelection();
            }
        },
        // v2.1: Grid types
        setGridType: (type: GridType) => {
            if (rendererRef.current) {
                rendererRef.current.setGridType(type);
            }
        }
    }));
    const containerRef = useRef<HTMLDivElement>(null);

    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    // Initialize Renderer
    useEffect(() => {
        try {
            if (!canvasRef.current || rendererRef.current) return;
            rendererRef.current = new GeminiInkRenderer(canvasRef.current);

            const handleResize = () => rendererRef.current?.resize();
            window.addEventListener('resize', handleResize);
            return () => {
                window.removeEventListener('resize', handleResize);
                rendererRef.current?.destroy();
                rendererRef.current = null;
            };
        } catch (err: any) {
            console.error("Renderer Init Failed:", err);
            setErrorMsg(err.message || "Unknown Renderer Error");
        }
    }, []);

    // Configuration Update
    useEffect(() => {
        if (rendererRef.current) {
            // Physics Profiles - SHARP INK v1.7.4: Much finer minWidth for crisp tips
            const physics: Record<SoundProfile, any> = {
                pencil: { minWidth: 0.5, maxWidth: 6, opacity: 0.85, velocityInfluence: 0.8 },      // SHARP: Fine tip like 0.5mm pencil
                charcoal: { minWidth: 2, maxWidth: 14, opacity: 0.7 },                              // Charcoal stays thick
                ballpoint: { minWidth: 0.3, maxWidth: 4, opacity: 1.0, velocityInfluence: 0.9 },   // SHARP: Ultra-fine like 0.38mm pen
                fountain: { minWidth: 0.5, maxWidth: 12, opacity: 1.0, streamline: 0.6, velocityInfluence: 0.7 }, // SHARP: Dynamic nib
                marker: { minWidth: 6, maxWidth: 20, opacity: 0.5 },                                // Marker stays thick
                highlighter: { minWidth: 15, maxWidth: 20, opacity: 0.3, streamline: 0.2 },        // Highlighter fixed
                monoline: { minWidth: 4, maxWidth: 4, opacity: 1.0, streamline: 0.8, pressureInfluence: 0, velocityInfluence: 0 }, // Fixed width
                calligraphy: { minWidth: 0.5, maxWidth: 20, opacity: 1.0, streamline: 0.7, pressureInfluence: 1.5, velocityInfluence: 0.6 } // SHARP: Dramatic contrast
            };

            const p = physics[soundProfile] || {};
            // Scale width by brushSize prop
            const scale = brushSize / 8;

            rendererRef.current.updateConfig({
                color: strokeColor, // User selected color
                opacity: p.opacity || 1.0,
                baseStrokeWidth: brushSize,
                minWidth: (p.minWidth || 0.5) * scale,  // SHARP INK: Lower default minWidth
                maxWidth: (p.maxWidth || 12) * scale,
                streamline: smoothing ?? (p.streamline || 0.35), // Use prop or default
                pressureInfluence: p.pressureInfluence ?? 0.8,   // SHARP INK: Higher default
                velocityInfluence: p.velocityInfluence ?? 0.7    // SHARP INK: Pass velocity influence
            });

            if (rendererRef.current.setSoundProfile) rendererRef.current.setSoundProfile(soundProfile);
            if (rendererRef.current.setSoundVolume) rendererRef.current.setSoundVolume(soundVolume);
            if (rendererRef.current.setHapticEnabled) rendererRef.current.setHapticEnabled(hapticEnabled);
            // v1.8.0: Unified surface texture control (replaces frictionLevel)
            if (rendererRef.current.setSurfaceTexture) rendererRef.current.setSurfaceTexture(surfaceTexture);
        }
    }, [brushSize, soundProfile, soundVolume, strokeColor, smoothing, hapticEnabled, surfaceTexture]);

    // --- GESTURE & INPUT HANDLING ---
    const activePointers = useRef<Map<number, { x: number, y: number }>>(new Map());
    const prevDist = useRef<number | null>(null);
    const prevCenter = useRef<{ x: number, y: number } | null>(null); // 2-finger pan while pinching
    const activeDrawingPointer = useRef<number | null>(null);
    const viewPanPointerId = useRef<number | null>(null);
    const viewPanLast = useRef<{ x: number; y: number } | null>(null);

    // v2.0: Selection mode refs
    const isSelectDragging = useRef(false);
    const isRectSelecting = useRef(false); // v2.2: rectangle selection vs move (now also lasso)
    const isResizeDragging = useRef(false); // v2.8: resize handle drag
    const resizeHandleIndex = useRef(-1);
    const selectPointerStart = useRef<{ x: number, y: number } | null>(null);
    const selectPointerId = useRef<number | null>(null);

    // Notify parent of selection count changes
    const notifySelectionChange = () => {
        if (onSelectionChange && rendererRef.current) {
            onSelectionChange(rendererRef.current.getSelectedCount());
        }
    };

    // Helper: Get canvas-relative coordinates (works on all devices)
    const getCanvasCoords = (e: React.PointerEvent) => {
        const canvas = canvasRef.current;
        if (!canvas) return { x: 0, y: 0 };
        const rect = canvas.getBoundingClientRect();
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        // Prevent default to avoid browser gesture interference on iPad
        e.preventDefault();

        // 1. PEN/MOUSE
        if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
            e.currentTarget.setPointerCapture(e.pointerId);

            const renderer = rendererRef.current;
            if (!renderer) return;

            const { x, y } = getCanvasCoords(e);

            if (interactionMode === 'view') {
                viewPanPointerId.current = e.pointerId;
                viewPanLast.current = { x: e.clientX, y: e.clientY };
                return;
            }

            // Branch: Draw mode vs Select mode
            if (renderer.getToolMode() === 'select') {
                // Select mode: record start for tap vs drag detection
                selectPointerId.current = e.pointerId;
                selectPointerStart.current = { x, y };
                isSelectDragging.current = false;
                isRectSelecting.current = false;
                isResizeDragging.current = false;
                resizeHandleIndex.current = -1;

                // v2.8: Check resize handle first
                const handle = renderer.hitTestResizeHandle(x, y);
                if (handle !== -1) {
                    resizeHandleIndex.current = handle;
                    renderer.startResizeSelected(handle, x, y);
                    isResizeDragging.current = true;
                    isSelectDragging.current = true;
                } else {
                    // If tapping on an already-selected stroke, prepare for move drag
                    const hitIndex = renderer.hitTestStroke(x, y);
                    if (hitIndex !== -1 && renderer.getSelectedIndices().has(hitIndex)) {
                        renderer.startMoveSelected(x, y);
                    } else {
                        // v2.8: Start selection (lasso or rect based on selectionType)
                        if (selectionType === 'rect') {
                            renderer.startSelectionRect(x, y);
                        } else {
                            renderer.startLasso(x, y);
                        }
                    }
                }
            } else {
                // Draw mode: start stroke as normal
                activeDrawingPointer.current = e.pointerId;
                renderer.startStroke(x, y, e.pressure || 0.5, e.tiltX || 0, e.tiltY || 0);
            }
            return;
        }

        // 2. TOUCH: Always Gesture (Never Draw)
        if (e.pointerType === 'touch') {
            activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            rendererRef.current?.setGesturing(true);

            // Pinch Init
            if (activePointers.current.size === 2) {
                const points = Array.from(activePointers.current.values());
                prevDist.current = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
                prevCenter.current = {
                    x: (points[0].x + points[1].x) / 2,
                    y: (points[0].y + points[1].y) / 2
                };
            }
        }
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        // PEN/MOUSE
        if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
            const renderer = rendererRef.current;
            if (!renderer) return;

            if (interactionMode === 'view' && viewPanPointerId.current === e.pointerId) {
                e.preventDefault();
                const last = viewPanLast.current;
                if (last) {
                    renderer.pan(e.clientX - last.x, e.clientY - last.y);
                }
                viewPanLast.current = { x: e.clientX, y: e.clientY };
                return;
            }

            // Select mode drag
            if (renderer.getToolMode() === 'select' && selectPointerId.current === e.pointerId) {
                e.preventDefault();
                const { x, y } = getCanvasCoords(e);

                // v2.8: Resize drag
                if (isResizeDragging.current) {
                    renderer.updateResizeSelected(x, y);
                    return;
                }

                const start = selectPointerStart.current;

                if (start) {
                    const dist = Math.hypot(x - start.x, y - start.y);
                    // Drag threshold: 5px to distinguish tap from drag
                    if (dist > 5) {
                        if (!isSelectDragging.current) {
                            isSelectDragging.current = true;
                            // Determine: move drag or lasso selection
                            const hitIndex = renderer.hitTestStroke(start.x, start.y);
                            if (hitIndex !== -1 && renderer.getSelectedIndices().has(hitIndex)) {
                                isRectSelecting.current = false; // move
                            } else {
                                isRectSelecting.current = true; // lasso
                            }
                        }

                        if (isRectSelecting.current) {
                            // v2.8: Selection (lasso or rect)
                            if (selectionType === 'rect') {
                                renderer.updateSelectionRect(x, y);
                            } else {
                                renderer.updateLasso(x, y);
                            }
                        } else {
                            renderer.updateMoveSelected(x, y);
                        }
                    }
                }
                return;
            }

            // Draw mode - must match the active drawing pointer
            if (activeDrawingPointer.current === e.pointerId) {
                e.preventDefault();

                const canvas = canvasRef.current;
                if (!canvas) return;
                const rect = canvas.getBoundingClientRect();

                // Use coalesced events for smoother input
                const nativeEvent = e.nativeEvent as PointerEvent;
                const coalescedEvents = nativeEvent.getCoalescedEvents?.() || [];

                if (coalescedEvents.length > 0) {
                    for (const pe of coalescedEvents) {
                        const x = pe.clientX - rect.left;
                        const y = pe.clientY - rect.top;
                        renderer.addPoint(x, y, pe.pressure || 0.5, pe.tiltX || 0, pe.tiltY || 0);
                    }
                } else {
                    const x = e.clientX - rect.left;
                    const y = e.clientY - rect.top;
                    renderer.addPoint(x, y, e.pressure || 0.5, e.tiltX || 0, e.tiltY || 0);
                }
                return;
            }
        }

        // TOUCH: Gesture
        if (e.pointerType === 'touch') {
            const p = activePointers.current.get(e.pointerId);
            if (!p) return;

            // Calculate delta
            const dx = e.clientX - p.x;
            const dy = e.clientY - p.y;
            const dist = Math.sqrt(dx * dx + dy * dy); // Distance moved

            // PALM ANCHOR v2.0: Trigger Friction Sound
            // Velocity calculation (rough approx)
            const velocity = dist * 2; // Simple scaling
            rendererRef.current?.updatePalm(velocity);

            activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

            if (activePointers.current.size === 1) {
                // 1 Finger Pan
                rendererRef.current?.pan(dx, dy);
            }
            else if (activePointers.current.size === 2) {
                // 2 Finger Zoom + Pan (Pivot + Translate)
                const points = Array.from(activePointers.current.values());
                const curDist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
                const centerClientX = (points[0].x + points[1].x) / 2;
                const centerClientY = (points[0].y + points[1].y) / 2;

                // Convert Client coordinates to Canvas-relative coordinates
                const rect = e.currentTarget.getBoundingClientRect();
                const cx = centerClientX - rect.left;
                const cy = centerClientY - rect.top;

                if (prevDist.current) {
                    const scale = curDist / prevDist.current;
                    const safeScale = 1 + (scale - 1) * 0.8;
                    rendererRef.current?.zoom(safeScale, cx, cy);
                }
                prevDist.current = curDist;

                // Pan by midpoint movement (so 2-finger swipe can move the canvas too)
                if (prevCenter.current) {
                    rendererRef.current?.pan(
                        centerClientX - prevCenter.current.x,
                        centerClientY - prevCenter.current.y
                    );
                }
                prevCenter.current = { x: centerClientX, y: centerClientY };
            }
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
            const renderer = rendererRef.current;

            if (interactionMode === 'view' && viewPanPointerId.current === e.pointerId) {
                viewPanPointerId.current = null;
                viewPanLast.current = null;
                return;
            }

            // Select mode
            if (renderer?.getToolMode() === 'select' && selectPointerId.current === e.pointerId) {
                const { x, y } = getCanvasCoords(e);

                if (isResizeDragging.current) {
                    // v2.8: End resize
                    renderer.endResizeSelected();
                } else if (isSelectDragging.current) {
                    if (isRectSelecting.current) {
                        // v2.8: End selection (lasso or rect)
                        if (selectionType === 'rect') {
                            renderer.endSelectionRect(multiSelectMode);
                        } else {
                            renderer.endLasso(multiSelectMode);
                        }
                    } else {
                        // End drag-to-move
                        renderer.endMoveSelected();
                    }
                } else {
                    // Tap = select/deselect stroke
                    // Cancel any started selection that didn't pass threshold
                    if (selectionType === 'rect') {
                        renderer.endSelectionRect(false);
                    } else {
                        renderer.endLasso(false);
                    }
                    renderer.selectStroke(x, y, multiSelectMode);
                }

                selectPointerId.current = null;
                selectPointerStart.current = null;
                isSelectDragging.current = false;
                isRectSelecting.current = false;
                isResizeDragging.current = false;
                resizeHandleIndex.current = -1;
                notifySelectionChange();
                return;
            }

            // Draw mode
            if (activeDrawingPointer.current === e.pointerId) {
                activeDrawingPointer.current = null;
                rendererRef.current?.endStroke();
            }
        } else {
            activePointers.current.delete(e.pointerId);
            if (activePointers.current.size < 2) {
                prevDist.current = null;
                prevCenter.current = null;
            }
            if (activePointers.current.size === 0) {
                rendererRef.current?.setGesturing(false);
            }
        }
    };

    // Handle lost pointer capture (important for iPad)
    const handleLostPointerCapture = (e: React.PointerEvent) => {
        if (activeDrawingPointer.current === e.pointerId) {
            activeDrawingPointer.current = null;
            rendererRef.current?.endStroke();
        }
        // Also handle select mode lost capture
        if (selectPointerId.current === e.pointerId) {
            if (isResizeDragging.current) {
                rendererRef.current?.endResizeSelected();
            } else if (isSelectDragging.current) {
                if (isRectSelecting.current) {
                    if (selectionType === 'rect') {
                        rendererRef.current?.endSelectionRect(multiSelectMode);
                    } else {
                        rendererRef.current?.endLasso(multiSelectMode);
                    }
                } else {
                    rendererRef.current?.endMoveSelected();
                }
            }
            selectPointerId.current = null;
            selectPointerStart.current = null;
            isSelectDragging.current = false;
            isRectSelecting.current = false;
            isResizeDragging.current = false;
            resizeHandleIndex.current = -1;
            notifySelectionChange();
        }
        if (viewPanPointerId.current === e.pointerId) {
            viewPanPointerId.current = null;
            viewPanLast.current = null;
        }
    };

    const handleWheel = (e: React.WheelEvent) => {
        if (e.ctrlKey) {
            e.preventDefault();
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const scale = 1 - e.deltaY * 0.002;
            rendererRef.current?.zoom(scale, x, y);
        } else {
            rendererRef.current?.pan(-e.deltaX, -e.deltaY);
        }
    };

    return (
        <div ref={containerRef} style={{
            width: '100%', height: '100%',
            backgroundColor: '#f9f9f9',
            position: 'relative',
            touchAction: 'none'
        }}>
            {/* Paper Texture */}
            {/* Paper Texture Removed - Moved to Canvas for Sync */}

            {/* Error Overlay */}
            {errorMsg && (
                <div style={{
                    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                    background: 'rgba(255, 0, 0, 0.9)', color: 'white', padding: '20px', borderRadius: '12px',
                    zIndex: 9999, textAlign: 'center', pointerEvents: 'none'
                }}>
                    <h3>⚠️ Physics Engine Error</h3>
                    <p>{errorMsg}</p>
                </div>
            )}

            <canvas
                ref={canvasRef}
                style={{
                    position: 'absolute',
                    top: 0, left: 0,
                    width: '100%', height: '100%',
                    cursor: interactionMode === 'view'
                        ? 'grab'
                        : rendererRef.current?.getToolMode() === 'select'
                            ? 'pointer'
                            : (_penOnly ? 'none' : 'crosshair'),
                    touchAction: 'none', // Critical for Pointer Events
                    WebkitUserSelect: 'none', // iOS Text Selection
                    WebkitTouchCallout: 'none', // iOS Long Press
                    outline: 'none',
                    zIndex: 2
                }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onLostPointerCapture={handleLostPointerCapture}
                onContextMenu={(e) => e.preventDefault()}
                onWheel={handleWheel}
            />
        </div>
    );
});
