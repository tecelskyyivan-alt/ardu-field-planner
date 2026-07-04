# Create Desktop shortcuts for Field Mission Planner.
#
#   "Field Mission Planner"  -> STABLE build (app_qt_stable.py, serves web-stable/, v2.5.4)
#   "FMP BETA (тест)"         -> BETA build   (app_qt.py,        serves web/,        redesign)
#
# The main desktop icon stays on the stable, working version; the beta is a
# separate icon so testing the redesign never disturbs the stable app.
# Re-run this script any time to (re)create both shortcuts.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$pythonw = Join-Path $root ".venv\Scripts\pythonw.exe"
$icon = Join-Path $root "icon.ico"
if (-not (Test-Path $pythonw)) { throw "pythonw not found: $pythonw (create the .venv first)" }

$desktop = [Environment]::GetFolderPath("Desktop")   # respects OneDrive redirect
$shell = New-Object -ComObject WScript.Shell

function New-FmpShortcut($name, $scriptName, $desc) {
    $script = Join-Path $root $scriptName
    if (-not (Test-Path $script)) { throw "$scriptName not found: $script" }
    $lnkPath = Join-Path $desktop "$name.lnk"
    $sc = $shell.CreateShortcut($lnkPath)
    $sc.TargetPath = $pythonw          # pythonw.exe = GUI, no console window
    $sc.Arguments = "`"$script`""
    $sc.WorkingDirectory = $root
    if (Test-Path $icon) { $sc.IconLocation = $icon }
    $sc.WindowStyle = 1
    $sc.Description = $desc
    $sc.Save()
    Write-Output "Shortcut created: $lnkPath"
}

New-FmpShortcut "Field Mission Planner" "app_qt_stable.py" "Field Mission Planner (STABLE v2.5.4) - ArduCopter coverage planner"
New-FmpShortcut "FMP BETA (тест)"        "app_qt.py"        "Field Mission Planner BETA (redesign / testing) - ArduCopter"
