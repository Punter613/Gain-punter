SKSK ProTech

An Automotive Intelligence Platform

Evidence. Reasoning. Safety. Human Judgment.


---

What is SKSK?

SKSK ProTech is not another AI chatbot for mechanics.

It is an automotive decision-support platform designed to help mechanics, fleet managers, service advisors, and shop owners make better repair decisions through structured reasoning, deterministic safety rules, and verified repair knowledge.

The mission is simple:

> Give every mechanic an extra set of eyes.



The mechanic always makes the final decision.

The AI assists.


---

Why This Exists

Most automotive software stores information.

Diagnostic scanners read trouble codes.

Estimating software creates invoices.

Shop management systems organize customers.

SKSK is designed to answer a different question:

> "Given everything we know about this vehicle, what is the safest and most likely path forward?"



Instead of replacing existing tools, SKSK is intended to become the intelligence layer that works alongside them.


---

Project History

Phase 1 — AI Estimator

The project began as a simple AI estimate generator.

One endpoint.

One AI provider.

One prompt.

Generate labor.

Generate parts.

Return an estimate.

It worked.

Then users wanted more.


---

Phase 2 — Growth

Features were added rapidly:

Diagnostics

Parts Lookup

TSB Search

Fleet

Buyer Tools

Receptionist

Pricing

Invoices

Payments


The application continued to function, but the architecture became increasingly difficult to maintain.

Logic became duplicated.

Routes expanded.

Business logic spread across unrelated files.

The software outgrew its original design.


---

Phase 3 — Controlled Migration

Rather than deleting everything and starting over, SKSK adopted a different strategy.

Separate the architecture without breaking the application.

Every new feature follows the new architecture.

Existing features continue to work until their replacement is complete.

Nothing is removed until the replacement has been tested.

This allows continuous development without sacrificing stability.


---

Core Philosophy

Artificial Intelligence should assist decisions.

Artificial Intelligence should not own decisions.

The repair process follows a structured pipeline.

Vehicle Information
        │
        ▼
Customer Complaint
        │
        ▼
TAG Safety Evaluation
        │
        ▼
AI Specialist Selection
        │
        ▼
Evidence Validation
        │
        ▼
Economic Analysis
        │
        ▼
Recommendation
        │
        ▼
Mechanic Decision
        │
        ▼
Repair Outcome
        │
        ▼
Knowledge Base

The mechanic remains responsible for the repair.

The AI provides a structured second opinion.


---

Deterministic Safety

Safety-critical recommendations are never left entirely to AI.

Examples include:

Brake wear

Steering components

Tire condition

Cooling system

Oil pressure

Electrical hazards


The Deterministic Orchestrator evaluates known safety rules before AI reasoning and validates AI output afterward.

This prevents unsafe recommendations from reaching the user without review.


---

Platform Architecture

SKSK is organized into specialized engines.

Each engine has a single responsibility.

Core Engines

• Diagnostics Engine
• Estimate Engine
• Pricing Engine
• Parts Intelligence
• VIN Engine
• Fleet Engine
• Buyer Engine
• Knowledge Engine
• Economic Engine
• Evidence Engine
• Safety (TAG) Engine

These engines communicate through structured interfaces rather than directly depending on one another.


---

Knowledge, Not Just AI

Language models improve every year.

The lasting value of SKSK is not the model itself.

The value comes from building a structured automotive knowledge system containing:

Verified repair outcomes

Historical diagnostics

Technician feedback

OEM procedures

Parts relationships

Labor history

Failure patterns

Economic analysis


Every completed repair has the potential to improve future recommendations.


---

Current Development Status

SKSK is currently undergoing a staged architectural migration.

The repository intentionally contains:

Legacy routes

Transitional modules

Duplicate functionality during migration

Temporary compatibility layers


These are not accidental.

They exist to preserve working functionality while the platform is reorganized into independent engines.

No production functionality is intentionally removed until its replacement has been verified.


---

Long-Term Vision

SKSK is designed to become an automotive intelligence platform capable of supporting:

Independent repair shops

Mobile mechanics

Fleet maintenance

Vehicle buyers

Service advisors

White-label commercial deployments


Future capabilities include:

Multi-provider AI routing

Predictive maintenance

Mechanic feedback network

Evidence-based confidence scoring

Fleet analytics

Offline edge deployment

Structured repair intelligence



---

Design Principles

Every major design decision follows these principles:

1. Human judgment always has final authority.


2. AI assists; it does not replace expertise.


3. Safety rules override AI recommendations.


4. Evidence is more valuable than confidence.


5. Architecture evolves through migration, not destructive rewrites.


6. Knowledge is accumulated from verified repair outcomes.


7. Every module should have one clear responsibility.




---

Repository Notice

If you notice duplicate modules, transitional routes, or legacy code, this is expected.

The repository represents an active architectural migration from an early prototype into a modular intelligence platform.

The goal is continuous evolution while preserving proven functionality.


---

Project Vision

Most automotive software answers:

> "What happened?"



SKSK is designed to answer:

> "What is the safest, most evidence-supported decision we can make next?"




---

Built by someone who's spent years turning wrenches, solving problems, and learning that sometimes the most valuable tool in the shop isn't another scanner—it's an extra set of eyes.

