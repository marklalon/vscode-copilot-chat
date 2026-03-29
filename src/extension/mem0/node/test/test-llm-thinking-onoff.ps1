# ============================================================================
# Test LLM Thinking On/Off (Direct LLM only, bypass mem0)
# Purpose: Compare response quality and latency with thinking enabled/disabled
# ============================================================================

param(
    [string]$LlmUrl = "http://127.0.0.1:18081/v1",
    [string]$Model = "Qwen3.5-9B-NVFP4",
    [int]$Repeats = 1,
    [int]$TimeoutSec = 90,
    [int]$MaxTokens = 256
)

$ErrorActionPreference = "Stop"

$memoryPrompt = @"
Extract durable long-term memory from the following conversation.

Keep only:
- stable user preferences
- long-term constraints or requirements
- durable personal or project facts
- important technical or project decisions

Ignore:
- temporary tasks or short-term plans
- progress updates, debugging details, or current status
- one-time requests, examples, guesses, or unverified claims
- raw conversation text or assistant promises

Return EXACTLY this JSON shape:
{"facts": ["fact 1", "fact 2"]}

Rules:
- facts must be short standalone sentences
- use the same language as the conversation
- if nothing is durable, return {"facts": []}
- output JSON only, no markdown or extra text
"@

$cases = @(
    @{
        Label = "short-preference"
        Input = "Input:`nUser: I always use TypeScript strict mode and prefer Jest for tests.`nAssistant: Noted."
        ExpectedMinFacts = 1
    },
    @{
        Label = "tech-stack"
        Input = "Input:`nUser: Our project uses React + Next.js and deploys to Vercel.`nAssistant: Understood."
        ExpectedMinFacts = 1
    },
    @{
        Label = "one-time-request"
        Input = "Input:`nUser: Show me multiple BST implementations.`nAssistant: Here are examples with code blocks and temporary debugging notes."
        ExpectedMinFacts = 0
    },
    @{
        Label = "mixed-long"
        Input = "Input:`nUser: I prefer dark mode. I am currently debugging a null pointer. Team decided to keep PostgreSQL 15.`nAssistant: Acknowledged."
        ExpectedMinFacts = 2
    }
)

$modes = @(
    @{ Name = "chat_template_kwargs_false"; Extra = @{ chat_template_kwargs = @{ enable_thinking = $false } } },
    @{ Name = "chat_template_kwargs_on"; Extra = @{ chat_template_kwargs = @{ enable_thinking = $true } } }
)

function Get-JsonObjectFromText {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $null
    }

    $start = $Text.IndexOf('{')
    $end = $Text.LastIndexOf('}')
    if ($start -lt 0 -or $end -le $start) {
        return $null
    }

    $candidate = $Text.Substring($start, $end - $start + 1)
    try {
        return ($candidate | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Invoke-LLM {
    param(
        [string]$ModeName,
        [hashtable]$Extra,
        [string]$Conversation,
        [string]$CaseLabel,
        [int]$ExpectedMinFacts
    )

    $body = @{
        model = $Model
        temperature = 0
        max_tokens = $MaxTokens
        messages = @(
            @{ role = "system"; content = $memoryPrompt },
            @{ role = "user"; content = $Conversation }
        )
    }

    foreach ($k in $Extra.Keys) {
        $body[$k] = $Extra[$k]
    }

    $payload = $body | ConvertTo-Json -Depth 8
    $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $resp = Invoke-WebRequest -Uri "$LlmUrl/chat/completions" -Method POST -ContentType "application/json" -Body $payloadBytes -TimeoutSec $TimeoutSec
        $sw.Stop()

        $obj = $resp.Content | ConvertFrom-Json
        $text = [string]$obj.choices[0].message.content
        $usage = $obj.usage

        $hasThinking = $text -match "<think>|</think>|Thinking Process:|^\s*Thought:"
        $parsedJson = Get-JsonObjectFromText -Text $text
        $jsonParsable = $parsedJson -ne $null -and $parsedJson.PSObject.Properties.Name -contains "facts"

        $factsCount = 0
        if ($jsonParsable -and $parsedJson.facts -is [System.Array]) {
            $factsCount = $parsedJson.facts.Count
        }

        $qualityPass = $false
        if ($ExpectedMinFacts -eq 0) {
            $qualityPass = ($factsCount -eq 0)
        } else {
            $qualityPass = ($factsCount -ge $ExpectedMinFacts)
        }

        return [PSCustomObject]@{
            mode = $ModeName
            case = $CaseLabel
            ms = [int]$sw.ElapsedMilliseconds
            ok = $true
            timeout = $false
            promptTokens = [int]($usage.prompt_tokens)
            completionTokens = [int]($usage.completion_tokens)
            hasThinking = [bool]$hasThinking
            jsonParsable = [bool]$jsonParsable
            factsCount = [int]$factsCount
            qualityPass = [bool]$qualityPass
            preview = if ($text.Length -gt 180) { $text.Substring(0, 180) + "..." } else { $text }
            err = ""
        }
    } catch {
        $sw.Stop()
        $msg = $_.Exception.Message
        $isTimeout = $msg -match "超时|timed out|timeout|aborted|中止"
        return [PSCustomObject]@{
            mode = $ModeName
            case = $CaseLabel
            ms = [int]$sw.ElapsedMilliseconds
            ok = $false
            timeout = [bool]$isTimeout
            promptTokens = 0
            completionTokens = 0
            hasThinking = $false
            jsonParsable = $false
            factsCount = 0
            qualityPass = $false
            preview = ""
            err = $msg
        }
    }
}

Write-Host "`n=== LLM Thinking On/Off Benchmark (Direct LLM) ===" -ForegroundColor Cyan
Write-Host "LlmUrl      : $LlmUrl"
Write-Host "Model       : $Model"
Write-Host "Repeats     : $Repeats"
Write-Host "TimeoutSec  : $TimeoutSec"
Write-Host "MaxTokens   : $MaxTokens"

$all = @()
for ($r = 1; $r -le $Repeats; $r++) {
    Write-Host "`n--- Round $r/$Repeats ---" -ForegroundColor DarkCyan
    foreach ($mode in $modes) {
        foreach ($case in $cases) {
            Write-Host "Running mode=$($mode.Name), case=$($case.Label)..."
            $res = Invoke-LLM -ModeName $mode.Name -Extra $mode.Extra -Conversation $case.Input -CaseLabel $case.Label -ExpectedMinFacts $case.ExpectedMinFacts
            $all += $res

            if ($res.ok) {
                Write-Host ("  ok ms={0} json={1} think={2} facts={3} pass={4}" -f $res.ms, $res.jsonParsable, $res.hasThinking, $res.factsCount, $res.qualityPass) -ForegroundColor Green
            } else {
                Write-Host ("  err ms={0} timeout={1} msg={2}" -f $res.ms, $res.timeout, $res.err) -ForegroundColor Red
            }
        }
    }
}

Write-Host "`n=== Mode Summary ===" -ForegroundColor Cyan
$summary = $all | Group-Object mode | ForEach-Object {
    $g = $_.Group
    $count = $g.Count
    $okCount = ($g | Where-Object { $_.ok }).Count
    $timeoutCount = ($g | Where-Object { $_.timeout }).Count
    $jsonCount = ($g | Where-Object { $_.jsonParsable }).Count
    $thinkCount = ($g | Where-Object { $_.hasThinking }).Count
    $qualityCount = ($g | Where-Object { $_.qualityPass }).Count
    $avgMs = [int](($g | Measure-Object ms -Average).Average)
    $avgPrompt = [int](($g | Measure-Object promptTokens -Average).Average)
    $avgCompletion = [int](($g | Measure-Object completionTokens -Average).Average)

    [PSCustomObject]@{
        mode = $_.Name
        samples = $count
        okRate = "{0:P0}" -f ($okCount / [Math]::Max(1, $count))
        timeoutRate = "{0:P0}" -f ($timeoutCount / [Math]::Max(1, $count))
        jsonRate = "{0:P0}" -f ($jsonCount / [Math]::Max(1, $count))
        thinkingLeakRate = "{0:P0}" -f ($thinkCount / [Math]::Max(1, $count))
        qualityPassRate = "{0:P0}" -f ($qualityCount / [Math]::Max(1, $count))
        avgMs = $avgMs
        avgPromptTokens = $avgPrompt
        avgCompletionTokens = $avgCompletion
    }
}

$summary | Sort-Object mode | Format-Table -AutoSize

Write-Host "`n=== Per-case Quick View ===" -ForegroundColor Cyan
$all | Select-Object mode, case, ms, ok, timeout, jsonParsable, hasThinking, factsCount, qualityPass | Format-Table -AutoSize
