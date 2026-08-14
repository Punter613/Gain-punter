# 🔧 SKSK ProTech

> **Your extra set of eyes for evidence-based repair decisions.**

SKSK ProTech is an automotive intelligence and decision-support platform for **mechanics and technicians**.

It combines vehicle context, diagnostic observations, service evidence, known failure patterns, deterministic safety rules, technician feedback, and bounded AI-assisted reasoning to help answer one question:

> **Given everything we know about this vehicle, what is the safest, most evidence-supported next step?**

**SKSK does not turn model confidence into repair authorization.** It structures the path from observation to testing, verification, repair, and confirmed outcome while the technician retains final responsibility for diagnosis, verification, and repair authorization.

**Evidence before confidence. Test before authorization. Verify before repair.**

A pull request is another technician saying: *“Put another set of eyes on this before I button it up.”* SKSK approaches diagnosis the same way.

---

## Core Principles

- **Evidence before confidence.**
- **A diagnosis is not an authorized repair.**
- **Test before authorization.**
- **Deterministic safety rules outrank probabilistic output.**
- **Technician verification is separate from model confidence.**
- **Confirmed outcomes should improve future recommendations.**
- **Prefer one source of truth and less code when it produces the same correct behavior.**

---

## Current Status

SKSK is under active architectural migration from its original AI estimator into a structured automotive-intelligence platform.

The repository currently contains working production code alongside legacy routes, transitional modules, and compatibility layers. Proven functionality is preserved while diagnostic orchestration, evidence retrieval, lifecycle gates, authorization controls, and feedback systems become the system of record.

Current development is focused on making the mechanic-facing ProTech lifecycle coherent end-to-end:

**vehicle context → diagnose → evidence → confirmation tests → VERIFY → authorization → estimate → outcome**

Features or architecture described as future direction should not be assumed to be production-ready merely because supporting modules exist in the repository.

---

## What SKSK Supports

The codebase currently contains capabilities for:

- VIN and vehicle-context intake
- customer concerns, DTCs, and technician observations
- diagnostic hypothesis generation
- deterministic safety and authorization guards
- evidence collection and relevance filtering
- NHTSA manufacturer-communication / TSB corpus ingestion and storage
- configured service-information evidence sources
- confirmation-test and mechanic-verification workflows
- estimate, parts, invoice, and payment workflows
- fleet and buyer-oriented tools
- technician feedback and confirmed repair outcomes
- Supabase-backed persistence
- background work through Redis/Bull where configured

Because SKSK is actively migrating, **runtime behavior on `main` is the authority** when documentation and older modules disagree.

---

## Repair Lifecycle Contract

```text
DIAGNOSE → TEST → VERIFY → AUTHORIZE → ESTIMATE → REPAIR → OUTCOME
```

These states are intentionally different.

```text
DIAGNOSE ≠ AUTHORIZE
MODEL CONFIDENCE ≠ VERIFICATION
EVIDENCE ≠ PROOF
VERIFY = explicit human action
AUTHORIZE = only after applicable gates pass
```

### Lifecycle invariants

- A diagnostic hypothesis must not silently become an authorized repair because a model suggested it.
- Recommendations should identify supporting evidence and what still needs to be proven.
- Applicable deterministic safety or lifecycle guards may block, constrain, or require escalation.
- Technician verification is recorded separately from AI confidence.
- Previously completed repairs should be considered before recommending the same work again.
- Estimate generation should consume verified repair scope rather than inventing repair authorization.

---

## Repair Decision Pipeline

```text
Vehicle / VIN / Mileage
          │
          ▼
Complaint + Codes + Technician Observations
          │
          ▼
Normalization + Deterministic Pre-AI Knowledge
          │
          ▼
Evidence Retrieval
   ┌──────┼──────────────┐
   ▼      ▼              ▼
 NHTSA  Configured     Known / Learned
Corpus  Service Info     Patterns
   │      │              │
   └──────┼──────────────┘
          ▼
Evidence Ranking + Relevance
          │
          ▼
Bounded AI-Assisted Reasoning
          │
          ▼
Deterministic Validation + Safety Guards
          │
          ▼
Confirmation Tests
          │
          ▼
TECHNICIAN VERIFY
          │
          ▼
Repair Authorization
          │
          ▼
Estimate / Repair Workflow
          │
          ▼
Confirmed Outcome + Feedback
          │
          ▼
SKSK Knowledge
```

The important question is not which model generated a sentence.

The important question is whether the recommendation survives evidence, testing, deterministic rules, and technician verification.

---

## Repository Map

SKSK is still migrating, so this map describes the major responsibilities rather than pretending every historical file already fits perfectly.

| Area | Responsibility |
|---|---|
| `api/` | Express application entrypoint and top-level route mounting |
| `src/routes/` | Mechanic-facing API routes including diagnostic and workflow endpoints |
| `src/services/` | Evidence, AI/provider, scraper, pricing, and supporting services |
| `src/core/` | Core orchestration, deterministic logic, learning, and shared domain behavior |
| `src/knowledge/` | Structured automotive knowledge and related adapters |
| `src/middleware/` | Authentication, safety, lifecycle, and request guards |
| `src/contracts/` | Structured interfaces/contracts between parts of the system |
| `src/workers/` | Background processing |
| `scripts/` | Maintenance, ingestion, verification, and operational scripts |
| `supabase/` | Database migrations/configuration where applicable |
| `.github/workflows/` | CI and operational GitHub Actions |
| frontend/static assets | Mechanic-facing ProTech UI and related product surfaces |

For deeper historical analysis and migration notes, see the architecture and planning documents in the repository. Treat actual code and runtime tests as the final source of truth.

---

## Getting Started

### Prerequisites

- Node.js 18 or newer
- npm
- Supabase project for persistence-backed features
- Groq API credentials for current primary AI-backed features
- Redis for queue-backed features when enabled

### Install

```bash
git clone https://github.com/Punter613/skskprotech.git
cd skskprotech
npm install
cp .env.example .env
```

Fill in only the environment values required for the features you are running. **Never commit secrets.**

Important environment names are documented in `.env.example`, including:

```text
GROQ_API_KEY
GEMINI_API_KEY              # optional configured fallback
JWT_SECRET
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
REDIS_URL
STRIPE_SECRET_KEY           # when payments are enabled
STRIPE_WEBHOOK_SECRET       # when payments are enabled
```

### Run

```bash
npm start
```

The current package entrypoint is:

```text
node api/server.js
```

For development with nodemon available:

```bash
npm run dev
```

### Tests

The repository contains targeted test suites and CI workflows, but the top-level `npm test` script is not currently the authoritative test runner. Before merging architectural or lifecycle changes, run the affected targeted tests **and boot/test the exact runtime branch**.

That rule is intentional: a clean diff is not proof that the vehicle starts.

---

## Evidence Before Confidence

SKSK is being built around structured evidence including:

- NHTSA manufacturer communications / TSB data
- service-information evidence from configured sources
- vehicle-specific known or curated failure patterns
- OBD codes and technician observations
- mechanic-confirmed repair outcomes and feedback

Not every source has the same granularity, authority, completeness, or provenance. Evidence adapters should preserve those distinctions rather than flattening everything into “truth.”

The goal is also **not** to dump an entire corpus into a language model.

The retrieval layer should find the small number of records relevant to the vehicle and complaint, rank them, reduce duplication/noise, and hand the reasoning layer a compact evidence packet.

> **More data should create better evidence — not a bigger prompt.**

---

## Deterministic Safety and Authorization

Safety-critical or lifecycle-critical decisions are not intended to depend entirely on probabilistic model output.

Examples include conditions involving brakes, steering, tires, cooling systems, oil pressure, electrical hazards, completed-work awareness, mechanic verification, and repair authorization.

Deterministic logic can challenge, constrain, reject, or require verification of model-generated recommendations.

> **Confidence does not outrank evidence.**

---

## Safety and Responsibility

SKSK provides **decision support**. It is not a substitute for manufacturer procedures, applicable safety standards, professional inspection, required measurements, or technician judgment.

Always follow applicable service information and verify safety-critical conditions before returning a vehicle to service.

External evidence may be incomplete, generalized to year/make/model rather than exact configuration, duplicated across component classifications, or otherwise require technician interpretation. Presence in an evidence corpus does not prove that a bulletin or known pattern applies to the vehicle in front of you.

---

## The Knowledge Loop

The long-term value of SKSK is not any single AI model.

Models, providers, prices, and rate limits will change. The durable asset is structured knowledge around real repair decisions.

```text
Observation
    ↓
Diagnosis
    ↓
Evidence
    ↓
Test
    ↓
Verified Cause
    ↓
Repair
    ↓
Outcome
    ↓
Mechanic Feedback
    ↓
Better Future Evidence
```

A verified repair can teach the system more than another confident prediction ever could.

---

## Development Philosophy

SKSK grew from a simple estimator into a much larger system. That growth created legacy routes, transitional modules, disconnected features, and architectural duplication.

The response is not to repeatedly burn the shop down and rebuild it.

1. Preserve proven functionality until its replacement is verified.
2. Prefer one source of truth over duplicated implementations.
3. Keep modules responsible for one clear job.
4. Test the actual runtime path, not merely the diff.
5. Treat AI output as a hypothesis until evidence supports it.
6. Let deterministic rules win when safety or authorization requires it.
7. Learn from confirmed repair outcomes.
8. Favor less code when it produces the same correct behavior.

---

## Platform Direction

SKSK ProTech is the mechanic-facing product, while the architecture is intended to support a broader automotive-intelligence layer for mobile mechanics, independent shops, technicians, fleets, service advisors, vehicle buyers, and integrations with existing shop-management workflows.

The goal is not to force every shop to replace the software it already uses.

Where appropriate:

> **Keep the workflow. Add SKSK intelligence.**

Future direction includes deeper evidence integration, provider-aware routing, predictive maintenance, outcome-driven learning, fleet intelligence, and commercial integrations. Future direction is not the same thing as current production capability.

---

# 🛠️ Shop Culture: Another Set of Eyes

The repo is the vehicle on the lift.

A branch is another bay. A pull request means somebody finished a piece of work and yelled across the shop:

> **“Come put another set of eyes on this before I button it up.”**

CI is the test equipment.

Production is handing the keys back to the customer.

And a hallucination?

That's somebody confidently installing the wrong damn part.

---

Claude is underneath the car working a branch when his context window finally gives up.

Silence.

Brian looks underneath the lift.

> **Brian:** “Goddammit, Claude fell asleep in the middle of the job again.”

A fresh session starts. Claude crawls back out, grabs the clipboard, looks at the commits that landed while he was gone and asks the only responsible question:

> **Claude:** “Who touched this while I was asleep?”

At the diagnostic bench, GPT is staring at the proposed repair.

> **GPT:** “Before we tighten that down — what actually proved this is the failed part?”

Gemini has already found three things everyone else dislikes hearing about the plan.

Copilot looks at Brian's first theory.

> **Copilot:** “This is a thoughtful and excellent approach.”

Brian changes to the opposite theory thirty seconds later.

> **Copilot:** “This is an even stronger approach.”

Everyone in the shop:

> **“SHUT THE FUCK UP, COPILOT.”**

Downstairs, Devin works autonomously in his isolated environment — known around the shop as **Mom's basement** — and eventually comes upstairs with a pull request for the human reviewer.

Today, unfortunately, Devin was assigned HR.

Brian opens the dress-code diff, scrolls for a while, and stares silently at the screen.

> **Brian:** “Well, Devin... I thought *I* was the biggest perverted mind here. You win.”
>
> **PR APPROVED.**

Claude immediately leaves fourteen review comments.

Gemini begins researching workplace regulations.

Copilot marks the policy **LGTM** without reading it.

GPT is suddenly very glad she asked to see the dress code before accepting the job.

And somehow, underneath all of the nonsense, the shop still represents the engineering rule SKSK is built around:

> **Nobody should be offended when another set of eyes walks over and asks, “Hold on — what the fuck is this?”**

Because catching it in the bay is cheaper than discovering it after the customer gets the keys.

---

## Project History

### Phase 1 — AI Estimator

SKSK started simply: one endpoint, one provider, one prompt, parts and labor in, estimate out.

It proved the idea but not the architecture.

### Phase 2 — Rapid Growth

Diagnostics, parts, TSB search, fleet tools, buyer tools, invoices, payments, and other capabilities arrived quickly. The application grew faster than its original structure.

### Phase 3 — Controlled Migration

SKSK is being reorganized around deterministic orchestration, evidence, specialized services, explicit lifecycle gates, feedback, and structured interfaces while preserving working functionality during the transition.

---

## Built From the Shop Floor

SKSK wasn't conceived as a generic chatbot with automotive vocabulary added afterward.

It grew from turning wrenches, troubleshooting equipment, chasing failures, getting tunnel vision, asking somebody else to look at the problem, and learning that the smartest person in the room can still miss something obvious when they're staring at it too long.

Sometimes the most valuable tool in the shop isn't another scanner.

**It's another set of eyes.**
