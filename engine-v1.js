/*
 * Замороженная первая версия ядра (v1) — для A/B-сравнения с текущей моделью.
 * Не развивается. Модель: импульсы выпуска + шумовые всплески стука в 3 резонатора
 * камеры и 4 моды блока, неравномерность вращения задана косинусом.
 * Возвращает класс ядра; процессор ворклета живёт в engine.js и умеет переключаться.
 */
function DIESEL_WORKLET_SOURCE_V1() {
  'use strict';

  const TAU = Math.PI * 2;
  const C_GAS = 1000;
  const C_EXH = 550;
  const PIPE_LEN = 32768;
  const PIPE_MASK = PIPE_LEN - 1;
  const MAX_CYL = 24;

  const G_EX = 0.55, G_THUMP = 0.35, G_CHAMBER = 0.05, G_BLOCK = 0.09,
    G_TICK = 0.05, G_INTAKE = 0.25, G_START = 0.22, G_TURBO = 0.16;

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

  function crossed(prev, deg, th, wrapped) {
    return wrapped ? (th > prev || th <= deg) : (prev < th && th <= deg);
  }

  class Rng {
    constructor(seed) { this.s = (seed | 0) || 0x2545f491; }
    next() {
      let x = this.s;
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      this.s = x;
      return (x >>> 0) / 2147483648 - 1;
    }
  }

  class Reson {
    constructor() { this.y1 = 0; this.y2 = 0; this.a1 = 0; this.a2 = 0; this.g = 0; }
    set(f, q, sr) {
      if (!(f > 0) || f >= sr * 0.45) { this.g = 0; this.a1 = 0; this.a2 = 0; return; }
      const w = TAU * f / sr, r = Math.exp(-Math.PI * f / (q * sr));
      this.a1 = 2 * r * Math.cos(w); this.a2 = -r * r; this.g = Math.sin(w);
    }
    tick(x) {
      const y = x * this.g + this.a1 * this.y1 + this.a2 * this.y2;
      this.y2 = this.y1; this.y1 = y;
      return y;
    }
  }

  class Biquad {
    constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
    _set(b0, b1, b2, a0, a1, a2) { this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; }
    lowpass(f, q, sr) {
      const w = TAU * Math.min(f, sr * 0.45) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
      this._set((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al);
    }
    highpass(f, q, sr) {
      const w = TAU * Math.min(f, sr * 0.45) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
      this._set((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al);
    }
    tick(x) {
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      return y;
    }
  }

  class OnePole {
    constructor() { this.y = 0; this.a = 1; }
    set(f, sr) { this.a = 1 - Math.exp(-TAU * Math.min(f, sr * 0.45) / sr); }
    tick(x) { return (this.y += this.a * (x - this.y)); }
  }

  class DieselCoreV1 {
    constructor(sr) {
      this.sr = sr;
      this.rng = new Rng(0x1234567);
      this.cfg = null;
      this.throttle = 0; this.load = 0; this.pedal = -1;
      this.fuelOn = false; this.starter = false; this.crankTime = 0;
      this.n = 0; this.fuel = 0; this.boost = 0; this.warm = 1; this.fl = 0;
      this.phi = 0; this.firing = false; this.stopped = true;
      this.knockEnv = 0; this.mechEnv = 0; this.tickEnv = 0; this.starterEnv = 0;
      this.turboPh = 0; this.motorPh = 0; this.fmNoise = 0; this.exPrev = 0;
      this.cylDeg = new Float64Array(MAX_CYL);
      this.cylAmp = new Float32Array(MAX_CYL);
      this.cylP = new Float32Array(MAX_CYL);
      this.cylThump = new Float32Array(MAX_CYL);
      this.cylVar = new Float32Array(MAX_CYL);
      this.fireAt = new Float64Array(MAX_CYL);
      this.chamber = [new Reson(), new Reson(), new Reson()];
      this.block = [new Reson(), new Reson(), new Reson(), new Reson()];
      this.tickR = [new Reson(), new Reson()];
      this.thumpHP = new Biquad(); this.thumpLP = new Biquad();
      this.exDC = new OnePole(); this.turbLP = new OnePole();
      this.pipeBuf = new Float32Array(PIPE_LEN); this.pipeIdx = 0; this.pipeD = 1; this.pipeG = -0.5;
      this.pipeLP = new OnePole();
      this.muffler = new Biquad(); this.muffler2 = new OnePole();
      this.hissLP = new OnePole(); this.hissHP = new OnePole();
      this.intakeLP = new OnePole(); this.airLP = new OnePole(); this.airHP = new OnePole();
    }

    setConfig(cfg, reset, cold) {
      const sr = this.sr;
      const prevRpm = this.cfg ? this.n * this.cfg.max : 0;
      const c = Object.assign({}, cfg);
      c.N = clamp(Math.round(c.cyl), 1, MAX_CYL);
      c.four = c.stroke !== 2;
      c.cycleDeg = c.four ? 720 : 360;
      c.B = clamp(c.bore, 20, 1200) / 1000;
      c.max = Math.max(20, c.max);
      c.idle = clamp(c.idle, c.max * 0.05, c.max * 0.85);
      c.crank = clamp(c.crank, c.idle * 0.15, c.idle * 0.8);
      c.nIdle = c.idle / c.max;
      c.nCrank = c.crank / c.max;
      c.nFire = c.nCrank * 0.6;
      c.starterT = (0.04 + 0.2 * c.nCrank + 0.15 * c.nCrank * c.nCrank) / 0.15;
      c.exOpen = c.four ? 130 : 95;
      c.exDur = c.four ? 240 : 150;
      c.ivc = c.four ? 570 : -1;
      c.degPerSampleMax = c.max / 60 * 360 / sr;
      c.inertia = Math.max(0.05, c.inertia);
      c.turboLag = Math.max(0.05, c.turboLag || 1);
      c.turbo = clamp(c.turbo || 0, 0, 1);
      c.turboHz = c.turboHz || 4000;

      const r = new Rng(7919 * c.N + 13);
      for (let i = 0; i < c.N; i++) {
        this.cylVar[i] = (0.04 + c.uneven * 1.5) * r.next();
        let f = (i + c.uneven * 0.6 * r.next()) / c.N;
        f -= Math.floor(f);
        this.fireAt[i] = f;
      }

      const f0 = C_GAS / (Math.PI * c.B);
      c.chamberHz = f0 * 1.841;
      [1.841, 3.054, 3.832].forEach((k, j) => this.chamber[j].set(f0 * k, 22, sr));
      const bs = Math.sqrt(0.1 / c.B), bq = c.B > 0.2 ? 18 : 9;
      [820, 1450, 2350, 3600].forEach((f, j) => this.block[j].set(f * bs, bq, sr));
      const tf = 6500 * Math.pow(0.1 / c.B, 0.35);
      this.tickR[0].set(tf, 30, sr); this.tickR[1].set(tf * 1.53, 25, sr);
      this.knockDecay = Math.exp(-1 / (0.00025 * Math.pow(c.B / 0.08, 0.6) * sr));
      this.mechDecay = Math.exp(-1 / (0.0004 * Math.pow(c.B / 0.08, 0.5) * sr));
      this.tickDecay = Math.exp(-1 / (0.00012 * sr));
      this.thumpHP.highpass(25, 0.7, sr);
      this.thumpLP.lowpass(clamp(350 * bs, 100, 450), 0.7, sr);
      this.exDC.set(12, sr); this.turbLP.set(2500, sr);
      this.pipeD = clamp(Math.round(2 * c.pipe / C_EXH * sr), 8, PIPE_LEN - 2);
      this.pipeG = c.pipe > 10 ? -0.35 : -0.55;
      this.pipeLP.set(c.pipe > 10 ? 700 : 2200, sr);
      this.muffler.lowpass(c.muffler, 0.8, sr); this.muffler2.set(c.muffler * 1.5, sr);
      this.hissLP.set(c.turboHz * 0.7, sr); this.hissHP.set(900, sr);
      this.intakeLP.set(600, sr);
      this.airLP.set(3500, sr); this.airHP.set(1200, sr);
      this.cfg = c;

      if (reset) {
        this.n = 0; this.fuel = 0; this.boost = 0; this.fl = 0; this.phi = 0;
        this.fuelOn = false; this.starter = false; this.firing = false; this.stopped = true;
        this.warm = cold ? 0 : 1;
        this.cylAmp.fill(0); this.cylThump.fill(0); this.cylP.fill(0); this.pipeBuf.fill(0);
      } else {
        this.n = clamp(prevRpm / c.max, 0, 1.2);
      }
      for (let i = 0; i < c.N; i++) {
        let d = this.phi - this.fireAt[i]; if (d < 0) d += 1;
        this.cylDeg[i] = d * c.cycleDeg;
      }
    }

    start() {
      if (!this.cfg) return;
      if (this.fuelOn && this.n > this.cfg.nIdle * 0.6) return;
      this.fuelOn = true; this.starter = true; this.crankTime = 0; this.stopped = false;
      this.mechEnv = Math.max(this.mechEnv, 1.6);
    }

    stop() { this.fuelOn = false; this.starter = false; }

    dynamics(dt) {
      const c = this.cfg;
      let n = this.n;
      if (this.starter) {
        this.crankTime += dt;
        if ((this.firing && n > c.nCrank * 1.6) || this.crankTime > 12) {
          this.starter = false;
          this.mechEnv = Math.max(this.mechEnv, 0.9);
        }
      }
      const loss = (n > 1e-4 ? 0.04 : 0) + 0.2 * n + 0.15 * n * n;
      const loadT = this.load * (0.85 * n * n + 0.1 * n);
      const canFire = this.fuelOn && n > c.nFire && !(this.starter && this.crankTime < c.startDelay);
      this.firing = canFire;

      let fuel = 0;
      if (canFire) {
        const fmax = 1 - c.turbo * 0.5 * (1 - this.boost);
        const nIdle = c.nIdle * (1 + 0.15 * (1 - this.warm));
        const ff = (loss + loadT) / 1.4;
        const th = this.pedal >= 0 ? this.pedal : this.throttle;
        if (c.gov === 'pedal') {
          fuel = Math.max(ff + 8 * (nIdle - n), th * th * fmax);
          if (n > 1) fuel = Math.min(fuel, ff + 8 * (1 - n));
        } else {
          fuel = ff + 8 * (nIdle + th * (1 - nIdle) - n);
        }
        fuel = clamp(fuel, 0, fmax);
      }
      this.fuel += (fuel - this.fuel) * Math.min(1, dt / 0.025);

      let torque = 1.4 * this.fuel - loss - loadT;
      if (this.starter) torque += c.starterT * Math.max(0, 1 - n / c.nCrank);
      // как в v2: без топлива тяжёлые моторы не выбегают минутами (иначе A/B на СТОП нечестный)
      const J = this.fuelOn ? c.inertia : Math.min(c.inertia, 2.5);
      n += torque / J * dt;
      if (n <= 0.002 && !this.starter && torque < 0) {
        if (!this.stopped) this.mechEnv = Math.max(this.mechEnv, 0.7);
        n = 0; this.stopped = true;
      }
      this.n = clamp(n, 0, 1.3);

      const bt = Math.min(1, this.fuel * (0.25 + 0.75 * this.n) * 1.3 + 0.06 * this.n);
      this.boost += (bt - this.boost) * Math.min(1, dt / (bt > this.boost ? c.turboLag : c.turboLag * 1.8));
      if (this.firing) this.warm = Math.min(1, this.warm + dt / c.warmTau);

      const flT = this.firing && this.n > c.nIdle * 0.7 ? 0.012 * Math.min(1, 4 / c.N) : 0.22 * Math.min(1, 6 / c.N);
      this.fl += (flT - this.fl) * Math.min(1, dt / 0.3);
      this.starterEnv += ((this.starter ? 1 : 0) - this.starterEnv) * Math.min(1, dt / 0.02);
    }

    latch(i) {
      const c = this.cfg;
      let a = 0;
      if (this.firing) {
        const missP = this.n < c.nIdle * 0.85 ? 0.25 * (1 - this.warm) + (this.starter ? 0.05 : 0) : 0;
        if (this.rng.next() * 0.5 + 0.5 >= missP) {
          a = Math.max(0.02, this.fuel) * (1 + this.cylVar[i] + 0.1 * this.rng.next());
        }
      }
      this.cylAmp[i] = a;
      this.cylThump[i] = Math.pow(a, 0.6);
      this.cylP[i] = (0.25 + 0.75 * Math.sqrt(a)) * (0.6 + 0.4 * Math.min(1, this.n / c.nIdle));
    }

    render(ex, bl, tu, len) {
      const c = this.cfg, sr = this.sr, N = c.N, cyc = c.cycleDeg, rng = this.rng;
      this.dynamics(len / sr);

      const n = this.n, fuel = this.fuel, nn = Math.min(n, 1);
      const cycPerSec = c.max / 60 / (c.four ? 2 : 1);
      const knockAmt = c.knock * (0.6 + 0.4 * fuel) * (0.9 + 0.3 * nn) * (1 + 0.8 * (1 - this.warm));
      const radNorm = 1 / (c.degPerSampleMax * Math.sqrt(Math.max(nn, 0.04)));
      const injAmt = c.mech * 0.45;
      const valveAmt = c.mech * 0.35 * (0.4 + 0.6 * nn);
      const ignDeg = 3 + 6 * (1 - this.warm) + 3 * (1 - fuel);
      const tS = c.turbo > 0 ? Math.min(1, 0.12 * Math.min(1, n / c.nIdle) + 0.88 * this.boost) : 0;
      const tHz = c.turboHz * (0.3 + 0.7 * tS);
      const tAmpW = c.turbo * tS * tS * Math.sqrt(tS) * 0.5;
      const tAmpH = c.turbo * tS * tS * 0.6;
      const intakeAmt = (c.turbo > 0 ? 0.3 : 1) * nn * (0.2 + fuel) * G_INTAKE;
      const exAtt = 1 - 0.45 * c.turbo * this.boost;
      const stEnv = this.starterEnv, air = c.starter === 'air';
      const kd = this.knockDecay, md = this.mechDecay, td = this.tickDecay;
      const fl = this.fl;
      let knockEnv = this.knockEnv, mechEnv = this.mechEnv, tickEnv = this.tickEnv;
      let phi = this.phi;

      for (let s = 0; s < len; s++) {
        const cosN = Math.cos(TAU * N * phi);
        const nInst = n * (1 - fl * cosN);
        phi += nInst * cycPerSec / sr;
        if (phi >= 1) phi -= 1;

        let exFlow = 0, thump = 0;
        for (let i = 0; i < N; i++) {
          let d = phi - this.fireAt[i]; if (d < 0) d += 1;
          const deg = d * cyc, prev = this.cylDeg[i];
          if (deg !== prev) {
            this.cylDeg[i] = deg;
            const wrapped = deg < prev;
            if (wrapped) this.latch(i);
            if (this.firing && crossed(prev, deg, cyc - 14, wrapped)) {
              tickEnv = Math.max(tickEnv, injAmt * (0.8 + 0.2 * rng.next()));
            }
            if (this.cylAmp[i] > 0 && crossed(prev, deg, ignDeg, wrapped)) {
              knockEnv = Math.max(knockEnv, knockAmt * (1 + 2 * this.cylVar[i]) * (0.85 + 0.25 * rng.next()));
            }
            if (crossed(prev, deg, c.exOpen + c.exDur, wrapped) || (c.ivc > 0 && crossed(prev, deg, c.ivc, wrapped))) {
              mechEnv = Math.max(mechEnv, valveAmt * (0.75 + 0.25 * rng.next()));
            }
          }
          const x = (deg - c.exOpen) / c.exDur;
          if (x > 0 && x < 1) exFlow += this.cylP[i] * (1 - Math.exp(-30 * x)) * Math.exp(-4 * x) * (1 - x);
          const dw = deg > cyc * 0.5 ? deg - cyc : deg;
          if (dw > -80 && dw < 110) {
            const u = (dw - 12) / 28, v = dw / 38;
            thump += this.cylThump[i] * Math.exp(-u * u) + 0.2 * nn * Math.exp(-v * v);
          }
        }

        const z1 = rng.next(), z2 = rng.next(), z3 = rng.next(), z4 = rng.next();

        const exhp = exFlow - this.exDC.tick(exFlow);
        const rad = (exFlow - this.exPrev) * radNorm;
        this.exPrev = exFlow;
        const turb = this.turbLP.tick(z4) * exFlow * 0.8;
        const e = (0.3 * exhp + 6 * rad + turb) * exAtt;
        const y = e + this.pipeG * this.pipeLP.tick(this.pipeBuf[(this.pipeIdx - this.pipeD) & PIPE_MASK]);
        this.pipeBuf[this.pipeIdx] = y;
        this.pipeIdx = (this.pipeIdx + 1) & PIPE_MASK;
        ex[s] = this.muffler2.tick(this.muffler.tick(y)) * G_EX;

        const kIn = z1 * knockEnv; knockEnv *= kd;
        const mIn = z2 * mechEnv; mechEnv *= md;
        const tIn = z3 * tickEnv; tickEnv *= td;
        const ch = this.chamber[0].tick(kIn) + 0.6 * this.chamber[1].tick(kIn) + 0.4 * this.chamber[2].tick(kIn);
        const bIn = 0.8 * kIn + mIn;
        const bm = this.block[0].tick(bIn) + 0.8 * this.block[1].tick(bIn) + 0.6 * this.block[2].tick(bIn) + 0.4 * this.block[3].tick(bIn);
        const tk = this.tickR[0].tick(tIn + 0.4 * mIn) + 0.5 * this.tickR[1].tick(tIn);
        const th = this.thumpLP.tick(this.thumpHP.tick(thump));
        const intake = this.intakeLP.tick(z4) * intakeAmt * (1 - 0.5 * cosN);

        let st = 0;
        if (stEnv > 1e-4) {
          if (air) {
            const a = this.airLP.tick(z2);
            st = stEnv * (a - this.airHP.tick(a)) * (0.6 + 0.4 * cosN) * 3;
          } else {
            this.motorPh += nInst * c.max / 60 * 11 / sr;
            this.motorPh -= Math.floor(this.motorPh);
            const mp = this.motorPh;
            st = stEnv * (0.35 * Math.sin(TAU * 9 * mp) + 0.18 * Math.sin(TAU * 18 * mp + 1) + 0.25 * Math.sin(TAU * mp) + 0.12 * z3);
          }
        }
        bl[s] = th * G_THUMP + ch * G_CHAMBER + bm * G_BLOCK + tk * G_TICK + intake + st * G_START;

        if (c.turbo > 0) {
          this.fmNoise += (z1 - this.fmNoise) * 0.0005;
          this.turboPh += tHz * (1 + 0.5 * this.fmNoise) / sr;
          this.turboPh -= Math.floor(this.turboPh);
          const p = this.turboPh;
          const w = (Math.sin(TAU * p) + 0.3 * Math.sin(TAU * 2 * p + 0.7)) * (1 + 0.25 * cosN);
          const hl = this.hissLP.tick(z2);
          tu[s] = (tAmpW * w + tAmpH * 2 * (hl - this.hissHP.tick(hl))) * G_TURBO;
        } else {
          tu[s] = 0;
        }
      }

      this.phi = phi;
      this.knockEnv = knockEnv; this.mechEnv = mechEnv; this.tickEnv = tickEnv;
    }

    telemetry() {
      const c = this.cfg;
      return {
        type: 'tele',
        rpm: this.n * c.max,
        fuel: this.fuel,
        boost: this.boost,
        warm: this.warm,
        firing: this.firing,
        starter: this.starter,
        fireHz: this.n * c.max / 60 / (c.four ? 2 : 1) * c.N,
      };
    }
  }

  return DieselCoreV1;
}

if (typeof module !== 'undefined' && module.exports) module.exports = DIESEL_WORKLET_SOURCE_V1;
