export type SoundProfile = 'pencil' | 'charcoal' | 'ballpoint' | 'fountain' | 'marker' | 'highlighter' | 'monoline' | 'calligraphy';

export class SoundEngine {
    private audioContext: AudioContext | null = null;
    private noiseNode: AudioBufferSourceNode | null = null;
    private gainNode: GainNode | null = null;
    private filterNode: BiquadFilterNode | null = null;
    private envelopeNode: GainNode | null = null;
    private isPlaying: boolean = false;
    private isInitializing: boolean = false;

    private pannerNode: StereoPannerNode | null = null;
    private currentProfile: SoundProfile = 'pencil';
    private baseVolume: number = 0.5;

    public setPanning(panX: number) {
        // panX: -1 (Left) to 1 (Right)
        if (this.pannerNode && this.audioContext) {
            const safePan = Math.max(-1, Math.min(1, panX));
            this.pannerNode.pan.setTargetAtTime(safePan, this.audioContext.currentTime, 0.1);
        }
    }

    constructor() {
        try {
            // @ts-ignore
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioContextClass();
            console.log('[SoundEngine] AudioContext created, state:', this.audioContext?.state);
        } catch (e) {
            console.warn("[SoundEngine] AudioContext not supported:", e);
        }
    }

    /**
     * Pre-initialize on user interaction (call early to ensure audio works)
     */
    public async preInit(): Promise<void> {
        if (!this.audioContext) return;
        if (this.audioContext.state === 'suspended') {
            try {
                await this.audioContext.resume();
                console.log('[SoundEngine] AudioContext resumed in preInit');
            } catch (e) {
                console.warn('[SoundEngine] Failed to resume AudioContext:', e);
            }
        }
    }

    public setVolume(volume: number) {
        // Reduced multiplier: 50% slider now feels like old 10-15%
        // Old: 6.0x (too loud), New: 1.2x (subtle, comfortable)
        this.baseVolume = volume * 1.2;
        if (this.gainNode && this.audioContext) {
            this.gainNode.gain.setTargetAtTime(this.baseVolume, this.audioContext.currentTime, 0.05);
        }
    }

    public setProfile(profile: SoundProfile) {
        if (this.currentProfile !== profile) {
            this.currentProfile = profile;
            // Restart audio to apply playbackRate changes cleanly if needed
            if (this.isPlaying) {
                this.stop();
                this.start();
            }
        }
    }

    private stop() {
        if (this.noiseNode) {
            try { this.noiseNode.stop(); } catch (e) { }
            this.noiseNode.disconnect();
            this.noiseNode = null;
        }
        this.isPlaying = false;
    }

    private start() {
        if (!this.isPlaying && !this.isInitializing) {
            this.initAudio().catch(e => console.error("Audio init failed", e));
        }
    }

    public dispose() {
        this.stop();
        if (this.audioContext && this.audioContext.state !== 'closed') {
            try { this.audioContext.close(); } catch (e) { }
        }
        this.audioContext = null;
        this.isPlaying = false;
        this.isInitializing = false;
    }

    public startStroke() {
        this.start();
    }

    private async initAudio() {
        if (this.isInitializing) return;
        this.isInitializing = true;

        try {
            if (!this.audioContext) return;
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
                console.log("AudioContext resumed");
            }
            if (this.isPlaying) return;

            console.log("Initializing Noise Buffer...");
            // Buffer Generation - Pink Noise
            const bufferSize = this.audioContext.sampleRate * 2;
            const buffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
            const data = buffer.getChannelData(0);
            let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0;
            for (let i = 0; i < bufferSize; i++) {
                const white = Math.random() * 2 - 1;
                b0 = 0.99886 * b0 + white * 0.0555179;
                b1 = 0.99332 * b1 + white * 0.0750759;
                b2 = 0.96900 * b2 + white * 0.1538520;
                b3 = 0.86650 * b3 + white * 0.3104856;
                b4 = 0.55000 * b4 + white * 0.5329522;
                b5 = -0.7616 * b5 - white * 0.0168980;
                data[i] = b0 + b1 + b2 + b3 + b4 + b5 + white * 0.5362;
                data[i] *= 0.11;
            }

            this.noiseNode = this.audioContext.createBufferSource();
            this.noiseNode.buffer = buffer;
            this.noiseNode.loop = true;

            this.filterNode = this.audioContext.createBiquadFilter();
            this.envelopeNode = this.audioContext.createGain();
            this.gainNode = this.audioContext.createGain();

            // --- EXTREME PROFILES ---
            let rate = 1.0;
            let type: BiquadFilterType = 'bandpass';
            let freq = 1000;
            let Q = 1.0;
            let gain = 0; // for peaking/shelf

            switch (this.currentProfile) {
                case 'pencil':
                    // Classic Scratch - Softened
                    rate = 1.0;
                    type = 'lowpass'; // Bandpass was too harsh, Lowpass cuts shrill highs
                    freq = 600; // Lower center freq
                    Q = 0.5;
                    break;
                case 'charcoal':
                    // RUMBLE (Low Rate)
                    rate = 0.5; // Pitch down octave
                    type = 'lowpass'; freq = 400; Q = 0.5;
                    break;
                case 'ballpoint':
                    // SMOOTH CLICK v1.7.7 - Less harsh, more "rolling ball" feel
                    rate = 1.3;  // Slight pitch up (was 2.0 - too clicky)
                    type = 'bandpass'; freq = 800; Q = 0.8;  // Mid-range, not harsh highs
                    break;
                case 'fountain':
                    // SMOOTH INK FLOW v1.7.7 - Wet, flowing feel (NOT metallic)
                    rate = 0.9;  // Slightly lower pitch for smoothness
                    type = 'lowpass'; freq = 400; Q = 0.3;  // Cut harsh highs, keep warmth
                    // Old was peaking@5000Hz/Q=5/gain=20 - WAY too harsh!
                    break;
                case 'marker':
                    // SOFT (Muffled)
                    rate = 0.8;
                    type = 'lowpass'; freq = 200; Q = 0.1;
                    break;
                case 'highlighter':
                    // SQUEAK (Very high pitch, wet)
                    rate = 1.5;
                    type = 'bandpass'; freq = 1200; Q = 5.0; gain = 10;
                    break;
                case 'monoline':
                    // DIGITAL (Silence or very subtle plastic tap)
                    rate = 2.0;
                    type = 'lowpass'; freq = 100; Q = 0; // Almost silent
                    break;
                case 'calligraphy':
                    // BRUSH (Soft, breathy)
                    rate = 0.6;
                    type = 'lowpass'; freq = 300; Q = 0.2; // Deep swoosh
                    break;
            }

            this.noiseNode.playbackRate.value = rate;
            this.filterNode.type = type;
            this.filterNode.frequency.value = freq;
            this.filterNode.Q.value = Q;
            this.filterNode.gain.value = gain;

            // Chain
            this.noiseNode.connect(this.filterNode);
            this.filterNode.connect(this.envelopeNode);
            this.envelopeNode.connect(this.gainNode);

            // Spatial Audio: Panner Node
            // PannerNode is better than StereoPannerNode for future 3D expansion, but StereoPanner is simpler for now.
            // Let's use StereoPannerNode for pure Left/Right separation.
            if (this.audioContext.createStereoPanner) {
                this.pannerNode = this.audioContext.createStereoPanner();
                this.gainNode.connect(this.pannerNode);
                this.pannerNode.connect(this.audioContext.destination);
            } else {
                // Fallback for Safari/Legacy
                this.gainNode.connect(this.audioContext.destination);
            }

            this.gainNode.gain.value = this.baseVolume;
            this.envelopeNode.gain.value = 0;

            this.noiseNode.start(0);
            this.isPlaying = true;
        } finally {
            this.isInitializing = false;
        }
    }

    public updateStroke(velocity: number, _pressure: number) {
        if (!this.envelopeNode || !this.audioContext) return;
        // v1.7.7: Balanced volume factors - none should be harsh
        let factor = 1.0;
        if (this.currentProfile === 'marker') factor = 0.6;      // Soft
        if (this.currentProfile === 'ballpoint') factor = 0.8;   // Reduced (was 1.3 - too loud)
        if (this.currentProfile === 'fountain') factor = 0.7;    // Smooth and subtle
        if (this.currentProfile === 'highlighter') factor = 0.5; // Very soft squeak

        const targetVol = Math.min(1.0, Math.pow(velocity / 2.5, 1.1) * factor); // Softer curve
        this.envelopeNode.gain.setTargetAtTime(targetVol, this.audioContext.currentTime, 0.05);
    }

    public endStroke() {
        if (!this.envelopeNode || !this.audioContext) return;
        this.envelopeNode.gain.setTargetAtTime(0, this.audioContext.currentTime, 0.1);
    }
}
