# ============================================================================
# Mem0 Clear Workspace Memory E2E Test
# Purpose: Real integration test against a running mem0 server.
# Flow: add -> verify exists -> delete all by user_id -> verify empty
# ============================================================================

param(
    [string]$Mem0Url = "http://127.0.0.1:18000",
    [string]$UserId = "workspace:e2e-clear-test",
    [int]$TimeoutSec = 20,
    [string]$ApiKey = ""
)

$ErrorActionPreference = "Stop"

function New-Headers {
    param([string]$ApiKey)

    $headers = @{ "Content-Type" = "application/json" }
    if (-not [string]::IsNullOrWhiteSpace($ApiKey)) {
        $headers["X-API-Key"] = $ApiKey
    }
    return $headers
}

function Invoke-Mem0Json {
    param(
        [string]$Method,
        [string]$Uri,
        [hashtable]$Headers,
        [object]$Body = $null,
        [int]$TimeoutSec = 20
    )

    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 20
        return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -Body $json -TimeoutSec $TimeoutSec
    }

    return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -TimeoutSec $TimeoutSec
}

function Get-MemoryCount {
    param(
        [string]$BaseUrl,
        [string]$UserId,
        [hashtable]$Headers,
        [int]$TimeoutSec
    )

    $resp = Invoke-Mem0Json -Method "GET" -Uri "$BaseUrl/memories?user_id=$([uri]::EscapeDataString($UserId))" -Headers $Headers -TimeoutSec $TimeoutSec
    if ($resp -is [System.Array]) {
        return $resp.Count
    }
    if ($null -ne $resp.results) {
        return @($resp.results).Count
    }
    return 0
}

function Clear-WorkspaceMemoriesWithRetry {
    param(
        [string]$BaseUrl,
        [string]$UserId,
        [hashtable]$Headers,
        [int]$TimeoutSec
    )

    $escapedUserId = [uri]::EscapeDataString($UserId)

    Invoke-Mem0Json -Method "DELETE" -Uri "$BaseUrl/memories?user_id=$escapedUserId" -Headers $Headers -TimeoutSec $TimeoutSec | Out-Null
    $remainingCount = Get-MemoryCount -BaseUrl $BaseUrl -UserId $UserId -Headers $Headers -TimeoutSec $TimeoutSec
    Write-Host "      count after first clear:  $remainingCount"

    if ($remainingCount -eq 0) {
        return 0
    }

    Write-Host "      retrying clear once because memories remain"
    Invoke-Mem0Json -Method "DELETE" -Uri "$BaseUrl/memories?user_id=$escapedUserId" -Headers $Headers -TimeoutSec $TimeoutSec | Out-Null
    $remainingCount = Get-MemoryCount -BaseUrl $BaseUrl -UserId $UserId -Headers $Headers -TimeoutSec $TimeoutSec
    Write-Host "      count after retry clear:  $remainingCount"
    return $remainingCount
}

$headers = New-Headers -ApiKey $ApiKey
$marker = "e2e-clear-marker-$(Get-Date -Format 'yyyyMMddHHmmss')"

Write-Host "[1/6] Health check: $Mem0Url/health"
$health = Invoke-Mem0Json -Method "GET" -Uri "$Mem0Url/health" -Headers $headers -TimeoutSec $TimeoutSec
if ($health.status -ne "ok") {
    throw "Health check failed: $($health | ConvertTo-Json -Depth 10)"
}

Write-Host "[2/6] Cleanup before test: DELETE /memories?user_id=$UserId"
$cleanupRemaining = Clear-WorkspaceMemoriesWithRetry -BaseUrl $Mem0Url -UserId $UserId -Headers $headers -TimeoutSec $TimeoutSec
if ($cleanupRemaining -ne 0) {
    throw "Pre-test cleanup failed: expected 0 memories, got $cleanupRemaining"
}

Write-Host "[3/6] Add memory: POST /memories"
$addBody = @{
    user_id = $UserId
    infer = $false
    messages = @(
        @{ role = "user"; content = "Please remember this marker: $marker" },
        @{ role = "assistant"; content = "Acknowledged marker: $marker" }
    )
}
$addResp = Invoke-Mem0Json -Method "POST" -Uri "$Mem0Url/memories" -Headers $headers -Body $addBody -TimeoutSec $TimeoutSec
$addedCount = @($addResp.results).Count
Write-Host "      add result count:     $addedCount"
if ($addedCount -le 0) {
    throw "E2E failed: add endpoint returned no created memories"
}

Write-Host "[4/6] Verify memory exists: GET /memories?user_id=$UserId"
$beforeCount = Get-MemoryCount -BaseUrl $Mem0Url -UserId $UserId -Headers $headers -TimeoutSec $TimeoutSec
Write-Host "      count before delete: $beforeCount"
if ($beforeCount -le 0) {
    throw "E2E failed: expected at least 1 memory before delete, got $beforeCount"
}

Write-Host "[5/6] Clear workspace memories: DELETE /memories?user_id=$UserId"
$afterClearCount = Clear-WorkspaceMemoriesWithRetry -BaseUrl $Mem0Url -UserId $UserId -Headers $headers -TimeoutSec $TimeoutSec

Write-Host "[6/6] Verify memory empty after delete: GET /memories?user_id=$UserId"
$afterCount = $afterClearCount
Write-Host "      count after delete:  $afterCount"
if ($afterCount -ne 0) {
    throw "E2E failed: expected 0 memories after delete, got $afterCount"
}

Write-Host "PASS: mem0 clear workspace memory E2E succeeded for user_id=$UserId" -ForegroundColor Green
