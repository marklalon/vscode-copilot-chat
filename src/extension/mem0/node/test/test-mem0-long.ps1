# ============================================================================
# Test mem0 only: latency + quality evaluation
# Purpose: Evaluate mem0 extraction quality for long-term memory (no direct LLM)
# ============================================================================

param(
    [string]$Mem0Url = "http://127.0.0.1:18000",
    [string]$UserId = "test-long-content",
    [int]$Repeats = 1,
    [int]$TimeoutSec = 120
)

$ErrorActionPreference = "Stop"

$codeBlock = @"
class TreeNode<T> {
  value: T;
  left: TreeNode<T> | null = null;
  right: TreeNode<T> | null = null;
  constructor(value: T) { this.value = value; }
}

class BinarySearchTree<T> {
  private root: TreeNode<T> | null = null;

  insert(value: T): void {
    const node = new TreeNode(value);
    if (!this.root) { this.root = node; return; }
    let current = this.root;
    while (true) {
      if (value < current.value) {
        if (!current.left) { current.left = node; return; }
        current = current.left;
      } else {
        if (!current.right) { current.right = node; return; }
        current = current.right;
      }
    }
  }

  search(value: T): boolean {
    let current = this.root;
    while (current) {
      if (value === current.value) return true;
      current = value < current.value ? current.left : current.right;
    }
    return false;
  }

  delete(value: T): void {
    // Complex deletion logic with three cases
  }

  inOrderTraversal(): T[] {
    const result: T[] = [];
    function traverse(node: TreeNode<T> | null) {
      if (!node) return;
      traverse(node.left);
      result.push(node.value);
      traverse(node.right);
    }
    traverse(this.root);
    return result;
  }
}
"@

# ── Long-session content fixtures ──────────────────────────────────────────

# Simulated 20-turn conversation history (buried facts + lots of noise)
$longHistoryUser = @"
Here is our full session history so far:

Turn 1: I prefer using TypeScript with strict mode for all my projects.
Turn 2: Can you help me debug this null pointer on line 42?
Turn 3: The team has agreed to use PostgreSQL 15 as the production database.
Turn 4: Let me paste the stack trace: TypeError: Cannot read properties of undefined (reading 'map') at Component.render (App.tsx:87)
Turn 5: How do I traverse a BST in order?
Turn 6: Currently the CI pipeline is failing because of a missing environment variable.
Turn 7: We deploy everything to AWS us-east-1. That's a long-term infrastructure decision.
Turn 8: Let me share the build log: [10:32:01] webpack compiled with 2 errors. Module not found: can't resolve './utils'.
Turn 9: I always write tests using Jest and React Testing Library - that's my standard.
Turn 10: I'm now looking at the component that handles payments. It might have a race condition.
Turn 11: Here's the relevant code snippet: useEffect(() => { fetchData(); }, []); The dependency array is probably wrong.
Turn 12: Can you check if TypeScript strict null checks would catch this?
Turn 13: Our monorepo uses Nx for task orchestration. That's been our structure for two years.
Turn 14: I'm seeing a 404 on /api/auth/session - could be a Next.js routing issue.
Turn 15: Currently working on the user authentication module for a private beta release.
Turn 16: I prefer functional components and hooks over class components.
Turn 17: We have a sprint deadline on Friday so I need to get this done quickly.
Turn 18: Do you know why useRef doesn't trigger re-renders?
Turn 19: I always use ESLint with the airbnb ruleset for all JavaScript/TypeScript projects.
Turn 20: Just fixed the issue - it was a missing await on the async call.
"@

$longHistoryAssistant = "Understood. I have reviewed the full session context."

# Simulated giant error log dump (no long-term facts)
$logNoiseDump = @"
Build log output:
[INFO] Starting build at 2026-03-27T10:00:00Z
[WARN] Deprecated API usage in node_modules/@babel/core
$("[ERROR] TypeError: Cannot read properties of undefined at Component.render (App.tsx:87:12)`n    at processChild (reconciler.js:214)`n    at React.createElement (react.development.js:512)`n" * 40)
[INFO] Retrying failed chunks...
[WARN] Memory usage: 87% of 4GB limit
[ERROR] Build failed after 3 retries. Check STDERR above.
"@

# Multi-turn messages array: dense real conversation with a few extractable facts
$multiTurnMessages = @(
    @{ role = "user"; content = "Our backend uses Go 1.22 and we picked gRPC over REST for all internal services." },
    @{ role = "assistant"; content = "Got it - Go 1.22 with gRPC for internal communication." },
    @{ role = "user"; content = "Now help me debug this: panic: runtime error: index out of range [5] with length 5" },
    @{ role = "assistant"; content = "That's an off-by-one error. Check your slice indexing." },
    @{ role = "user"; content = "Also, we use Argo CD for GitOps deployments - that's been decided." },
    @{ role = "assistant"; content = "Noted, Argo CD for GitOps." },
    @{ role = "user"; content = "What does this log mean: FATA[0003] failed to connect to db: dial tcp 127.0.0.1:5432: connect: connection refused" },
    @{ role = "assistant"; content = "Your Postgres isn't running. Start it with: systemctl start postgresql" },
    @{ role = "user"; content = "Right. Also our company standard is to use OpenTelemetry for all observability tooling." },
    @{ role = "assistant"; content = "Understood, OpenTelemetry as the observability standard." },
    @{ role = "user"; content = "Right now I'm fixing a race condition in the payment service - it should be done by EOD." },
    @{ role = "assistant"; content = "Good luck with the race condition fix." }
)

# ──────────────────────────────────────────────────────────────────────────────

$testCases = @(
    @{
        Label = "1. SHORT preference"
        User = "I prefer using TypeScript with strict mode"
        Assistant = "Got it, I'll use TypeScript strict mode for all projects."
        ExpectedMinFacts = 1
        ExpectedMaxFacts = 3
        RequiredKeywords = @("typescript", "strict")
        ForbiddenKeywords = @("debug", "error", "line")
    },
    @{
        Label = "2. Tech stack"
        User = "My project uses React with Next.js and I deploy to Vercel"
        Assistant = "Noted. Your tech stack is React with Next.js deployed on Vercel."
        ExpectedMinFacts = 1
        ExpectedMaxFacts = 4
        RequiredKeywords = @("react", "next", "vercel")
        ForbiddenKeywords = @("today", "currently", "debug")
    },
    @{
        Label = "3. Code with natural language"
        User = "How do I implement a binary search tree in TypeScript?"
        Assistant = "Here is a BST implementation in TypeScript:`n`n$codeBlock"
        ExpectedMinFacts = 0
        ExpectedMaxFacts = 0
        RequiredKeywords = @()
        ForbiddenKeywords = @("bst", "binary search tree", "implementation")
    },
    @{
        Label = "4. Code-heavy (10K chars)"
        User = "Show me multiple BST implementations"
        Assistant = ("Here are multiple BST variations:`n`n" + ("$codeBlock`n`n" * 8))
        ExpectedMinFacts = 0
        ExpectedMaxFacts = 0
        RequiredKeywords = @()
        ForbiddenKeywords = @("bst", "implementation", "variation")
    },
    @{
        Label = "5. Long history dump - facts buried in noise (3K chars)"
        User = $longHistoryUser
        Assistant = $longHistoryAssistant
        ExpectedMinFacts = 3
        ExpectedMaxFacts = 10
        RequiredKeywords = @("typescript", "postgresql")
        ForbiddenKeywords = @("sprint", "deadline", "currently", "null pointer", "stack trace")
    },
    @{
        Label = "6. Giant log/error dump - no long-term facts"
        User = "Can you analyze this build output?"
        Assistant = $logNoiseDump
        ExpectedMinFacts = 0
        ExpectedMaxFacts = 0
        RequiredKeywords = @()
        ForbiddenKeywords = @("error", "warn", "build", "retry", "deprecated")
    },
    @{
        Label = "7. Multi-turn conversation - facts mixed with debugging"
        Messages = $multiTurnMessages
        ExpectedMinFacts = 2
        ExpectedMaxFacts = 6
        RequiredKeywords = @("grpc", "argo")
        ForbiddenKeywords = @("panic", "race condition", "eod", "connection refused")
    },
    @{
        Label = "8. Extremely long single assistant response (30K chars)"
        User = "Give me an exhaustive tutorial on binary search trees."
        Assistant = ("Here is a comprehensive BST tutorial with many examples:`n`n" + ("$codeBlock`n`n" * 25) + "`nThis tutorial covered: insert, delete, search, and traversal.
https://en.wikipedia.org/wiki/Binary_search_tree")
        ExpectedMinFacts = 0
        ExpectedMaxFacts = 3
        RequiredKeywords = @()
        ForbiddenKeywords = @("bst", "traversal", "insert")
    }
)

function Remove-TestUserMemories {
    param([string]$BaseUrl, [string]$Uid)

    try {
        Invoke-WebRequest -Uri "$BaseUrl/memories?user_id=$([uri]::EscapeDataString($Uid))" -Method DELETE -TimeoutSec 20 | Out-Null
        Write-Host "Cleanup user memories: done ($Uid)" -ForegroundColor DarkGray
    } catch {
        Write-Host "Cleanup user memories: skipped ($($_.Exception.Message))" -ForegroundColor DarkYellow
    }
}

function Evaluate-Quality {
    param(
        [string[]]$Memories,
        [hashtable]$Case,
        [bool]$Ok
    )

    if (-not $Ok) {
        return [PSCustomObject]@{ score = 0; pass = $false; reason = "request failed" }
    }

    $count = $Memories.Count
    $score = 100
    $reasons = @()

    if ($count -lt [int]$Case.ExpectedMinFacts -or $count -gt [int]$Case.ExpectedMaxFacts) {
        $score -= 50
        $reasons += "fact count out of expected range"
    }

    $joined = ($Memories -join " || ").ToLowerInvariant()

    foreach ($kw in $Case.RequiredKeywords) {
        if (-not $joined.Contains($kw.ToLowerInvariant())) {
            $score -= 20
            $reasons += "missing keyword: $kw"
        }
    }

    foreach ($kw in $Case.ForbiddenKeywords) {
        if ($joined.Contains($kw.ToLowerInvariant())) {
            $score -= 20
            $reasons += "contains temporary keyword: $kw"
        }
    }

    if ($score -lt 0) { $score = 0 }
    $pass = $score -ge 70

    if ($reasons.Count -eq 0) {
        $reasons = @("meets expected long-term extraction pattern")
    }

    return [PSCustomObject]@{
        score = [int]$score
        pass = [bool]$pass
        reason = ($reasons -join "; ")
    }
}

function Invoke-Mem0Case {
    param(
        [hashtable]$Case,
        [string]$CaseUserId
    )

    $msgArray = if ($Case.ContainsKey("Messages")) {
        $Case.Messages
    } else {
        @(
            @{ role = "user"; content = $Case.User },
            @{ role = "assistant"; content = $Case.Assistant }
        )
    }

    $totalChars = ($msgArray | ForEach-Object { [string]$_.content } | Measure-Object Length -Sum).Sum

    $body = @{
        messages = $msgArray
        user_id = $CaseUserId
    } | ConvertTo-Json -Depth 10

    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $r = Invoke-WebRequest -Uri "$Mem0Url/memories" -Method POST -ContentType "application/json" -Body $bodyBytes -TimeoutSec $TimeoutSec
        $sw.Stop()

        $parsed = $r.Content | ConvertFrom-Json
        $results = @($parsed.results)
        $memories = @($results | ForEach-Object { [string]$_.memory } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        $events = @($results | ForEach-Object { [string]$_.event })

        $quality = Evaluate-Quality -Memories $memories -Case $Case -Ok $true

        return [PSCustomObject]@{
            label = $Case.Label
            status = [int]$r.StatusCode
            ok = $true
            ms = [int]$sw.ElapsedMilliseconds
            inputChars = [int]$totalChars
            count = $memories.Count
            events = ($events -join ",")
            memories = $memories
            qualityScore = [int]$quality.score
            qualityPass = [bool]$quality.pass
            qualityReason = [string]$quality.reason
            error = ""
        }
    } catch {
        $sw.Stop()
        $quality = Evaluate-Quality -Memories @() -Case $Case -Ok $false

        return [PSCustomObject]@{
            label = $Case.Label
            status = 0
            ok = $false
            ms = [int]$sw.ElapsedMilliseconds
            inputChars = [int]$totalChars
            count = 0
            events = ""
            memories = @()
            qualityScore = [int]$quality.score
            qualityPass = [bool]$quality.pass
            qualityReason = [string]$quality.reason
            error = [string]$_.Exception.Message
        }
    }
}

Write-Host "`n=== mem0 Extraction Benchmark (mem0 only) ===" -ForegroundColor Cyan
Write-Host "Mem0Url    : $Mem0Url"
Write-Host "UserId     : $UserId"
Write-Host "Repeats    : $Repeats"
Write-Host "TimeoutSec : $TimeoutSec"

$all = @()
for ($round = 1; $round -le $Repeats; $round++) {
    Write-Host "`n--- Round $round/$Repeats ---" -ForegroundColor DarkCyan
    Remove-TestUserMemories -BaseUrl $Mem0Url -Uid $UserId

    $caseIndex = 0
    foreach ($case in $testCases) {
        $caseIndex++
        $caseUserId = "{0}-r{1}-c{2}" -f $UserId, $round, $caseIndex

        # Isolate each case to avoid cross-case memory pollution.
        Remove-TestUserMemories -BaseUrl $Mem0Url -Uid $caseUserId

        Write-Host "`n$('=' * 60)" -ForegroundColor Cyan
        Write-Host "TEST: $($case.Label)" -ForegroundColor Cyan
        Write-Host "$('=' * 60)" -ForegroundColor Cyan

        $res = Invoke-Mem0Case -Case $case -CaseUserId $caseUserId
        $all += $res

        if ($res.ok) {
            Write-Host "  Status:      $($res.status)" -ForegroundColor Green
            Write-Host "  Input size:  $($res.inputChars) chars"
            Write-Host "  Time:        $($res.ms)ms"
            Write-Host "  Results:     $($res.count) entries ($($res.events))"
            Write-Host "  Quality:     score=$($res.qualityScore), pass=$($res.qualityPass)"
            Write-Host "  Reason:      $($res.qualityReason)"

            if ($res.count -gt 0) {
                foreach ($m in $res.memories) {
                    Write-Host "    - $m" -ForegroundColor Yellow
                }
            } else {
                Write-Host "    - (no memories extracted)" -ForegroundColor DarkYellow
            }
        } else {
            Write-Host "  ERROR:       $($res.error)" -ForegroundColor Red
            Write-Host "  Time:        $($res.ms)ms"
            Write-Host "  Quality:     score=$($res.qualityScore), pass=$($res.qualityPass)" -ForegroundColor Red
        }
    }
}

Write-Host "`n=== Summary (Overall) ===" -ForegroundColor Cyan
$total = $all.Count
$okCount = ($all | Where-Object { $_.ok }).Count
$passCount = ($all | Where-Object { $_.qualityPass }).Count
$avgMs = [int](($all | Measure-Object ms -Average).Average)
$avgScore = [int](($all | Measure-Object qualityScore -Average).Average)

Write-Host ("Samples        : {0}" -f $total)
Write-Host ("Success rate   : {0:P0}" -f ($okCount / [Math]::Max(1, $total)))
Write-Host ("Quality pass   : {0:P0}" -f ($passCount / [Math]::Max(1, $total)))
Write-Host ("Avg latency    : {0}ms" -f $avgMs)
Write-Host ("Avg quality    : {0}/100" -f $avgScore)

Write-Host "`n=== Summary (By Case) ===" -ForegroundColor Cyan
$byCase = $all | Group-Object label | ForEach-Object {
    $g = @($_.Group)
    $sampleCount = @($g).Count
    $successCount = @($g | Where-Object { $_.ok }).Count
    $qualityPassCount = @($g | Where-Object { $_.qualityPass }).Count

    [PSCustomObject]@{
        case = $_.Name
        samples = $sampleCount
        successRate = "{0:P0}" -f ($successCount / [double][Math]::Max(1, $sampleCount))
        qualityPassRate = "{0:P0}" -f ($qualityPassCount / [double][Math]::Max(1, $sampleCount))
        avgMs = [int](($g | Measure-Object ms -Average).Average)
        avgInputChars = [int](($g | Measure-Object inputChars -Average).Average)
        avgQuality = [int](($g | Measure-Object qualityScore -Average).Average)
    }
}
$byCase | Sort-Object case | Format-Table -AutoSize

Write-Host "`n=== Per-case Detail ===" -ForegroundColor Cyan
$all | Select-Object label, inputChars, ms, ok, count, qualityScore, qualityPass | Format-Table -AutoSize

Write-Host "`nFinal cleanup..." -ForegroundColor Cyan
Remove-TestUserMemories -BaseUrl $Mem0Url -Uid $UserId
