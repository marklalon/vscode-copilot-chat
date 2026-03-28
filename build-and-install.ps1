# build-and-install.ps1
# Re-launches itself as a detached process to survive VS Code terminal shutdown.

if (-not $env:VSCODE_BUILD_DETACHED) {
    $env:VSCODE_BUILD_DETACHED = "1"
    Start-Process powershell.exe -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $MyInvocation.MyCommand.Path
    exit
}

$ProjectDir = Split-Path $MyInvocation.MyCommand.Path

Set-Location $ProjectDir

Write-Host '=== [1/5] Compiling...' -ForegroundColor Cyan
npm run compile
if ($LASTEXITCODE -ne 0) { Write-Host 'Compile failed!' -ForegroundColor Red; pause; exit 1 }

Write-Host '=== [2/5] Packaging VSIX...' -ForegroundColor Cyan
Copy-Item 'package.json' 'package.json.bak' -Force
npm run package
$packExit = $LASTEXITCODE
Copy-Item 'package.json.bak' 'package.json' -Force
Remove-Item 'package.json.bak' -Force
if ($packExit -ne 0) { Write-Host 'Package failed!' -ForegroundColor Red; pause; exit 1 }

$vsix = Get-ChildItem -Path $ProjectDir -Filter '*.vsix' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $vsix) { Write-Host 'No VSIX found!' -ForegroundColor Red; pause; exit 1 }
Write-Host "Using: $($vsix.Name)" -ForegroundColor Green

Write-Host '=== [3/5] Closing VS Code...' -ForegroundColor Cyan
Get-Process -Name Code -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3

Write-Host '=== [4/5] Extracting VSIX to extensions dir...' -ForegroundColor Cyan
$extDir = Join-Path $env:USERPROFILE '.vscode\extensions'
$destDir = Get-ChildItem -Path $extDir -Directory -Filter 'github.copilot-chat-*' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $destDir) {
    $version = ($vsix.BaseName -replace '^.*-','')
    $destDir = New-Item -ItemType Directory -Path (Join-Path $extDir "github.copilot-chat-$version")
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($vsix.FullName)
foreach ($entry in $zip.Entries) {
    if (-not $entry.FullName.StartsWith('extension/')) { continue }
    $rel = $entry.FullName.Substring('extension/'.Length)
    if ($rel -eq '') { continue }
    $target = Join-Path $destDir.FullName $rel
    if ($entry.FullName.EndsWith('/')) {
        New-Item -ItemType Directory -Path $target -Force | Out-Null
    } else {
        New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
    }
}
$zip.Dispose()

Write-Host '=== [5/5] Launching VS Code...' -ForegroundColor Cyan
Start-Process -FilePath "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
Write-Host '=== Done!' -ForegroundColor Green
