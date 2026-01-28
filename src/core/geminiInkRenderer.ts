import { SoundEngine } from './SoundEngine';
import { HapticEngine } from './HapticEngine';
import { FrictionEngine } from './FrictionEngine';

export interface Point {
    x: number;
    y: number;
    pressure: number;
    timestamp: number;
}

interface BezierSegment {
    p0: Point;
    p1: Point;
    p2: Point;
    p3: Point;
    width0: number;
    width1: number;
}

interface Stroke {
    points: Point[];
    config: RenderConfig;
}

export interface RenderConfig {
    baseStrokeWidth: number;
    minWidth: number;
    maxWidth: number;
    smoothness: number;
    velocityInfluence: number;
    pressureInfluence: number;
    color: string;
    opacity: number;
    streamline: number;
}

export const DEFAULT_CONFIG: RenderConfig = {
    baseStrokeWidth: 8,
    minWidth: 0.5,              // SHARP INK: Much finer minimum for crisp tips
    maxWidth: 16,
    smoothness: 0.65,
    velocityInfluence: 0.7,     // SHARP INK: More velocity sensitivity (fast = thin)
    pressureInfluence: 0.8,     // SHARP INK: More pressure dynamic range
    color: '#000000',
    opacity: 1.0,
    streamline: 0.35
};

export class GeminiInkRenderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private config: RenderConfig = DEFAULT_CONFIG;
    private soundEngine: SoundEngine;
    private hapticEngine: HapticEngine;
    private frictionEngine: FrictionEngine;

    private points: Point[] = [];
    private isDrawing: boolean = false;
    private strokes: Stroke[] = [];
    private redoStack: Stroke[] = []; // For undo/redo

    private camera = { x: 0, y: 0, zoom: 1 };
    private readonly dpr: number = window.devicePixelRatio || 1;

    // Block redraw during active stroke to prevent visual glitches
    private blockRedraw: boolean = false;

    // MOTION PREDICTION v1.7.5: Reduce perceived latency
    private velocityHistory: { vx: number; vy: number; timestamp: number }[] = [];
    private predictionEnabled: boolean = true;
    private predictionLookahead: number = 25; // ms to predict ahead

    // RAW MODE v1.7.6: Bypass ALL processing for latency testing
    // When enabled: No friction, no streamline, no prediction - pure 1:1 input
    private rawModeEnabled: boolean = false;

    constructor(canvas: HTMLCanvasElement, config: Partial<RenderConfig> = {}) {
        this.canvas = canvas;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.soundEngine = new SoundEngine();
        this.hapticEngine = new HapticEngine();
        this.frictionEngine = new FrictionEngine();

        const ctx = this.canvas.getContext('2d', {
            alpha: true,
            desynchronized: false
        });

        if (!ctx) throw new Error('Helpers failed');
        this.ctx = ctx;
        this.loadPaperTexture();
        this.resize();
    }

    public destroy() {
        // this.stopWetLoop(); // Wet ink disabled
        if (this.soundEngine && this.soundEngine.dispose) {
            this.soundEngine.dispose();
        }
    }

    public updateConfig(newConfig: Partial<RenderConfig>): void {
        this.config = { ...this.config, ...newConfig };
    }

    // Track pending resize to apply after stroke ends
    private pendingResize: boolean = false;

    public resize(): void {
        // If currently drawing, defer resize until stroke ends
        if (this.isDrawing) {
            console.log('[Renderer] Resize deferred - stroke in progress');
            this.pendingResize = true;
            return;
        }

        this.doResize();
    }

    private doResize(): void {
        const rect = this.canvas.parentElement?.getBoundingClientRect();
        if (!rect) return;

        this.canvas.width = rect.width * this.dpr;
        this.canvas.height = rect.height * this.dpr;
        this.canvas.style.width = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;

        this.ctx.scale(this.dpr, this.dpr);
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

        this.pendingResize = false;
        this.redrawAll();
    }

    public pan(dx: number, dy: number) {
        // Pan in World units (compensate for zoom)
        this.camera.x += dx / this.camera.zoom;
        this.camera.y += dy / this.camera.zoom;
        this.requestRedraw();
    }

    public zoom(scaleFactor: number, screenX: number, screenY: number) {
        // Model: Screen = (World + Pan) * Zoom
        // 1. World point under cursor BEFORE zoom
        const worldX = (screenX / this.camera.zoom) - this.camera.x;
        const worldY = (screenY / this.camera.zoom) - this.camera.y;

        // 2. Apply zoom
        let newZoom = this.camera.zoom * scaleFactor;
        newZoom = Math.max(0.2, Math.min(5.0, newZoom));
        this.camera.zoom = newZoom;

        // 3. Adjust pan so world point stays at same screen position
        // screenX = (worldX + panX) * zoom → panX = screenX/zoom - worldX
        this.camera.x = (screenX / newZoom) - worldX;
        this.camera.y = (screenY / newZoom) - worldY;

        this.requestRedraw();
    }

    // --- Sound Control ---
    private updateSpatialAudio(x: number) {
        // x is World coordinate, convert to Screen coordinate
        // Model: Screen = (World + Pan) * Zoom
        const screenX = (x + this.camera.x) * this.camera.zoom;
        const windowWidth = this.canvas.width / this.dpr;

        // Map screen X to stereo pan [-1, 1]
        let pan = (screenX / windowWidth) * 2 - 1; // 0 -> -1, Width -> 1
        pan = Math.max(-1, Math.min(1, pan)); // Clamp
        this.soundEngine.setPanning(pan);
    }
    public setSoundProfile(profile: any) {
        if (this.soundEngine && this.soundEngine.setProfile) {
            this.soundEngine.setProfile(profile);
        }
    }

    public setSoundVolume(volume: number) {
        if (this.soundEngine && this.soundEngine.setVolume) {
            this.soundEngine.setVolume(volume);
        }
    }

    public setHapticEnabled(enabled: boolean) {
        if (this.hapticEngine) {
            this.hapticEngine.setEnabled(enabled);
        }
    }

    public setFrictionEnabled(enabled: boolean) {
        if (this.frictionEngine) {
            this.frictionEngine.setEnabled(enabled);
        }
    }

    public setFrictionLevel(level: number) {
        // level: 0.0 (no friction) to 1.0 (max friction)
        // At 50% slider = 0.4 (noticeable), at 100% = 0.8 (very strong lag)
        if (this.frictionEngine) {
            this.frictionEngine.setConfig({
                baseResistance: level * 0.8
            });
        }
    }

    // MOTION PREDICTION v1.7.5: Configure prediction
    public setPredictionEnabled(enabled: boolean) {
        this.predictionEnabled = enabled;
    }

    public setPredictionLookahead(ms: number) {
        this.predictionLookahead = Math.max(0, Math.min(50, ms)); // Clamp 0-50ms
    }

    // RAW MODE v1.7.6: Toggle raw input mode
    // When ON: Bypass friction, streamline, prediction - pure 1:1 input for minimum latency
    public setRawMode(enabled: boolean) {
        this.rawModeEnabled = enabled;
        console.log(`[Renderer] RAW MODE: ${enabled ? 'ON - Pure input, no processing' : 'OFF - Full processing'}`);
    }

    public isRawMode(): boolean {
        return this.rawModeEnabled;
    }

    // --- UNDO / REDO ---
    public undo(): boolean {
        if (this.strokes.length === 0) return false;
        const stroke = this.strokes.pop();
        if (stroke) {
            this.redoStack.push(stroke);
            this.requestRedraw();
            return true;
        }
        return false;
    }

    public redo(): boolean {
        if (this.redoStack.length === 0) return false;
        const stroke = this.redoStack.pop();
        if (stroke) {
            this.strokes.push(stroke);
            this.requestRedraw();
            return true;
        }
        return false;
    }

    public canUndo(): boolean {
        return this.strokes.length > 0;
    }

    public canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    public clearAll(): void {
        this.strokes = [];
        this.redoStack = [];
        this.requestRedraw();
    }

    private requestRedraw() {
        // Block redraw during active stroke to prevent visual glitches
        if (this.blockRedraw) {
            console.log('[Renderer] Redraw blocked - stroke in progress');
            return;
        }
        requestAnimationFrame(() => this.redrawAll());
    }

    private redrawAll() {
        this.ctx.clearRect(0, 0, this.canvas.width / this.dpr, this.canvas.height / this.dpr);
        this.drawPaperBackground();
        this.drawGrid();
        this.ctx.save();

        // Camera Transform: Screen = (World + Pan) * Zoom
        // CORRECT Order: Scale THEN Translate (translate gets scaled!)
        this.ctx.scale(this.camera.zoom, this.camera.zoom);
        this.ctx.translate(this.camera.x, this.camera.y);

        // Draw Strokes
        this.strokes.forEach(stroke => {
            this.renderStroke(stroke.points, stroke.config);
        });

        if (this.points.length > 0) {
            this.renderStroke(this.points, this.config);
        }

        this.ctx.restore();
    }

    private drawGrid() {
        // Model: Screen = (World + Pan) * Zoom → World = Screen/Zoom - Pan
        const zoom = this.camera.zoom;
        const panX = this.camera.x;
        const panY = this.camera.y;

        // Calculate Visible World Bounds
        const worldLeft = -panX;
        const worldTop = -panY;
        const worldRight = (this.canvas.width / this.dpr / zoom) - panX;
        const worldBottom = (this.canvas.height / this.dpr / zoom) - panY;

        const gridSize = 40;

        this.ctx.save();
        // CORRECT Order: Scale THEN Translate
        this.ctx.scale(zoom, zoom);
        this.ctx.translate(panX, panY);

        this.ctx.strokeStyle = '#e1e1e1';
        this.ctx.lineWidth = 1 / zoom; // Keep hairline width regardless of zoom

        this.ctx.beginPath();

        // Vertical Lines
        const startX = Math.floor(worldLeft / gridSize) * gridSize;
        const endX = Math.ceil(worldRight / gridSize) * gridSize;
        for (let x = startX; x <= endX; x += gridSize) {
            this.ctx.moveTo(x, worldTop);
            this.ctx.lineTo(x, worldBottom);
        }

        // Horizontal Lines
        const startY = Math.floor(worldTop / gridSize) * gridSize;
        const endY = Math.ceil(worldBottom / gridSize) * gridSize;
        for (let y = startY; y <= endY; y += gridSize) {
            this.ctx.moveTo(worldLeft, y);
            this.ctx.lineTo(worldRight, y);
        }

        this.ctx.stroke();
        this.ctx.restore();
    }

    private paperPattern: CanvasPattern | null = null;

    private loadPaperTexture() {
        const img = new Image();
        img.src = `data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.08'/%3E%3C/svg%3E`;
        img.onload = () => {
            this.paperPattern = this.ctx.createPattern(img, 'repeat');
            // Only redraw if NOT currently drawing (blockRedraw handles this too, but explicit is better)
            if (!this.isDrawing) {
                this.requestRedraw();
            }
        };
    }

    private drawPaperBackground() {
        if (!this.paperPattern) return;

        const zoom = this.camera.zoom;
        const panX = this.camera.x;
        const panY = this.camera.y;

        this.ctx.save();
        // CORRECT Order: Scale THEN Translate
        this.ctx.scale(zoom, zoom);
        this.ctx.translate(panX, panY);

        // Calculate Visible World Bounds: World = Screen/Zoom - Pan
        const worldLeft = -panX;
        const worldTop = -panY;
        const worldRight = (this.canvas.width / this.dpr / zoom) - panX;
        const worldBottom = (this.canvas.height / this.dpr / zoom) - panY;

        this.ctx.fillStyle = this.paperPattern;
        // FILL ONLY VISIBLE AREA
        this.ctx.fillRect(worldLeft, worldTop, worldRight - worldLeft, worldBottom - worldTop);

        this.ctx.restore();
    }

    startStroke(x: number, y: number, pressure: number): void {
        console.log('[Renderer] startStroke at', x, y, 'pressure:', pressure);
        this.isDrawing = true;
        this.blockRedraw = true; // Block any redraw during stroke

        // Reset friction engine for new stroke
        this.frictionEngine.reset();

        // MOTION PREDICTION v1.7.5: Reset velocity history for new stroke
        this.velocityHistory = [];

        // Pre-init audio (resume AudioContext on user gesture)
        this.soundEngine.preInit().then(() => {
            this.soundEngine.startStroke();
        });

        // Trigger immediate haptic on first touch
        this.hapticEngine.triggerImmediate();

        const worldPoint = this.screenToWorld(x, y);
        this.points = [{ x: worldPoint.x, y: worldPoint.y, pressure, timestamp: performance.now() }];

        // Draw initial point immediately
        this.renderInitialPoint(worldPoint.x, worldPoint.y, pressure);
    }

    // Draw the first point of stroke immediately for responsiveness
    private renderInitialPoint(worldX: number, worldY: number, pressure: number): void {
        const width = this.config.baseStrokeWidth * (pressure * this.config.pressureInfluence + (1 - this.config.pressureInfluence) * 0.5);

        this.ctx.save();
        this.ctx.scale(this.camera.zoom, this.camera.zoom);
        this.ctx.translate(this.camera.x, this.camera.y);

        this.ctx.fillStyle = this.config.color;
        this.ctx.globalAlpha = this.config.opacity;
        this.ctx.beginPath();
        this.ctx.arc(worldX, worldY, width / 2, 0, Math.PI * 2);
        this.ctx.fill();

        this.ctx.restore();
    }

    // --- Wet Ink Simulation (Bleed) - DISABLED FOR NOW ---
    // Kept for future implementation
    // private wetLoopId: number | null = null;
    // private startWetLoop() { ... }
    // private stopWetLoop() { ... }

    addPoint(x: number, y: number, pressure: number): void {
        if (!this.isDrawing) {
            console.log('[Renderer] addPoint ignored - not drawing');
            return;
        }

        const worldPoint = this.screenToWorld(x, y);
        const now = performance.now();

        const lastPoint = this.points[this.points.length - 1];
        if (!lastPoint) {
            console.log('[Renderer] addPoint - no last point, starting fresh');
            this.points.push({ x: worldPoint.x, y: worldPoint.y, pressure, timestamp: now });
            this.velocityHistory = []; // Reset velocity history
            return;
        }

        // Calculate basic metrics (needed for sound/haptic even in RAW MODE)
        const dx = worldPoint.x - lastPoint.x;
        const dy = worldPoint.y - lastPoint.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const dt = Math.max(1, now - lastPoint.timestamp);
        const velocity = dist / dt * 10; // Scale for reasonable range

        // ═══════════════════════════════════════════════════════════════════
        // RAW MODE v1.7.6: BYPASS ALL PROCESSING - Pure 1:1 input
        // ═══════════════════════════════════════════════════════════════════
        if (this.rawModeEnabled) {
            // Direct push - no friction, no streamline, no prediction
            const rawPoint: Point = {
                x: worldPoint.x,
                y: worldPoint.y,
                pressure: pressure,
                timestamp: now
            };
            this.points.push(rawPoint);

            // Still do sound/haptic feedback (doesn't affect latency)
            this.soundEngine.updateStroke(dist, pressure);
            if (dist > 2 && now - this.lastHapticTime > 30) {
                this.hapticEngine.triggerGrain();
                this.lastHapticTime = now;
            }
            this.updateSpatialAudio(rawPoint.x);

            // Direct render - no RAF delay
            this.renderIncrementalStroke();
            return;
        }

        // ═══════════════════════════════════════════════════════════════════
        // PROCESSED MODE: Full processing pipeline
        // ═══════════════════════════════════════════════════════════════════
        const vx = dx / dt * 1000; // pixels per second
        const vy = dy / dt * 1000;
        const direction = Math.atan2(dy, dx);

        // MOTION PREDICTION v1.7.5: Track velocity history
        this.velocityHistory.push({ vx, vy, timestamp: now });
        // Keep only last 5 samples for smoothing
        if (this.velocityHistory.length > 5) {
            this.velocityHistory.shift();
        }

        // Calculate predicted position
        let predictedX = worldPoint.x;
        let predictedY = worldPoint.y;

        if (this.predictionEnabled && this.velocityHistory.length >= 2) {
            // Average velocity from recent history
            const avgVx = this.velocityHistory.reduce((s, v) => s + v.vx, 0) / this.velocityHistory.length;
            const avgVy = this.velocityHistory.reduce((s, v) => s + v.vy, 0) / this.velocityHistory.length;

            // Predict ahead by lookahead time
            const lookaheadSec = this.predictionLookahead / 1000;
            predictedX = worldPoint.x + avgVx * lookaheadSec;
            predictedY = worldPoint.y + avgVy * lookaheadSec;

            // Blend between predicted and actual based on velocity consistency
            // High variance = less confidence in prediction
            const speed = Math.sqrt(avgVx * avgVx + avgVy * avgVy);
            const confidence = Math.min(1, speed / 500); // Full confidence at 500px/s
            predictedX = worldPoint.x + (predictedX - worldPoint.x) * confidence;
            predictedY = worldPoint.y + (predictedY - worldPoint.y) * confidence;
        }

        // Apply friction simulation (use predicted position for smoother feel)
        const frictionResult = this.frictionEngine.processPoint({
            x: predictedX,
            y: predictedY,
            pressure,
            velocity,
            direction
        });

        // Apply streamline smoothing on top of friction (REDUCED for less lag)
        const k = 1 - (this.config.streamline * 0.5); // Halve streamline effect for responsiveness
        const smoothedPoint: Point = {
            x: lastPoint.x + (frictionResult.adjustedX - lastPoint.x) * k,
            y: lastPoint.y + (frictionResult.adjustedY - lastPoint.y) * k,
            pressure: pressure,
            timestamp: now
        };

        this.points.push(smoothedPoint);

        // Sound feedback based on movement
        this.soundEngine.updateStroke(dist, pressure);

        // Haptic feedback - intensity based on friction
        if (dist > 2) {
            // Get dynamic haptic interval based on velocity
            const hapticInterval = this.frictionEngine.getHapticInterval(velocity);
            if (now - this.lastHapticTime > hapticInterval) {
                this.hapticEngine.triggerGrain();
                this.lastHapticTime = now;
            }
        }

        this.updateSpatialAudio(smoothedPoint.x);

        // Direct incremental rendering - no RAF delay for responsiveness
        this.renderIncrementalStroke();
    }

    private lastHapticTime: number = 0;

    // Optimized incremental rendering - draws only the newest segment
    private renderIncrementalStroke() {
        const len = this.points.length;
        if (len < 2) return;

        this.ctx.save();
        // Apply camera transform
        this.ctx.scale(this.camera.zoom, this.camera.zoom);
        this.ctx.translate(this.camera.x, this.camera.y);

        this.ctx.strokeStyle = this.config.color;
        this.ctx.globalAlpha = this.config.opacity;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

        // Draw simple line segment for immediate feedback
        const p1 = this.points[len - 2];
        const p2 = this.points[len - 1];
        const width = this.calculateStrokeWidth(p2, p1);

        this.ctx.beginPath();
        this.ctx.lineWidth = width;
        this.ctx.moveTo(p1.x, p1.y);
        this.ctx.lineTo(p2.x, p2.y);
        this.ctx.stroke();

        this.ctx.restore();
    }

    endStroke(): void {
        if (!this.isDrawing) return;
        this.isDrawing = false;
        this.blockRedraw = false; // Allow redraw again
        // this.stopWetLoop(); // Wet ink disabled
        this.soundEngine.endStroke();
        this.strokes.push({ points: [...this.points], config: { ...this.config } });
        this.redoStack = []; // Clear redo stack when new stroke is added
        this.points = [];

        // Apply pending resize if there was one during stroke
        if (this.pendingResize) {
            console.log('[Renderer] Applying deferred resize');
            this.doResize();
        } else {
            // Full redraw to finalize stroke with proper bezier curves
            this.requestRedraw();
        }
    }

    // --- Incremental Tip Rendering - DISABLED FOR NOW ---
    // Kept for future optimization
    // private renderIncrementalTip() { ... }

    // --- Helper Math ---

    private screenToWorld(sx: number, sy: number) {
        // Model: Screen = (World + Pan) * Zoom
        // World = Screen/Zoom - Pan
        return {
            x: (sx / this.camera.zoom) - this.camera.x,
            y: (sy / this.camera.zoom) - this.camera.y
        };
    }

    // --- EXPORT FUNCTIONALITY ---
    public async exportImage(): Promise<string> {
        return new Promise((resolve) => {
            const exportCanvas = document.createElement('canvas');
            // Export at 2x resolution
            const scale = 2;
            exportCanvas.width = this.canvas.width * scale;
            exportCanvas.height = this.canvas.height * scale;
            const ctx = exportCanvas.getContext('2d');

            if (!ctx) {
                resolve('');
                return;
            }

            // 1. Draw Paper Background
            ctx.fillStyle = '#f9f9f9';
            ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

            // Draw Grid (Replicating logic for Export Context)
            // const gridSize = 40 * scale; // Scale grid
            // const zoom = this.camera.zoom;
            // Since we export "What we see", we respect camera pan/zoom?
            // Actually usually people want to export the WHOLE drawing or the CURRENT VIEW.
            // Let's do CURRENT VIEW high-res for "Viral Share" ( Screenshot behavior).

            // Setup Transform: High-res scale + Camera transform
            // 1. Scale for high-res export
            ctx.scale(scale * this.dpr, scale * this.dpr);
            // 2. Camera transform: CORRECT Order - Scale THEN Translate
            ctx.scale(this.camera.zoom, this.camera.zoom);
            ctx.translate(this.camera.x, this.camera.y);

            // 2. Draw Strokes
            this.strokes.forEach(stroke => {
                this.renderStroke(stroke.points, stroke.config, ctx);
            });

            if (this.points.length > 0) {
                this.renderStroke(this.points, this.config, ctx);
            }

            resolve(exportCanvas.toDataURL('image/png'));
        });
    }

    private renderStroke(strokePoints: Point[], config: RenderConfig, targetCtx?: CanvasRenderingContext2D) {
        // Use targetCtx if provided, otherwise use this.ctx
        const ctx = targetCtx || this.ctx;

        if (strokePoints.length < 2) return;

        ctx.strokeStyle = config.color;
        ctx.globalAlpha = config.opacity;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();

        if (strokePoints.length < 4) {
            ctx.moveTo(strokePoints[0].x, strokePoints[0].y);
            strokePoints.forEach(p => ctx.lineTo(p.x, p.y));
            ctx.lineWidth = config.baseStrokeWidth;
            ctx.stroke();
            return;
        }

        const totalPoints = strokePoints.length;
        const taperLength = Math.min(8, Math.floor(totalPoints * 0.15)); // Taper first/last 15% or 8 points

        for (let i = 0; i < strokePoints.length - 3; i++) {
            const p0 = strokePoints[i];
            const p1 = strokePoints[i + 1];
            const p2 = strokePoints[i + 2];
            const p3 = strokePoints[i + 3];
            const bezier = this.catmullRomToBezier(p0, p1, p2, p3);

            // Calculate base widths
            let w1 = this.calculateStrokeWidth(p1, p0, config);
            let w2 = this.calculateStrokeWidth(p2, p1, config);

            // SHARP INK: Apply taper at stroke start
            if (i < taperLength) {
                const taperFactor = (i + 1) / (taperLength + 1); // 0.1 to ~1.0
                const taperCurve = taperFactor * taperFactor; // Quadratic ease-in for sharp entry
                w1 *= taperCurve;
                w2 *= Math.min(1, (i + 2) / (taperLength + 1)) ** 2;
            }

            // SHARP INK: Apply taper at stroke end
            const distFromEnd = totalPoints - 3 - i;
            if (distFromEnd < taperLength) {
                const taperFactor = (distFromEnd + 1) / (taperLength + 1);
                const taperCurve = taperFactor * taperFactor; // Quadratic ease-out for sharp exit
                w1 *= Math.min(1, (distFromEnd + 2) / (taperLength + 1)) ** 2;
                w2 *= taperCurve;
            }

            // Ensure minimum width for visibility
            w1 = Math.max(config.minWidth, w1);
            w2 = Math.max(config.minWidth, w2);

            this.renderBezierSegment(bezier, w1, w2, ctx);
        }
    }

    private catmullRomToBezier(p0: Point, p1: Point, p2: Point, p3: Point): BezierSegment {
        const tension = 1 - this.config.smoothness;
        const cp1 = { ...p1, x: p1.x + (p2.x - p0.x) / (6 * tension), y: p1.y + (p2.y - p0.y) / (6 * tension) };
        const cp2 = { ...p2, x: p2.x - (p3.x - p1.x) / (6 * tension), y: p2.y - (p3.y - p1.y) / (6 * tension) };
        return { p0: p1, p1: cp1, p2: cp2, p3: p2, width0: 0, width1: 0 };
    }

    private calculateStrokeWidth(current: Point, previous: Point, config: RenderConfig = this.config): number {
        const pFactor = config.pressureInfluence * current.pressure + (1 - config.pressureInfluence) * 0.5;
        const dx = current.x - previous.x;
        const dy = current.y - previous.y;
        const dt = Math.max(1, current.timestamp - previous.timestamp);
        const velocity = Math.sqrt(dx * dx + dy * dy) / dt;
        const vFactor = 1 - Math.min(1, velocity / 2.5) * config.velocityInfluence;

        let width = config.baseStrokeWidth * pFactor * vFactor;
        return Math.max(config.minWidth, Math.min(config.maxWidth, width));
    }

    private renderBezierSegment(segment: BezierSegment, wStart: number, wEnd: number, targetCtx?: CanvasRenderingContext2D): void {
        const ctx = targetCtx || this.ctx;
        const { p0, p1, p2, p3 } = segment;

        // Optimize: Calculate approximate length to determine steps
        const dist = Math.abs(p0.x - p3.x) + Math.abs(p0.y - p3.y);
        // Reduce steps: 1 step per 5px (was 2px), min 2, max 8.
        const steps = Math.max(2, Math.min(8, Math.ceil(dist / 5)));

        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const x = this.cubicBezier(p0.x, p1.x, p2.x, p3.x, t);
            const y = this.cubicBezier(p0.y, p1.y, p2.y, p3.y, t);
            const w = wStart + (wEnd - wStart) * t;

            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);

            // Optimization: Only stroke if width changes significantly or at end of sub-segment
            // For now, keep it simple but with fewer steps
            ctx.lineWidth = w;
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x, y);
        }
    }

    private cubicBezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
        const t2 = t * t, t3 = t2 * t;
        const mt = 1 - t, mt2 = mt * mt, mt3 = mt2 * mt;
        return mt3 * p0 + 3 * mt2 * t * p1 + 3 * mt * t2 * p2 + t3 * p3;
    }
}
