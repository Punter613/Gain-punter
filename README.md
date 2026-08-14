# 🔧 SKSK ProTech

> **Your extra set of eyes.**
>
> Evidence. Reasoning. Safety. Human judgment.

SKSK ProTech is an automotive intelligence and decision-support platform built for mechanics — not an AI chatbot pretending to be one.

It brings vehicle data, diagnostic observations, known failure patterns, service evidence, technician feedback, deterministic safety rules, and AI reasoning together to answer one practical question:

> **Given everything we know about this vehicle, what is the safest, most evidence-supported thing to do next?**

The mechanic always makes the final decision.

AI assists. Evidence grounds. Deterministic rules guard. The mechanic verifies.

---

## Why SKSK Exists

Most automotive software is good at storing or retrieving information.

- Scan tools read trouble codes.
- Estimating systems price repairs.
- Shop-management systems organize jobs and customers.
- Service information tells a technician how a repair is performed.

SKSK is intended to sit between those pieces as an **intelligence layer**.

A trouble code is not automatically a failed part. A symptom is not a diagnosis. A Technical Service Bulletin is evidence, not proof. A confident AI answer is still only an answer until the vehicle proves it.

SKSK is designed around that distinction.

---

## The Repair Decision Pipeline

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
   ┌──────┼──────┐
   ▼      ▼      ▼
 Lemon   NHTSA   Known Patterns
   │      │      │
   └──────┼──────┘
          ▼
Evidence Ranking + Relevance
          │
          ▼
AI Specialist Reasoning
          │
          ▼
Deterministic Validation + Safety Guards
          │
          ▼
Confirmation Tests
          │
          ▼
MECHANIC VERIFY
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

The important part is not which model generated a sentence.

The important part is whether the recommendation survives evidence, testing, deterministic rules, and technician verification.

---

## AI Never Gets the Final Word

SKSK deliberately puts deterministic controls around model reasoning.

Known safety conditions can be evaluated before AI runs. AI output is validated afterward. Completed work is tracked so the system does not casually recommend replacing the same component again. Diagnostic-stage guards prevent an unverified hypothesis from silently becoming an authorized repair.

The intended lifecycle is:

**DIAGNOSE → TEST → VERIFY → AUTHORIZE → ESTIMATE → REPAIR → OUTCOME**

AI is valuable inside that process. It does not own the process.

---

## Evidence Before Confidence

SKSK is being built around increasingly structured automotive evidence, including:

- NHTSA manufacturer communications / TSB corpus
- Lemon/manual-derived service evidence
- Vehicle-specific known failure patterns
- OBD codes and technician observations
- Repair procedures and service information
- Confirmed mechanic feedback and repair outcomes

The goal is not to dump an entire library into a language model.

The retrieval layer should find the small number of records that matter for the vehicle and complaint, rank them, remove noise and duplication, and hand the reasoning layer a compact evidence packet.

**More data should create better evidence — not a bigger prompt.**

---

## Deterministic Safety

Safety-critical decisions are never intended to depend entirely on probabilistic model output.

Examples include conditions involving:

- brakes
- steering
- tires
- cooling systems
- oil pressure
- electrical hazards
- repair authorization

The deterministic layer can challenge, constrain, reject, or require verification of AI-generated recommendations.

Confidence does not outrank evidence.

---

## The Knowledge Loop

The long-term value of SKSK is not any single AI model.

Models will change. Providers will change. Prices and rate limits will change.

The durable asset is the knowledge accumulated around real repair decisions:

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

## Platform Direction

SKSK ProTech is the mechanic-facing product, but the architecture is intended to support a broader automotive intelligence layer.

Potential consumers include:

- mobile mechanics
- independent repair shops
- shop technicians
- fleets
- service advisors
- vehicle buyers
- existing shop-management software through an intelligence API

The goal is not to force every shop to replace the software it already uses.

Where appropriate: **keep the workflow; add SKSK intelligence.**

---

## Development Philosophy

SKSK grew from a simple AI estimator into a much larger system. That growth created legacy routes, transitional modules, disconnected features, and architectural duplication.

The response is not to repeatedly burn the shop down and rebuild it.

The migration rules are intentionally practical:

1. Preserve proven functionality until its replacement is verified.
2. Prefer one source of truth over duplicated implementations.
3. Keep modules responsible for one clear job.
4. Test the actual runtime path, not merely the diff.
5. Treat AI output as a hypothesis until evidence supports it.
6. Let deterministic rules win when safety or authorization requires it.
7. Learn from confirmed repair outcomes.
8. Favor less code when it produces the same correct behavior.

---

# 🛠️ A Few Minutes Inside the SKSK Shop

The repo is the vehicle on the lift.

A branch is another bay. A pull request means somebody finished a piece of work and yelled across the shop:

> **“Come put another set of eyes on this before I button it up.”**

CI is the test equipment. Production is handing the keys back to the customer.

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

**Nobody should be offended when another set of eyes walks over and asks, “Hold on — what the fuck is this?”**

Because catching it in the bay is cheaper than discovering it after the customer gets the keys.

---

## Project History

### Phase 1 — AI Estimator

SKSK started simply: one endpoint, one provider, one prompt, parts and labor in, estimate out.

It proved the idea but not the architecture.

### Phase 2 — Rapid Growth

Diagnostics, parts, TSB search, fleet tools, buyer tools, invoices, payments and other capabilities arrived quickly. The application grew faster than its original structure.

### Phase 3 — Controlled Migration

SKSK is now being reorganized around deterministic orchestration, evidence, specialized services, explicit lifecycle gates, feedback, and structured interfaces — while preserving working functionality during the transition.

---

## Long-Term Vision

SKSK is intended to become an automotive intelligence platform capable of supporting diagnostics, estimates, repair knowledge, fleet maintenance, evidence-based confidence, predictive maintenance, provider routing, mechanic feedback, and commercial integrations.

But the principle underneath the roadmap stays simple:

> **Don't replace the mechanic's judgment. Give it better information and another set of eyes.**

---

## Built From the Shop Floor

SKSK wasn't conceived as a generic chatbot with automotive vocabulary added afterward.

It grew from years of turning wrenches, troubleshooting equipment, chasing failures, getting tunnel vision, asking somebody else to look at the problem, and learning that the smartest person in the room can still miss something obvious when they're staring at it too long.

Sometimes the most valuable tool in the shop isn't another scanner.

**It's another set of eyes.**
