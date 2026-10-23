// Сверка порта: рендерит тот же сценарий, что render-js.js, и сравнивает с эталоном JS
using System;
using System.IO;
using DieselLab.Core;
using System.Web.Script.Serialization;

static class Parity
{
    static int Main(string[] args)
    {
        string id = args[0], presetsPath = args[1], refPath = args[2];
        var presets = new JavaScriptSerializer().Deserialize<EngineConfig[]>(File.ReadAllText(presetsPath));
        EngineConfig cfg = Array.Find(presets, p => p.id == id);
        var k = new DieselCore(48000);
        k.SetConfig(cfg, true, false);
        const int B = 128;
        float[] ex = new float[B], bl = new float[B], tu = new float[B];
        byte[] raw = File.ReadAllBytes(refPath);
        float[] reference = new float[raw.Length / 4];
        Buffer.BlockCopy(raw, 0, reference, 0, raw.Length);
        int pos = 0; double err = 0, sig = 0, maxErr = 0; int firstDiff = -1;
        Action<double> run = sec =>
        {
            int blocks = (int)Math.Floor(sec * 48000 / B + 0.5);
            for (int i = 0; i < blocks; i++)
            {
                k.Render(ex, bl, tu, B);
                for (int s = 0; s < B; s++)
                {
                    float[] v = { ex[s], bl[s], tu[s] };
                    for (int ch = 0; ch < 3; ch++, pos++)
                    {
                        double d = v[ch] - reference[pos];
                        err += d * d; sig += reference[pos] * (double)reference[pos];
                        if (Math.Abs(d) > maxErr) maxErr = Math.Abs(d);
                        if (firstDiff < 0 && d != 0) firstDiff = pos / 3;
                    }
                }
            }
        };
        k.Start(); run(3);
        k.Throttle = 0.55; k.Load = 0.4; run(3);
        double rel = Math.Sqrt(err / Math.Max(sig, 1e-30));
        Console.WriteLine("{0,-8} rpm {1,5:0}  rel.err {2:E2}  max |d| {3:E2}  first diff @ {4}", id, k.Rpm, rel, maxErr,
            firstDiff < 0 ? "none" : (firstDiff / 48000.0).ToString("0.000") + " s");
        return rel < 1e-3 ? 0 : 1;
    }
}
