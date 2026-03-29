# ============================================================================
# Test mem0 compressContext: quality + performance benchmark
# Purpose: Evaluate compression latency, ratio, and quality on varied text types
# Direct LLM mode: bypasses mem0, calls LLM /chat/completions directly
# ============================================================================

param(
	[string]$LlmUrl = "http://127.0.0.1:18081/v1",
	[string]$Model = "Qwen3.5-9B-NVFP4",
	[int]$Repeats = 1,
	[int]$TimeoutSec = 90,
	[int]$MaxTokens = 10000
)

$ErrorActionPreference = "Stop"

# Read system prompt from the shared compactSystemPrompt.md file
$promptFile = Join-Path $PSScriptRoot "..\..\..\..\..\assets\prompts\compactSystemPrompt.md"
$promptFile = [System.IO.Path]::GetFullPath($promptFile)
if (-not (Test-Path $promptFile)) {
	Write-Host "ERROR: Cannot find compactSystemPrompt.md at: $promptFile" -ForegroundColor Red
	exit 1
}
$systemPrompt = Get-Content -Path $promptFile -Raw -Encoding UTF8
Write-Host "Loaded system prompt from: $promptFile" -ForegroundColor DarkGray

$codeNoise = @"
function fetchUsers() {
  return db.query('select * from users');
}

function saveUser(u) {
  // TODO: handle retry
  return db.insert('users', u);
}
"@

$codeNoise2 = @"
export class OrderService {
  private readonly repo: OrderRepository;
  private readonly eventBus: EventEmitter;

  constructor(repo: OrderRepository, eventBus: EventEmitter) {
    this.repo = repo;
    this.eventBus = eventBus;
  }

  async createOrder(dto: CreateOrderDto): Promise<Order> {
    const order = Order.fromDto(dto);
    order.validate();
    const saved = await this.repo.save(order);
    this.eventBus.emit('order.created', { orderId: saved.id, total: saved.total });
    return saved;
  }

  async cancelOrder(id: string): Promise<void> {
    const order = await this.repo.findById(id);
    if (!order) throw new NotFoundException('Order not found');
    order.cancel();
    await this.repo.save(order);
    this.eventBus.emit('order.cancelled', { orderId: id });
  }
}
"@

$stackTraceNoise = @"
Error: Connection refused
    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1278:16)
    at Protocol._enqueue (/app/node_modules/mysql2/lib/protocol.js:45:53)
    at Connection.query (/app/node_modules/mysql2/lib/connection.js:198:25)
    at UserRepository.findByEmail (/app/src/repos/user.repo.ts:42:18)
    at AuthService.login (/app/src/services/auth.service.ts:67:24)
    at AuthController.handleLogin (/app/src/controllers/auth.controller.ts:31:20)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at next (/app/node_modules/express/lib/router/route.js:144:13)
    at Route.dispatch (/app/node_modules/express/lib/router/route.js:114:3)
    at handle (/app/node_modules/express/lib/router/index.js:284:7)
"@

$configNoise = @"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@shared/*": ["packages/shared/src/*"]
    }
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
"@

$apiResponseNoise = @"
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Request-Id: a3f7b21c-9e84-4d12-b6f3-1a2c3d4e5f6a
X-RateLimit-Remaining: 47
Cache-Control: no-store

{
  "data": [
    {"id": 1, "name": "Alice", "role": "admin", "lastLogin": "2026-03-28T10:00:00Z"},
    {"id": 2, "name": "Bob", "role": "editor", "lastLogin": "2026-03-27T15:30:00Z"},
    {"id": 3, "name": "Charlie", "role": "viewer", "lastLogin": "2026-03-25T08:12:00Z"},
    {"id": 4, "name": "Dana", "role": "editor", "lastLogin": "2026-03-28T11:45:00Z"},
    {"id": 5, "name": "Eve", "role": "admin", "lastLogin": "2026-03-28T09:22:00Z"}
  ],
  "pagination": {"page": 1, "pageSize": 20, "total": 5},
  "meta": {"requestDuration": 42, "cacheHit": false}
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

$logNoiseBlock2 = @"
[2026-03-28T10:32:01.123Z] INFO  [kafka-consumer] Partition 3 rebalanced, offset=148291
[2026-03-28T10:32:01.456Z] WARN  [circuit-breaker] payment-svc half-open, failures=3/5
[2026-03-28T10:32:02.789Z] ERROR [graphql-resolver] Cannot return null for non-nullable field User.email
[2026-03-28T10:32:03.012Z] DEBUG [redis-cache] MISS key=session:u-9f8e7d ttl=0
[2026-03-28T10:32:03.345Z] INFO  [health-check] upstream latency p99=312ms (threshold=500ms)
[2026-03-28T10:32:04.678Z] WARN  [rate-limiter] IP 10.0.3.47 approaching limit 980/1000
[2026-03-28T10:32:05.901Z] ERROR [s3-upload] PutObject failed: SlowDown, reduce request rate
[2026-03-28T10:32:06.234Z] INFO  [migration] Applied 20260327_add_index_orders_status (14ms)
[2026-03-28T10:32:07.567Z] DEBUG [tracing] span=auth.verify parent=req-abc123 duration=8ms
[2026-03-28T10:32:08.890Z] INFO  [deploy] Canary v2.14.3 healthy, promoting to 100% traffic
"@

$chatNoiseBlock = @"
User: can you explain this stack trace?
Assistant: sure, looks related to async ordering.
User: I also saw this only once in staging.
Assistant: let's inspect logs around 10:32.
User: maybe cache invalidation?
Assistant: possible, but we need more data.
"@

$chatNoiseBlock2 = @"
User: the dashboard is showing stale data again
Assistant: let me check the cache TTL settings. Looking at the Redis config...
User: we already tried flushing the cache manually, didn't help
Assistant: interesting. Let me check if the event listener for invalidation is connected.
User: here's the prometheus graph showing the lag
Assistant: I see - there's a 30s gap between writes and cache updates. The CDC pipeline might be backed up.
User: could it be related to the Kafka partition rebalance we saw earlier?
Assistant: that's very likely. During rebalance, consumers pause and events queue up. Let me check consumer group lag.
User: we also deployed a new version of the ingestion service around that time
Assistant: that would trigger a rebalance. The new deployment likely caused a temporary consumer group disruption.
User: ok so what should we do?
Assistant: short term: increase the consumer session timeout. Long term: implement graceful shutdown with cooperative rebalancing.
"@

$cicdNoise = @"
Step 1/12: Checkout repository... done (2s)
Step 2/12: Setup Node.js 20.x... done (8s)
Step 3/12: Cache pnpm store... hit (0s)
Step 4/12: Install dependencies... done (14s)
Step 5/12: Run lint... done (22s)
Step 6/12: Run typecheck... done (18s)
Step 7/12: Run unit tests... done (45s), 312 passed, 0 failed
Step 8/12: Run integration tests... done (120s), 48 passed, 0 failed
Step 9/12: Build production bundle... done (35s), size=2.4MB
Step 10/12: Upload coverage report... done (3s), coverage=87.2%
Step 11/12: Build docker image... done (42s), sha256:a1b2c3d4e5f6
Step 12/12: Push to registry... done (8s)
Total: 317s | Status: SUCCESS
"@

$sqlNoise = @"
EXPLAIN ANALYZE SELECT o.id, o.status, u.name, u.email,
    SUM(oi.quantity * oi.unit_price) AS total
  FROM orders o
  JOIN users u ON u.id = o.user_id
  JOIN order_items oi ON oi.order_id = o.id
  WHERE o.created_at > NOW() - INTERVAL '7 days'
    AND o.status IN ('pending', 'processing')
  GROUP BY o.id, o.status, u.name, u.email
  ORDER BY total DESC
  LIMIT 50;

 Limit  (cost=1842.35..1842.48 rows=50 width=128) (actual time=12.4..12.5 rows=50 loops=1)
   ->  Sort  (cost=1842.35..1845.67 rows=1328 width=128) (actual time=12.4..12.4 rows=50 loops=1)
         Sort Key: (sum((oi.quantity * oi.unit_price))) DESC
         Sort Method: top-N heapsort  Memory: 32kB
         ->  HashAggregate  (cost=1792.12..1805.40 rows=1328 width=128) (actual time=11.2..11.8 rows=1328 loops=1)
               Group Key: o.id, u.name, u.email
               ->  Hash Join  (cost=245.00..1752.12 rows=5328 width=96) (actual time=2.1..8.9 rows=5328 loops=1)
 Planning Time: 0.8 ms
 Execution Time: 12.7 ms
"@

$cases = @(
	@{
		Label = "1. Log-heavy noise with scattered facts"
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
$($logNoiseBlock * 8)
$($logNoiseBlock2 * 6)
10. [INFO] session chat transcript follows:
$($chatNoiseBlock * 5)
$($chatNoiseBlock2 * 3)
11. [ERROR] more runtime traces:
$($logNoiseBlock * 6)
$($stackTraceNoise * 4)
12. CI/CD pipeline output:
$($cicdNoise * 3)
13. API debug responses captured:
$($apiResponseNoise * 5)
"@
		RequiredKeywords = @("pnpm", "workspace")
		MinRatio = 0.05
		MaxRatio = 0.90
	},
	@{
		Label = "2. Code-heavy with mixed artifacts"
		Input = @"
1. Prefers TypeScript strict mode and noImplicitAny.
2. $codeNoise
3. Uses Vitest for unit tests.
4. $codeNoise2
5. Package manager is pnpm.
6. $codeNoise
7. Extended repository snippets:
$($codeNoise * 15)
$($codeNoise2 * 10)
8. Interleaved debug logs:
$($logNoiseBlock * 5)
$($logNoiseBlock2 * 5)
9. Troubleshooting chat transcript:
$($chatNoiseBlock * 4)
$($chatNoiseBlock2 * 3)
10. Stack traces from error monitoring:
$($stackTraceNoise * 6)
11. tsconfig.json variations tried:
$($configNoise * 4)
12. Database query analysis:
$($sqlNoise * 3)
"@
		RequiredKeywords = @("typescript", "strict", "vitest", "pnpm")
		MinRatio = 0.05
		MaxRatio = 0.85
	},
	@{
		Label = "3. Bilingual facts in heavy noise"
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
$($chatNoiseBlock * 8)
$($chatNoiseBlock2 * 6)
10. Additional stack and logs:
$($logNoiseBlock * 6)
$($logNoiseBlock2 * 6)
$($stackTraceNoise * 4)
11. Repeat mixed code snippets:
$($codeNoise * 10)
$($codeNoise2 * 8)
12. 临时错误信息：
$($logNoiseBlock * 5)
13. CI/CD pipeline runs:
$($cicdNoise * 3)
14. API response dumps:
$($apiResponseNoise * 4)
15. SQL query plans from investigation:
$($sqlNoise * 3)
"@
		RequiredKeywords = @("typescript", "vercel", "next", "postgresql", "jest", "pnpm", "us-east-1")
		MinRatio = 0.05
		MaxRatio = 0.90
	},
	@{
		Label = "4. Architecture decision + debug session"
		Input = @"
1. We decided to migrate from REST to GraphQL for the public API. Internal services stay gRPC.
2. Authentication uses OAuth2 with PKCE flow, tokens stored in HttpOnly cookies, not localStorage.
3. The event sourcing pattern is used for the order domain; other domains use plain CRUD.
4. Redis Cluster (6 nodes) handles both caching and pub/sub; we avoid using it as primary storage.
5. Frontend uses React 19 with Server Components; state management via Zustand, not Redux.
6. 我们的微服务通过 Istio service mesh 通信，不直接暴露端口。
7. Database sharding strategy: hash-based on tenant_id, 16 shards across 4 PostgreSQL clusters.
8. 我们使用 Temporal 作为工作流引擎处理长事务，替代了之前的 saga 手动编排。

--- Debug session for order timeout issue (ephemeral) ---
$($chatNoiseBlock2 * 8)
$($stackTraceNoise * 8)
$($logNoiseBlock2 * 10)
$($sqlNoise * 5)
$($apiResponseNoise * 6)

--- More troubleshooting context ---
$($chatNoiseBlock * 6)
$($logNoiseBlock * 8)
$($cicdNoise * 2)
$($configNoise * 3)
"@
		RequiredKeywords = @("graphql", "grpc", "oauth2", "redis", "react", "zustand", "istio", "temporal", "shard")
		MinRatio = 0.05
		MaxRatio = 0.85
	},
	@{
		Label = "5. Multi-team incident postmortem"
		Input = @"
1. Root cause: connection pool exhaustion in payment-svc due to unclosed DB connections in error path.
2. Impact: 23 minutes of degraded checkout (error rate peaked at 34%).
3. Detection: PagerDuty alert from Grafana dashboard api-latency p99 > 2s.
4. 修复方案：在 finally 块中确保连接释放，并将连接池上限从 20 调到 50。
5. Action items: add connection pool metrics to Datadog, add integration test for error-path cleanup.
6. Follow-up: implement circuit breaker for payment-svc -> bank-api calls (deadline: 2026-04-15).
7. Lesson learned: our load test suite didn't cover error paths; adding chaos testing with LitmusChaos.

--- Full incident timeline and raw logs ---
$($logNoiseBlock2 * 15)
$($stackTraceNoise * 10)

--- On-call chat during incident ---
$($chatNoiseBlock2 * 10)

--- Grafana query results dumped ---
$($apiResponseNoise * 8)

--- CI runs during hotfix ---
$($cicdNoise * 4)

--- Post-incident DB analysis ---
$($sqlNoise * 6)

--- Additional noise from monitoring ---
$($logNoiseBlock * 10)
$($chatNoiseBlock * 5)
"@
		RequiredKeywords = @("connection pool", "payment", "finally", "circuit breaker", "datadog", "chaos")
		MinRatio = 0.05
		MaxRatio = 0.85
	},
	@{
		Label = "6. Pure noise stress test (minimal signal)"
		Input = @"
1. The team uses Rust for performance-critical backend services.

--- Everything below is ephemeral debug noise ---
$($logNoiseBlock * 15)
$($logNoiseBlock2 * 15)
$($stackTraceNoise * 12)
$($chatNoiseBlock * 12)
$($chatNoiseBlock2 * 10)
$($cicdNoise * 5)
$($apiResponseNoise * 8)
$($sqlNoise * 6)
$($configNoise * 5)
$($codeNoise * 20)
$($codeNoise2 * 12)
"@
		RequiredKeywords = @("rust")
		MinRatio = 0.01
		MaxRatio = 0.50
	},
	@{
		Label = "7. Dense multi-domain knowledge base"
		Input = @"
1. Frontend: React 19 + Next.js 15 App Router, deployed on Vercel, styled with Tailwind CSS v4.
2. Backend: Node.js 22 LTS with Fastify, deployed as containers on AWS ECS Fargate.
3. Database: PostgreSQL 16 (RDS) as primary, DynamoDB for session store, Redis 7 for caching.
4. 搜索引擎使用 Elasticsearch 8，通过 NDJSON bulk API 做索引，查询走 BFF 层。
5. Messaging: Kafka 3.7 for event streaming, SQS for task queues, SNS for fan-out notifications.
6. CI/CD: GitHub Actions, pnpm for package management, Turborepo for monorepo orchestration.
7. Monitoring: Datadog APM + logs, PagerDuty for alerting, Sentry for error tracking.
8. 基础设施即代码使用 Terraform + Terragrunt，环境分为 dev/staging/prod 三套。
9. Auth: Auth0 for B2C, custom OIDC provider for B2B SSO, short-lived JWTs (15min) + refresh tokens.
10. Feature flags managed via LaunchDarkly, percentage rollouts with targeting rules.
11. API versioning: URL-based (v1, v2), with sunset headers and deprecation warnings.
12. 我们的 GraphQL gateway 用 Apollo Federation v2，子图按领域拆分（user/order/inventory/payment）。
13. Mobile: React Native 0.76, shared business logic via a common TypeScript package.
14. Testing: Vitest for unit, Playwright for E2E, k6 for load testing, contract tests via Pact.
15. 数据管道用 Apache Airflow 编排，Spark 做批处理，Flink 做实时流处理。

--- Troubleshooting session from this morning (discard) ---
$($chatNoiseBlock2 * 6)
$($chatNoiseBlock * 8)

--- Stack traces collected ---
$($stackTraceNoise * 6)

--- Logs from various services ---
$($logNoiseBlock * 8)
$($logNoiseBlock2 * 8)

--- CI pipeline output ---
$($cicdNoise * 3)

--- API responses captured ---
$($apiResponseNoise * 5)

--- Query plans reviewed ---
$($sqlNoise * 4)

--- Config files checked ---
$($configNoise * 3)

--- Code reviewed during session ---
$($codeNoise * 8)
$($codeNoise2 * 6)
"@
		RequiredKeywords = @("react", "next", "fastify", "postgresql", "dynamodb", "elasticsearch", "kafka", "datadog", "terraform", "auth0", "apollo", "vitest", "playwright", "airflow")
		MinRatio = 0.05
		MaxRatio = 0.85
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

function Get-ContextSection {
	param([string]$Text)

	if ([string]::IsNullOrWhiteSpace($Text)) {
		return ""
	}

	# Extract text after ### Summary heading (the main output section)
	if ($Text -match "(?s)###\s*Summary\s*\r?\n(.+)$") {
		return $Matches[1].Trim()
	}

	return $Text
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

	$body = @{
		model       = $Model
		temperature = 0
		max_tokens  = $MaxTokens
		messages    = @(
			@{ role = "system"; content = $systemPrompt },
			@{ role = "user"; content = $inputText }
		)
	}

	$payload = $body | ConvertTo-Json -Depth 8
	$payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
	$sw = [System.Diagnostics.Stopwatch]::StartNew()

	try {
		$resp = Invoke-WebRequest -Uri "$BaseUrl/chat/completions" -Method POST -ContentType "application/json" -Body $payloadBytes -TimeoutSec $Timeout
		$sw.Stop()

		$obj = $resp.Content | ConvertFrom-Json
		$fullText = [string]$obj.choices[0].message.content
		$usage = $obj.usage

		$outputText = Get-ContextSection -Text $fullText
		$outputChars = $outputText.Length
		$ratio = if ($inputChars -gt 0) { [math]::Round($outputChars / [double]$inputChars, 4) } else { 0 }
		$savingsRate = if ($inputChars -gt 0) { [math]::Round((1 - ($outputChars / [double]$inputChars)) * 100, 2) } else { 0 }
		$quality = Evaluate-CompressionQuality -Case $Case -Output $outputText -Ratio $ratio -Ok $true

		return [PSCustomObject]@{
			label           = $Case.Label
			ok              = $true
			status          = [int]$resp.StatusCode
			ms              = [int]$sw.ElapsedMilliseconds
			inputChars      = [int]$inputChars
			outputChars     = [int]$outputChars
			ratio           = [double]$ratio
			savingsRate     = [double]$savingsRate
			promptTokens    = [int]($usage.prompt_tokens)
			completionTokens = [int]($usage.completion_tokens)
			isNumbered      = [bool](Test-IsNumberedList -Text $outputText)
			qualityScore    = [int]$quality.score
			qualityPass     = [bool]$quality.pass
			qualityReason   = [string]$quality.reason
			preview         = if ($outputText.Length -gt 220) { $outputText.Substring(0, 220) + "..." } else { $outputText }
			error           = ""
		}
	} catch {
		$sw.Stop()
		$quality = Evaluate-CompressionQuality -Case $Case -Output "" -Ratio 1 -Ok $false

		return [PSCustomObject]@{
			label           = $Case.Label
			ok              = $false
			status          = 0
			ms              = [int]$sw.ElapsedMilliseconds
			inputChars      = [int]$inputChars
			outputChars     = 0
			ratio           = 1.0
			savingsRate     = 0
			promptTokens    = 0
			completionTokens = 0
			isNumbered      = $false
			qualityScore    = [int]$quality.score
			qualityPass     = [bool]$quality.pass
			qualityReason   = [string]$quality.reason
			preview         = ""
			error           = [string]$_.Exception.Message
		}
	}
}

Write-Host "`n=== mem0 compressContext Benchmark (Direct LLM) ===" -ForegroundColor Cyan
Write-Host "LlmUrl      : $LlmUrl"
Write-Host "Model       : $Model"
Write-Host "Repeats     : $Repeats"
Write-Host "TimeoutSec  : $TimeoutSec"
Write-Host "MaxTokens   : $MaxTokens"

$all = @()

for ($round = 1; $round -le $Repeats; $round++) {
	Write-Host "`n--- Round $round/$Repeats ---" -ForegroundColor DarkCyan

	foreach ($case in $cases) {
		Write-Host "Running case: $($case.Label)"
		$res = Invoke-CompressCase -Case $case -BaseUrl $LlmUrl -Timeout $TimeoutSec
		$all += $res

		if ($res.ok) {
			Write-Host ("  ok ms={0} ratio={1:P1} savings={2}% quality={3} pass={4} tokens={5}+{6}" -f $res.ms, $res.ratio, $res.savingsRate, $res.qualityScore, $res.qualityPass, $res.promptTokens, $res.completionTokens) -ForegroundColor Green
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
		case            = $_.Name
		samples         = $sampleCount
		successRate     = "{0:P0}" -f ($successCount / [double][Math]::Max(1, $sampleCount))
		qualityPassRate = "{0:P0}" -f ($qualityPassCount / [double][Math]::Max(1, $sampleCount))
		avgMs           = [int](($g | Measure-Object ms -Average).Average)
		avgRatio        = [double](($g | Measure-Object ratio -Average).Average)
		avgSavings      = [double](($g | Measure-Object savingsRate -Average).Average)
		avgQuality      = [int](($g | Measure-Object qualityScore -Average).Average)
	}
}
$byCase | Sort-Object case | Format-Table -AutoSize

Write-Host "`n=== Per-case Detail ===" -ForegroundColor Cyan
$all | Select-Object label, ms, inputChars, outputChars, ratio, savingsRate, qualityScore, qualityPass, isNumbered, promptTokens, completionTokens | Format-Table -AutoSize

Write-Host "`n=== Output Previews ===" -ForegroundColor Cyan
$all | Select-Object label, preview, qualityReason | Format-List