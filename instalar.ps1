# Instala la extensión «Mapa de agentes» en VS Code copiando sus archivos a ~/.vscode/extensions.
# Uso (PowerShell):  .\instalar.ps1     Luego en VS Code: Developer: Reload Window.
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$pkg = Get-Content "$src\package.json" -Raw | ConvertFrom-Json
$dst = Join-Path $env:USERPROFILE ".vscode\extensions\$($pkg.publisher).$($pkg.name)-$($pkg.version)"
New-Item -ItemType Directory -Force "$dst\media" | Out-Null
foreach ($f in 'package.json', 'extension.js', 'view.html', 'precios.json') { Copy-Item "$src\$f" "$dst\$f" -Force }
Copy-Item "$src\media\icon.svg" "$dst\media\icon.svg" -Force
Write-Host "Instalada en $dst. Recarga VS Code (Developer: Reload Window)."
