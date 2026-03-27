# ============================================================================
# Test mem0 compressContext: quality + performance benchmark
# Purpose: Evaluate compression latency, ratio, and quality on varied text types
# ============================================================================

param(
	[string]$Mem0Url = "http://127.0.0.1:18000",
	[int]$Repeats = 1,
	[int]$TimeoutSec = 90
)

$ErrorActionPreference = "Stop"

$codeNoise = @"
function fetchUsers() {
  return db.query('select * from users');
}

function saveUser(u) {
  // TODO: handle retry
  return db.insert('users', u);
}
"@

$logNoiseBlock = @"
[INFO] scheduler tick=1 queue=91
[WARN] retrying worker id=alpha due to timeout
[ERROR] cannot read properties of undefined (reading 'map')
[DEBUG] stack: at renderItem (List.tsx:184)
[INFO] recovered with fallback serializer
[WARN] deprecation: legacy parser will be removed in next release
[ERROR] failed to open tcp socket: connect ETIMEDOUT
[INFO] build artifact uploaded: part-17.tar.gz
"@

$chatNoiseBlock = @"
User: can you explain this stack trace?
Assistant: sure, looks related to async ordering.
User: I also saw this only once in staging.
Assistant: let's inspect logs around 10:32.
User: maybe cache invalidation?
Assistant: possible, but we need more data.
"@

$cases = @(
	@{
		Label = "1. Long log-heavy noise"
		Input = @"
1. [INFO] build started at 10:21:00
2. [WARN] deprecated package found
3. [ERROR] cannot read property map of undefined
4. Team standard package manager is pnpm.
5. [INFO] retrying chunk 3/5
6. [ERROR] timeout while contacting api
7. Uses pnpm workspace protocol in monorepo.
8. [WARN] memory usage 92%
9. [INFO] diagnostic dump follows:
$($logNoiseBlock * 12)
10. [INFO] session chat transcript follows:
$($chatNoiseBlock * 8)
11. [ERROR] more runtime traces:
$($logNoiseBlock * 10)
"@
		RequiredKeywords = @("pnpm", "workspace")
		MinRatio = 0.20
		MaxRatio = 0.95
	},
	@{
		Label = "2. Long code-heavy content"
		Input = @"
1. Prefers TypeScript strict mode and noImplicitAny.
2. $codeNoise
3. Uses Vitest for unit tests.
4. $codeNoise
5. Package manager is pnpm.
6. $codeNoise
7. Extended repository snippets:
$($codeNoise * 25)
8. Interleaved debug logs:
$($logNoiseBlock * 9)
9. Troubleshooting chat transcript:
$($chatNoiseBlock * 7)
"@
		RequiredKeywords = @("typescript", "strict", "vitest", "pnpm")
		MinRatio = 0.15
		MaxRatio = 0.90
	},
	@{
		Label = "3. Long bilingual facts"
		Input = @"
1. 我偏好 TypeScript 严格模式。
2. 部署平台是 Vercel，前端框架是 Next.js。
3. 团队统一使用 PostgreSQL 15。
4. I always use Jest and React Testing Library.
5. 目前正在排查一条偶发报错，但这是临时问题。
6. We standardize on pnpm workspaces and turbo caching across the monorepo.
7. 我们把部署区域固定在 AWS us-east-1，这个决策不会频繁变化。
8. I prefer strict lint + typecheck gates on pull requests.
9. 以下是临时排障聊天记录：
$($chatNoiseBlock * 16)
10. Additional stack and logs:
$($logNoiseBlock * 12)
11. Repeat mixed code snippets:
$($codeNoise * 16)
12. 临时错误信息：
$($logNoiseBlock * 8)
"@
		RequiredKeywords = @("typescript", "vercel", "next", "postgresql", "jest", "pnpm", "us-east-1")
		MinRatio = 0.20
		MaxRatio = 0.95
	}
)

function Test-IsNumberedList {
	param([string]$Text)

	if ([string]::IsNullOrWhiteSpace($Text)) {
		return $false
	}

	$numberedLines = @($Text -split "`r?`n" | Where-Object { $_ -match "^\s*\d+\.\s+" })
	return $numberedLines.Count -gt 0
}

function Evaluate-CompressionQuality {
	param(
		[hashtable]$Case,
		[string]$Output,
		[double]$Ratio,
		[bool]$Ok
	)

	if (-not $Ok) {
		return [PSCustomObject]@{
			score = 0
			pass = $false
			reason = "request failed"
		}
	}

	$score = 100
	$reasons = @()

	if (-not (Test-IsNumberedList -Text $Output)) {
		$score -= 20
		$reasons += "output is not a numbered list"
	}

	$normalized = $Output.ToLowerInvariant()

	foreach ($kw in $Case.RequiredKeywords) {
		if (-not $normalized.Contains($kw.ToLowerInvariant())) {
			$score -= 12
			$reasons += "missing keyword: $kw"
		}
	}

	if ($Ratio -gt [double]$Case.MaxRatio) {
		$score -= 10
		$reasons += "under-compressed (ratio too high)"
	}

	if ([string]::IsNullOrWhiteSpace($Output)) {
		$score -= 70
		$reasons += "empty output"
	}

	if ($score -lt 0) {
		$score = 0
	}

	if ($reasons.Count -eq 0) {
		$reasons = @("meets expected compression pattern")
	}

	return [PSCustomObject]@{
		score = [int]$score
		pass = [bool]($score -ge 70)
		reason = ($reasons -join "; ")
	}
}

function Invoke-CompressCase {
	param(
		[hashtable]$Case,
		[string]$BaseUrl,
		[int]$Timeout
	)

	$inputText = [string]$Case.Input
	$inputChars = $inputText.Length

	$payload = @{ text = $inputText } | ConvertTo-Json -Depth 2
	$payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
	$sw = [System.Diagnostics.Stopwatch]::StartNew()

	try {
		$resp = Invoke-WebRequest -Uri "$BaseUrl/compress" -Method POST -ContentType "application/json" -Body $payloadBytes -TimeoutSec $Timeout
		$sw.Stop()

		$obj = $resp.Content | ConvertFrom-Json
		$outputText = [string]$obj.compressed
		$outputChars = $outputText.Length
		$ratio = if ($inputChars -gt 0) { [math]::Round($outputChars / [double]$inputChars, 4) } else { 0 }
		$savingsRate = if ($inputChars -gt 0) { [math]::Round((1 - ($outputChars / [double]$inputChars)) * 100, 2) } else { 0 }
		$quality = Evaluate-CompressionQuality -Case $Case -Output $outputText -Ratio $ratio -Ok $true

		return [PSCustomObject]@{
			label = $Case.Label
			ok = $true
			status = [int]$resp.StatusCode
			ms = [int]$sw.ElapsedMilliseconds
			inputChars = [int]$inputChars
			outputChars = [int]$outputChars
			ratio = [double]$ratio
			savingsRate = [double]$savingsRate
			isNumbered = [bool](Test-IsNumberedList -Text $outputText)
			qualityScore = [int]$quality.score
			qualityPass = [bool]$quality.pass
			qualityReason = [string]$quality.reason
			preview = if ($outputText.Length -gt 220) { $outputText.Substring(0, 220) + "..." } else { $outputText }
			error = ""
		}
	} catch {
		$sw.Stop()
		$quality = Evaluate-CompressionQuality -Case $Case -Output "" -Ratio 1 -Ok $false

		return [PSCustomObject]@{
			label = $Case.Label
			ok = $false
			status = 0
			ms = [int]$sw.ElapsedMilliseconds
			inputChars = [int]$inputChars
			outputChars = 0
			ratio = 1.0
			savingsRate = 0
			isNumbered = $false
			qualityScore = [int]$quality.score
			qualityPass = [bool]$quality.pass
			qualityReason = [string]$quality.reason
			preview = ""
			error = [string]$_.Exception.Message
		}
	}
}

Write-Host "`n=== mem0 compressContext Benchmark ===" -ForegroundColor Cyan
Write-Host "Mem0Url     : $Mem0Url"
Write-Host "Repeats     : $Repeats"
Write-Host "TimeoutSec  : $TimeoutSec"

$all = @()

for ($round = 1; $round -le $Repeats; $round++) {
	Write-Host "`n--- Round $round/$Repeats ---" -ForegroundColor DarkCyan

	foreach ($case in $cases) {
		Write-Host "Running case: $($case.Label)"
		$res = Invoke-CompressCase -Case $case -BaseUrl $Mem0Url -Timeout $TimeoutSec
		$all += $res

		if ($res.ok) {
			Write-Host ("  ok ms={0} ratio={1:P1} savings={2}% quality={3} pass={4}" -f $res.ms, $res.ratio, $res.savingsRate, $res.qualityScore, $res.qualityPass) -ForegroundColor Green
		} else {
			Write-Host ("  err ms={0} msg={1}" -f $res.ms, $res.error) -ForegroundColor Red
		}
	}
}

Write-Host "`n=== Summary (Overall) ===" -ForegroundColor Cyan
$total = $all.Count
$okCount = ($all | Where-Object { $_.ok }).Count
$qualityPassCount = ($all | Where-Object { $_.qualityPass }).Count
$avgMs = [int](($all | Measure-Object ms -Average).Average)
$avgRatio = [double](($all | Measure-Object ratio -Average).Average)
$avgSavings = [double](($all | Measure-Object savingsRate -Average).Average)
$avgQuality = [int](($all | Measure-Object qualityScore -Average).Average)

Write-Host ("Samples        : {0}" -f $total)
Write-Host ("Success rate   : {0:P0}" -f ($okCount / [Math]::Max(1, $total)))
Write-Host ("Quality pass   : {0:P0}" -f ($qualityPassCount / [Math]::Max(1, $total)))
Write-Host ("Avg latency    : {0}ms" -f $avgMs)
Write-Host ("Avg ratio      : {0:P1}" -f $avgRatio)
Write-Host ("Avg savings    : {0:N2}%" -f $avgSavings)
Write-Host ("Avg quality    : {0}/100" -f $avgQuality)

Write-Host "`n=== Summary (By Case) ===" -ForegroundColor Cyan
$byCase = $all | Group-Object label | ForEach-Object {
	$g = @($_.Group)
	$sampleCount = $g.Count
	$successCount = ($g | Where-Object { $_.ok }).Count
	$qualityPassCount = ($g | Where-Object { $_.qualityPass }).Count

	[PSCustomObject]@{
		case = $_.Name
		samples = $sampleCount
		successRate = "{0:P0}" -f ($successCount / [double][Math]::Max(1, $sampleCount))
		qualityPassRate = "{0:P0}" -f ($qualityPassCount / [double][Math]::Max(1, $sampleCount))
		avgMs = [int](($g | Measure-Object ms -Average).Average)
		avgRatio = [double](($g | Measure-Object ratio -Average).Average)
		avgSavings = [double](($g | Measure-Object savingsRate -Average).Average)
		avgQuality = [int](($g | Measure-Object qualityScore -Average).Average)
	}
}
$byCase | Sort-Object case | Format-Table -AutoSize

Write-Host "`n=== Per-case Detail ===" -ForegroundColor Cyan
$all | Select-Object label, ms, inputChars, outputChars, ratio, savingsRate, qualityScore, qualityPass, isNumbered | Format-Table -AutoSize

Write-Host "`n=== Output Previews ===" -ForegroundColor Cyan
$all | Select-Object label, preview, qualityReason | Format-List

$outFile = Join-Path $PSScriptRoot ("mem0-compress-context-results-{0}.json" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
$all | ConvertTo-Json -Depth 8 | Set-Content -Path $outFile -Encoding UTF8
Write-Host "`nSaved raw results to: $outFile" -ForegroundColor Yellow
