# Remove the heavy AI libraries from the local .venv AFTER the AI server is live
# and FMP_AI_SERVER is set. Frees ~0.9-1 GB. Field auto-detect then runs only via
# the server; manual draw / OSM / routes / MAVLink stay fully local.
#
# DO NOT run this until the remote AI server works — it removes local SAM.
$ErrorActionPreference = "Stop"
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

if (-not $env:FMP_AI_SERVER) {
    Write-Warning "FMP_AI_SERVER is not set. Without a working AI server, removing torch breaks field auto-detect."
    Write-Output "Set it first:  `$env:FMP_AI_SERVER = 'https://your-ai-server'"
    if ((Read-Host "Continue anyway? (y/N)") -ne "y") { return }
}

Write-Output "Before: $([math]::Round((Get-ChildItem (Join-Path $PSScriptRoot '.venv') -Recurse -File | Measure-Object Length -Sum).Sum/1MB)) MB"
& $py -m pip uninstall -y torch ultralytics opencv-python scipy scikit-image
& $py -m pip cache purge
Write-Output "After:  $([math]::Round((Get-ChildItem (Join-Path $PSScriptRoot '.venv') -Recurse -File | Measure-Object Length -Sum).Sum/1MB)) MB"
Write-Output "Done. Field auto-detect now requires FMP_AI_SERVER. Manual draw / OSM / MAVLink remain local."
