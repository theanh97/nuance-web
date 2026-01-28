export class HapticEngine {
    private enabled: boolean = false;
    private lastVibrateTime: number = 0;

    constructor() {
        // Check if vibration is supported
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
            this.enabled = true;
        }
    }

    public setEnabled(enabled: boolean) {
        this.enabled = enabled;
    }

    /**
     * Trigger a subtle "grain" vibration.
     * Use this when the pen moves a certain distance to simulate paper texture.
     */
    public triggerGrain() {
        if (!this.enabled) return;

        const now = performance.now();
        // Limit frequency to max 20Hz (every 50ms) to avoid overwhelming the motor/user
        if (now - this.lastVibrateTime < 50) return;

        try {
            // Shortest possible vibration for "click" or "bump" feel
            navigator.vibrate(5);
        } catch (e) {
            // Ignore errors (e.g. if user interaction hasn't happened yet)
        }
        this.lastVibrateTime = now;
    }

    /**
     * Stronger feedback for events like connecting a shape or end of stroke (optional)
     */
    public triggerFeedback() {
        if (!this.enabled) return;
        navigator.vibrate(10);
    }
}
