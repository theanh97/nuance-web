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
        this.baseVolume = volume * 6.0; // Extreme boost
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
                    // CLICK (High Rate)
                    rate = 2.0; // Pitch up octave
                    type = 'highpass'; freq = 2000; Q = 2.0;
                    break;
                case 'fountain':
                    // METAL (Very High Res)
                    rate = 1.2;
                    type = 'peaking'; freq = 5000; Q = 5.0; gain = 20;
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
        // Make Marker quieter, Ballpoint louder
        let factor = 1.0;
        if (this.currentProfile === 'marker') factor = 0.6;
        if (this.currentProfile === 'ballpoint') factor = 1.3;

        const targetVol = Math.min(1.2, Math.pow(velocity / 2.0, 1.2) * factor);
        this.envelopeNode.gain.setTargetAtTime(targetVol, this.audioContext.currentTime, 0.05);
    }

    public endStroke() {
        if (!this.envelopeNode || !this.audioContext) return;
        this.envelopeNode.gain.setTargetAtTime(0, this.audioContext.currentTime, 0.1);
    }
}
