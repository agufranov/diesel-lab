# Сборка мода Diesel Lab для Derail Valley (Unity Mod Manager).
#   powershell -File mod\build.ps1                 — собрать в mod\out\DieselLab и mod\out\DieselLab.zip
#   powershell -File mod\build.ps1 -Install        — ещё и скопировать в <игра>\Mods\DieselLab
# Нужны: Derail Valley (ссылки на её DLL), Node.js (presets.js → presets.json),
# компилятор C# из Visual Studio Build Tools (Roslyn csc.exe).
param(
  [string]$GameDir = 'D:\Steam\steamapps\common\Derail Valley',
  [switch]$Install
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$managed = Join-Path $GameDir 'DerailValley_Data\Managed'
$out = Join-Path $PSScriptRoot 'out\DieselLab'

$csc = Get-ChildItem 'C:\Program Files*\Microsoft Visual Studio\*\*\MSBuild\Current\Bin\Roslyn\csc.exe' -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $csc) { throw 'Не найден csc.exe: поставьте Visual Studio Build Tools (C#)' }
if (-not (Test-Path $managed)) { throw "Нет папки игры: $managed (укажите -GameDir)" }

New-Item -ItemType Directory -Force $out | Out-Null
node (Join-Path $root 'tools\gen-presets.js') (Join-Path $out 'presets.json')
if ($LASTEXITCODE -ne 0) { throw 'gen-presets.js упал' }
Copy-Item (Join-Path $PSScriptRoot 'DieselLab\Info.json'), (Join-Path $PSScriptRoot 'DieselLab\engines.json') $out -Force

$refs = @(
  'mscorlib.dll', 'netstandard.dll', 'System.dll', 'System.Core.dll',
  'UnityEngine.dll', 'UnityEngine.CoreModule.dll', 'UnityEngine.AudioModule.dll', 'UnityEngine.IMGUIModule.dll',
  'Assembly-CSharp.dll', 'DV.Simulation.dll', 'DV.LayeredAudio.dll', 'DV.ThingTypes.dll', 'DV.Utils.dll',
  'Newtonsoft.Json.dll', 'UnityModManager\UnityModManager.dll'
) | ForEach-Object { '-r:' + (Join-Path $managed $_) }

$src = Get-ChildItem (Join-Path $PSScriptRoot 'src') -Filter *.cs | ForEach-Object { $_.FullName }
& $csc -nologo -nostdlib -noconfig -langversion:9 -optimize+ -target:library -nowarn:1701,1702,0649 `
  "-out:$(Join-Path $out 'DieselLab.dll')" @refs @src
if ($LASTEXITCODE -ne 0) { throw 'Ошибка компиляции' }

$zip = Join-Path $PSScriptRoot 'out\DieselLab.zip'
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path $out -DestinationPath $zip
Write-Host "Готово: $out  и  $zip"

if ($Install) {
  $dst = Join-Path $GameDir 'Mods\DieselLab'
  New-Item -ItemType Directory -Force $dst | Out-Null
  # свой engines.json пользователя не трогаем
  Get-ChildItem $out | Where-Object { -not ($_.Name -eq 'engines.json' -and (Test-Path (Join-Path $dst 'engines.json'))) } |
    Copy-Item -Destination $dst -Force
  Write-Host "Установлено в $dst"
}
