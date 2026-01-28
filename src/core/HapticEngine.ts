export class HapticEngine {
    private enabled: boolean = false; // Default to OFF - user must enable
    private lastVibrateTime: number = 0;
    private isSupported: boolean = false;

    constructor() {
        // Check if vibration is supported
        this.isSupported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
        console.log('[HapticEngine] Vibration supported:', this.isSupported);
    }

    public setEnabled(enabled: boolean) {
        this.enabled = Boolean(enabled); // Ensure boolean conversion
        console.log('[HapticEngine] setEnabled:', this.enabled);
    }

    /**
     * Trigger a subtle "grain" vibration.
     * Use this when the pen moves a certain distance to simulate paper texture.
     */
    public triggerGrain() {
        if (!this.enabled || !this.isSupported) return;

        const now = performance.now();
        // Limit frequency to max 20Hz (every 50ms) to avoid overwhelming the motor/user
        if (now - this.lastVibrateTime < 50) return;

        try {
            // Shortest possible vibration for "click" or "bump" feel
            navigator.vibrate(5);
        } catch (e) {
            console.warn('[HapticEngine] Vibration failed:', e);
        }
        this.lastVibrateTime = now;
    }

    /**
     * Force trigger (bypass rate limit) - for first touch
     */
    public triggerImmediate() {
        if (!this.enabled || !this.isSupported) return;

        try {
            navigator.vibrate(8);
            this.lastVibrateTime = performance.now();
        } catch (e) {
            console.warn('[HapticEngine] Vibration failed:', e);
        }
    }

    /**
     * Stronger feedback for events like connecting a shape or end of stroke (optional)
     */
    public triggerFeedback() {
        if (!this.enabled) return;
        navigator.vibrate(10);
    }
}
