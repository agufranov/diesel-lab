// Точка входа мода для Unity Mod Manager: настройки, окно в UMM, запуск трекера локомотивов
using System;
using System.Linq;
using UnityEngine;
using UnityModManagerNet;

namespace DieselLab
{
    public class Settings : UnityModManager.ModSettings
    {
        public float volume = 1f;          // общий множитель громкости синтеза
        public bool muteVanilla = true;    // глушить штатные петли двигателя
        public bool synthStarter = true;   // синтезировать стартер (штатные клипы пуска остаются)
        public float maxDistance = 350f;   // дальше этого синтез не считается
        public bool showDebug = false;

        public override void Save(UnityModManager.ModEntry modEntry) { Save(this, modEntry); }
    }

    public static class Main
    {
        public static UnityModManager.ModEntry Mod;
        public static Settings Settings;
        public static bool Enabled;
        static GameObject runner;

        public static bool Load(UnityModManager.ModEntry modEntry)
        {
            Mod = modEntry;
            Settings = UnityModManager.ModSettings.Load<Settings>(modEntry);
            try
            {
                EngineMap.Load(modEntry.Path);
            }
            catch (Exception e)
            {
                modEntry.Logger.Error("Не удалось прочитать presets.json / engines.json: " + e);
                return false;
            }
            modEntry.OnToggle = OnToggle;
            modEntry.OnGUI = OnGUI;
            modEntry.OnSaveGUI = m => Settings.Save(m);
            return true;
        }

        static bool OnToggle(UnityModManager.ModEntry modEntry, bool value)
        {
            Enabled = value;
            if (value)
            {
                if (runner == null)
                {
                    runner = new GameObject("DieselLab");
                    UnityEngine.Object.DontDestroyOnLoad(runner);
                    runner.AddComponent<LocoTracker>();
                }
            }
            else if (runner != null)
            {
                UnityEngine.Object.Destroy(runner); // LocoTracker.OnDestroy снимает синтез и возвращает штатный звук
                runner = null;
            }
            return true;
        }

        static void OnGUI(UnityModManager.ModEntry modEntry)
        {
            GUILayout.Label("Громкость синтеза: " + Settings.volume.ToString("0.00"));
            Settings.volume = GUILayout.HorizontalSlider(Settings.volume, 0f, 3f, GUILayout.Width(300));
            GUILayout.Label("Дальность синтеза, м: " + Settings.maxDistance.ToString("0"));
            Settings.maxDistance = GUILayout.HorizontalSlider(Settings.maxDistance, 100f, 1000f, GUILayout.Width(300));
            Settings.muteVanilla = GUILayout.Toggle(Settings.muteVanilla, " Глушить штатный звук двигателя");
            Settings.synthStarter = GUILayout.Toggle(Settings.synthStarter, " Синтезировать стартер");
            Settings.showDebug = GUILayout.Toggle(Settings.showDebug, " Показать локомотивы (отладка)");
            if (GUILayout.Button("Перечитать presets.json и engines.json", GUILayout.Width(300)))
            {
                try { EngineMap.Load(modEntry.Path); LocoTracker.ReloadAll(); }
                catch (Exception e) { modEntry.Logger.Error(e.ToString()); }
            }
            if (Settings.showDebug)
            {
                var synths = LocoTracker.Synths.ToList();
                GUILayout.Label("Отслеживается локомотивов: " + synths.Count);
                foreach (var s in synths) GUILayout.Label("  " + s.DebugLine());
            }
        }
    }
}
