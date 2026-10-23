// Какой пресет звучит на каком локомотиве: engines.json сопоставляет id ливреи с пресетом из presets.json.
// Обороты ХХ и максимум всегда берутся из игры, чтобы частота вспышек совпадала с тахометром.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using DieselLab.Core;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DieselLab
{
    public static class EngineMap
    {
        class Rule
        {
            public string match;          // регулярное выражение по id ливреи
            public double maxRpmBelow;    // для запасных правил: если максимум игры ниже
            public string preset;
            public JObject @override;     // поля поверх пресета
        }

        class MapFile
        {
            public List<Rule> map = new List<Rule>();
            public List<Rule> fallback = new List<Rule>();
        }

        static Dictionary<string, JObject> presets = new Dictionary<string, JObject>();
        static MapFile mapFile = new MapFile();

        public static void Load(string modPath)
        {
            var list = JArray.Parse(File.ReadAllText(Path.Combine(modPath, "presets.json")));
            var p = new Dictionary<string, JObject>();
            foreach (JObject o in list) p[(string)o["id"]] = o;
            presets = p;
            mapFile = JsonConvert.DeserializeObject<MapFile>(File.ReadAllText(Path.Combine(modPath, "engines.json")));
            Main.Mod.Logger.Log("Пресетов: " + presets.Count + ", правил: " + mapFile.map.Count + " + " + mapFile.fallback.Count);
        }

        // Возвращает конфиг и имя пресета; null — если подходящего нет
        public static EngineConfig Resolve(string liveryId, double gameIdle, double gameMax, out string presetId)
        {
            presetId = null;
            Rule rule = null;
            foreach (var r in mapFile.map)
                if (!string.IsNullOrEmpty(r.match) && Regex.IsMatch(liveryId ?? "", r.match, RegexOptions.IgnoreCase)) { rule = r; break; }
            if (rule == null)
                foreach (var r in mapFile.fallback)
                    if (r.maxRpmBelow <= 0 || gameMax < r.maxRpmBelow) { rule = r; break; }
            if (rule == null || rule.preset == null || !presets.TryGetValue(rule.preset, out var baseObj)) return null;

            var obj = (JObject)baseObj.DeepClone();
            if (rule.@override != null) obj.Merge(rule.@override, new JsonMergeSettings { MergeArrayHandling = MergeArrayHandling.Replace });
            var cfg = obj.ToObject<EngineConfig>();
            presetId = rule.preset;

            // подгоняем обороты под игру, сохраняя пропорцию прокрутки стартером
            if (gameMax > 1 && gameIdle > 0 && gameIdle < gameMax)
            {
                double crankRatio = cfg.crank / Math.Max(1, cfg.idle);
                cfg.max = gameMax;
                cfg.idle = gameIdle;
                cfg.crank = gameIdle * crankRatio;
            }
            return cfg;
        }
    }
}
