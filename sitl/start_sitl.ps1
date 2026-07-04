# Launch ArduCopter SITL + the MAVLink fan-out mux so BOTH Mission Planner and
# the Field Mission Planner app can share one simulated copter.
#
#   SITL :5760  ──►  mux  ──►  :5762  Mission Planner  (Connect → TCP → 127.0.0.1:5762)
#                          └─►  :5763  our app          (Політ → TCP → 127.0.0.1:5763)
#
# Run:  powershell -ExecutionPolicy Bypass -File sitl\start_sitl.ps1

$sitl = $PSScriptRoot
$py = Join-Path (Split-Path $sitl -Parent) ".venv\Scripts\python.exe"

# Clean any previous run.
Get-Process ArduCopter -ErrorAction SilentlyContinue | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -like '*sitl_mux*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep 1

# ArduCopter SITL (home near Lviv). test_params.parm sets arming off, the
# WP_SPD/lean params for fast missions, and safety-switch off. No -w (single
# boot = more stable on this cygwin build). The mux holds SERIAL0 (:5760) open
# so GCS connect/disconnect on :5762/:5763 never drops it (which would exit SITL).
$a = @("-M", "quad", "--home", "49.5275,24.004,200,0", "-I0",
       "--defaults", "test_params.parm")
Start-Process -FilePath "$sitl\ArduCopter.exe" -ArgumentList $a -WorkingDirectory $sitl `
    -WindowStyle Minimized -RedirectStandardOutput "$sitl\sitl_run.log" `
    -RedirectStandardError "$sitl\sitl_err.log"
Start-Sleep -Seconds 12

# Fan-out mux.
Start-Process -FilePath $py -ArgumentList @("$sitl\sitl_mux.py") -WorkingDirectory $sitl `
    -WindowStyle Minimized -RedirectStandardOutput "$sitl\mux.log" `
    -RedirectStandardError "$sitl\mux_err.log"
Start-Sleep -Seconds 4

Write-Output ("SITL running: " + (Get-Process ArduCopter -ErrorAction SilentlyContinue).Count)
netstat -an | Select-String "576[023]" | Select-Object -First 4
Write-Output "Mission Planner: Connect -> TCP -> 127.0.0.1 : 5762"
Write-Output "Our app (Politit): TCP -> 127.0.0.1:5763"
