# Component applicability boundary

SKSK ProTech must not turn a symptom pattern into a vehicle-specific component fact.

## Core rule

A configuration-sensitive component may appear as a diagnosis candidate only when SKSK has enough evidence that the component exists on the exact vehicle. Otherwise the diagnosis must stay at the broader system level or explicitly say `if equipped — configuration not verified`.

Policy identifier:

`PROVE_COMPONENT_EXISTS_OR_QUALIFY_IF_EQUIPPED`

## Configuration trust

- `VIN_VERIFIED` means the current identity/configuration field came from a successful VIN decode.
- `MANUAL_UNVERIFIED` means the value was typed or otherwise supplied without VIN-backed configuration proof.
- `UNKNOWN` means the field is not established.

A manually typed engine or drivetrain is useful intake context but is not component-fitment proof.

If a successfully decoded VIN conflicts with manual year/make/model/engine/drivetrain input, the boundary records the contradiction and diagnostic confidence is forced low until the mismatch is resolved.

## Component presence

Some components require explicit physical presence evidence even when the broad drivetrain is known. Examples include center-support/carrier bearings, transfer cases, power transfer units, center differentials, turbochargers, superchargers, high-voltage batteries, and DPF assemblies.

Physical mechanic observations such as inspected, measured, replaced, installed, present, visible, or measured play at the named component can establish that the component is present. Customer wording alone does not.

Other drivetrain components can be admitted only when the known drive configuration makes the component class applicable or the mechanic has physically established its presence.

## Output guard

The deterministic guard runs after the initial Diagnose response and again after diagnostic reassessment.

If an unproven configuration-sensitive part is emitted as the primary cause, SKSK replaces it with a broader system-level candidate such as:

`Driveline / torque-transfer mechanical fault (specific component fitment not yet verified)`

Secondary candidates and probability candidates are explicitly qualified as if-equipped. Tests that mention an unproven component are rewritten to start with:

`If equipped on this exact vehicle configuration:`

The guard also lowers diagnostic direction confidence when a component-specific primary cause had to be bounded or when VIN/manual configuration contradictions exist.

## Persistence

The lifecycle middleware persists `vehicleConfiguration` inside the diagnostic evidence packet so later reassessment uses the same applicability boundary instead of forgetting how vehicle configuration was established.

## Separation from VERIFY

This boundary does not verify a fault. A component can be proven to exist and still be healthy. Existing TEST -> CONFIRMS -> VERIFY requirements remain unchanged.
