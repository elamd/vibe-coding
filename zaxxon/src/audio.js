/**
 * Procedural Web Audio API Sound Synthesizer for ZAXXON: DESERT HOG
 * Synthesizes the iconic A-10 GAU-8/A 30mm rotary chaingun "BRRRRRRT",
 * twin TF34 turbofan engine whine, concrete wall fracturing, and deep explosions.
 */
export class SoundEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.paused = false;
    this.masterGain = null;
    this.noiseBuffer = null;

    // Continuous GAU-8 Chaingun nodes
    this.isFiringBrrrt = false;
    this.brrrtOsc1 = null;
    this.brrrtOsc2 = null;
    this.brrrtNoise = null;
    this.brrrtGain = null;

    // Engine hum nodes
    this.engineOsc = null;
    this.engineGain = null;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !this.paused) this.ctx.resume();
      return;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    this.ctx = new AudioCtx();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.42;
    this.masterGain.connect(this.ctx.destination);

    // Pre-generate 2 seconds of white/pink noise for explosions & cannon roar
    const sampleRate = this.ctx.sampleRate;
    this.noiseBuffer = this.ctx.createBuffer(1, sampleRate * 2, sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    this._initEngineHum();
  }

  setPaused(isPaused) {
    this.paused = isPaused;
    if (isPaused) {
      this.stopBrrrt();
      if (this.ctx && this.ctx.state === 'running') {
        this.ctx.suspend();
      }
    } else {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
    }
  }

  toggleMute() {
    this.enabled = !this.enabled;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.enabled ? 0.42 : 0.0, this.ctx.currentTime, 0.05);
    }
    return this.enabled;
  }

  _initEngineHum() {
    if (!this.ctx) return;
    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 110;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 340;
    filter.Q.value = 2.5;

    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0.045;

    this.engineOsc.connect(filter);
    filter.connect(this.engineGain);
    this.engineGain.connect(this.masterGain);
    this.engineOsc.start();
  }

  updateEnginePitch(altitudeNorm, isFiring) {
    if (!this.ctx || !this.engineOsc || this.paused) return;
    const targetFreq = 95 + altitudeNorm * 55 + (isFiring ? 15 : 0);
    this.engineOsc.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 0.08);
  }

  /**
   * Starts the iconic 65 Hz / 3900 RPM GAU-8/A Avenger "BRRRRRRT" rotary cannon sound
   */
  startBrrrt() {
    if (!this.enabled || this.paused) return;
    this.init();
    if (!this.ctx || this.isFiringBrrrt) return;
    this.isFiringBrrrt = true;

    const now = this.ctx.currentTime;
    this.brrrtGain = this.ctx.createGain();
    this.brrrtGain.gain.setValueAtTime(0.01, now);
    this.brrrtGain.gain.exponentialRampToValueAtTime(0.38, now + 0.03);

    this.brrrtOsc1 = this.ctx.createOscillator();
    this.brrrtOsc1.type = 'sawtooth';
    this.brrrtOsc1.frequency.setValueAtTime(65, now);

    this.brrrtOsc2 = this.ctx.createOscillator();
    this.brrrtOsc2.type = 'square';
    this.brrrtOsc2.frequency.setValueAtTime(130, now);

    this.brrrtNoise = this.ctx.createBufferSource();
    this.brrrtNoise.buffer = this.noiseBuffer;
    this.brrrtNoise.loop = true;

    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 950;
    noiseFilter.Q.value = 1.2;

    const waveshaper = this.ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i * 2) / 256 - 1;
      curve[i] = Math.tanh(x * 3.5);
    }
    waveshaper.curve = curve;

    const oscMix = this.ctx.createGain();
    oscMix.gain.value = 0.65;
    const noiseMix = this.ctx.createGain();
    noiseMix.gain.value = 0.55;

    this.brrrtOsc1.connect(oscMix);
    this.brrrtOsc2.connect(oscMix);
    this.brrrtNoise.connect(noiseFilter);
    noiseFilter.connect(noiseMix);

    oscMix.connect(waveshaper);
    noiseMix.connect(waveshaper);
    waveshaper.connect(this.brrrtGain);
    this.brrrtGain.connect(this.masterGain);

    this.brrrtOsc1.start(now);
    this.brrrtOsc2.start(now);
    this.brrrtNoise.start(now);
  }

  /**
   * Stops the GAU-8/A cannon and plays the characteristic mechanical barrel spool-down whine
   */
  stopBrrrt() {
    if (!this.isFiringBrrrt || !this.ctx) return;
    this.isFiringBrrrt = false;
    const now = this.ctx.currentTime;

    try {
      if (this.brrrtGain) {
        this.brrrtGain.gain.cancelScheduledValues(now);
        this.brrrtGain.gain.setValueAtTime(this.brrrtGain.gain.value, now);
        this.brrrtGain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
      }
      if (this.brrrtOsc1) this.brrrtOsc1.stop(now + 0.1);
      if (this.brrrtOsc2) this.brrrtOsc2.stop(now + 0.1);
      if (this.brrrtNoise) this.brrrtNoise.stop(now + 0.1);

      if (!this.paused) {
        const tailOsc = this.ctx.createOscillator();
        const tailGain = this.ctx.createGain();
        tailOsc.type = 'triangle';
        tailOsc.frequency.setValueAtTime(420, now);
        tailOsc.frequency.exponentialRampToValueAtTime(110, now + 0.18);
        tailGain.gain.setValueAtTime(0.08, now);
        tailGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        tailOsc.connect(tailGain);
        tailGain.connect(this.masterGain);
        tailOsc.start(now);
        tailOsc.stop(now + 0.19);
      }
    } catch (_) {
      // Ignore cleanup race
    }
  }

  playWallFracture(heavy = false) {
    if (!this.enabled || !this.ctx || this.paused) return;
    const now = this.ctx.currentTime;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(heavy ? 420 : 1150, now);
    filter.frequency.exponentialRampToValueAtTime(160, now + (heavy ? 0.35 : 0.14));
    filter.Q.value = 1.8;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(heavy ? 0.36 : 0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + (heavy ? 0.36 : 0.15));

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    src.start(now, Math.random() * 1.2, heavy ? 0.38 : 0.16);
  }

  playExplosion(scale = 1.0) {
    if (!this.enabled || !this.ctx || this.paused) return;
    const now = this.ctx.currentTime;
    const dur = Math.min(1.4, 0.55 + scale * 0.35);

    const subOsc = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(115, now);
    subOsc.frequency.exponentialRampToValueAtTime(24, now + dur * 0.8);
    subGain.gain.setValueAtTime(Math.min(0.65, 0.35 * scale), now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + dur * 0.85);
    subOsc.connect(subGain);
    subGain.connect(this.masterGain);
    subOsc.start(now);
    subOsc.stop(now + dur * 0.86);

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1400, now);
    filter.frequency.exponentialRampToValueAtTime(140, now + dur);

    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(Math.min(0.6, 0.32 * scale), now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    noise.connect(filter);
    filter.connect(nGain);
    nGain.connect(this.masterGain);
    noise.start(now, Math.random() * 0.5, dur);
  }

  playFuelReplenish() {
    if (!this.enabled || !this.ctx || this.paused) return;
    const now = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, idx) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.055);
      gain.gain.setValueAtTime(0.14, now + idx * 0.055);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.055 + 0.15);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now + idx * 0.055);
      osc.stop(now + idx * 0.055 + 0.16);
    });
  }

  playAlertBeep() {
    if (!this.enabled || !this.ctx || this.paused) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(660, now + 0.07);
    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.16);
  }
}
