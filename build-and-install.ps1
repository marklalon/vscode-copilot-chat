# build-and-install.ps1
# Re-launches itself as a detached process to survive VS Code terminal shutdown.

if ($env:TERM_PROGRAM -eq 'vscode' -or $env:VSCODE_INJECTION -eq '1') {
    Write-Host '请在独立的终端（如 PowerShell 或 Windows Terminal）中运行此脚本，不要在 VS Code 内置终端中运行。' -ForegroundColor Yellow
    exit 1
}

if (-not $env:VSCODE_BUILD_DETACHED) {
    $env:VSCODE_BUILD_DETACHED = "1"
    Start-Process powershell.exe -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $MyInvocation.MyCommand.Path
    exit
}

$ProjectDir = Split-Path $MyInvocation.MyCommand.Path

Set-Location $ProjectDir

Write-Host '=== [1/5] Building (release)...' -ForegroundColor Cyan
Copy-Item 'package.json' 'package.json.bak' -Force
npm run build
$buildExit = $LASTEXITCODE
if ($buildExit -ne 0) {
    Copy-Item 'package.json.bak' 'package.json' -Force
    Remove-Item 'package.json.bak' -Force
    Write-Host 'Build failed!' -ForegroundColor Red; pause; exit 1
}

Copy-Item 'package.json.bak' 'package.json' -Force
Remove-Item 'package.json.bak' -Force

Write-Host '=== [2/5] Packaging VSIX...' -ForegroundColor Cyan
npx vsce package --no-dependencies
$packExit = $LASTEXITCODE
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
