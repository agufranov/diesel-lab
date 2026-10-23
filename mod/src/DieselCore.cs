// Порт ядра engine.js (модель v2: давление в цилиндре) на C#.
// Держим вычисления как в JS: double для чисел, float[] там, где в JS Float32Array,
// тот же порядок вызовов ГСЧ — тогда вывод совпадает с браузером (tools/parity).
// Без зависимостей от Unity: собирается и в мод, и в консольный тест.
using System;

namespace DieselLab.Core
{
    public class EngineConfig
    {
        public string id = "custom", name = "";
        public double cyl = 6, stroke = 4, bore = 130, idle = 550, max = 2000, crank = 150;
        public string gov = "speed", starter = "electric";
        public double startDelay = 0.5, inertia = 1, turbo = 0.7, turboHz = 5000, turboLag = 1.2;
        public double pipe = 5, muffler = 900, knock = 0.6, mech = 0.5, uneven = 0.02, warmTau = 150;
        public Mix mix = new Mix();

        public class Mix { public double ex = 1, block = 1, turbo = 1; }

        public EngineConfig Clone()
        {
            var c = (EngineConfig)MemberwiseClone();
            c.mix = new Mix { ex = mix.ex, block = mix.block, turbo = mix.turbo };
            return c;
        }
    }

    public sealed class DieselCore
    {
        const double TAU = Math.PI * 2, DEG = Math.PI / 180;
        const double C_GAS = 1000, C_EXH = 550;
        const int PIPE_LEN = 32768, PIPE_MASK = PIPE_LEN - 1, MAX_CYL = 24, N_MODES = 28;
        const double K_COMB = 80, T_MIN = -180, T_MAX = 260, T_STEP = 0.5;
        const double G_EX = 0.5, G_THUMP = 0.003, G_STRUCT = 0.065, G_MODES = 0.05, G_CHAMBER = 0.03,
            G_TICK = 0.05, G_INTAKE = 0.25, G_START = 0.22, G_TURBO = 0.16;

        static double Clamp(double x, double a, double b) { return x < a ? a : x > b ? b : x; }
        static double JsRound(double x) { return Math.Floor(x + 0.5); }

        static bool Crossed(double prev, double deg, double th, bool wrapped)
        {
            return wrapped ? (th > prev || th <= deg) : (prev < th && th <= deg);
        }

        sealed class Rng
        {
            uint s;
            public Rng(int seed) { s = seed != 0 ? (uint)seed : 0x2545f491u; }
            public double Next() // xorshift32 → [-1, 1)
            {
                uint x = s;
                x ^= x << 13; x ^= x >> 17; x ^= x << 5;
                s = x;
                return x / 2147483648.0 - 1;
            }
            public double Gauss() { return (Next() + Next() + Next()) * 0.577; }
        }

        sealed class Reson
        {
            double y1, y2, a1, a2, g;
            public void Set(double f, double q, double sr)
            {
                if (!(f > 0) || f >= sr * 0.45) { g = 0; a1 = 0; a2 = 0; return; }
                double w = TAU * f / sr, r = Math.Exp(-Math.PI * f / (q * sr));
                a1 = 2 * r * Math.Cos(w); a2 = -r * r; g = Math.Sin(w);
            }
            public double Tick(double x)
            {
                double y = x * g + a1 * y1 + a2 * y2;
                y2 = y1; y1 = y;
                return y;
            }
        }

        sealed class Biquad
        {
            double b0 = 1, b1, b2, a1, a2, x1, x2, y1, y2;
            void Set(double nb0, double nb1, double nb2, double a0, double na1, double na2)
            {
                b0 = nb0 / a0; b1 = nb1 / a0; b2 = nb2 / a0; a1 = na1 / a0; a2 = na2 / a0;
            }
            public void Lowpass(double f, double q, double sr)
            {
                double w = TAU * Math.Min(f, sr * 0.45) / sr, cs = Math.Cos(w), al = Math.Sin(w) / (2 * q);
                Set((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al);
            }
            public void Highpass(double f, double q, double sr)
            {
                double w = TAU * Math.Min(f, sr * 0.45) / sr, cs = Math.Cos(w), al = Math.Sin(w) / (2 * q);
                Set((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al);
            }
            public double Tick(double x)
            {
                double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
                x2 = x1; x1 = x; y2 = y1; y1 = y;
                return y;
            }
        }

        sealed class OnePole
        {
            double y, a = 1;
            public void Set(double f, double sr) { a = 1 - Math.Exp(-TAU * Math.Min(f, sr * 0.45) / sr); }
            public double Tick(double x) { return y += a * (x - y); }
        }

        // производная конфигурация (в JS — поля в копии cfg)
        sealed class Derived
        {
            public EngineConfig src;
            public int N; public bool four, air, pedal; public double cycleDeg, B, max, idle, crank;
            public double nIdle, nCrank, nFire, starterT, exOpen, exDur, ivc, winA, winB, degPerSampleMax;
            public double inertia, turboLag, turbo, turboHz, uneven, cr, premixMs, qp0, knock, mech;
            public double startDelay, warmTau;
        }

        readonly double sr;
        readonly Rng rng = new Rng(0x1234567);
        Derived c;

        // управление (как в JS) …
        public double Throttle, Load, Pedal = -1;
        bool fuelOn, starter; double crankTime;
        // … и внешнее: обороты, подача и стартер приходят из игры
        public bool External;
        public double ExtRpm, ExtFuel; public bool ExtRunning, ExtStarter;

        double n, fuel, boost, warm = 1, phi;
        bool firing, stopped = true;
        double hunt, huntV, tqMean, dw;
        double knockEnv, mechEnv, tickEnv, starterEnv;
        double turboPh, motorPh, fmNoise, exPrev;
        double knockDecay, mechDecay, tickDecay;

        readonly double[] cylDeg = new double[MAX_CYL], fireAt = new double[MAX_CYL];
        readonly float[] sQ = new float[MAX_CYL], sInj = new float[MAX_CYL], sEx = new float[MAX_CYL], sExD = new float[MAX_CYL];
        readonly float[] cQ = new float[MAX_CYL], cQp = new float[MAX_CYL], cSoc = new float[MAX_CYL],
            cDp = new float[MAX_CYL], cDd = new float[MAX_CYL], cylP = new float[MAX_CYL];
        float[] tPm = new float[0], tEx = new float[0];

        readonly Reson[] chamber = { new Reson(), new Reson(), new Reson() };
        readonly Reson[] modes = new Reson[N_MODES];
        readonly float[] modeG = new float[N_MODES];
        readonly Biquad saHP1 = new Biquad(), saHP2 = new Biquad(), saLP = new Biquad();
        readonly Reson[] tickR = { new Reson(), new Reson() };
        readonly Biquad thumpHP = new Biquad(), thumpLP = new Biquad();
        readonly OnePole exDC = new OnePole(), turbLP = new OnePole();
        readonly float[] pipeBuf = new float[PIPE_LEN];
        int pipeIdx, pipeD = 1; double pipeG = -0.5;
        readonly OnePole pipeLP = new OnePole();
        readonly Biquad muffler = new Biquad(); readonly OnePole muffler2 = new OnePole();
        readonly OnePole hissLP = new OnePole(), hissHP = new OnePole();
        readonly OnePole intakeLP = new OnePole(), airLP = new OnePole(), airHP = new OnePole();

        public DieselCore(double sampleRate)
        {
            sr = sampleRate;
            for (int i = 0; i < N_MODES; i++) modes[i] = new Reson();
        }

        public double Rpm { get { return c == null ? 0 : n * c.max; } }
        public double Fuel { get { return fuel; } }
        public double Boost { get { return boost; } }
        public bool Firing { get { return firing; } }
        public bool HasConfig { get { return c != null; } }
        public double Warm { get { return warm; } set { warm = value; } }

        public void SetConfig(EngineConfig cfg, bool reset, bool cold)
        {
            double prevRpm = c != null ? n * c.max : 0;
            var d = new Derived { src = cfg };
            d.N = (int)Clamp(JsRound(cfg.cyl), 1, MAX_CYL);
            d.four = cfg.stroke != 2;
            d.cycleDeg = d.four ? 720 : 360;
            d.B = Clamp(cfg.bore, 20, 1200) / 1000;
            d.max = Math.Max(20, cfg.max);
            d.idle = Clamp(cfg.idle, d.max * 0.05, d.max * 0.85);
            d.crank = Clamp(cfg.crank, d.idle * 0.15, d.idle * 0.8);
            d.nIdle = d.idle / d.max;
            d.nCrank = d.crank / d.max;
            d.nFire = d.nCrank * 0.6;
            d.starterT = (0.04 + 0.2 * d.nCrank + 0.15 * d.nCrank * d.nCrank) / 0.15;
            d.exOpen = d.four ? 130 : 95;
            d.exDur = d.four ? 240 : 150;
            d.ivc = d.four ? 570 : -1;
            d.winA = d.four ? -150 : -100;
            d.winB = d.exOpen + 60;
            d.degPerSampleMax = d.max / 60 * 360 / sr;
            d.inertia = Math.Max(0.05, cfg.inertia);
            d.turboLag = Math.Max(0.05, cfg.turboLag > 0 ? cfg.turboLag : 1);
            d.turbo = Clamp(cfg.turbo, 0, 1);
            d.turboHz = cfg.turboHz > 0 ? cfg.turboHz : 4000;
            d.uneven = cfg.uneven;
            d.cr = d.B < 0.15 ? 17 : 14;
            d.premixMs = 0.35 * Math.Pow(d.B / 0.1, 0.6);
            d.knock = cfg.knock; d.mech = cfg.mech;
            d.qp0 = 0.1 * d.knock;
            d.air = cfg.starter == "air";
            d.pedal = cfg.gov == "pedal";
            d.startDelay = cfg.startDelay; d.warmTau = cfg.warmTau;

            int nT = (int)JsRound((T_MAX - T_MIN) / T_STEP) + 1;
            tPm = new float[nT]; tEx = new float[nT];
            for (int k = 0; k < nT; k++)
            {
                double th = T_MIN + k * T_STEP;
                double v = 1 + (d.cr - 1) / 2 * (1 - Math.Cos(th * DEG));
                double blow = th > d.exOpen ? Math.Exp(-Math.Pow((th - d.exOpen) / 18, 2)) : 1;
                tPm[k] = (float)(Math.Max(0, Math.Pow(d.cr / v, 1.35) - 1) * blow);
                tEx[k] = (float)(Math.Pow(1 / v, 1.3) * blow);
            }

            var r = new Rng(7919 * d.N + 13);
            for (int i = 0; i < d.N; i++)
            {
                sQ[i] = (float)((0.03 + d.uneven * 1.2) * r.Gauss());
                sInj[i] = (float)((0.4 + d.uneven * 12) * r.Gauss());
                sEx[i] = (float)Math.Max(0.4, 1 + (0.15 + d.uneven * 2) * r.Gauss());
                sExD[i] = (float)((2 + d.uneven * 60) * r.Gauss());
                double f = (i + d.uneven * 0.3 * r.Next()) / d.N;
                f -= Math.Floor(f);
                fireAt[i] = f;
            }

            double f0 = C_GAS / (Math.PI * d.B);
            double[] bessel = { 1.841, 3.054, 3.832 };
            for (int j = 0; j < 3; j++) chamber[j].Set(f0 * bessel[j], 22, sr);

            double bs = Math.Sqrt(0.1 / d.B);
            double fSA = Clamp(1000 * bs, 250, 1600);
            saHP1.Highpass(fSA, 0.7, sr); saHP2.Highpass(fSA, 0.7, sr);
            saLP.Lowpass(Clamp(7000 * bs, 2500, 12000), 0.7, sr);
            var mr = new Rng(424242 + (int)JsRound(cfg.bore));
            double fLo = 280 * bs, fHi = 6500 * bs;
            for (int i = 0; i < N_MODES; i++)
            {
                double f = fLo * Math.Pow(fHi / fLo, (i + 0.5 + 0.45 * mr.Next()) / N_MODES);
                double q = (d.B > 0.2 ? 30 : 18) * (1 + 0.4 * mr.Next());
                modes[i].Set(f, q, sr);
                modeG[i] = (float)((0.6 + 0.4 * mr.Next()) / Math.Sqrt(N_MODES));
            }
            double tf = 6500 * Math.Pow(0.1 / d.B, 0.35);
            tickR[0].Set(tf, 30, sr); tickR[1].Set(tf * 1.53, 25, sr);
            knockDecay = Math.Exp(-1 / (0.00025 * Math.Pow(d.B / 0.08, 0.6) * sr));
            mechDecay = Math.Exp(-1 / (0.0004 * Math.Pow(d.B / 0.08, 0.5) * sr));
            tickDecay = Math.Exp(-1 / (0.00012 * sr));
            thumpHP.Highpass(18, 0.7, sr);
            thumpLP.Lowpass(Clamp(320 * bs, 90, 420), 0.7, sr);
            exDC.Set(10, sr); turbLP.Set(2500, sr);
            pipeD = (int)Clamp(JsRound(2 * cfg.pipe / C_EXH * sr), 8, PIPE_LEN - 2);
            pipeG = cfg.pipe > 10 ? -0.35 : -0.55;
            pipeLP.Set(cfg.pipe > 10 ? 700 : 2200, sr);
            muffler.Lowpass(cfg.muffler, 0.8, sr); muffler2.Set(cfg.muffler * 1.5, sr);
            hissLP.Set(d.turboHz * 0.7, sr); hissHP.Set(900, sr);
            intakeLP.Set(600, sr);
            airLP.Set(3500, sr); airHP.Set(1200, sr);
            c = d;

            if (reset)
            {
                n = 0; fuel = 0; boost = 0; phi = 0;
                fuelOn = false; starter = false; firing = false; stopped = true;
                warm = cold ? 0 : 1;
                dw = 0; tqMean = 0; hunt = 0; huntV = 0;
                Array.Clear(cQ, 0, MAX_CYL); Array.Clear(cQp, 0, MAX_CYL); Array.Clear(cylP, 0, MAX_CYL);
                Array.Clear(pipeBuf, 0, PIPE_LEN); Array.Clear(cSoc, 0, MAX_CYL);
                for (int i = 0; i < MAX_CYL; i++) { cDp[i] = 1; cDd[i] = 40; }
            }
            else
            {
                n = Clamp(prevRpm / d.max, 0, 1.2);
            }
            for (int i = 0; i < d.N; i++)
            {
                double dd = phi - fireAt[i]; if (dd < 0) dd += 1;
                cylDeg[i] = dd * d.cycleDeg;
            }
        }

        public void Start()
        {
            if (c == null) return;
            if (fuelOn && n > c.nIdle * 0.6) return;
            fuelOn = true; starter = true; crankTime = 0; stopped = false;
            mechEnv = Math.Max(mechEnv, 1.6);
        }

        public void Stop() { fuelOn = false; starter = false; }

        void Dynamics(double dt)
        {
            if (External) { ExternalDynamics(dt); return; }
            var d = c;
            double nn0 = n;
            if (starter)
            {
                crankTime += dt;
                if ((firing && nn0 > d.nCrank * 1.6) || crankTime > 12)
                {
                    starter = false;
                    mechEnv = Math.Max(mechEnv, 0.9);
                }
            }
            double loss = (nn0 > 1e-4 ? 0.04 : 0) + 0.2 * nn0 + 0.15 * nn0 * nn0;
            double loadT = Load * (0.85 * nn0 * nn0 + 0.1 * nn0);
            bool canFire = fuelOn && nn0 > d.nFire && !(starter && crankTime < d.startDelay);
            firing = canFire;
            double th = Pedal >= 0 ? Pedal : Throttle;

            huntV += (rng.Next() * 3 - huntV) * Math.Min(1, dt * 3);
            hunt += (huntV - hunt) * Math.Min(1, dt * 3);

            double f = 0;
            if (canFire)
            {
                double fmax = 1 - d.turbo * 0.5 * (1 - boost);
                double nIdle = d.nIdle * (1 + 0.15 * (1 - warm));
                double ff = (loss + loadT) / 1.4;
                if (d.pedal)
                {
                    f = Math.Max(ff + 8 * (nIdle - nn0), th * th * fmax);
                    if (nn0 > 1) f = Math.Min(f, ff + 8 * (1 - nn0));
                }
                else
                {
                    f = ff + 8 * (nIdle + th * (1 - nIdle) - nn0);
                }
                f += ff * 0.25 * hunt * (1 - th) * Math.Max(0, 1 - Load);
                f = Clamp(f, 0, fmax);
            }
            fuel += (f - fuel) * Math.Min(1, dt / 0.025);

            double torque = 1.4 * fuel - loss - loadT;
            if (starter) torque += d.starterT * Math.Max(0, 1 - nn0 / d.nCrank);
            double J = fuelOn ? d.inertia : Math.Min(d.inertia, 2.5);
            double nx = nn0 + torque / J * dt;
            if (nx <= 0.002 && !starter && torque < 0)
            {
                if (!stopped) mechEnv = Math.Max(mechEnv, 0.7);
                nx = 0; stopped = true;
            }
            if (stopped && !starter) { nx = 0; if (!fuelOn) fuel = 0; }
            n = Clamp(nx, 0, 1.3);
            TurboWarmStarter(dt);
        }

        // Режим игры: обороты и подача задаются извне, своя модель — только звук
        void ExternalDynamics(double dt)
        {
            var d = c;
            double target = Clamp(ExtRpm / d.max, 0, 1.3);
            n += (target - n) * Math.Min(1, dt / 0.04);
            if (n < 0.002 && target < 0.002) n = 0;
            bool wasStarter = starter;
            starter = ExtStarter;
            if (starter && !wasStarter) mechEnv = Math.Max(mechEnv, 1.6);
            if (!starter && wasStarter) mechEnv = Math.Max(mechEnv, 0.9);
            fuelOn = ExtRunning;
            firing = ExtRunning && n > d.nFire;
            double f = firing ? Clamp(ExtFuel, 0.02, 1) : 0;
            fuel += (f - fuel) * Math.Min(1, dt / 0.06);
            if (n == 0 && !stopped) { mechEnv = Math.Max(mechEnv, 0.7); stopped = true; }
            if (n > 0) stopped = false;
            TurboWarmStarter(dt);
        }

        void TurboWarmStarter(double dt)
        {
            var d = c;
            double bt = Math.Min(1, fuel * (0.25 + 0.75 * n) * 1.3 + 0.06 * n);
            boost += (bt - boost) * Math.Min(1, dt / (bt > boost ? d.turboLag : d.turboLag * 1.8));
            if (firing) warm = Math.Min(1, warm + dt / d.warmTau);
            starterEnv += ((starter ? 1 : 0) - starterEnv) * Math.Min(1, dt / 0.02);
        }

        void Latch(int i)
        {
            var d = c;
            double nn = Math.Min(n, 1);
            double q = 0;
            if (firing)
            {
                double missP = n < d.nIdle * 0.85 ? 0.25 * (1 - warm) + (starter ? 0.05 : 0) : 0;
                if (rng.Next() * 0.5 + 0.5 >= missP)
                {
                    q = Math.Max(0.02, fuel) * Math.Max(0.2, 1 + sQ[i] + 0.05 * rng.Gauss());
                }
            }
            double cold = 1 - warm;
            double degPerMs = n * d.max * 0.006;
            double inj = -(8 + 6 * nn) + sInj[i] + 0.4 * rng.Gauss();
            double delayMs = (0.55 + 0.6 * cold + 0.25 * (1 - boost)) * (1 + 0.1 * rng.Gauss());
            double qp = Math.Min(q, d.qp0 * (1 + 0.8 * cold) * (1 + 0.2 * rng.Gauss()));
            cQ[i] = (float)q;
            cQp[i] = (float)Math.Max(0, qp);
            cSoc[i] = (float)(inj + delayMs * degPerMs);
            cDp[i] = (float)Math.Max(1e-3, d.premixMs * (1 + 0.15 * rng.Gauss()) * degPerMs);
            cDd[i] = (float)((35 + 30 * q) * (1 + 0.1 * rng.Gauss()));
        }

        double Pressure(int i, double th, double pBoost)
        {
            double k = (th - T_MIN) / T_STEP; int k0 = (int)k; double fr = k - k0;
            double pm0 = tPm[k0], pm1 = tPm[k0 + 1];
            double p = (pm0 + (pm1 - pm0) * fr) * pBoost;
            double q = cQ[i];
            if (q > 0)
            {
                double u = th - cSoc[i];
                if (u > 0)
                {
                    double e0 = tEx[k0], e1 = tEx[k0 + 1];
                    double ex = e0 + (e1 - e0) * fr;
                    double a = u / cDp[i], b = u / cDd[i];
                    double xp = a > 2.5 ? 1 : 1 - Math.Exp(-6.9 * a * a * a);
                    double xd = 1 - Math.Exp(-6.9 * b * b);
                    double qp = cQp[i];
                    p += K_COMB * pBoost * (qp * xp + (q - qp) * xd) * ex;
                }
            }
            return p;
        }

        public void Render(float[] ex, float[] bl, float[] tu, int len)
        {
            var d = c;
            int N = d.N; double cyc = d.cycleDeg;
            Dynamics(len / sr);

            double nn = Math.Min(n, 1), fu = fuel, nv = n;
            double cycPerSec = d.max / 60 / (d.four ? 2 : 1);
            double degPerSec = d.max / 60 * 360;
            double pBoost = 1 + 1.5 * d.turbo * boost;
            double injAmt = d.mech * 0.45;
            double valveAmt = d.mech * 0.35 * (0.4 + 0.6 * nn);
            double tS = d.turbo > 0 ? Math.Min(1, 0.12 * Math.Min(1, nv / d.nIdle) + 0.88 * boost) : 0;
            double tHz = d.turboHz * (0.3 + 0.7 * tS);
            double tAmpW = d.turbo * tS * tS * Math.Sqrt(tS) * 0.5;
            double tAmpH = d.turbo * tS * tS * 0.6;
            double intakeAmt = (d.turbo > 0 ? 0.3 : 1) * nn * (0.2 + fu) * G_INTAKE;
            double exAtt = 1 - 0.45 * d.turbo * boost;
            double stEnv = starterEnv; bool air = d.air;
            double kd = knockDecay, md = mechDecay, td = tickDecay;
            double radNorm = 1 / (d.degPerSampleMax * Math.Sqrt(Math.Max(nn, 0.04)));
            double torK = 0.0003 / (Math.Max(nv, 0.03) * Math.Max(nv, 0.03) * Math.Sqrt(N));
            double winA = d.winA, winB = d.winB, latchDeg = cyc + winA - 15;
            double kEnv = knockEnv, mEnv = mechEnv, tEnv = tickEnv;
            double ph = phi, w = dw, tqM = tqMean;

            for (int s = 0; s < len; s++)
            {
                double nInst = nv * (1 + w);
                double dDeg = nInst * degPerSec / sr;
                ph += nInst * cycPerSec / sr;
                if (ph >= 1) ph -= 1;

                double exFlow = 0, pSum = 0, tq = 0;
                for (int i = 0; i < N; i++)
                {
                    double dd = ph - fireAt[i]; if (dd < 0) dd += 1;
                    double deg = dd * cyc, prev = cylDeg[i];
                    if (deg != prev)
                    {
                        cylDeg[i] = deg;
                        bool wrapped = deg < prev;
                        if (Crossed(prev, deg, latchDeg, wrapped)) Latch(i);
                        if (firing && Crossed(prev, deg, cyc - 14, wrapped))
                            tEnv = Math.Max(tEnv, injAmt * (0.8 + 0.2 * rng.Next()));
                        double socV = cSoc[i];
                        double soc = socV < 0 ? cyc + socV : socV;
                        if (cQp[i] > 0 && Crossed(prev, deg, soc, wrapped))
                            kEnv = Math.Max(kEnv, cQp[i] / d.qp0 * d.knock * 0.8 * (0.85 + 0.25 * rng.Next()));
                        if (Crossed(prev, deg, d.exOpen, wrapped))
                        {
                            double pe = Pressure(i, d.exOpen, pBoost);
                            cylP[i] = (float)(0.55 * Math.Sqrt(Math.Max(0, pe)) * sEx[i] * (1 + 0.06 * rng.Gauss()) *
                                (0.6 + 0.4 * Math.Min(1, nv / d.nIdle)));
                        }
                        if (Crossed(prev, deg, d.exOpen + d.exDur, wrapped) || (d.ivc > 0 && Crossed(prev, deg, d.ivc, wrapped)))
                            mEnv = Math.Max(mEnv, valveAmt * (0.75 + 0.25 * rng.Next()));
                    }
                    double th = deg > cyc + winA ? deg - cyc : deg;
                    if (th >= winA && th <= winB)
                    {
                        double p = Pressure(i, th, pBoost);
                        pSum += p;
                        tq += p * Math.Sin(th * DEG);
                    }
                    double x = (deg - d.exOpen - sExD[i]) / d.exDur;
                    if (x < -0.5) x += cyc / d.exDur;
                    if (x > 0 && x < 1) exFlow += cylP[i] * (1 - Math.Exp(-30 * x)) * Math.Exp(-4 * x) * (1 - x);
                }

                if (nv > 0)
                {
                    tqM += (tq - tqM) * Math.Min(1, dDeg / cyc);
                    w = Clamp((w + (tq - tqM) * dDeg * DEG * torK) * (1 - dDeg / cyc), -0.3, 0.3);
                }

                double z1 = rng.Next(), z2 = rng.Next(), z3 = rng.Next(), z4 = rng.Next();

                double exhp = exFlow - exDC.Tick(exFlow);
                double rad = (exFlow - exPrev) * radNorm;
                exPrev = exFlow;
                double turb = turbLP.Tick(z4) * exFlow * 0.8;
                double e = (0.6 * exhp + 5 * rad + turb) * exAtt;
                double y = e + pipeG * pipeLP.Tick(pipeBuf[(pipeIdx - pipeD) & PIPE_MASK]);
                pipeBuf[pipeIdx] = (float)y;
                pipeIdx = (pipeIdx + 1) & PIPE_MASK;
                ex[s] = (float)(muffler2.Tick(muffler.Tick(y)) * G_EX);

                double sa = saLP.Tick(saHP2.Tick(saHP1.Tick(pSum)));
                double kIn = z1 * kEnv; kEnv *= kd;
                double mIn = z2 * mEnv; mEnv *= md;
                double tIn = z3 * tEnv; tEnv *= td;
                double ch = chamber[0].Tick(kIn) + 0.6 * chamber[1].Tick(kIn) + 0.4 * chamber[2].Tick(kIn);
                double mx = sa * 0.15 + mIn * 0.5;
                double md2 = 0;
                for (int k = 0; k < N_MODES; k++) md2 += modes[k].Tick(mx) * modeG[k];
                double tk = tickR[0].Tick(tIn + 0.4 * mIn) + 0.5 * tickR[1].Tick(tIn);
                double thump = thumpLP.Tick(thumpHP.Tick(pSum));
                double intake = intakeLP.Tick(z4) * intakeAmt;

                double st = 0;
                if (stEnv > 1e-4)
                {
                    double pulse = 1 + 6 * w;
                    if (air)
                    {
                        double a = airLP.Tick(z2);
                        st = stEnv * (a - airHP.Tick(a)) * Clamp(pulse, 0.3, 1.6) * 3;
                    }
                    else
                    {
                        motorPh += nInst * d.max / 60 * 11 / sr;
                        motorPh -= Math.Floor(motorPh);
                        double mp = motorPh;
                        st = stEnv * (0.35 * Math.Sin(TAU * 9 * mp) + 0.18 * Math.Sin(TAU * 18 * mp + 1) + 0.25 * Math.Sin(TAU * mp) + 0.12 * z3);
                    }
                }
                bl[s] = (float)(thump * G_THUMP + sa * G_STRUCT + md2 * G_MODES + ch * G_CHAMBER + tk * G_TICK + intake + st * G_START);

                if (d.turbo > 0)
                {
                    fmNoise += (z1 - fmNoise) * 0.0005;
                    turboPh += tHz * (1 + 0.5 * fmNoise) / sr;
                    turboPh -= Math.Floor(turboPh);
                    double p = turboPh;
                    double wv = (Math.Sin(TAU * p) + 0.3 * Math.Sin(TAU * 2 * p + 0.7)) * (1 + 0.25 * exFlow);
                    double hl = hissLP.Tick(z2);
                    tu[s] = (float)((tAmpW * wv + tAmpH * 2 * (hl - hissHP.Tick(hl))) * G_TURBO);
                }
                else tu[s] = 0;
            }

            phi = ph; dw = w; tqMean = tqM;
            knockEnv = kEnv; mechEnv = mEnv; tickEnv = tEnv;
        }
    }
}
