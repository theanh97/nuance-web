/**
 * FrictionEngine - Simulates paper friction for realistic writing feel
 *
 * Creates the sensation of "dragging pen through paper" by:
 * 1. Adding slight resistance/lag to stroke movement
 * 2. Modulating haptic feedback based on friction
 * 3. Adjusting based on pressure, velocity, and direction
 */

export interface FrictionConfig {
    enabled: boolean;
    baseResistance: number;      // 0.0 - 1.0, how much the stroke "drags"
    pressureInfluence: number;   // How much pressure affects friction
    velocityDamping: number;     // High velocity = less friction (momentum)
    grainDirection: number;      // Angle of paper grain (radians), 0 = horizontal
    grainStrength: number;       // How much grain affects friction
}

export const DEFAULT_FRICTION_CONFIG: FrictionConfig = {
    enabled: true,
    baseResistance: 0.5,         // Strong drag - clearly feels like pen on paper
    pressureInfluence: 0.6,      // Strong pressure effect - press harder = more drag
    velocityDamping: 0.3,        // Less momentum = more friction feel
    grainDirection: 0,           // Horizontal grain
    grainStrength: 0.25          // Clear grain effect
};

export interface FrictionPoint {
    x: number;
    y: number;
    pressure: number;
    velocity: number;
    direction: number;           // Angle of movement (radians)
}

export interface FrictionResult {
    adjustedX: number;
    adjustedY: number;
    frictionAmount: number;      // 0.0 - 1.0, for haptic/sound feedback
    grainFactor: number;         // How much grain is affecting this stroke
}

export class FrictionEngine {
    private config: FrictionConfig;
    private lastPoint: { x: number; y: number } | null = null;
    private accumulatedFriction: number = 0;

    constructor(config: Partial<FrictionConfig> = {}) {
        this.config = { ...DEFAULT_FRICTION_CONFIG, ...config };
    }

    public setConfig(newConfig: Partial<FrictionConfig>): void {
        this.config = { ...this.config, ...newConfig };
    }

    public setEnabled(enabled: boolean): void {
        this.config.enabled = enabled;
    }

    public reset(): void {
        this.lastPoint = null;
        this.accumulatedFriction = 0;
    }

    /**
     * Process a point through friction simulation
     * Returns adjusted position and friction metadata for feedback systems
     */
    public processPoint(input: FrictionPoint): FrictionResult {
        if (!this.config.enabled) {
            return {
                adjustedX: input.x,
                adjustedY: input.y,
                frictionAmount: 0,
                grainFactor: 0
            };
        }

        // Initialize last point if first point
        if (!this.lastPoint) {
            this.lastPoint = { x: input.x, y: input.y };
            return {
                adjustedX: input.x,
                adjustedY: input.y,
                frictionAmount: 0,
                grainFactor: 0
            };
        }

        // Calculate base friction
        let friction = this.config.baseResistance;

        // Pressure increases friction (pressing harder = more drag)
        friction += input.pressure * this.config.pressureInfluence * 0.2;

        // Velocity decreases friction (momentum overcomes resistance)
        const velocityFactor = Math.min(1, input.velocity / 5); // Normalize to 0-1
        friction *= (1 - velocityFactor * this.config.velocityDamping);

        // Grain direction affects friction
        const grainFactor = this.calculateGrainFactor(input.direction);
        friction += grainFactor * this.config.grainStrength;

        // Clamp friction to reasonable range
        friction = Math.max(0, Math.min(0.5, friction));

        // Apply friction as interpolation toward target
        // Lower friction = faster catch-up, higher = more lag
        const smoothFactor = 1 - friction;
        const adjustedX = this.lastPoint.x + (input.x - this.lastPoint.x) * smoothFactor;
        const adjustedY = this.lastPoint.y + (input.y - this.lastPoint.y) * smoothFactor;

        // Update last point for next iteration
        this.lastPoint = { x: adjustedX, y: adjustedY };

        // Track accumulated friction for feedback
        this.accumulatedFriction = friction;

        return {
            adjustedX,
            adjustedY,
            frictionAmount: friction,
            grainFactor
        };
    }

    /**
     * Calculate how much the grain direction affects friction
     * Returns 0-1 where 1 = moving perpendicular to grain (max friction)
     */
    private calculateGrainFactor(moveDirection: number): number {
        // Angle difference between movement and grain
        const angleDiff = Math.abs(moveDirection - this.config.grainDirection);

        // Normalize to 0 - PI/2 range
        const normalizedAngle = Math.min(angleDiff, Math.PI - angleDiff);

        // Convert to 0-1 factor (perpendicular = 1, parallel = 0)
        return normalizedAngle / (Math.PI / 2);
    }

    /**
     * Get current friction level for haptic feedback
     */
    public getCurrentFriction(): number {
        return this.accumulatedFriction;
    }

    /**
     * Calculate recommended haptic intensity based on friction
     */
    public getHapticIntensity(baseIntensity: number = 1): number {
        // More friction = stronger haptic
        return baseIntensity * (0.5 + this.accumulatedFriction);
    }

    /**
     * Calculate recommended haptic interval based on velocity
     * Faster movement = more frequent haptic (paper grain bumps)
     */
    public getHapticInterval(velocity: number): number {
        // Base interval 50ms, reduce with velocity (more bumps when fast)
        const minInterval = 20;  // ms
        const maxInterval = 80;  // ms
        const velocityFactor = Math.min(1, velocity / 10);

        return maxInterval - (maxInterval - minInterval) * velocityFactor;
    }
}
