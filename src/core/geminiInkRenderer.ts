import { SoundEngine } from './SoundEngine';
import { HapticEngine } from './HapticEngine';

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
    minWidth: 3,
    maxWidth: 16,
    smoothness: 0.65,
    velocityInfluence: 0.5,
    pressureInfluence: 0.7,
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

    private points: Point[] = [];
    private isDrawing: boolean = false;
    private strokes: Stroke[] = [];

    private camera = { x: 0, y: 0, zoom: 1 };
    private readonly dpr: number = window.devicePixelRatio || 1;

    constructor(canvas: HTMLCanvasElement, config: Partial<RenderConfig> = {}) {
        this.canvas = canvas;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.soundEngine = new SoundEngine();
        this.hapticEngine = new HapticEngine();

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
        this.stopWetLoop();
        if (this.soundEngine && this.soundEngine.dispose) {
            this.soundEngine.dispose();
        }
    }

    public updateConfig(newConfig: Partial<RenderConfig>): void {
        this.config = { ...this.config, ...newConfig };
    }

    public resize(): void {
        const rect = this.canvas.parentElement?.getBoundingClientRect();
        if (!rect) return;

        this.canvas.width = rect.width * this.dpr;
        this.canvas.height = rect.height * this.dpr;
        this.canvas.style.width = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;

        this.ctx.scale(this.dpr, this.dpr);
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

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

    private requestRedraw() {
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
            this.requestRedraw();
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
        this.isDrawing = true;
        this.soundEngine.startStroke();
        const worldPoint = this.screenToWorld(x, y);
        this.points = [{ x: worldPoint.x, y: worldPoint.y, pressure, timestamp: performance.now() }];
        // this.startWetLoop(); // Disabled for performance/stability check
    }

    // --- Wet Ink Simulation (Bleed) ---
    private wetLoopId: number | null = null;

    private startWetLoop() {
        if (this.wetLoopId) cancelAnimationFrame(this.wetLoopId);

        const loop = () => {
            if (!this.isDrawing) return;

            // Check if stationary
            if (this.points.length > 0) {
                const now = performance.now();
                const lastPoint = this.points[this.points.length - 1];
                const timeSinceLast = now - lastPoint.timestamp;

                // If stationary for > 50ms, start bleeding (increasing pressure)
                if (timeSinceLast > 50) {
                    // Bleed heavily for Fountain, slightly for Marker, none for Pencil
                    // We can reuse current config or check sound profile? 
                    // Let's use config.pressureInfluence as a proxy or just simulate generic bleed

                    // Artificial pressure growth
                    // Cap at some max to prevent explosion
                    if (lastPoint.pressure < 2.0) {
                        lastPoint.pressure += 0.01; // Slow growth
                        this.requestRedraw();
                    }
                }
            }
            this.wetLoopId = requestAnimationFrame(loop);
        };
        this.wetLoopId = requestAnimationFrame(loop);
    }

    private stopWetLoop() {
        if (this.wetLoopId) {
            cancelAnimationFrame(this.wetLoopId);
            this.wetLoopId = null;
        }
    }

    addPoint(x: number, y: number, pressure: number): void {
        if (!this.isDrawing) return;
        const worldPoint = this.screenToWorld(x, y);
        const rawPoint = { x: worldPoint.x, y: worldPoint.y, pressure, timestamp: performance.now() };

        const lastPoint = this.points[this.points.length - 1];
        const k = 1 - this.config.streamline;
        const smoothedPoint: Point = {
            x: lastPoint.x + (rawPoint.x - lastPoint.x) * k,
            y: lastPoint.y + (rawPoint.y - lastPoint.y) * k,
            pressure: rawPoint.pressure,
            timestamp: rawPoint.timestamp
        };

        this.points.push(smoothedPoint);

        const dx = smoothedPoint.x - lastPoint.x;
        const dy = smoothedPoint.y - lastPoint.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        this.soundEngine.updateStroke(dist, pressure);
        this.hapticEngine.triggerGrain(); // Trigger vibration
        this.updateSpatialAudio(smoothedPoint.x);

        // FIX: Use full redraw instead of incremental to avoid coordinate issues
        this.requestRedraw();
    }

    endStroke(): void {
        if (!this.isDrawing) return;
        this.isDrawing = false;
        this.stopWetLoop();
        this.soundEngine.endStroke();
        this.strokes.push({ points: [...this.points], config: { ...this.config } });
        this.points = [];
    }

    private renderIncrementalTip() {
        if (this.points.length < 4) return;
        this.ctx.save();
        // CORRECT Order: Scale THEN Translate
        this.ctx.scale(this.camera.zoom, this.camera.zoom);
        this.ctx.translate(this.camera.x, this.camera.y);

        const len = this.points.length;
        const p0 = this.points[len - 4];
        const p1 = this.points[len - 3];
        const p2 = this.points[len - 2];
        const p3 = this.points[len - 1];

        const bezier = this.catmullRomToBezier(p0, p1, p2, p3);
        const w1 = this.calculateStrokeWidth(p1, p0);
        const w2 = this.calculateStrokeWidth(p2, p1);

        this.ctx.strokeStyle = this.config.color;
        this.ctx.globalAlpha = this.config.opacity;
        this.renderBezierSegment(bezier, w1, w2);
        this.ctx.restore();
    }

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

        for (let i = 0; i < strokePoints.length - 3; i++) {
            const p0 = strokePoints[i];
            const p1 = strokePoints[i + 1];
            const p2 = strokePoints[i + 2];
            const p3 = strokePoints[i + 3];
            const bezier = this.catmullRomToBezier(p0, p1, p2, p3);
            const w1 = this.calculateStrokeWidth(p1, p0, config);
            const w2 = this.calculateStrokeWidth(p2, p1, config);
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
