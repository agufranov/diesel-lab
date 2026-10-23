// Внешний режим ядра (как в игре): стартер → ХХ → разгон → останов; уровни и отсутствие NaN
using System;
using System.IO;
using System.Web.Script.Serialization;
using DieselLab.Core;

static class ExternalTest
{
    static int Main(string[] args)
    {
        var presets = new JavaScriptSerializer().Deserialize<EngineConfig[]>(File.ReadAllText(args[0]));
        bool bad = false;
        foreach (var id in new[] { "emd", "m62", "genset", "truck" })
        {
            var cfg = Array.Find(presets, p => p.id == id);
            var k = new DieselCore(48000) { External = true };
            k.SetConfig(cfg, true, false);
            float[] a = new float[256], b = new float[256], c = new float[256];
            Console.Write("{0,-7}", id);
            // фазы: (сек, обороты, подача, работает, стартер)
            var phases = new[] {
                Tuple.Create(2.0, cfg.crank, 0.0, false, true), Tuple.Create(3.0, cfg.idle, 0.08, true, false),
                Tuple.Create(4.0, cfg.max, 0.9, true, false), Tuple.Create(3.0, 0.0, 0.0, false, false) };
            foreach (var ph in phases)
            {
                k.ExtRpm = ph.Item2; k.ExtFuel = ph.Item3; k.ExtRunning = ph.Item4; k.ExtStarter = ph.Item5;
                double sq = 0; int n = 0;
                for (int i = 0; i < ph.Item1 * 48000 / 256; i++)
                {
                    k.Render(a, b, c, 256);
                    for (int s = 0; s < 256; s++)
                    {
                        double x = 0.8 * a[s] + 0.7 * b[s] + 0.6 * c[s];
                        if (double.IsNaN(x) || double.IsInfinity(x)) bad = true;
                        sq += x * x; n++;
                    }
                }
                Console.Write("  {0,5:0} об/мин {1,6:0.0} дБ", k.Rpm, 10 * Math.Log10(sq / n + 1e-20));
            }
            Console.WriteLine();
        }
        Console.WriteLine(bad ? "NaN!" : "ok");
        return bad ? 1 : 0;
    }
}
