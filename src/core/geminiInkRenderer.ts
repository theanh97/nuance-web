import { SoundEngine } from './SoundEngine';
import { HapticEngine } from './HapticEngine';
import { FrictionEngine } from './FrictionEngine';

export interface Point {
    x: number;
    y: number;
    pressure: number;
    timestamp: number;
    tiltX: number;  // v1.9.0: Pen tilt in degrees (-90 to 90)
    tiltY: number;
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

export type ToolMode = 'draw' | 'select';
export type GridType = 'none' | 'square' | 'dot' | 'ruled' | 'isometric' | 'graph' | 'hex';

export interface SerializedDrawing {
    version: 1;
    gridType: GridType;
    strokes: Stroke[];
}

type UndoAction =
    | { type: 'addStroke'; stroke: Stroke }
    | { type: 'delete'; deletedStrokes: { index: number; stroke: Stroke }[] }
    | { type: 'recolor'; oldConfigs: { index: number; oldColor: string }[]; newColor: string }
    | { type: 'move'; indices: number[]; dx: number; dy: number };

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
    // redoStack removed - replaced by undoStack/redoActionStack in v2.0

    private camera = { x: 0, y: 0, zoom: 1 };
    private readonly dpr: number = window.devicePixelRatio || 1;

    // Block redraw during active stroke to prevent visual glitches
    private blockRedraw: boolean = false;

    // MOTION PREDICTION v1.7.5: Reduce perceived latency
    private velocityHistory: { vx: number; vy: number; timestamp: number }[] = [];
    private predictionEnabled: boolean = false; // DISABLED: caused stray strokes
    private predictionLookahead: number = 25; // ms to predict ahead

    // RAW MODE v1.7.6: Bypass ALL processing for latency testing
    private rawModeEnabled: boolean = false;

    // v2.0: Selection tool
    private toolMode: ToolMode = 'draw';
    private gridType: GridType = 'square';
    private selectedIndices: Set<number> = new Set();
    private isDragging: boolean = false;
    private dragStartWorld: { x: number; y: number } | null = null;
    private dragCurrentWorld: { x: number; y: number } | null = null;
    private undoStack: UndoAction[] = [];
    private redoActionStack: UndoAction[] = [];

    // v2.2: Rectangle selection
    private selectionRect: { sx1: number; sy1: number; sx2: number; sy2: number } | null = null;

    // v2.4: Shape snap - hold still to snap stroke to perfect shape
    private lastMoveTimestamp: number = 0;
    private shapeSnapThreshold: number = 250; // ms of holding still to trigger snap

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

    public exportStrokes(): SerializedDrawing {
        return {
            version: 1,
            gridType: this.gridType,
            strokes: this.strokes.map(stroke => ({
                config: { ...stroke.config },
                points: stroke.points.map(point => ({ ...point }))
            }))
        };
    }

    public loadStrokes(data: SerializedDrawing): void {
        if (!data || !Array.isArray(data.strokes)) return;
        this.strokes = data.strokes.map(stroke => ({
            config: { ...stroke.config },
            points: stroke.points.map(point => ({ ...point }))
        }));
        this.points = [];
        this.redoActionStack = [];
        this.undoStack = [];
        this.clearSelection();
        if (data.gridType) {
            this.gridType = data.gridType;
        }
        this.requestRedraw();
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

    public updatePalm(velocity: number) {
        if (this.soundEngine && this.soundEngine.updatePalm) {
            this.soundEngine.updatePalm(velocity);
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



    /**
     * v1.8.0: Unified Surface Texture control
     * 0 = Glass (smooth, silent, no friction)
     * 1 = Stone (rough, scratchy sound, high friction)
     *
     * This single slider controls BOTH:
     * - Physical feel (friction/resistance)
     * - Sound character (smooth vs scratchy)
     */
    public setSurfaceTexture(texture: number) {
        const t = Math.max(0, Math.min(1, texture));

        // 1. Update friction (texture = friction feeling)
        if (this.frictionEngine) {
            this.frictionEngine.setConfig({
                baseResistance: t * 0.7,      // 0-0.7 range (not too laggy)
                grainStrength: t * 0.4        // Higher texture = more grain feel
            });
        }

        // 2. Update sound character
        if (this.soundEngine && this.soundEngine.setTexture) {
            this.soundEngine.setTexture(t);
        }

        console.log(`[Renderer] Surface Texture: ${Math.round(t * 100)}% (${t < 0.3 ? '🧊 Glass' : t > 0.7 ? '🪨 Stone' : '📝 Paper'})`);
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

    // --- TOOL MODE ---
    public setToolMode(mode: ToolMode): void {
        this.toolMode = mode;
        if (mode === 'draw') {
            this.clearSelection();
        }
    }

    public getToolMode(): ToolMode {
        return this.toolMode;
    }

    // --- GRID TYPE ---
    public setGridType(type: GridType): void {
        this.gridType = type;
        this.requestRedraw();
    }

    public getGridType(): GridType {
        return this.gridType;
    }

    // --- SELECTION ---
    public clearSelection(): void {
        this.selectedIndices.clear();
        this.isDragging = false;
        this.dragStartWorld = null;
        this.dragCurrentWorld = null;
        this.requestRedraw();
    }

    public getSelectedCount(): number {
        return this.selectedIndices.size;
    }

    public getSelectedIndices(): Set<number> {
        return this.selectedIndices;
    }

    public hitTestStroke(screenX: number, screenY: number): number {
        const world = this.screenToWorld(screenX, screenY);
        const hitRadius = 12 / this.camera.zoom;

        for (let i = this.strokes.length - 1; i >= 0; i--) {
            if (this.isPointNearStroke(world.x, world.y, this.strokes[i], hitRadius)) {
                return i;
            }
        }
        return -1;
    }

    private isPointNearStroke(wx: number, wy: number, stroke: Stroke, hitRadius: number): boolean {
        const points = stroke.points;
        if (points.length === 0) return false;

        // Bounding box pre-filter
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of points) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        const margin = hitRadius + stroke.config.baseStrokeWidth;
        if (wx < minX - margin || wx > maxX + margin || wy < minY - margin || wy > maxY + margin) {
            return false;
        }

        if (points.length === 1) {
            const dx = wx - points[0].x;
            const dy = wy - points[0].y;
            return (dx * dx + dy * dy) <= hitRadius * hitRadius;
        }

        const strokeHalf = stroke.config.baseStrokeWidth / 2;
        for (let j = 0; j < points.length - 1; j++) {
            if (this.pointToSegmentDist(wx, wy, points[j].x, points[j].y, points[j + 1].x, points[j + 1].y) <= hitRadius + strokeHalf) {
                return true;
            }
        }
        return false;
    }

    private pointToSegmentDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
        const abx = bx - ax, aby = by - ay;
        const apx = px - ax, apy = py - ay;
        const ab2 = abx * abx + aby * aby;
        if (ab2 === 0) return Math.sqrt(apx * apx + apy * apy);
        let t = (apx * abx + apy * aby) / ab2;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + t * abx - px;
        const cy = ay + t * aby - py;
        return Math.sqrt(cx * cx + cy * cy);
    }

    public selectStroke(screenX: number, screenY: number, addToSelection: boolean): boolean {
        const index = this.hitTestStroke(screenX, screenY);
        if (index === -1) {
            if (!addToSelection) this.clearSelection();
            return false;
        }
        if (addToSelection) {
            if (this.selectedIndices.has(index)) {
                this.selectedIndices.delete(index);
            } else {
                this.selectedIndices.add(index);
            }
        } else {
            this.selectedIndices.clear();
            this.selectedIndices.add(index);
        }
        this.requestRedraw();
        return true;
    }

    // --- SELECTION ACTIONS ---
    public deleteSelected(): boolean {
        if (this.selectedIndices.size === 0) return false;
        const indices = Array.from(this.selectedIndices).sort((a, b) => b - a);
        const deletedStrokes: { index: number; stroke: Stroke }[] = [];
        for (const idx of indices) {
            deletedStrokes.push({ index: idx, stroke: this.strokes[idx] });
            this.strokes.splice(idx, 1);
        }
        this.pushUndoAction({ type: 'delete', deletedStrokes });
        this.clearSelection();
        return true;
    }

    public changeSelectedColor(newColor: string): boolean {
        if (this.selectedIndices.size === 0) return false;
        const oldConfigs: { index: number; oldColor: string }[] = [];
        for (const idx of this.selectedIndices) {
            oldConfigs.push({ index: idx, oldColor: this.strokes[idx].config.color });
            this.strokes[idx].config = { ...this.strokes[idx].config, color: newColor };
        }
        this.pushUndoAction({ type: 'recolor', oldConfigs, newColor });
        this.requestRedraw();
        return true;
    }

    public startMoveSelected(screenX: number, screenY: number): void {
        if (this.selectedIndices.size === 0) return;
        const world = this.screenToWorld(screenX, screenY);
        this.isDragging = true;
        this.dragStartWorld = { x: world.x, y: world.y };
        this.dragCurrentWorld = { x: world.x, y: world.y };
    }

    public updateMoveSelected(screenX: number, screenY: number): void {
        if (!this.isDragging || !this.dragCurrentWorld) return;
        const world = this.screenToWorld(screenX, screenY);
        const dx = world.x - this.dragCurrentWorld.x;
        const dy = world.y - this.dragCurrentWorld.y;
        for (const idx of this.selectedIndices) {
            for (const p of this.strokes[idx].points) {
                p.x += dx;
                p.y += dy;
            }
        }
        this.dragCurrentWorld = { x: world.x, y: world.y };
        this.requestRedraw();
    }

    public endMoveSelected(): void {
        if (!this.isDragging || !this.dragStartWorld || !this.dragCurrentWorld) return;
        const totalDx = this.dragCurrentWorld.x - this.dragStartWorld.x;
        const totalDy = this.dragCurrentWorld.y - this.dragStartWorld.y;
        if (Math.abs(totalDx) > 0.5 || Math.abs(totalDy) > 0.5) {
            this.pushUndoAction({
                type: 'move',
                indices: Array.from(this.selectedIndices),
                dx: totalDx,
                dy: totalDy,
            });
        }
        this.isDragging = false;
        this.dragStartWorld = null;
        this.dragCurrentWorld = null;
    }

    // --- RECTANGLE SELECTION ---
    public startSelectionRect(screenX: number, screenY: number): void {
        this.selectionRect = { sx1: screenX, sy1: screenY, sx2: screenX, sy2: screenY };
    }

    public updateSelectionRect(screenX: number, screenY: number): void {
        if (!this.selectionRect) return;
        this.selectionRect.sx2 = screenX;
        this.selectionRect.sy2 = screenY;
        this.requestRedraw();
    }

    public endSelectionRect(addToSelection: boolean): void {
        if (!this.selectionRect) return;
        const rect = this.selectionRect;
        this.selectionRect = null;

        // Convert screen corners to world coords
        const w1 = this.screenToWorld(Math.min(rect.sx1, rect.sx2), Math.min(rect.sy1, rect.sy2));
        const w2 = this.screenToWorld(Math.max(rect.sx1, rect.sx2), Math.max(rect.sy1, rect.sy2));

        if (!addToSelection) {
            this.selectedIndices.clear();
        }

        // Select strokes whose bounding box overlaps the rectangle
        for (let i = 0; i < this.strokes.length; i++) {
            const stroke = this.strokes[i];
            if (stroke.points.length === 0) continue;

            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of stroke.points) {
                if (p.x < minX) minX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x;
                if (p.y > maxY) maxY = p.y;
            }

            // Check bounding box overlap
            if (maxX >= w1.x && minX <= w2.x && maxY >= w1.y && minY <= w2.y) {
                this.selectedIndices.add(i);
            }
        }
        this.requestRedraw();
    }

    private renderSelectionRect(): void {
        if (!this.selectionRect) return;
        const r = this.selectionRect;
        const x = Math.min(r.sx1, r.sx2);
        const y = Math.min(r.sy1, r.sy2);
        const w = Math.abs(r.sx2 - r.sx1);
        const h = Math.abs(r.sy2 - r.sy1);

        this.ctx.save();
        // Draw in screen space (no camera transform)
        this.ctx.fillStyle = 'rgba(0, 122, 255, 0.08)';
        this.ctx.fillRect(x, y, w, h);
        this.ctx.strokeStyle = 'rgba(0, 122, 255, 0.5)';
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([6, 4]);
        this.ctx.strokeRect(x, y, w, h);
        this.ctx.setLineDash([]);
        this.ctx.restore();
    }

    // --- SELECTION HIGHLIGHT RENDERING ---
    private renderSelectionHighlight(stroke: Stroke): void {
        const points = stroke.points;
        if (points.length === 0) return;
        this.ctx.save();
        this.ctx.strokeStyle = '#007AFF';
        this.ctx.lineWidth = (stroke.config.baseStrokeWidth + 6) / this.camera.zoom;
        this.ctx.globalAlpha = 0.3;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        this.ctx.setLineDash([8 / this.camera.zoom, 6 / this.camera.zoom]);
        this.ctx.beginPath();
        if (points.length === 1) {
            this.ctx.arc(points[0].x, points[0].y, stroke.config.baseStrokeWidth + 4, 0, Math.PI * 2);
        } else {
            this.ctx.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) {
                this.ctx.lineTo(points[i].x, points[i].y);
            }
        }
        this.ctx.stroke();
        this.ctx.setLineDash([]);
        this.ctx.restore();
    }

    // --- UNDO / REDO (Action-based) ---
    private pushUndoAction(action: UndoAction): void {
        this.undoStack.push(action);
        this.redoActionStack = [];
    }

    public undo(): boolean {
        if (this.undoStack.length === 0) return false;
        const action = this.undoStack.pop()!;
        switch (action.type) {
            case 'addStroke': {
                this.strokes.pop();
                this.redoActionStack.push(action);
                break;
            }
            case 'delete': {
                const sorted = [...action.deletedStrokes].sort((a, b) => a.index - b.index);
                for (const { index, stroke } of sorted) {
                    this.strokes.splice(index, 0, stroke);
                }
                this.redoActionStack.push(action);
                break;
            }
            case 'recolor': {
                for (const { index, oldColor } of action.oldConfigs) {
                    if (this.strokes[index]) {
                        this.strokes[index].config = { ...this.strokes[index].config, color: oldColor };
                    }
                }
                this.redoActionStack.push(action);
                break;
            }
            case 'move': {
                for (const idx of action.indices) {
                    if (this.strokes[idx]) {
                        for (const p of this.strokes[idx].points) {
                            p.x -= action.dx;
                            p.y -= action.dy;
                        }
                    }
                }
                this.redoActionStack.push(action);
                break;
            }
        }
        this.requestRedraw();
        return true;
    }

    public redo(): boolean {
        if (this.redoActionStack.length === 0) return false;
        const action = this.redoActionStack.pop()!;
        switch (action.type) {
            case 'addStroke': {
                this.strokes.push(action.stroke);
                this.undoStack.push(action);
                break;
            }
            case 'delete': {
                const indices = action.deletedStrokes.map(d => d.index).sort((a, b) => b - a);
                for (const idx of indices) {
                    this.strokes.splice(idx, 1);
                }
                this.undoStack.push(action);
                break;
            }
            case 'recolor': {
                for (const { index } of action.oldConfigs) {
                    if (this.strokes[index]) {
                        this.strokes[index].config = { ...this.strokes[index].config, color: action.newColor };
                    }
                }
                this.undoStack.push(action);
                break;
            }
            case 'move': {
                for (const idx of action.indices) {
                    if (this.strokes[idx]) {
                        for (const p of this.strokes[idx].points) {
                            p.x += action.dx;
                            p.y += action.dy;
                        }
                    }
                }
                this.undoStack.push(action);
                break;
            }
        }
        this.requestRedraw();
        return true;
    }

    public canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    public canRedo(): boolean {
        return this.redoActionStack.length > 0;
    }

    public clearAll(): void {
        this.strokes = [];
        this.undoStack = [];
        this.redoActionStack = [];
        this.clearSelection();
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

        // Draw Strokes + selection highlights
        this.strokes.forEach((stroke, index) => {
            this.renderStroke(stroke.points, stroke.config);
            if (this.selectedIndices.has(index)) {
                this.renderSelectionHighlight(stroke);
            }
        });

        if (this.points.length > 0) {
            this.renderStroke(this.points, this.config);
        }

        this.ctx.restore();

        // v2.2: Selection rectangle overlay (screen space, after camera restore)
        this.renderSelectionRect();
    }

    private drawGrid() {
        if (this.gridType === 'none') return;

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
        this.ctx.scale(zoom, zoom);
        this.ctx.translate(panX, panY);

        const startX = Math.floor(worldLeft / gridSize) * gridSize;
        const endX = Math.ceil(worldRight / gridSize) * gridSize;
        const startY = Math.floor(worldTop / gridSize) * gridSize;
        const endY = Math.ceil(worldBottom / gridSize) * gridSize;

        switch (this.gridType) {
            case 'square': {
                this.ctx.strokeStyle = '#e1e1e1';
                this.ctx.lineWidth = 1 / zoom;
                this.ctx.beginPath();
                for (let x = startX; x <= endX; x += gridSize) {
                    this.ctx.moveTo(x, worldTop);
                    this.ctx.lineTo(x, worldBottom);
                }
                for (let y = startY; y <= endY; y += gridSize) {
                    this.ctx.moveTo(worldLeft, y);
                    this.ctx.lineTo(worldRight, y);
                }
                this.ctx.stroke();
                break;
            }

            case 'dot': {
                this.ctx.fillStyle = '#c8c8c8';
                const dotRadius = 1.5 / zoom;
                for (let x = startX; x <= endX; x += gridSize) {
                    for (let y = startY; y <= endY; y += gridSize) {
                        this.ctx.beginPath();
                        this.ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
                        this.ctx.fill();
                    }
                }
                break;
            }

            case 'ruled': {
                this.ctx.strokeStyle = '#d4d8e0';
                this.ctx.lineWidth = 1 / zoom;
                this.ctx.beginPath();
                for (let y = startY; y <= endY; y += gridSize) {
                    this.ctx.moveTo(worldLeft, y);
                    this.ctx.lineTo(worldRight, y);
                }
                this.ctx.stroke();
                // Red margin line — fixed at world x = gridSize*2
                const marginX = gridSize * 2;
                if (marginX >= worldLeft && marginX <= worldRight) {
                    this.ctx.strokeStyle = 'rgba(220, 80, 80, 0.3)';
                    this.ctx.beginPath();
                    this.ctx.moveTo(marginX, worldTop);
                    this.ctx.lineTo(marginX, worldBottom);
                    this.ctx.stroke();
                }
                break;
            }

            case 'isometric': {
                this.ctx.strokeStyle = '#e1e1e1';
                this.ctx.lineWidth = 1 / zoom;
                const isoH = gridSize * Math.sqrt(3) / 2; // height of equilateral triangle row

                this.ctx.beginPath();
                // Horizontal lines
                const isoStartY = Math.floor(worldTop / isoH) * isoH;
                const isoEndY = Math.ceil(worldBottom / isoH) * isoH;
                for (let y = isoStartY; y <= isoEndY; y += isoH) {
                    this.ctx.moveTo(worldLeft, y);
                    this.ctx.lineTo(worldRight, y);
                }

                // Diagonal lines (/) and (\)
                const rowCount = Math.ceil((worldBottom - worldTop) / isoH) + 2;
                const colCount = Math.ceil((worldRight - worldLeft) / gridSize) + 2;
                const baseX = Math.floor(worldLeft / gridSize) * gridSize;
                const baseY = Math.floor(worldTop / isoH) * isoH;

                for (let c = -rowCount; c <= colCount + rowCount; c++) {
                    // Lines going from top-left to bottom-right (\)
                    const x1 = baseX + c * gridSize;
                    this.ctx.moveTo(x1, baseY);
                    this.ctx.lineTo(x1 + rowCount * gridSize * 0.5, baseY + rowCount * isoH);

                    // Lines going from top-right to bottom-left (/)
                    this.ctx.moveTo(x1, baseY);
                    this.ctx.lineTo(x1 - rowCount * gridSize * 0.5, baseY + rowCount * isoH);
                }
                this.ctx.stroke();
                break;
            }

            case 'graph': {
                // Graph paper: minor grid (small) + major grid (emphasized)
                const minorSize = gridSize / 4; // 10px minor divisions
                const majorSize = gridSize; // 40px major divisions

                // Minor grid lines (light)
                this.ctx.strokeStyle = '#eaeaea';
                this.ctx.lineWidth = 0.5 / zoom;
                this.ctx.beginPath();
                const minorStartX = Math.floor(worldLeft / minorSize) * minorSize;
                const minorEndX = Math.ceil(worldRight / minorSize) * minorSize;
                const minorStartY = Math.floor(worldTop / minorSize) * minorSize;
                const minorEndY = Math.ceil(worldBottom / minorSize) * minorSize;
                for (let x = minorStartX; x <= minorEndX; x += minorSize) {
                    this.ctx.moveTo(x, worldTop);
                    this.ctx.lineTo(x, worldBottom);
                }
                for (let y = minorStartY; y <= minorEndY; y += minorSize) {
                    this.ctx.moveTo(worldLeft, y);
                    this.ctx.lineTo(worldRight, y);
                }
                this.ctx.stroke();

                // Major grid lines (darker, thicker)
                this.ctx.strokeStyle = '#c8c8c8';
                this.ctx.lineWidth = 1 / zoom;
                this.ctx.beginPath();
                const majorStartX = Math.floor(worldLeft / majorSize) * majorSize;
                const majorEndX = Math.ceil(worldRight / majorSize) * majorSize;
                const majorStartY = Math.floor(worldTop / majorSize) * majorSize;
                const majorEndY = Math.ceil(worldBottom / majorSize) * majorSize;
                for (let x = majorStartX; x <= majorEndX; x += majorSize) {
                    this.ctx.moveTo(x, worldTop);
                    this.ctx.lineTo(x, worldBottom);
                }
                for (let y = majorStartY; y <= majorEndY; y += majorSize) {
                    this.ctx.moveTo(worldLeft, y);
                    this.ctx.lineTo(worldRight, y);
                }
                this.ctx.stroke();
                break;
            }

            case 'hex': {
                // Hexagonal grid
                this.ctx.strokeStyle = '#d8d8d8';
                this.ctx.lineWidth = 1 / zoom;
                const hexR = gridSize * 0.6; // hex radius (center to vertex)
                const hexW = hexR * Math.sqrt(3); // width (flat-to-flat for pointy-top)
                const hexH = hexR * 2;
                const rowH = hexH * 0.75; // vertical distance between row centers

                const hexStartRow = Math.floor((worldTop - hexR) / rowH) - 1;
                const hexEndRow = Math.ceil((worldBottom + hexR) / rowH) + 1;
                const hexStartCol = Math.floor((worldLeft - hexW) / hexW) - 1;
                const hexEndCol = Math.ceil((worldRight + hexW) / hexW) + 1;

                this.ctx.beginPath();
                for (let row = hexStartRow; row <= hexEndRow; row++) {
                    const cy = row * rowH;
                    const offsetX = (row % 2 !== 0) ? hexW / 2 : 0;
                    for (let col = hexStartCol; col <= hexEndCol; col++) {
                        const cx = col * hexW + offsetX;
                        // Draw hexagon (pointy-top)
                        for (let i = 0; i < 6; i++) {
                            const angle = (Math.PI / 3) * i - Math.PI / 6;
                            const nextAngle = (Math.PI / 3) * (i + 1) - Math.PI / 6;
                            const x1 = cx + hexR * Math.cos(angle);
                            const y1 = cy + hexR * Math.sin(angle);
                            const x2 = cx + hexR * Math.cos(nextAngle);
                            const y2 = cy + hexR * Math.sin(nextAngle);
                            this.ctx.moveTo(x1, y1);
                            this.ctx.lineTo(x2, y2);
                        }
                    }
                }
                this.ctx.stroke();
                break;
            }
        }

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

    startStroke(x: number, y: number, pressure: number, tiltX: number = 0, tiltY: number = 0): void {
        console.log('[Renderer] startStroke at', x, y, 'pressure:', pressure, 'tilt:', tiltX, tiltY);
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
        this.points = [{ x: worldPoint.x, y: worldPoint.y, pressure, timestamp: performance.now(), tiltX, tiltY }];

        // Draw initial point immediately
        this.renderInitialPoint(worldPoint.x, worldPoint.y, pressure);
    }

    // Draw the first point of stroke immediately for responsiveness
    // v1.7.7: Fixed "tap creates huge dot" bug - initial point now respects minWidth/maxWidth
    private renderInitialPoint(worldX: number, worldY: number, pressure: number): void {
        // Calculate base width from pressure
        const pFactor = pressure * this.config.pressureInfluence + (1 - this.config.pressureInfluence) * 0.5;
        let width = this.config.baseStrokeWidth * pFactor;

        // v1.7.7: Apply taper reduction for initial point (like stroke start)
        // This makes quick taps produce smaller dots
        const taperFactor = 0.4; // Start at 40% of full width (like stroke taper)
        width *= taperFactor;

        // Clamp to min/max width
        width = Math.max(this.config.minWidth, Math.min(this.config.maxWidth, width));

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

    addPoint(x: number, y: number, pressure: number, tiltX: number = 0, tiltY: number = 0): void {
        if (!this.isDrawing) {
            console.log('[Renderer] addPoint ignored - not drawing');
            return;
        }

        const worldPoint = this.screenToWorld(x, y);
        const now = performance.now();

        // v2.4: Track last significant movement for shape snap
        if (this.points.length > 0) {
            const last = this.points[this.points.length - 1];
            const moveDist = Math.hypot(worldPoint.x - last.x, worldPoint.y - last.y);
            if (moveDist > 2) {
                this.lastMoveTimestamp = now;
            }
        } else {
            this.lastMoveTimestamp = now;
        }

        const lastPoint = this.points[this.points.length - 1];
        if (!lastPoint) {
            console.log('[Renderer] addPoint - no last point, starting fresh');
            this.points.push({ x: worldPoint.x, y: worldPoint.y, pressure, timestamp: now, tiltX, tiltY });
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
                timestamp: now,
                tiltX, tiltY
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
            timestamp: now,
            tiltX, tiltY
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

        // v2.7: Scratch-to-erase — check before shape snap or saving
        if (this.isScratchGesture(this.points)) {
            const erased = this.eraseStrokesUnderScratch(this.points);
            this.points = [];
            if (erased) {
                console.log('[Renderer] Scratch-to-erase triggered!');
            }
            if (this.pendingResize) {
                this.doResize();
            } else {
                this.requestRedraw();
            }
            return; // Don't save the scratch stroke
        }

        // v2.4: Shape snap - if pen was held still at end, try to snap to perfect shape
        const now = performance.now();
        const holdDuration = now - this.lastMoveTimestamp;
        if (holdDuration >= this.shapeSnapThreshold && this.points.length >= 4) {
            const snappedPoints = this.detectAndSnapShape(this.points);
            if (snappedPoints) {
                this.points = snappedPoints;
                console.log('[Renderer] Shape snapped!');
            }
        }

        const newStroke: Stroke = { points: [...this.points], config: { ...this.config } };
        this.strokes.push(newStroke);
        this.pushUndoAction({ type: 'addStroke', stroke: newStroke });
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

    // v1.8.3: Post-stroke smoothing (smoothStrokePoints) REMOVED
    // Reason: Caused "mushy" feel - double smoothing with streamline during drawing
    // Decision: Premium pen experience = pen does exactly what user intends

    // --- Incremental Tip Rendering - DISABLED FOR NOW ---
    // Kept for future optimization
    // private renderIncrementalTip() { ... }

    // --- SCRATCH-TO-ERASE v2.7 ---

    private isScratchGesture(points: Point[]): boolean {
        // Scratch = rapid back-and-forth motion in a confined area.
        // Detect by counting horizontal direction reversals.
        if (points.length < 15) return false;

        let reversals = 0;
        let lastDir = 0;
        let totalTravel = 0;

        for (let i = 1; i < points.length; i++) {
            const dx = points[i].x - points[i - 1].x;
            const dy = points[i].y - points[i - 1].y;
            totalTravel += Math.hypot(dx, dy);

            // Only count direction when movement is significant (avoid noise)
            if (Math.abs(dx) > 2) {
                const dir = dx > 0 ? 1 : -1;
                if (lastDir !== 0 && dir !== lastDir) {
                    reversals++;
                }
                lastDir = dir;
            }
        }

        // Bbox of the scratch area
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of points) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        const bboxDiag = Math.hypot(maxX - minX, maxY - minY);

        // Scratch: at least 4 reversals AND total travel >> bbox diagonal
        // (back-and-forth covering the same area many times)
        const isScratch = reversals >= 4 && totalTravel > bboxDiag * 2.5;
        if (isScratch) {
            console.log(`[ScratchErase] Detected: ${reversals} reversals, travel=${totalTravel.toFixed(0)}, bbox=${bboxDiag.toFixed(0)}`);
        }
        return isScratch;
    }

    private eraseStrokesUnderScratch(scratchPoints: Point[]): boolean {
        // Find bounding box of the scratch gesture
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of scratchPoints) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }

        // Expand scratch area slightly for forgiving hit detection
        const margin = 5;
        minX -= margin; minY -= margin; maxX += margin; maxY += margin;

        // Find all strokes that have any point inside the scratch bbox
        const toDelete: number[] = [];
        for (let i = 0; i < this.strokes.length; i++) {
            const stroke = this.strokes[i];
            for (const p of stroke.points) {
                if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
                    toDelete.push(i);
                    break;
                }
            }
        }

        if (toDelete.length === 0) return false;

        // Delete strokes from end to preserve indices
        const indices = toDelete.sort((a, b) => b - a);
        const deletedStrokes: { index: number; stroke: Stroke }[] = [];
        for (const idx of indices) {
            deletedStrokes.push({ index: idx, stroke: this.strokes[idx] });
            this.strokes.splice(idx, 1);
        }
        this.pushUndoAction({ type: 'delete', deletedStrokes });

        // Clear selection if any selected strokes were deleted
        if (this.selectedIndices.size > 0) {
            this.clearSelection();
        }

        return true;
    }

    // --- SHAPE SNAP v2.4 ---

    private filterHoldPoints(points: Point[]): Point[] {
        // Remove clustered hold-still points from the end of the stroke.
        // When the user holds the pen still to trigger shape snap, many points
        // accumulate at the endpoint, skewing centroid and variance calculations.
        if (points.length < 8) return points;
        const last = points[points.length - 1];
        const clusterRadius = 4; // px — points within this radius of the last point are "hold" points
        let cutoff = points.length;
        // Walk backwards from the end, find where points stop clustering
        for (let i = points.length - 2; i >= Math.floor(points.length * 0.5); i--) {
            const d = Math.hypot(points[i].x - last.x, points[i].y - last.y);
            if (d > clusterRadius) {
                cutoff = i + 2; // Keep one point past the cluster boundary
                break;
            }
        }
        return cutoff < points.length ? points.slice(0, cutoff) : points;
    }

    private detectAndSnapShape(rawPoints: Point[]): Point[] | null {
        if (rawPoints.length < 4) return null;

        // Filter out hold-still points clustered at the end
        const points = this.filterHoldPoints(rawPoints);
        if (points.length < 4) return null;

        // Calculate bounding box
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of points) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        const bboxW = maxX - minX;
        const bboxH = maxY - minY;
        const bboxDiag = Math.hypot(bboxW, bboxH);

        // Too small to snap
        if (bboxDiag < 20) return null;

        // Check if stroke is closed (start ~= end)
        const first = points[0];
        const last = points[points.length - 1];
        const closeDist = Math.hypot(last.x - first.x, last.y - first.y);
        const isClosed = closeDist < bboxDiag * 0.35;

        // Calculate centroid
        let cx = 0, cy = 0;
        for (const p of points) { cx += p.x; cy += p.y; }
        cx /= points.length;
        cy /= points.length;

        // Average pressure/tilt from original points
        const avgPressure = rawPoints.reduce((s, p) => s + p.pressure, 0) / rawPoints.length;
        const avgTiltX = rawPoints.reduce((s, p) => s + p.tiltX, 0) / rawPoints.length;
        const avgTiltY = rawPoints.reduce((s, p) => s + p.tiltY, 0) / rawPoints.length;

        if (isClosed) {
            // --- CLOSED SHAPES: Circle, Ellipse, or Rectangle ---

            // Test for circle: check variance of distance from centroid
            const distances = points.map(p => Math.hypot(p.x - cx, p.y - cy));
            const avgRadius = distances.reduce((s, d) => s + d, 0) / distances.length;
            const variance = distances.reduce((s, d) => s + (d - avgRadius) ** 2, 0) / distances.length;
            const stdDev = Math.sqrt(variance);
            const circleScore = stdDev / avgRadius; // Lower = more circular

            // Test for ellipse: check how well points fit an axis-aligned ellipse
            const rx = bboxW / 2;
            const ry = bboxH / 2;
            const ellipseScore = this.scoreEllipse(points, cx, cy, rx, ry);

            // Test for rectangle: check how well corners are defined
            const rectScore = this.scoreRectangle(points, minX, minY, maxX, maxY);

            // Aspect ratio — close to 1 means circle-like, far from 1 means oval
            const aspect = Math.max(bboxW, bboxH) / Math.max(1, Math.min(bboxW, bboxH));

            console.log(`[ShapeSnap] circle=${circleScore.toFixed(3)} ellipse=${ellipseScore.toFixed(3)} rect=${rectScore.toFixed(3)} aspect=${aspect.toFixed(2)}`);

            if (circleScore < 0.22 && aspect < 1.4) {
                // Snap to circle
                return this.generateCirclePoints(cx, cy, avgRadius, avgPressure, avgTiltX, avgTiltY);
            } else if (rectScore > 0.7) {
                // Strong rectangle match → rounded rectangle
                return this.generateRoundedRectPoints(minX, minY, maxX, maxY, avgPressure, avgTiltX, avgTiltY);
            } else if (ellipseScore < 0.20 && aspect >= 1.4) {
                // Ellipse / oval (non-circular aspect ratio)
                return this.generateEllipsePoints(cx, cy, rx, ry, avgPressure, avgTiltX, avgTiltY);
            } else if (circleScore < 0.38) {
                // Looser circle/ellipse — pick based on aspect ratio
                if (aspect < 1.5) {
                    return this.generateCirclePoints(cx, cy, avgRadius, avgPressure, avgTiltX, avgTiltY);
                } else {
                    return this.generateEllipsePoints(cx, cy, rx, ry, avgPressure, avgTiltX, avgTiltY);
                }
            } else if (rectScore > 0.5) {
                // Looser rectangle match → rounded rectangle
                return this.generateRoundedRectPoints(minX, minY, maxX, maxY, avgPressure, avgTiltX, avgTiltY);
            } else if (ellipseScore < 0.35) {
                // Fallback: loose ellipse
                return this.generateEllipsePoints(cx, cy, rx, ry, avgPressure, avgTiltX, avgTiltY);
            }
        } else {
            // --- OPEN SHAPES: Line ---

            // Test for straight line: deviation from first-to-last line
            const lineLen = Math.hypot(last.x - first.x, last.y - first.y);
            if (lineLen < 10) return null;

            let maxDeviation = 0;
            for (const p of points) {
                const d = this.pointToSegmentDist(p.x, p.y, first.x, first.y, last.x, last.y);
                if (d > maxDeviation) maxDeviation = d;
            }
            const lineScore = maxDeviation / lineLen; // Lower = straighter

            if (lineScore < 0.10) {
                // Snap to straight line
                return this.generateLinePoints(first.x, first.y, last.x, last.y, avgPressure, avgTiltX, avgTiltY);
            }
        }

        return null; // No shape detected
    }

    private scoreRectangle(points: Point[], minX: number, minY: number, maxX: number, maxY: number): number {
        // Score how well points fit a rectangle
        // Check: what % of points are near the edges of the bounding box
        const w = maxX - minX;
        const h = maxY - minY;
        if (w < 10 || h < 10) return 0;

        const edgeThreshold = Math.min(w, h) * 0.15;
        let nearEdge = 0;
        for (const p of points) {
            const distLeft = Math.abs(p.x - minX);
            const distRight = Math.abs(p.x - maxX);
            const distTop = Math.abs(p.y - minY);
            const distBottom = Math.abs(p.y - maxY);
            const minDist = Math.min(distLeft, distRight, distTop, distBottom);
            if (minDist < edgeThreshold) nearEdge++;
        }
        return nearEdge / points.length;
    }

    private generateCirclePoints(cx: number, cy: number, radius: number, pressure: number, tiltX: number, tiltY: number): Point[] {
        const numPoints = 64;
        const result: Point[] = [];
        const baseTime = performance.now();
        for (let i = 0; i <= numPoints; i++) {
            const angle = (i / numPoints) * Math.PI * 2;
            result.push({
                x: cx + radius * Math.cos(angle),
                y: cy + radius * Math.sin(angle),
                pressure,
                timestamp: baseTime + i,
                tiltX, tiltY
            });
        }
        return result;
    }

    private generateRectPoints(minX: number, minY: number, maxX: number, maxY: number, pressure: number, tiltX: number, tiltY: number): Point[] {
        const result: Point[] = [];
        const baseTime = performance.now();
        const corners = [
            { x: minX, y: minY },
            { x: maxX, y: minY },
            { x: maxX, y: maxY },
            { x: minX, y: maxY },
            { x: minX, y: minY }, // close
        ];
        // Interpolate between corners for smooth rendering
        let t = 0;
        for (let c = 0; c < corners.length - 1; c++) {
            const from = corners[c];
            const to = corners[c + 1];
            const segLen = Math.hypot(to.x - from.x, to.y - from.y);
            const steps = Math.max(4, Math.ceil(segLen / 5));
            for (let i = 0; i <= steps; i++) {
                const frac = i / steps;
                result.push({
                    x: from.x + (to.x - from.x) * frac,
                    y: from.y + (to.y - from.y) * frac,
                    pressure,
                    timestamp: baseTime + t++,
                    tiltX, tiltY
                });
            }
        }
        return result;
    }

    private scoreEllipse(points: Point[], cx: number, cy: number, rx: number, ry: number): number {
        // RMS deviation from an axis-aligned ellipse: (x-cx)²/rx² + (y-cy)²/ry² = 1
        // Score = average |ellipseEq - 1|. Lower = better fit.
        if (rx < 5 || ry < 5) return 999;
        let totalDev = 0;
        for (const p of points) {
            const ex = ((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2;
            totalDev += Math.abs(ex - 1);
        }
        return totalDev / points.length;
    }

    private generateEllipsePoints(cx: number, cy: number, rx: number, ry: number, pressure: number, tiltX: number, tiltY: number): Point[] {
        const numPoints = 64;
        const result: Point[] = [];
        const baseTime = performance.now();
        for (let i = 0; i <= numPoints; i++) {
            const angle = (i / numPoints) * Math.PI * 2;
            result.push({
                x: cx + rx * Math.cos(angle),
                y: cy + ry * Math.sin(angle),
                pressure,
                timestamp: baseTime + i,
                tiltX, tiltY
            });
        }
        return result;
    }

    private generateRoundedRectPoints(minX: number, minY: number, maxX: number, maxY: number, pressure: number, tiltX: number, tiltY: number): Point[] {
        const result: Point[] = [];
        const baseTime = performance.now();
        const w = maxX - minX;
        const h = maxY - minY;
        // Corner radius: 12% of shorter side, clamped to reasonable range
        const r = Math.min(Math.min(w, h) * 0.12, 20);
        const arcSteps = 8; // Points per quarter-circle arc
        let t = 0;

        const addPoint = (x: number, y: number) => {
            result.push({ x, y, pressure, timestamp: baseTime + t++, tiltX, tiltY });
        };

        // Top edge (left-to-right)
        const segSteps = (len: number) => Math.max(4, Math.ceil(len / 5));
        const topLen = w - 2 * r;
        for (let i = 0; i <= segSteps(topLen); i++) {
            addPoint(minX + r + (topLen * i / segSteps(topLen)), minY);
        }
        // Top-right arc
        for (let i = 1; i <= arcSteps; i++) {
            const angle = -Math.PI / 2 + (Math.PI / 2) * (i / arcSteps);
            addPoint(maxX - r + r * Math.cos(angle), minY + r + r * Math.sin(angle));
        }
        // Right edge (top-to-bottom)
        const rightLen = h - 2 * r;
        for (let i = 1; i <= segSteps(rightLen); i++) {
            addPoint(maxX, minY + r + (rightLen * i / segSteps(rightLen)));
        }
        // Bottom-right arc
        for (let i = 1; i <= arcSteps; i++) {
            const angle = 0 + (Math.PI / 2) * (i / arcSteps);
            addPoint(maxX - r + r * Math.cos(angle), maxY - r + r * Math.sin(angle));
        }
        // Bottom edge (right-to-left)
        const bottomLen = w - 2 * r;
        for (let i = 1; i <= segSteps(bottomLen); i++) {
            addPoint(maxX - r - (bottomLen * i / segSteps(bottomLen)), maxY);
        }
        // Bottom-left arc
        for (let i = 1; i <= arcSteps; i++) {
            const angle = Math.PI / 2 + (Math.PI / 2) * (i / arcSteps);
            addPoint(minX + r + r * Math.cos(angle), maxY - r + r * Math.sin(angle));
        }
        // Left edge (bottom-to-top)
        const leftLen = h - 2 * r;
        for (let i = 1; i <= segSteps(leftLen); i++) {
            addPoint(minX, maxY - r - (leftLen * i / segSteps(leftLen)));
        }
        // Top-left arc
        for (let i = 1; i <= arcSteps; i++) {
            const angle = Math.PI + (Math.PI / 2) * (i / arcSteps);
            addPoint(minX + r + r * Math.cos(angle), minY + r + r * Math.sin(angle));
        }
        // Close — connect back to start
        addPoint(minX + r, minY);

        return result;
    }

    private generateLinePoints(x1: number, y1: number, x2: number, y2: number, pressure: number, tiltX: number, tiltY: number): Point[] {
        const result: Point[] = [];
        const baseTime = performance.now();
        const dist = Math.hypot(x2 - x1, y2 - y1);
        const steps = Math.max(4, Math.ceil(dist / 5));
        for (let i = 0; i <= steps; i++) {
            const frac = i / steps;
            result.push({
                x: x1 + (x2 - x1) * frac,
                y: y1 + (y2 - y1) * frac,
                pressure,
                timestamp: baseTime + i,
                tiltX, tiltY
            });
        }
        return result;
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

        // v1.7.7: Handle single-point strokes (taps/dots)
        if (strokePoints.length === 1) {
            const p = strokePoints[0];
            // Draw as small dot with taper factor applied
            const pFactor = p.pressure * config.pressureInfluence + (1 - config.pressureInfluence) * 0.5;
            let width = config.baseStrokeWidth * pFactor * 0.4; // Taper factor for dots
            width = Math.max(config.minWidth, Math.min(config.maxWidth, width));

            ctx.fillStyle = config.color;
            ctx.globalAlpha = config.opacity;
            ctx.beginPath();
            ctx.arc(p.x, p.y, width / 2, 0, Math.PI * 2);
            ctx.fill();
            return;
        }

        if (strokePoints.length < 2) return;

        ctx.strokeStyle = config.color;
        ctx.globalAlpha = config.opacity;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();

        // v1.7.7: Short strokes (2-3 points) now use pressure-based width with taper
        if (strokePoints.length < 4) {
            ctx.moveTo(strokePoints[0].x, strokePoints[0].y);
            // Calculate average pressure for width
            const avgPressure = strokePoints.reduce((s, p) => s + p.pressure, 0) / strokePoints.length;
            const pFactor = avgPressure * config.pressureInfluence + (1 - config.pressureInfluence) * 0.5;
            let width = config.baseStrokeWidth * pFactor * 0.5; // Apply taper for short strokes
            width = Math.max(config.minWidth, Math.min(config.maxWidth, width));

            strokePoints.forEach(p => ctx.lineTo(p.x, p.y));
            ctx.lineWidth = width;
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

        // v1.9.0: TILT CALLIGRAPHY - pen angle affects stroke width
        // Like a real calligraphy nib: angle relative to stroke direction changes width
        if (current.tiltX !== 0 || current.tiltY !== 0) {
            // Pen tilt angle from vertical (0 = straight up, 90 = flat on surface)
            const tiltAngle = Math.sqrt(current.tiltX * current.tiltX + current.tiltY * current.tiltY);
            // Direction the pen is tilting toward (radians)
            const tiltDirection = Math.atan2(current.tiltY, current.tiltX);
            // Direction of stroke movement (radians)
            const strokeDirection = Math.atan2(dy, dx);

            // Angle between tilt direction and stroke direction
            // When perpendicular → wide stroke (nib catches paper)
            // When parallel → thin stroke (nib slices through)
            const angleDiff = Math.abs(tiltDirection - strokeDirection);
            const normalizedAngle = Math.min(angleDiff, Math.PI - angleDiff) / (Math.PI / 2); // 0-1

            // Tilt magnitude: how much tilt affects width (more tilted = more effect)
            const tiltMagnitude = Math.min(1, tiltAngle / 60); // Full effect at 60 degrees

            // Apply: perpendicular = wider (up to 1.5x), parallel = thinner (down to 0.6x)
            const tiltFactor = 0.6 + normalizedAngle * 0.9; // Range: 0.6 to 1.5
            // Blend based on tilt magnitude (no tilt = no effect)
            width *= 1 + (tiltFactor - 1) * tiltMagnitude;
        }

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
