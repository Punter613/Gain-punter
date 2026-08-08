# SKSK ProTech - Complete Architecture Analysis

## 📋 Project Overview

**SKSK ProTech** is an **Automotive Intelligence Platform** — not another AI chatbot, but a structured decision-support system that helps mechanics make better repair decisions through:
- **Deterministic Safety Rules** (overrides unsafe AI recommendations)
- **Specialized AI Routing** (diagnostic, estimating, predictive, buyer, economic)
- **Evidence-Based Validation** (verifies AI outputs before delivery)
- **Economic Analysis** (cost-benefit recommendations)
- **Knowledge Accumulation** (learns from verified repair outcomes)

**Core Philosophy:** Mechanics make final decisions. AI assists. Safety rules override everything.

---

## 🏗️ Architecture Layers

```
REQUEST FLOW:
   ↓
[Frontend: HTML/JS]
   ↓
[Express Server: api/server.js (Port 3000)]
   ↓
[API Routes: /src/routes/]
   ├─ /api/diagnose          → Diagnosis pipeline
   ├─ /api/estimateHeuristic → Cost estimation
   ├─ /api/intelligence      → Full orchestration
   ├─ /api/full-estimate     → Complete pipeline with rescue fallback
   ├─ /api/invoice           → Invoice building
   ├─ /api/translate         → Customer speech → Technical terms
   ├─ /api/parts/search      → Parts lookup with tiered pricing
   ├─ /api/fleet             → Fleet management (Supabase)
   ├─ /api/buyer             → Vehicle purchase evaluation
   └─ [More routes...]
   ↓
[Core Orchestrator: main.orchestrator.js]
   ↓
   Step 1: Deterministic Safety Checks
      ↓
   Step 2: AI Specialist Routing
      ↓
   Step 3: Execute Specialist AI
      ↓
   Step 4: Evidence Verification
      ↓
   Step 5: Economic Analysis
      ↓
   Step 6: Package & Return Decision
   ↓
[Response to Frontend]
```

---

## 🎯 Core Engines (Specialized Components)

### **1. Orchestrator** (`src/core/orchestrator/main.orchestrator.js`)
- **Role:** Single entry point for all intelligence requests
- **Workflow:** Deterministic → AI Router → Evidence → Economic → Output
- **Key Methods:**
  - `process()` - Main orchestration pipeline
  - `_buildDeterministicResponse()` - Handle safety overrides
  - `_executeChain()` - Multi-specialist workflows (diagnostic + estimate + parts)
  - `_parseAIOutput()` - Extract structured data from AI responses

**Stats Tracking:**
```
- totalRequests: Count of all incoming requests
- deterministicOverrides: Times safety rules blocked AI
- aiProcessed: Completed AI executions
- evidenceRejected: AI outputs failed validation
- economicAnalyzed: Economic analysis runs
- errors: Failed requests
```

### **2. Deterministic Engine** (`src/core/orchestrator/deterministic.orchestrator.js`)
- **Role:** Safety-first validation layer
- **Handles:** Brake wear, steering, tires, cooling, oil pressure, electrical hazards
- **Returns:** Override recommendations with severity levels (CRITICAL/WARNING)

### **3. AI Router** (`src/services/ai/ai.specialist.router.js`)
- **Role:** Route requests to correct AI specialist
- **Specialists:**
  - `diagnostic` → Analyze symptoms/codes
  - `estimate` → Generate labor/parts costs
  - `prediction` → Predictive maintenance
  - `buyer` → Vehicle purchase evaluation
  - `receptionist` → General inquiries
  - `economic` → Cost-benefit analysis

### **4. Evidence Verifier** (`src/core/evidence/evidence.verifier.js`)
- **Role:** Validate AI output before delivery to user
- **Checks:**
  - Response completeness
  - Data structure validity
  - Confidence levels
  - Safety constraint adherence

### **5. Economic Engine** (`src/core/economic/economic.engine.js`)
- **Role:** Cost-benefit analysis for recommendations
- **Outputs:**
  - Optimal action (REPLACE_TODAY, REPLACE_SOON, MONITOR, HOLD)
  - Urgency level
  - Economic reasoning

### **6. Pipeline Engine** (`src/services/pipeline.engine.js`)
- **Role:** PLANNER ONLY - no AI calls inside
- **Returns:** Structured workflow steps for execution

---

## 📡 API Routes Reference

### **DIAGNOSTIC ROUTES**

#### `POST /api/diagnose`
**Purpose:** Run diagnostic analysis on vehicle symptoms/codes
```javascript
Request Body:
{
  vin: "1FTFW1ET5DFC10312",
  mileage: 85000,
  symptoms: ["rough idle", "check engine light"],
  codes: ["P0171"],
  customerStates: ["Engine knocking..."],
  mechanicNotices: ["Spark plugs fouled..."],
  obdCodes: ["P0300", "P0171"],
  notes: [],
  vehicle: { make: "Ford", model: "F-150", year: 2019 },
  laborRate: 65,
  axleCode: ""
}

Response:
{
  success: true,
  result: {
    urgency: "immediate" | "soon" | "monitor",
    safetyRisk: boolean,
    primaryCause: "string",
    secondaryCauses: ["string"],
    codeExplanations: { "P0300": "Random/Multiple cylinder misfire..." },
    probability: [{ cause: "string", likelihood: 85 }],
    knownIssues: ["string"],
    repairSteps: ["string"],
    proTips: ["string"],
    recommendedTests: ["string"],
    estimatedRepairTime: "2.5 hours",
    diagnosticConfidence: { percentage: 95, rating: "HIGH" },
    localVehicleTelemetry: { ... },
    vinManufacturingTelemetry: null
  },
  traceLog: {
    traceId: "TR-ABC123",
    logs: ["[API_ROUTER] Payload received...", ...]
  }
}
```

**Flow:**
1. Extracts vehicle info, symptoms, codes
2. Runs offline deterministic pattern matching
3. If local match found → returns immediately (HIGH confidence)
4. If no match → calls Groq AI for diagnosis
5. Returns safety-validated result

---

#### `POST /api/estimateHeuristic`
**Purpose:** Generate cost estimate for repairs
```javascript
Request Body:
{
  vehicle: { year: 2012, make: "Ram", model: "1500" },
  obdCodes: ["P0303"],
  customerStates: ["Lifter Tick", "Misfire under load"],
  mechanicNotices: ["String..."],
  laborRate: 65,
  partsCost: 0,
  mileage: 142500,
  vin: "1FTFW1ET5DFC10312",
  customer: { name: "John", phone: "555-1234" }
}

Response:
{
  success: true,
  appliedRustPenalty: boolean,
  estimate: {
    priority: "high" | "medium" | "low",
    diagnosis: "string",
    estimatedHours: 2.5,
    laborCost: 162.50,
    partsCost: 485.50,
    total: 648.00,
    repairs: ["Replace spark plugs", "Check fuel injectors"],
    probability: [{ cause: "Misfire", likelihood: 80 }],
    knownIssues: ["string"],
    repairSteps: ["Step 1...", "Step 2..."],
    proTips: ["Pro tip 1", "Pro tip 2"],
    additionalChecks: ["Check compression"],
    notes: "Additional findings during repair may change final charges"
  }
}
```

**Flow:**
1. Validates vehicle/financial inputs
2. Runs diagnostic pipeline for context
3. Applies "rust belt multiplier" if needed (higher labor costs in rust-belt regions)
4. Calls Groq AI with strict JSON schema
5. Validates response structure
6. Falls back to safe defaults if AI parse fails
7. Optionally saves to Supabase

---

#### `POST /api/intelligence/analyze` (MAIN ENTRY POINT)
**Purpose:** Full orchestration pipeline - most powerful endpoint
```javascript
Request Body:
{
  input: "Engine grinding noise when starting cold",
  vehicleProfile: {
    vin: "1FTFW1ET5DFC10312",
    make: "Ford",
    model: "F-150",
    year: 2019,
    mileage: 85000,
    componentData: {
      brakes: { padThickness: 3.2, rotorRunout: 0.03 },
      tires: { treadDepth: 6 }
    }
  },
  context: {
    forceSpecialist: "diagnostic", // optional
    fleetData: null // optional
  }
}

Response:
{
  status: "SUCCESS" | "DETERMINISTIC_OVERRIDE" | "QUARANTINED" | "ERROR",
  pipeline: {
    deterministic: { /* step 1 results */ },
    routing: { specialist: "diagnostic", /* routing results */ },
    ai: { /* step 3 AI output */ },
    evidence: { /* step 4 verification */ },
    economic: { /* step 5 economic analysis */ }
  },
  decision: {
    action: "IMMEDIATE" | "REPLACE_TODAY" | "REPLACE_SOON" | "MONITOR" | "HOLD",
    urgency: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
    confidence: 92,
    reasoning: "Brake pad thickness below safety threshold...",
    specialist: "Brake Specialist",
    aiOutput: "{ ... }",
    economicAnalysis: { 
      recommendation: { optimalAction: "REPLACE_TODAY", urgency: "HIGH" },
      savings: 0,
      riskIfDeferred: "Component failure likely"
    }
  },
  metadata: {
    latencyMs: 1245,
    pipelineVersion: "1.0.0",
    requestId: "req_1234567890_abc123",
    timestamp: "2024-01-15T10:30:00.000Z"
  }
}
```

**Pipeline Steps:**
1. **Deterministic Checks** → Safety override rules
2. **AI Specialist Routing** → Select right AI expert
3. **Execute Specialist** → Generate AI response
4. **Evidence Verification** → Validate AI output
5. **Economic Analysis** → Cost-benefit reasoning
6. **Package Response** → Formatted decision

---

#### `POST /api/intelligence/estimate`
**Purpose:** Diagnostic + Estimate chain
```javascript
// Same input as /analyze
// Forces specialist chain: ['diagnostic', 'estimate', 'parts']
// Returns: Full estimate result with multiple specialist perspectives
```

---

#### `POST /api/intelligence/predict`
**Purpose:** Predictive maintenance forecast
```javascript
Request Body:
{
  vehicleProfile: { vin, make, model, year, mileage, componentData },
  context: {}
}

Response:
{
  status: "SUCCESS",
  predictions: [
    { component: "brakes", daysUntilFailure: 45, urgency: "HIGH" },
    { component: "timing_belt", daysUntilFailure: 180, urgency: "MEDIUM" }
  ],
  economicAnalysis: { ... }
}
```

---

#### `POST /api/intelligence/economic`
**Purpose:** Economic analysis only (for custom recommendations)
```javascript
Request Body:
{
  recommendation: {
    component: "brakes",
    partsCost: 450,
    laborHours: 2,
    description: "Replace brake pads and rotors"
  },
  vehicleProfile: { vin, mileage, ... }
}

Response:
{
  status: "SUCCESS",
  recommendation: {
    optimalAction: "REPLACE_TODAY",
    urgency: "HIGH",
    reasoning: "Safety-critical component",
    deferralRisk: "Brake failure likely"
  }
}
```

---

#### `GET /api/intelligence/health`
**Purpose:** System health check
```
Response:
{
  ok: true,
  layer: "proxy" | "full",
  timestamp: "2024-01-15T10:30:00.000Z"
}
```

---

#### `GET /api/intelligence/stats`
**Purpose:** Pipeline statistics
```
Response:
{
  status: "SUCCESS",
  stats: {
    totalRequests: 1243,
    deterministicOverrides: 34,
    aiProcessed: 1209,
    evidenceRejected: 12,
    economicAnalyzed: 1197,
    errors: 5
  },
  economicAssumptions: {
    averageLaborRate: 125,
    riskThreshold: 0.7
  }
}
```

---

#### `POST /api/intelligence/batch`
**Purpose:** Process multiple recommendations at once
```javascript
Request Body:
{
  recommendations: [
    { component: "brakes", partsCost: 450, laborHours: 2 },
    { component: "timing_belt", partsCost: 800, laborHours: 4 }
  ],
  vehicleProfile: { vin, make, model, year, mileage }
}

Response:
{
  status: "SUCCESS",
  count: 2,
  results: [{ recommendation, economicAnalysis }, ...],
  rankedByUrgency: true
}
```

---

#### `POST /api/intelligence/feedback`
**Purpose:** Record repair outcomes for continuous learning
```javascript
Request Body:
{
  repairKey: "REP-2024-001",
  feedback: {
    diagnosis: "Misfire diagnosis",
    actualCause: "Fouled spark plugs",
    successful: true,
    laborActual: 1.5,
    partsActual: 45.00,
    notes: "Customer satisfied"
  }
}

Response:
{
  status: "SUCCESS",
  message: "Feedback recorded for continuous learning",
  repairKey: "REP-2024-001"
}
```

---

### **TRANSLATION ROUTES**

#### `POST /api/translate`
**Purpose:** Convert customer speech → technical terms
```javascript
Request:
{ text: "Engine makes a clunky noise when I turn..." }

Response:
{
  translated: "Audible noise from drivetrain during steering input; possible CV joint or transmission mount issue",
  keywords: ["CV joint", "transmission mount", "drivetrain"]
}

Note: If GROQ_API_KEY not set, returns original text as fallback
```

---

### **INVOICE ROUTES**

#### `POST /api/invoice/build`
**Purpose:** Generate invoice from estimate
```javascript
Request Body:
{
  estimate: { 
    repairs: ["Replace spark plugs", "Check fuel injectors"],
    diagnosis: "Multiple cylinder misfire",
    laborCost: 162.50,
    partsCost: 485.50,
    estimatedHours: 2.5,
    knownIssues: [...],
    proTips: [...]
  },
  customerInfo: { name: "John Doe", phone: "555-1234", email: "john@email.com" },
  vehicleInfo: { year: 2019, make: "Ford", model: "F-150", trim: "XLT", vin: "..." },
  laborRate: 65,
  notes: "Additional findings during repair may change final charges"
}

Response:
{
  invoiceNumber: "SKSK-20240115-4567",
  status: "ESTIMATE",
  createdAt: "2024-01-15T10:30:00.000Z",
  dueDate: "2024-02-14T10:30:00.000Z",
  customer: { name, phone, email },
  vehicle: { year, make, model, trim, vin },
  diagnosis: { primary, priority },
  lineItems: [
    { lineNumber: 1, type: "LABOR", description, hours, rate, amount },
    { lineNumber: 2, type: "PARTS", description, quantity, unitPrice, amount }
  ],
  totals: {
    laborTotal: 162.50,
    partsTotal: 485.50,
    subtotal: 648.00,
    taxRate: 0.075,
    taxAmount: 36.41,
    total: 684.41,
    laborHours: 2.5
  },
  notes: { knownIssues, proTips, extra },
  repairProcedure: [...],
  footer: "This is an estimate. Final charges may vary..."
}
```

---

### **PARTS ROUTES**

#### `POST /api/parts/search`
**Purpose:** Find parts with tiered pricing
```javascript
Request Body:
{ year: 2019, make: "Ford", model: "F-150", partType: "brake pads" }

Response:
{
  success: true,
  vehicle: "2019 Ford F-150",
  partType: "brake pads",
  results: [
    {
      tier: "Economy",
      brand: "Duralast / Everyday Aftermarket",
      price: 29.75,
      source: "Retail Center",
      availability: "In Stock (Local Store)",
      link: "https://www.autozone.com",
      eta: "Immediate Pick-up"
    },
    {
      tier: "OEM / Factory Spec",
      brand: "Ford Genuine Certified",
      price: 49.00,
      source: "eBay Motors API",
      availability: "Low Inventory (2 left)",
      link: "https://www.ebay.com/...",
      eta: "2-Day Express Shipping"
    },
    {
      tier: "Premium Performance",
      brand: "Brembo / Bosch Ceramic",
      price: 66.50,
      source: "Commercial Supply Warehouse",
      availability: "In Stock (Regional Hub)",
      link: "https://www.napaauto.com",
      eta: "Same-Day Delivery"
    }
  ]
}

Note: Currently uses heuristic pricing. Future: Live eBay/Amazon API integration
```

---

#### `POST /api/parts-lookup`
**Purpose:** Detailed part lookup
```javascript
Request Body:
{ part_number: "ABC123", name: "Brake Pad", vehicle: "Ford F-150", vin: "..." }

Response:
{
  success: true,
  local: [
    { source: "Local Auto Store", price: 49.99, pickup_eta: "Immediate", order_url: "..." }
  ],
  online: [
    { source: "Online Distributor", price: 44.99, shipping_eta: "2-3 days", order_url: "..." }
  ],
  meta: { part_number, name, vehicle, vin }
}
```

---

### **FLEET ROUTES** (Requires `X-Tenant-ID` header)

#### `GET /api/fleet/roster`
**Purpose:** List all fleet vehicles
```
Header: X-Tenant-ID: company-id-123
Response:
{ 
  ok: true, 
  roster: [
    { tenant_id, vin, year_make_model, mileage, status, next_predicted_failure }
  ]
}
```

#### `POST /api/fleet/add`
**Purpose:** Add vehicle to fleet
```javascript
Request Body:
{ vin: "17-char VIN", year: 2019, make: "Ford", model: "F-150", mileage: 85000 }

Response:
{
  ok: true,
  vehicle: { tenant_id, vin, year_make_model, mileage, status: "Healthy" }
}
```

#### `POST /api/fleet/bulk-estimate`
**Purpose:** Run estimates on multiple fleet vehicles
```javascript
Request Body:
{
  vins: ["VIN1", "VIN2", "VIN3"],
  notes: "Annual maintenance check",
  labor_rate: 125
}

Response:
{
  summary: "Processed 3 assets. Success: 3, Failures: 0",
  results: [
    { vin: "VIN1", status: "Success", error: null },
    { vin: "VIN2", status: "Success", error: null }
  ]
}
```

---

### **BUYER ROUTES**

#### `POST /api/buyer/evaluate`
**Purpose:** Evaluate vehicle purchase
```javascript
Request Body:
{
  vin: "1FTFW1ET5DFC10312",
  year: 2019,
  make: "Ford",
  model: "F-150",
  mileage: 85000,
  askingPrice: 28500,
  context: {}
}

Response:
{
  status: "SUCCESS",
  decision: {
    action: "BUY" | "CAUTION" | "AVOID",
    reasoning: "Vehicle shows good maintenance history...",
    riskFactors: ["Timing belt due at 100k miles"],
    estimatedCosts: { nextService: 1200, majorRepairs: 3500 },
    priceRecommendation: 27500
  }
}
```

---

### **JOBS ROUTES**

#### `GET /api/jobs/:id`
**Purpose:** Check job status
```
Response:
{
  success: true,
  status: "queued" | "processing" | "done" | "failed",
  job: { id, status, createdAt, request },
  result: { /* estimate or error */ },
  estimate: { /* same as result */ }
}
```

---

### **SCRAPE ROUTES**

#### `POST /api/scrape`
**Purpose:** Queue scraping job for parts/manuals
```javascript
Request Body:
{ keyword: "brake pads", vin: "...", fitment: "Ford F-150" }

Response:
{
  jobId: "uuid",
  status: "queued",
  request: { keyword, vin, fitment }
}

Check status with: GET /api/jobs/{jobId}
```

---

### **OEM ROUTES**

#### `GET /api/oem-data/:vin/:procedure`
**Purpose:** Fetch OEM repair procedures
```
Response:
{
  found: true,
  source: "LEMON Core" | "CHARM Core",
  data: { torqueSequence, antiseizeNote, clearanceSteps }
}

Note: Uses local Rust binary (./lemon-core) if available
```

---

### **PAYMENTS ROUTES** (Stripe Integration)

#### `POST /api/payments/webhook`
**Purpose:** Stripe webhook receiver (raw buffer)
```
Note: Mounted with express.raw() to preserve signature verification
```

#### `POST /api/payments/...` (Other payment endpoints)
```
Implementation depends on STRIPE_SECRET_KEY configuration
```

---

### **FULL ESTIMATE ROUTE** (Rescue Fallback)

#### `POST /api/full-estimate`
**Purpose:** Complete estimate with emergency fallback engine
```javascript
Request Body:
{
  vin: "1FTFW1ET5DFC10312",
  customerStates: ["grinding noise"],
  obdCodes: ["P0300"],
  mechanicNotices: ["rough idle"],
  laborRate: 65,
  partsCost: 0,
  mileage: 85000,
  context: {}
}

Response:
{
  success: true,
  status: "SUCCESS",
  metadata: {
    vin: "...",
    durationMs: 145,
    requestId: "req_...",
    logs: ["[1/2] Processing pipeline context...", "Execution completed..."]
  },
  decision: { action, urgency, confidence, reasoning, specialist, economicAnalysis }
}

Note: If main orchestrator fails to load, deploys inline "rescue fallback engine"
that returns safe default recommendations
```

---

## 🗄️ Database (Supabase)

### **Optional Tables**

#### `fleet_vehicles`
```sql
- tenant_id (STRING) - Company identifier
- vin (STRING) - 17-char vehicle ID
- year_make_model (STRING) - "2019 Ford F-150"
- mileage (NUMBER) - Current mileage
- status (STRING) - "Healthy" | "Monitor" | "Urgent"
- next_predicted_failure (DATE) - Predictive maintenance date
```

#### `estimates`
```sql
- id (UUID)
- total (NUMERIC) - Total estimate cost
- details (JSONB) - Complete estimate + customer + vehicle data
- created_at (TIMESTAMP)
- updated_at (TIMESTAMP)
```

#### `scraped_manuals`
```sql
- vehicle_key (STRING) - Unique cache key
- year (NUMBER)
- make (STRING)
- model (STRING)
- engine (STRING)
- data (JSONB) - Cached OEM manual data
- scraped_at (TIMESTAMP)
```

### **Required Environment Variables**
```
SUPABASE_URL=https://project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

---

## 🔑 Environment Configuration

```dotenv
# Server
PORT=4000
NODE_ENV=production
CORS_ORIGIN=https://your-frontend.com
REQUEST_TIMEOUT_MS=30000

# AI (Required for most features)
GROQ_API_KEY=gsk_... 

# Database (Optional but recommended)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_KEY=... (fallback)
SUPABASE_ANON_KEY=... (fallback)

# Payments (Optional)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_ENABLED=true/false

# API Keys (Optional)
EBAY_CLIENT_ID=...
EBAY_CLIENT_SECRET=...
EBAY_MARKETPLACE_ID=...

# Routing
AI_URL=...
REDIS_URL=...

# Business Rules (with defaults)
DEFAULT_LABOR_RATE=65
TAX_RATE=0.07
SHOP_SUPPLIES_RATE=0.07

# Feature Flags
INTEL_ENABLED=true
CHARM_ENABLED=false
LIVE_SEARCH_ENABLED=false
STRIPE_ENABLED=false

# Security (Required in production)
JWT_SECRET=your-secure-random-secret-min-32-chars
```

---

## 🚀 Deployment & Boot Sequence

### **Current Status: Phase 3 - Controlled Migration**
✅ Multiple routes coexist (legacy + new)
✅ Features work during transition
✅ Architecture evolves without breaking production
✅ Nothing removed until replacement verified

### **Server Entry Point**
```bash
node api/server.js
# OR
npm start
```

### **Boot Sequence** (api/server.js)
```
1. Load environment variables (dotenv)
   ↓
2. Initialize Express app
   ↓
3. Mount CORS + security headers
   ↓
4. Mount webhook handler (raw buffer for Stripe)
   ↓
5. Parse JSON/URL-encoded bodies (2MB limit)
   ↓
6. Load & mount route handlers:
   - /api/scrape → scrapeRouter
   - /api/parts → partsRouter
   - /api/full-estimate → fullEstimateRouter
   - /api/jobs → jobsRouter
   - /api/diagnose → diagnose
   - /api/estimateHeuristic → estimateHeuristic
   - /api/invoice → invoice
   - /api/translate → translate
   - /api/parts-lookup → partsLookupRouter
   - /api/fleet → fleetRouter
   - /api/intelligence → intelligence.routes
   - /api/buyer → buyer
   - /api/payments → payments (if STRIPE_SECRET_KEY)
   ↓
7. Mount static assets (/public)
   ↓
8. Mount health check (GET /health)
   ↓
9. Mount 404 handler
   ↓
10. Mount global error handler
    ↓
11. Start database keep-alive loop
    ↓
12. Start AI background worker
    ↓
13. Listen on PORT (3000 or process.env.PORT)
```

### **Health Check**
```bash
curl http://localhost:3000/health
# Response:
{
  ok: true,
  timestamp: "2024-01-15T10:30:00.000Z",
  db: "connected" | "not configured" | "error",
  stripe: "configured" | "not configured",
  groq: "configured" | "not configured"
}
```

---

## 📊 Request Flow Summary

```
1. Frontend posts to /api/X with body/headers
   ↓
2. Express server receives & validates CORS
   ↓
3. Route handler receives, validates input schema
   ↓
4. Extracts parameters (VIN, symptoms, codes, etc.)
   ↓
5. Depending on route:
   a) Simple logic → Return immediately
   b) Needs AI → Call through aiClient.js
   c) Full intelligence → Route through Orchestrator
      - Deterministic safety check
      - AI specialist routing
      - Execute AI with Groq SDK
      - Verify output evidence
      - Economic analysis
      - Package decision
   ↓
6. Error handling:
   - Missing keys → Safe fallback
   - AI call fails → Fallback response
   - Parsing fails → Default structure
   ↓
7. Return JSON response with:
   - status (success/error)
   - data (requested info)
   - metadata (traceId, latencyMs, timestamp)
   ↓
8. Frontend displays result to user
```

---

## 🛡️ Error Handling & Resilience

### **Graceful Degradation Layers**

| Component | Missing | Fallback |
|-----------|---------|----------|
| GROQ_API_KEY | No AI inference | Return cached/heuristic responses |
| Orchestrator | Load failure | Inline "rescue fallback engine" |
| Supabase | DB unavailable | In-memory storage (session-only) |
| Evidence Verifier | Verification fails | Drop to safe defaults |
| AI Output | Unparseable JSON | Return "Manual inspection required" |
| OEM Procedure | Not found | Generic procedure steps |

### **Trace IDs for Debugging**
Every request gets unique trace ID:
```
TR-ABC123DEF456  (diagnostic requests)
req_1234567_abc  (other requests)
```

Track errors:
```javascript
// Check server logs for trace ID
[Diagnose Fatal TR-ABC123DEF456]: Error message here
```

---

## 📱 Frontend Integration Points

### **Current Frontend Endpoints Called** (from public/js/sksk-frontend.js)
```javascript
POST /api/translate                    // ✅ Customer speech translation
POST /api/estimateHeuristic           // ✅ Cost estimation
POST /api/intelligence/analyze        // ✅ Full orchestration (RECOMMENDED)
POST /api/intelligence/estimate       // ✅ Diagnostic + estimate chain
POST /api/full-estimate               // ✅ With fallback engine
POST /api/invoice/build               // ✅ Invoice generation
POST /api/parts/search                // ✅ Parts lookup
POST /api/jobs/:id                    // ✅ Check async job status
```

### **Authentication Headers**
```javascript
X-Tenant-ID: "company-id-123"  // For fleet operations
Authorization: "Bearer JWT..."  // For future auth (not yet implemented)
```

### **CORS Configuration**
```javascript
{
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}
```

---

## ✨ Key Design Patterns

### **1. Fail-Safe Defaults**
- AI fails? Return safe defaults
- Orchestrator loads fail? Use inline rescue engine
- Parse fails? Return "Manual inspection required"

### **2. Evidence-First**
- AI output validated before reaching user
- Quarantine responses that fail validation
- Track evidence rejection rate in stats

### **3. Safety Overrides**
- Deterministic rules trump AI recommendations
- Safety-critical components never left to AI alone
- CRITICAL severity overrides require human review

### **4. Specialist Routing**
- Different AI experts for different tasks
- Route selector chooses optimal specialist
- Multi-specialist chains (diagnostic → estimate → parts)

### **5. Economic Reasoning**
- Cost-benefit analysis for every recommendation
- Actions ranked by urgency × economic value
- Deferral risk calculated for MONITOR actions

### **6. Modular Architecture**
- Each engine has ONE clear responsibility
- Engines communicate through structured interfaces
- No direct dependencies between engines

### **7. Migration-First**
- New code coexists with legacy during transition
- Nothing removed until replacement verified
- Continuous evolution without breaking production

---

## 🔄 Request/Response Patterns

### **Successful Response Pattern**
```javascript
{
  success: true,           // or status: "SUCCESS"
  data: { ... },           // Endpoint-specific data
  estimate: { ... },       // For estimate endpoints
  result: { ... },         // For diagnostic endpoints
  decision: { ... },       // For intelligence endpoints
  metadata: {
    latencyMs: 145,
    requestId: "req_...",
    timestamp: "2024-01-15T10:30:00Z",
    traceId: "TR-..."      // For diagnostic endpoints
  }
}
```

### **Error Response Pattern**
```javascript
{
  success: false,          // or status: "ERROR"
  error: "Error message",
  details: "Extended explanation",
  trace: "TR-ABC123",      // For debugging
  fallback: {              // Optional fallback action
    action: "HUMAN_HANDOFF",
    message: "Please contact a service advisor"
  }
}
```

---

## 🎓 For Mobile App Development

The architecture is **API-first and stateless**, meaning:

✅ **Can wrap with React Native** - Expo or vanilla RN
✅ **Can build native Android/iOS** - Swift/Kotlin
✅ **Can deploy as PWA** - Web app + service worker
✅ **Can use as serverless backend** - Render/Vercel
✅ **All logic centralized** - Single source of truth

### **Mobile Implementation Path**

1. **Wrap existing backend** (recommended for speed)
   ```
   Frontend (React/Vue) → Express Backend
   Mobile Wrapper (Expo/RN) → Same Express Backend
   ```

2. **Or build native wrapper**
   ```
   Mobile App (Swift/Kotlin) → Same REST API
   ```

3. **Add offline capability**
   ```
   Local SQLite → Sync daemon → Backend
   Work offline, sync when connected
   ```

4. **Distribute via app stores**
   ```
   APK → Google Play Store
   IPA → Apple App Store
   Web → Cloudflare Pages
   ```

---

## 📊 Architecture Summary Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT LAYER                              │
│  Web (Vue/React) │ Mobile (Expo/RN) │ Native (Swift/Kotlin)    │
└────────────┬────────────────────────────┬──────────────────────┘
             │                            │
             └────────────────┬───────────┘
                              │
        ┌─────────────────────▼──────────────────────┐
        │         EXPRESS REST API                    │
        │         (api/server.js)                     │
        │  ├─ /api/diagnose                           │
        │  ├─ /api/estimateHeuristic                  │
        │  ├─ /api/intelligence/... (MAIN)            │
        │  ├─ /api/invoice                            │
        │  ├─ /api/parts                              │
        │  ├─ /api/translate                          │
        │  ├─ /api/fleet                              │
        │  └─ ... (15+ routes)                        │
        └────────────────────┬──────────────────────┘
                             │
        ┌────────────────────▼──────────────────────┐
        │    CORE ORCHESTRATOR                       │
        │  (main.orchestrator.js)                    │
        │  Step 1: Deterministic Safety              │
        │  Step 2: AI Specialist Routing             │
        │  Step 3: Execute Specialist                │
        │  Step 4: Evidence Verification             │
        │  Step 5: Economic Analysis                 │
        │  Step 6: Package Decision                  │
        └────────────┬─────────────────┬────────────┘
                     │                 │
      ┌──────────────▼──┐     ┌────────▼──────────┐
      │ DETERMINISTIC    │     │  AI SPECIALIST    │
      │ ENGINE           │     │  ROUTER           │
      │ (Safety Rules)   │     │  (Route Logic)    │
      └──────────────────┘     └────────┬──────────┘
                                        │
                            ┌───────────▼──────────┐
                            │  GROQ AI PROVIDER    │
                            │  (groq-sdk)          │
                            │  ├─ Diagnostic      │
                            │  ├─ Estimate        │
                            │  ├─ Prediction      │
                            │  └─ Buyer           │
                            └──────────────────────┘
                                        │
      ┌──────────────┐      ┌──────────▼──────────┐
      │  EVIDENCE    │      │  ECONOMIC ENGINE    │
      │  VERIFIER    │      │  (Cost Analysis)    │
      │  (Validate)  │      │                     │
      └──────────────┘      └─────────────────────┘

        ┌────────────────────────────────────────┐
        │      DATABASE LAYER (Supabase)         │
        │  ├─ fleet_vehicles                     │
        │  ├─ estimates                          │
        │  ├─ scraped_manuals                    │
        │  └─ (user tables)                      │
        └────────────────────────────────────────┘
```

---

## 📚 Additional Resources

### **Project Documentation**
- `README.md` - Project overview and vision
- `src/services/ai/README.md` - AI layer contract
- `.env.example` - Configuration template

### **Key Files Reference**
- `api/server.js` - Express server boot
- `src/core/orchestrator/main.orchestrator.js` - Main intelligence pipeline
- `src/routes/intelligence.routes.js` - Intelligence API endpoints
- `src/routes/diagnose.js` - Diagnostic routing
- `src/routes/estimate.js` - Estimation engine
- `public/index.html` - Frontend interface
- `package.json` - Dependencies (Express, Groq, Supabase, Stripe)

### **Development Tips**
1. **Test Health**: `curl http://localhost:3000/health`
2. **Check Stats**: `GET /api/intelligence/stats`
3. **Trace Errors**: Look for trace IDs in server logs
4. **Local Development**: Set `NODE_ENV=development`
5. **Debug AI**: Add `GROQ_DEBUG=true` (if implemented)

---

**Built by:** Someone who spent years turning wrenches and realized the best tool in the shop is often just an extra set of eyes. 🔧

**Version:** 1.0.0
**Last Updated:** 2024-01-15
