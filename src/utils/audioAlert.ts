// Browser-native Web Audio API synthesizer for zero-dependency trading audio alerts
class TradingAudioEngine {
  private audioCtx: AudioContext | null = null;
  private isEnabled: boolean = true;

  constructor() {
    try {
      const stored = localStorage.getItem('intraday_audio_alerts_enabled');
      if (stored !== null) {
        this.isEnabled = stored === 'true';
      }
    } catch {
      this.isEnabled = true;
    }
  }

  public getEnabled(): boolean {
    return this.isEnabled;
  }

  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    try {
      localStorage.setItem('intraday_audio_alerts_enabled', String(enabled));
    } catch {
      // ignore
    }
  }

  private initContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return null;

    if (!this.audioCtx) {
      this.audioCtx = new AudioContextClass();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  // Double chime when price crosses trigger level
  public playTriggerBreakoutAlert(): void {
    if (!this.isEnabled) return;
    try {
      const ctx = this.initContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      // Tone 1: 880 Hz (A5)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(880, now);
      gain1.gain.setValueAtTime(0.15, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.18);

      // Tone 2: 1320 Hz (E6, harmonic 5th above)
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(1320, now + 0.12);
      gain2.gain.setValueAtTime(0.18, now + 0.12);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.12);
      osc2.stop(now + 0.35);
    } catch {
      // Audio playback fails safely if blocked by user autoplay policy
    }
  }

  // T1 Target Achieved victory chime
  public playTargetReachedAlert(): void {
    if (!this.isEnabled) return;
    try {
      const ctx = this.initContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      // 3 ascending tones (major chord: C6, E6, G6)
      const notes = [1046.5, 1318.5, 1567.98];
      notes.forEach((freq, idx) => {
        const t = now + idx * 0.1;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.14, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.22);
      });
    } catch {
      // safe fallback
    }
  }
}

export const tradingAudio = new TradingAudioEngine();
