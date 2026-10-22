import { WeaponCategory } from '../network/schemas';

export type ImpactSurfaceType =
  | 'wood'
  | 'stone'
  | 'metal'
  | 'terrain'
  | 'shield'
  | 'flesh';

/**
 * Procedural WebAudio Synthesizer for CI Craft 2.4
 * Generates zero-latency game sound effects for distinct weapon profiles, footsteps,
 * multi-stage reloads, surface impacts, shield breaks, loot, storm warnings, and UI
 * with distance attenuation, anti-stacking rate limiters, and mute/volume controls.
 */
export class SoundManager {
  private ctx: AudioContext | null = null;
  private readonly firearmNoise = new Map<WeaponCategory, AudioBuffer>();
  public enabled: boolean = true;
  public muted: boolean = false;
  public masterGainScale: number = 0.8;
  public sfxGainScale: number = 1.0;
  public masterVolume: number = 0.36;
  private lastPlayedAt: Map<string, number> = new Map();
  private activeNodeCount: number = 0;
  private readonly maxConcurrentNodes: number = 28;

  private ensureContext(): AudioContext | null {
    if (!this.enabled || this.muted || this.masterVolume <= 0.001) return null;
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /**
   * Prevents repeated sounds from stacking excessively within a short window
   * or exceeding the browser's safe concurrent WebAudio node budget.
   */
  private canPlay(key: string, minIntervalMs: number): boolean {
    if (this.activeNodeCount >= this.maxConcurrentNodes) return false;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const prev = this.lastPlayedAt.get(key) || 0;
    if (now - prev < minIntervalMs) return false;
    this.lastPlayedAt.set(key, now);
    return true;
  }

  private trackVoice(durationSec: number): void {
    this.activeNodeCount++;
    setTimeout(() => {
      this.activeNodeCount = Math.max(0, this.activeNodeCount - 1);
    }, Math.ceil(durationSec * 1000) + 20);
  }

  public resume(): void {
    this.ensureContext();
  }

  public setVolume(vol: number): void {
    this.masterGainScale = Math.max(0, Math.min(1, vol));
    this.masterVolume = this.masterGainScale * this.sfxGainScale * 0.45;
  }

  public getVolume(): number {
    return this.masterGainScale;
  }

  public setSfxVolume(sfxVol: number): void {
    this.sfxGainScale = Math.max(0, Math.min(1, sfxVol));
    this.masterVolume = this.masterGainScale * this.sfxGainScale * 0.45;
  }

  public getSfxVolume(): number {
    return this.sfxGainScale;
  }

  public setMuted(mute: boolean): void {
    this.muted = mute;
  }

  public toggleMute(): boolean {
    this.muted = !this.muted;
    return this.muted;
  }

  public playChestOpen(): void {
    if (!this.canPlay('chest_open', 140)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    // 1. Mechanical Latch Pop
    const latchOsc = ctx.createOscillator();
    const latchGain = ctx.createGain();
    latchOsc.type = 'triangle';
    latchOsc.frequency.setValueAtTime(180, now);
    latchOsc.frequency.exponentialRampToValueAtTime(420, now + 0.055);
    latchGain.gain.setValueAtTime(this.masterVolume * 0.42, now);
    latchGain.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
    latchOsc.connect(latchGain);
    latchGain.connect(ctx.destination);
    latchOsc.start(now);
    latchOsc.stop(now + 0.07);

    // 2. Shimmering Golden Treasure Arpeggio
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const t = now + 0.04 + i * 0.058;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(this.masterVolume * 0.38, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.23);
    });
    this.trackVoice(0.5);
  }

  public playVictory(): void {
    this.playVictoryFanfare();
  }

  public playUIClick(): void {
    if (!this.canPlay('ui_click', 35)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(740, now);
    osc.frequency.exponentialRampToValueAtTime(1140, now + 0.045);
    gain.gain.setValueAtTime(this.masterVolume * 0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.055);
    this.trackVoice(0.06);
  }

  public playFootstep(
    isSprinting: boolean = false,
    distanceFactor: number = 1.0,
    surface: 'ground' | 'hard' | 'wood' | 'metal' = 'ground'
  ): void {
    if (distanceFactor <= 0.03) return;
    if (!this.canPlay('footstep', isSprinting ? 95 : 140)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const vol =
      Math.max(0.02, Math.min(1, distanceFactor)) *
      this.masterVolume *
      (isSprinting ? 0.17 : 0.11);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const pitch = surface === 'metal' ? 210 : surface === 'hard' ? 155 : surface === 'wood' ? 115 : 92;
    osc.type = surface === 'hard' ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(pitch * (isSprinting ? 1.25 : 1), now);
    osc.frequency.exponentialRampToValueAtTime(36, now + 0.058);
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.062);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    osc.stop(now + 0.068);
    this.trackVoice(0.07);
  }

  public playDamageTaken(shield = false): void {
    if (!this.canPlay('damage_taken', 75)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = shield ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(shield ? 740 : 155, now);
    osc.frequency.exponentialRampToValueAtTime(shield ? 310 : 52, now + 0.13);
    gain.gain.setValueAtTime(this.masterVolume * 0.36, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.15);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    this.trackVoice(0.15);
  }

  public playShieldBreak(distanceFactor: number = 1.0): void {
    if (distanceFactor <= 0.03 || !this.canPlay('shield_break', 120)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const vol = Math.max(0.04, Math.min(1, distanceFactor)) * this.masterVolume;

    [1680, 1240, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      const t = now + i * 0.035;
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.45, t + 0.09);
      gain.gain.setValueAtTime(vol * 0.32, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.095);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.1);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    });
    this.trackVoice(0.2);
  }

  public playSurfaceImpact(
    surface: ImpactSurfaceType,
    distanceFactor: number = 1.0
  ): void {
    if (distanceFactor <= 0.04 || !this.canPlay(`impact_${surface}`, 45)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const vol = Math.max(0.02, Math.min(1, distanceFactor)) * this.masterVolume * 0.26;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    if (surface === 'metal') {
      osc.type = 'square';
      osc.frequency.setValueAtTime(1320, now);
      osc.frequency.exponentialRampToValueAtTime(420, now + 0.065);
    } else if (surface === 'stone') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(140, now + 0.055);
    } else if (surface === 'wood') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(340, now);
      osc.frequency.exponentialRampToValueAtTime(110, now + 0.06);
    } else if (surface === 'shield') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(1100, now);
      osc.frequency.exponentialRampToValueAtTime(620, now + 0.07);
    } else {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(210, now);
      osc.frequency.exponentialRampToValueAtTime(65, now + 0.05);
    }
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.075);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    this.trackVoice(0.08);
  }

  public playWeaponFire(category: WeaponCategory, distanceFactor: number = 1.0): void {
    if (distanceFactor <= 0.02) return;
    const minGap =
      category === 'smg'
        ? 38
        : category === 'burst_rifle'
          ? 34
          : category === 'assault_rifle'
            ? 55
            : category === 'tactical_shotgun'
              ? 85
              : category === 'dmr'
                ? 95
                : category === 'heavy_pistol'
                  ? 105
                  : 70;
    if (!this.canPlay(`fire_${category}`, minGap)) return;

    const ctx = this.ensureContext();
    if (!ctx) return;

    const vol = Math.max(0.03, Math.min(1, distanceFactor)) * this.masterVolume;
    const now = ctx.currentTime;

    if (category === 'harvester') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(310, now);
      osc.frequency.exponentialRampToValueAtTime(82, now + 0.14);
      gain.gain.setValueAtTime(vol * 0.45, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.16);
      this.trackVoice(0.16);
      return;
    }

    const duration =
      category === 'shotgun'
        ? 0.26
        : category === 'tactical_shotgun'
          ? 0.21
          : category === 'sniper'
            ? 0.38
            : category === 'dmr'
              ? 0.24
              : category === 'heavy_pistol'
                ? 0.2
                : category === 'burst_rifle'
                  ? 0.095
                  : category === 'smg'
                    ? 0.075
                    : category === 'pistol'
                      ? 0.105
                      : 0.135;

    // One small immutable noise buffer per firearm, not a new typed array
    // and exponential loop on every automatic shot. Sources remain per voice.
    let noiseBuffer = this.firearmNoise.get(category);
    if (!noiseBuffer) {
      const bufferSize = Math.floor(ctx.sampleRate * duration);
      noiseBuffer = ctx.createBuffer(1,bufferSize,ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i=0;i<bufferSize;i++) data[i]=(Math.random()*2-1)*Math.exp(-i/(bufferSize*.34));
      if (this.firearmNoise.size >= 9) this.firearmNoise.clear();
      this.firearmNoise.set(category,noiseBuffer);
    }

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(
      category === 'shotgun'
        ? 580
        : category === 'tactical_shotgun'
          ? 760
          : category === 'sniper'
            ? 1350
            : category === 'dmr'
              ? 1180
              : category === 'burst_rifle'
                ? 1650
                : category === 'heavy_pistol'
                  ? 920
                  : category === 'smg'
                    ? 1950
                    : category === 'pistol'
                      ? 1520
                      : 1080,
      now
    );

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(vol * 0.85, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noise.onended = () => { noise.disconnect(); filter.disconnect(); noiseGain.disconnect(); };
    noise.start(now);

    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type =
      category === 'sniper' || category === 'dmr'
        ? 'sawtooth'
        : category === 'shotgun' || category === 'tactical_shotgun' || category === 'heavy_pistol'
          ? 'square'
          : 'triangle';
    const startFreq =
      category === 'shotgun'
        ? 138
        : category === 'tactical_shotgun'
          ? 168
          : category === 'heavy_pistol'
            ? 185
            : category === 'sniper'
              ? 295
              : category === 'dmr'
                ? 255
                : category === 'burst_rifle'
                  ? 310
                  : category === 'smg'
                    ? 340
                    : category === 'pistol'
                      ? 285
                      : 215;
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(38, now + duration * 0.85);

    oscGain.gain.setValueAtTime(vol * 0.68, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + duration * 0.85);

    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration);
    osc.onended = () => { osc.disconnect(); oscGain.disconnect(); };
    this.trackVoice(duration);
  }

  public playHitmarker(
    isHeadshot: boolean = false,
    isShield: boolean = false,
    isElimination: boolean = false
  ): void {
    if (!this.canPlay('hitmarker', 28)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = isHeadshot ? 'sine' : 'triangle';

    if (isHeadshot || isElimination) {
      // Crisp dual-tone critical confirmation chime
      osc.frequency.setValueAtTime(1520, now);
      osc.frequency.setValueAtTime(2180, now + 0.038);
      gain.gain.setValueAtTime(this.masterVolume * 0.76, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.145);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.15);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };

      const subOsc = ctx.createOscillator();
      const subGain = ctx.createGain();
      subOsc.type = 'triangle';
      subOsc.frequency.setValueAtTime(340, now);
      subOsc.frequency.exponentialRampToValueAtTime(110, now + 0.075);
      subGain.gain.setValueAtTime(this.masterVolume * 0.45, now);
      subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      subOsc.connect(subGain);
      subGain.connect(ctx.destination);
      subOsc.start(now);
      subOsc.stop(now + 0.085);
      subOsc.onended = () => { subOsc.disconnect(); subGain.disconnect(); };
      this.trackVoice(0.16);
    } else {
      osc.frequency.setValueAtTime(isShield ? 1120 : 840, now);
      osc.frequency.exponentialRampToValueAtTime(isShield ? 520 : 310, now + 0.062);
      gain.gain.setValueAtTime(this.masterVolume * 0.56, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.068);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.072);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
      this.trackVoice(0.075);
    }
  }

  public playReload(category?: WeaponCategory): void {
    if (!this.canPlay('reload', 180)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const freqs =
      category === 'shotgun' || category === 'tactical_shotgun'
        ? [340, 480, 620]
        : category === 'sniper' || category === 'dmr'
          ? [310, 520, 740]
          : category === 'heavy_pistol'
            ? [280, 390, 560]
            : category === 'burst_rifle'
              ? [460, 680, 540]
              : category === 'smg' ? [560, 820, 690]
              : category === 'pistol' ? [490, 720, 610]
              : [420, 620, 510];

    freqs.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      const t = now + idx * 0.11;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(this.masterVolume * 0.16, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.055);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.06);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    });
    this.trackVoice(0.32);
  }

  public playReloadComplete(): void {
    if (!this.canPlay('reload_complete', 120)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    [580, 920].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      const t = now + idx * 0.045;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(this.masterVolume * 0.34, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.065);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.07);
    });
    this.trackVoice(0.14);
  }

  public playWeaponSwitch(): void {
    if (!this.canPlay('weapon_switch', 60)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(360, now);
    osc.frequency.exponentialRampToValueAtTime(590, now + 0.045);
    gain.gain.setValueAtTime(this.masterVolume * 0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.055);
    this.trackVoice(0.06);
  }

  /** Original, brief endgame ambience; never a loop or a fabricated countdown. */
  public playFinalZoneCue(): void {
    if (!this.canPlay('final_zone',1500)) return;
    const ctx = this.ensureContext(); if (!ctx) return;
    const now = ctx.currentTime;
    for (const frequency of [146.83,220]) {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.setValueAtTime(frequency,now);
      gain.gain.setValueAtTime(.001,now);
      gain.gain.linearRampToValueAtTime(this.masterVolume*.09,now+.08);
      gain.gain.exponentialRampToValueAtTime(.001,now+.6);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
      osc.start(now); osc.stop(now+.62);
    }
    this.trackVoice(.65);
  }

  public playStormWarning(): void {
    if (!this.canPlay('storm_warn', 1500)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(195, now);
    osc.frequency.linearRampToValueAtTime(135, now + 0.32);
    gain.gain.setValueAtTime(this.masterVolume * 0.24, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    this.trackVoice(0.36);
  }

  public playPickup(isChest: boolean = false, isHighRarity: boolean = false): void {
    if (!this.canPlay('pickup', 65)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const notes = isChest
      ? [523.25, 659.25, 783.99, 1046.5]
      : isHighRarity
      ? [659.25, 987.77, 1318.51]
      : [587.33, 880];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const t = now + i * 0.058;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(this.masterVolume * 0.38, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.17);
    });
    this.trackVoice(0.35);
  }

  public playBuild(): void {
    if (!this.canPlay('build', 60)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(540, now + 0.09);
    gain.gain.setValueAtTime(this.masterVolume * 0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.11);
    this.trackVoice(0.11);
  }

  public playJump(): void {
    if (!this.canPlay('jump', 120)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(170, now);
    osc.frequency.exponentialRampToValueAtTime(340, now + 0.11);
    gain.gain.setValueAtTime(this.masterVolume * 0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.13);
    this.trackVoice(0.13);
  }

  public playLand(): void {
    if (!this.canPlay('land', 120)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(115, now);
    osc.frequency.exponentialRampToValueAtTime(45, now + 0.09);
    gain.gain.setValueAtTime(this.masterVolume * 0.28, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.095);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.1);
    this.trackVoice(0.1);
  }

  public playCountdownBeep(isFinal: boolean = false): void {
    if (!this.canPlay('countdown', 200)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(isFinal ? 880 : 440, now);
    gain.gain.setValueAtTime(this.masterVolume * 0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + (isFinal ? 0.26 : 0.12));
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + (isFinal ? 0.28 : 0.14));
    this.trackVoice(0.28);
  }

  public playHeal(): void {
    if (!this.canPlay('heal', 150)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    [440, 554.37, 659.25, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const t = now + i * 0.07;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(this.masterVolume * 0.34, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    });
    this.trackVoice(0.4);
  }

  public playElimination(): void {
    if (!this.canPlay('elim', 120)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    [587.33, 880, 1174.66].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      const t = now + i * 0.08;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(this.masterVolume * 0.5, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.25);
    });
    this.trackVoice(0.45);
  }

  public playVictoryFanfare(): void {
    if (!this.canPlay('victory', 500)) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      const t = now + i * 0.11;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(this.masterVolume * 0.55, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.36);
    });
    this.trackVoice(0.8);
  }
}
