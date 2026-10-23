// Раз в секунду находит локомотивы с дизелем (компонент симуляции DieselEngineDirect)
// и вешает на каждый синтезатор LocoSynth.
using System.Collections.Generic;
using System.Linq;
using LocoSim.Implementations;
using UnityEngine;

namespace DieselLab
{
    public class LocoTracker : MonoBehaviour
    {
        static readonly HashSet<LocoSynth> synths = new HashSet<LocoSynth>();
        public static IEnumerable<LocoSynth> Synths { get { synths.RemoveWhere(s => s == null); return synths; } }

        public static void Register(LocoSynth s) { synths.Add(s); }
        public static void Unregister(LocoSynth s) { synths.Remove(s); }

        public static void ReloadAll()
        {
            foreach (var s in Synths.ToList()) s.Reconfigure();
        }

        float nextScan;

        void Update()
        {
            if (Time.unscaledTime < nextScan) return;
            nextScan = Time.unscaledTime + 1f;
            var spawner = CarSpawner.Instance;
            if (spawner == null) return;
            foreach (var car in spawner.AllCars)
            {
                if (car == null || !car.IsLoco) continue;
                if (car.GetComponentInChildren<LocoSynth>(true) != null) continue;
                var engine = FindEngine(car);
                if (engine == null) continue;
                var go = new GameObject("DieselLabSynth");
                go.transform.SetParent(car.transform, false);
                go.transform.localPosition = new Vector3(0, 2.5f, 0);
                go.AddComponent<LocoSynth>().Init(car, engine);
            }
        }

        public static DieselEngineDirect FindEngine(TrainCar car)
        {
            var flow = car.SimController != null ? car.SimController.SimulationFlow : null;
            if (flow == null || flow.OrderedSimComps == null) return null;
            foreach (var comp in flow.OrderedSimComps)
                if (comp is DieselEngineDirect d) return d;
            return null;
        }

        void OnDestroy()
        {
            foreach (var s in Synths.ToList())
                if (s != null) Destroy(s.gameObject);
            synths.Clear();
        }
    }
}
