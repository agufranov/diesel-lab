// Синтезатор на одном локомотиве: читает симуляцию двигателя в Update,
// считает звук ядром DieselCore в аудиопотоке (OnAudioFilterRead) и глушит штатные петли.
//
// AudioSource играет «постоянку» (клип из единиц), а фильтр умножает её на синтез:
// так звук проходит обычное 3D-позиционирование и микшер игры.
using System;
using System.Collections.Generic;
using System.Reflection;
using DieselLab.Core;
using DV.Simulation.Ports;
using LocoSim.Implementations;
using UnityEngine;

namespace DieselLab
{
    public class LocoSynth : MonoBehaviour
    {
        const int CHUNK = 256;
        static readonly FieldInfo fTorque = typeof(DieselEngineDirect).GetField("torqueGenerated", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
        static readonly FieldInfo fLayered = typeof(LayeredAudioPortReader).GetField("layeredAudio", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
        static AudioClip dcClip;

        TrainCar car;
        DieselEngineDirect engine;
        string liveryId, presetId = "—";
        AudioSource source;
        readonly List<AudioSource> muted = new List<AudioSource>();
        Transform anchor; // где играет штатный звук двигателя
        float nextAudioScan;
        double torqueMax = 1e-3;

        // аудиопоток
        readonly object sync = new object();
        DieselCore core, pendingCore;
        float[] bEx = new float[CHUNK], bBl = new float[CHUNK], bTu = new float[CHUNK];
        double wEx, wBl, wTu, hpX, hpY, hpA;
        volatile float gain;
        volatile bool active;
        // значения из игры, пишутся в Update, читаются в аудиопотоке
        double extRpm, extFuel; bool extRunning, extStarter;

        public void Init(TrainCar car, DieselEngineDirect engine)
        {
            this.car = car;
            this.engine = engine;
            liveryId = car.carLivery != null ? car.carLivery.id : car.carType.ToString();

            if (dcClip == null)
            {
                int sr = AudioSettings.outputSampleRate;
                dcClip = AudioClip.Create("DieselLab_DC", sr, 1, sr, false);
                var ones = new float[sr];
                for (int i = 0; i < ones.Length; i++) ones[i] = 1f;
                dcClip.SetData(ones, 0);
            }
            source = gameObject.AddComponent<AudioSource>();
            source.clip = dcClip;
            source.loop = true;
            source.playOnAwake = false;
            source.spatialBlend = 1f;
            source.rolloffMode = AudioRolloffMode.Logarithmic;
            source.minDistance = 8f;
            source.maxDistance = Main.Settings.maxDistance;
            source.dopplerLevel = 0f; // «постоянку» Доплер не сдвигает, тон и так идёт от оборотов
            source.spread = 60f;

            Reconfigure();
            LocoTracker.Register(this);
            Main.Mod.Logger.Log($"Локомотив {car.ID} ({liveryId}): пресет {presetId}, ХХ {GameIdle():0} / макс {GameMax():0} об/мин");
        }

        double GameMax() { return engine.engineRpmMaxReadOut != null ? engine.engineRpmMaxReadOut.Value : 0; }
        double GameIdle() { return engine.engineIdleRpmNormalizedReadOut != null ? engine.engineIdleRpmNormalizedReadOut.Value * GameMax() : 0; }

        public void Reconfigure()
        {
            double max = GameMax(), idle = GameIdle();
            var cfg = EngineMap.Resolve(liveryId, idle, max, out var pid);
            if (cfg == null) { presetId = "нет правила"; lock (sync) { pendingCore = null; core = null; } return; }
            presetId = pid;
            var k = new DieselCore(AudioSettings.outputSampleRate) { External = true };
            k.SetConfig(cfg, true, false);
            // баланс «смешанный» × баланс пресета, как в экспорте
            lock (sync)
            {
                wEx = 0.8 * cfg.mix.ex; wBl = 0.7 * cfg.mix.block; wTu = 0.6 * cfg.mix.turbo;
                hpA = Math.Exp(-2 * Math.PI * 15 / AudioSettings.outputSampleRate);
                pendingCore = k;
            }
        }

        void Update()
        {
            if (engine == null || car == null) return;

            double rpm = engine.engineRpm != null ? engine.engineRpm.Value : 0;
            bool running = engine.engineOnReadOut != null && engine.engineOnReadOut.Value > 0.5f;
            bool starting = engine.ignitionInProgressReadOut != null && engine.ignitionInProgressReadOut.Value > 0.5f;
            double throttle = engine.throttleReader != null ? engine.throttleReader.Value : 0;
            double fuelEst = throttle;
            if (fTorque != null)
            {
                double tq = Math.Max(0, Convert.ToDouble(fTorque.GetValue(engine)));
                torqueMax = Math.Max(torqueMax * 0.99995, tq); // нормируем на наибольший виденный момент
                fuelEst = Math.Max(throttle * 0.5, tq / torqueMax);
            }
            extRpm = rpm;
            extFuel = 0.06 + 0.94 * Math.Min(1, fuelEst);
            extRunning = running;
            extStarter = starting && Main.Settings.synthStarter;

            var cam = Camera.main;
            float dist = cam != null ? Vector3.Distance(cam.transform.position, transform.position) : 0f;
            bool shouldPlay = Main.Enabled && (core != null || pendingCore != null);
            shouldPlay &= dist < Main.Settings.maxDistance && (rpm > 1 || starting);
            active = shouldPlay;
            gain = Main.Settings.volume * 2.5f;
            source.maxDistance = Main.Settings.maxDistance;
            if (shouldPlay && !source.isPlaying) source.Play();
            else if (!shouldPlay && source.isPlaying) source.Stop();

            if (Time.unscaledTime >= nextAudioScan)
            {
                nextAudioScan = Time.unscaledTime + 1f;
                ScanVanillaAudio();
            }
            if (anchor != null) transform.position = anchor.position;
        }

        // Штатные петли двигателя — LayeredAudioPortReader, читающие порты этого же компонента
        void ScanVanillaAudio()
        {
            string prefix = engine.id + ".";
            var readers = car.GetComponentsInChildren<LayeredAudioPortReader>(true);
            foreach (var r in readers)
            {
                if (r == null || string.IsNullOrEmpty(r.portId) || !r.portId.StartsWith(prefix, StringComparison.Ordinal)) continue;
                var la = fLayered != null ? fLayered.GetValue(r) as LayeredAudio : null;
                if (la == null || la.layers == null) continue;
                if (anchor == null)
                {
                    anchor = la.transform;
                    if (la.audioMixerGroup != null) source.outputAudioMixerGroup = la.audioMixerGroup;
                }
                foreach (var layer in la.layers)
                {
                    if (layer == null || layer.source == null) continue;
                    if (Main.Settings.muteVanilla && !layer.source.mute) { layer.source.mute = true; muted.Add(layer.source); }
                    else if (!Main.Settings.muteVanilla && muted.Remove(layer.source)) layer.source.mute = false;
                }
            }
            muted.RemoveAll(s => s == null);
        }

        void OnAudioFilterRead(float[] data, int channels)
        {
            DieselCore k;
            lock (sync)
            {
                if (pendingCore != null) { core = pendingCore; pendingCore = null; }
                k = core;
            }
            if (k == null || !active) { Array.Clear(data, 0, data.Length); return; }
            k.ExtRpm = extRpm; k.ExtFuel = extFuel; k.ExtRunning = extRunning; k.ExtStarter = extStarter;
            float g = gain;
            int frames = data.Length / channels;
            for (int pos = 0; pos < frames; pos += CHUNK)
            {
                int n = Math.Min(CHUNK, frames - pos);
                k.Render(bEx, bBl, bTu, n);
                for (int i = 0; i < n; i++)
                {
                    double x = wEx * bEx[i] + wBl * bBl[i] + wTu * bTu[i];
                    hpY = hpA * (hpY + x - hpX); hpX = x;             // ФВЧ 15 Гц
                    float y = (float)Math.Tanh(hpY * g);               // мягкий потолок
                    int o = (pos + i) * channels;
                    for (int ch = 0; ch < channels; ch++) data[o + ch] *= y;
                }
            }
        }

        public string DebugLine()
        {
            double rpm = engine != null && engine.engineRpm != null ? engine.engineRpm.Value : 0;
            return $"{(car != null ? car.ID : "?")} {liveryId} → {presetId}: {rpm:0} об/мин, подача {extFuel:0.00}, " +
                   $"{(active ? "звучит" : "тихо")}, заглушено слоёв {muted.Count}";
        }

        void OnDestroy()
        {
            active = false;
            foreach (var s in muted) if (s != null) s.mute = false;
            muted.Clear();
            LocoTracker.Unregister(this);
        }
    }
}
