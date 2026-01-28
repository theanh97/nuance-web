import { useRef, forwardRef, useImperativeHandle, useEffect, useState } from 'react';
import { GeminiInkRenderer } from '../core/geminiInkRenderer';
import { type SoundProfile } from '../core/SoundEngine';

export interface NuanceCanvasHandle {
    exportImage: () => Promise<string>;
}

interface NuanceCanvasProps {
    brushSize: number;
    penOnly: boolean;
    soundProfile: SoundProfile;
    soundVolume: number;
    strokeColor: string;
    smoothing?: number; // 0.0 to 1.0
    hapticEnabled?: boolean;
}

export const NuanceCanvas = forwardRef<NuanceCanvasHandle, NuanceCanvasProps>(({ brushSize, penOnly: _penOnly, soundProfile, soundVolume, strokeColor, smoothing, hapticEnabled = true }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rendererRef = useRef<GeminiInkRenderer | null>(null);

    useImperativeHandle(ref, () => ({
        exportImage: async () => {
            if (rendererRef.current) {
                return await rendererRef.current.exportImage();
            }
            return '';
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
            // Physics Profiles
            const physics: Record<SoundProfile, any> = {
                pencil: { minWidth: 2, maxWidth: 6, opacity: 0.8 },
                charcoal: { minWidth: 5, maxWidth: 14, opacity: 0.7 },
                ballpoint: { minWidth: 3, maxWidth: 6, opacity: 1.0 },
                fountain: { minWidth: 2, maxWidth: 10, opacity: 1.0, streamline: 0.6 },
                marker: { minWidth: 10, maxWidth: 20, opacity: 0.5 },
                highlighter: { minWidth: 20, maxWidth: 20, opacity: 0.3, streamline: 0.2 }, // Fixed width, transparent
                monoline: { minWidth: 6, maxWidth: 6, opacity: 1.0, streamline: 0.8, pressureInfluence: 0 }, // No pressure, smooth
                calligraphy: { minWidth: 2, maxWidth: 18, opacity: 1.0, streamline: 0.7, pressureInfluence: 1.5 } // High contrast
            };

            const p = physics[soundProfile] || {};
            // Scale width by brushSize prop
            const scale = brushSize / 8;

            rendererRef.current.updateConfig({
                color: strokeColor, // User selected color
                opacity: p.opacity || 1.0,
                baseStrokeWidth: brushSize,
                minWidth: (p.minWidth || 2) * scale,
                maxWidth: (p.maxWidth || 12) * scale,
                streamline: smoothing ?? (p.streamline || 0.35), // Use prop or default
                pressureInfluence: p.pressureInfluence ?? 0.7
            });

            if (rendererRef.current.setSoundProfile) rendererRef.current.setSoundProfile(soundProfile);
            if (rendererRef.current.setSoundVolume) rendererRef.current.setSoundVolume(soundVolume);
            if (rendererRef.current.setHapticEnabled) rendererRef.current.setHapticEnabled(hapticEnabled);
        }
    }, [brushSize, soundProfile, soundVolume, strokeColor, hapticEnabled]);

    // --- GESTURE & INPUT HANDLING ---
    const activePointers = useRef<Map<number, { x: number, y: number }>>(new Map());
    const prevDist = useRef<number | null>(null);
    const activeDrawingPointer = useRef<number | null>(null);

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

        // 1. PEN/MOUSE: Always Draw
        if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
            // Capture this pointer for reliable tracking
            e.currentTarget.setPointerCapture(e.pointerId);
            activeDrawingPointer.current = e.pointerId;

            const { x, y } = getCanvasCoords(e);
            rendererRef.current?.startStroke(x, y, e.pressure || 0.5);
            return;
        }

        // 2. TOUCH: Always Gesture (Never Draw)
        if (e.pointerType === 'touch') {
            activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

            // Pinch Init
            if (activePointers.current.size === 2) {
                const points = Array.from(activePointers.current.values());
                prevDist.current = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
            }
        }
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        // PEN/MOUSE: Draw - must match the active drawing pointer
        if ((e.pointerType === 'pen' || e.pointerType === 'mouse') &&
            activeDrawingPointer.current === e.pointerId) {
            e.preventDefault();

            // Use coalesced events for smoother iPad/pen input
            const nativeEvent = e.nativeEvent as PointerEvent;
            const coalescedEvents = nativeEvent.getCoalescedEvents?.() || [nativeEvent];

            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();

            // Process all coalesced events for smoother strokes
            for (const pe of coalescedEvents) {
                const x = pe.clientX - rect.left;
                const y = pe.clientY - rect.top;
                rendererRef.current?.addPoint(x, y, pe.pressure || 0.5);
            }
            return;
        }

        // TOUCH: Gesture
        if (e.pointerType === 'touch') {
            const p = activePointers.current.get(e.pointerId);
            if (!p) return;

            // Calculate delta
            const dx = e.clientX - p.x;
            const dy = e.clientY - p.y;

            activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

            if (activePointers.current.size === 1) {
                // 1 Finger Pan
                rendererRef.current?.pan(dx, dy);
            }
            else if (activePointers.current.size === 2) {
                // 2 Finger Zoom + Pan (Pivot)
                const points = Array.from(activePointers.current.values());
                const curDist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);

                // Convert Client coordinates to Canvas-relative coordinates
                const rect = e.currentTarget.getBoundingClientRect();
                const cx = ((points[0].x + points[1].x) / 2) - rect.left;
                const cy = ((points[0].y + points[1].y) / 2) - rect.top;

                if (prevDist.current) {
                    const scale = curDist / prevDist.current;
                    const safeScale = 1 + (scale - 1) * 0.8;
                    rendererRef.current?.zoom(safeScale, cx, cy);
                }
                prevDist.current = curDist;
            }
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
            if (activeDrawingPointer.current === e.pointerId) {
                console.log('[Canvas] Pen up:', e.pointerId);
                activeDrawingPointer.current = null;
                rendererRef.current?.endStroke();
            }
        } else {
            activePointers.current.delete(e.pointerId);
            if (activePointers.current.size < 2) prevDist.current = null;
        }
    };

    // Handle lost pointer capture (important for iPad)
    const handleLostPointerCapture = (e: React.PointerEvent) => {
        if (activeDrawingPointer.current === e.pointerId) {
            console.log('[Canvas] Lost pointer capture:', e.pointerId);
            activeDrawingPointer.current = null;
            rendererRef.current?.endStroke();
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
                    cursor: _penOnly ? 'none' : 'crosshair',
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
