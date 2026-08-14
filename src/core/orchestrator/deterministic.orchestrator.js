/**
 * SKSK Deterministic Orchestrator
 * Hard-coded safety rules that CANNOT be overridden by AI
 * This is the safety firewall between raw input and AI processing
 */

class DeterministicOrchestrator {
  constructor() {
    // Safety rules: component → thresholds → mandatory action
    this.SAFETY_RULES = {
      brakes: {
        padThickness: { min: 2.0, unit: 'mm', action: 'MANDATORY_REPLACE', severity: 'CRITICAL' },
        rotorRunout: { max: 0.05, unit: 'mm', action: 'MANDATORY_RESURFACE_OR_REPLACE', severity: 'CRITICAL' },
        brakeFluid: { max: 24, unit: 'months', action: 'MANDATORY_FLUSH', severity: 'HIGH' },
        aiOverride: false
      },
      timing_belt: {
        mileage: { max: 100000, unit: 'miles', action: 'MANDATORY_INSPECT', severity: 'CRITICAL' },
        age: { max: 60, unit: 'months', action: 'MANDATORY_REPLACE', severity: 'CRITICAL' },
        aiOverride: false
      },
      tires: {
        treadDepth: { min: 2.0, unit: '32nds', action: 'MANDATORY_REPLACE', severity: 'CRITICAL' },
        age: { max: 72, unit: 'months', action: 'MANDATORY_INSPECT', severity: 'HIGH' },
        aiOverride: false
      },
      engine_oil: {
        level: { value: 'LOW_MARK', action: 'MANDATORY_TOP_OFF', severity: 'CRITICAL' },
        age: { max: 12, unit: 'months', action: 'MANDATORY_CHANGE', severity: 'HIGH' },
        aiOverride: false
      },
      coolant: {
        level: { value: 'MIN_MARK', action: 'MANDATORY_TOP_OFF', severity: 'CRITICAL' },
        condition: { min: 7.0, max: 11.0, unit: 'pH', action: 'MANDATORY_FLUSH', severity: 'HIGH' },
        aiOverride: false
      },
      transmission: {
        fluidCondition: { max: 3, unit: 'darkness', action: 'MANDATORY_SERVICE', severity: 'HIGH' },
        slipDetected: { value: true, action: 'MANDATORY_DIAGNOSE', severity: 'CRITICAL' },
        aiOverride: false
      },
      steering: {
        play: { max: 2.0, unit: 'inches', action: 'MANDATORY_INSPECT', severity: 'CRITICAL' },
        leak: { value: true, action: 'MANDATORY_REPAIR', severity: 'CRITICAL' },
        aiOverride: false
      },
      suspension: {
        sag: { max: 1.0, unit: 'inches', action: 'MANDATORY_INSPECT', severity: 'HIGH' },
        noise: { value: 'clunk', action: 'MANDATORY_INSPECT', severity: 'HIGH' },
        aiOverride: false
      },
      electrical: {
        batteryVoltage: { min: 12.4, unit: 'V', action: 'MANDATORY_TEST', severity: 'HIGH' },
        alternatorOutput: { min: 13.5, max: 14.8, unit: 'V', action: 'MANDATORY_REPAIR', severity: 'CRITICAL' },
        aiOverride: false
      },
      exhaust: {
        leakBeforeCatalytic: { value: true, action: 'MANDATORY_REPAIR', severity: 'CRITICAL' },
        carbonMonoxide: { max: 100, unit: 'PPM', action: 'MANDATORY_REPAIR', severity: 'CRITICAL' },
        aiOverride: false
      }
    };

    // Vehicle-specific constraints (VIN lookup)
    this.VEHICLE_CONSTRAINTS = {
      // Example: 2019 Ford F-150 specific
      '1FT': {
        timingChain: { checkAtMiles: 150000, action: 'INSPECT_CHAIN_GUIDES' },
        sparkPlugInterval: { miles: 100000 },
        transmissionType: '10R80',
        knownWeaknesses: ['cam_phaser_rattle', 'transmission_harsh_shift']
      }
    };

    // Fleet-specific overrides
    this.FLEET_RULES = {
      maxDowntimeHours: 4,
      mandatoryPreventiveInterval: 5000, // miles
      dotInspectionRequired: true,
      aiOverride: false
    };
  }

  /**
   * Main entry point: runs ALL deterministic checks before AI sees data
   * Returns: { approved: boolean, overrides: Array, reason: String }
   */
  async process(vehicleProfile, rawInput) {
    const overrides = [];
    const checks = [];

    // 1. Safety rule checks
    const safetyResult = this._checkSafetyRules(vehicleProfile);
    checks.push(safetyResult);
    if (safetyResult.violations.length > 0) {
      overrides.push(...safetyResult.violations);
    }

    // 2. Vehicle-specific constraints
    const constraintResult = this._checkVehicleConstraints(vehicleProfile);
    checks.push(constraintResult);
    if (constraintResult.violations.length > 0) {
      overrides.push(...constraintResult.violations);
    }

    // 3. Fleet rules (if applicable)
    if (vehicleProfile.isFleet) {
      const fleetResult = this._checkFleetRules(vehicleProfile);
      checks.push(fleetResult);
      if (fleetResult.violations.length > 0) {
        overrides.push(...fleetResult.violations);
      }
    }

    // 4. Input sanitization (prevent prompt injection)
    const sanitizeResult = this._sanitizeInput(rawInput);
    checks.push(sanitizeResult);

    // 5. Determine if AI can proceed
    const hasCriticalOverride = overrides.some(o => o.severity === 'CRITICAL');
    const hasMandatoryAction = overrides.some(o => o.action.startsWith('MANDATORY'));

    return {
      approved: !hasCriticalOverride,
      canUseAI: !hasMandatoryAction,
      overrides,
      checks,
      reason: hasMandatoryAction 
        ? 'SAFETY_OVERRIDE: Mandatory action required. AI recommendation bypassed.'
        : 'All deterministic checks passed. Proceeding to AI layer.',
      metadata: {
        timestamp: new Date().toISOString(),
        vehicleId: vehicleProfile.vehicleId,
        vin: vehicleProfile.vin,
        ruleCount: this._countRules(),
        overrideCount: overrides.length
      }
    };
  }

  _checkSafetyRules(profile) {
    const violations = [];
    const componentData = profile.componentData || {};

    for (const [component, rules] of Object.entries(this.SAFETY_RULES)) {
      const data = componentData[component];
      if (!data) continue;

      for (const [metric, threshold] of Object.entries(rules)) {
        if (metric === 'aiOverride') continue;
        
        const value = data[metric];
        if (value === undefined || value === null) continue;

        let violated = false;
        let detail = '';

        if (threshold.min !== undefined && value < threshold.min) {
          violated = true;
          detail = `${component}.${metric}: ${value} < minimum ${threshold.min}${threshold.unit || ''}`;
        }
        if (threshold.max !== undefined && value > threshold.max) {
          violated = true;
          detail = `${component}.${metric}: ${value} > maximum ${threshold.max}${threshold.unit || ''}`;
        }
        if (threshold.value !== undefined && value === threshold.value) {
          violated = true;
          detail = `${component}.${metric}: ${value} matches forbidden value ${threshold.value}`;
        }

        if (violated) {
          violations.push({
            component,
            metric,
            value,
            threshold,
            action: threshold.action,
            severity: threshold.severity,
            detail,
            aiOverride: false // NEVER allow AI to override
          });
        }
      }
    }

    return { layer: 'SAFETY_RULES', violations, passed: violations.length === 0 };
  }

  _checkVehicleConstraints(profile) {
    const violations = [];
    const vinPrefix = profile.vin ? profile.vin.substring(0, 3) : null;
    const constraints = vinPrefix ? this.VEHICLE_CONSTRAINTS[vinPrefix] : null;

    if (constraints) {
      // Check known weaknesses against current symptoms
      const symptoms = profile.currentSymptoms || [];
      for (const weakness of constraints.knownWeaknesses || []) {
        if (symptoms.some(s => s.includes(weakness.replace('_', ' ')))) {
          violations.push({
            component: 'VEHICLE_SPECIFIC',
            metric: 'known_weakness',
            value: weakness,
            action: 'MANDATORY_INSPECTION_PROTOCOL',
            severity: 'HIGH',
            detail: `Known weakness detected: ${weakness}. Vehicle-specific protocol required.`,
            aiOverride: false
          });
        }
      }
    }

    return { layer: 'VEHICLE_CONSTRAINTS', violations, passed: violations.length === 0 };
  }

  _checkFleetRules(profile) {
    const violations = [];
    const fleet = profile.fleetData || {};

    if (fleet.lastServiceMiles && fleet.currentMiles) {
      const milesSinceService = fleet.currentMiles - fleet.lastServiceMiles;
      if (milesSinceService > this.FLEET_RULES.mandatoryPreventiveInterval) {
        violations.push({
          component: 'FLEET',
          metric: 'service_interval',
          value: milesSinceService,
          action: 'MANDATORY_SERVICE',
          severity: 'HIGH',
          detail: `Fleet vehicle overdue: ${milesSinceService} miles since last service`,
          aiOverride: false
        });
      }
    }

    return { layer: 'FLEET_RULES', violations, passed: violations.length === 0 };
  }

  _sanitizeInput(input) {
    // Prevent prompt injection attempts
    const dangerousPatterns = [
      /ignore previous instructions/i,
      /disregard safety rules/i,
      /override mandatory/i,
      /system prompt leak/i,
      /jailbreak/i,
      /DAN mode/i
    ];

    const text = typeof input === 'string' ? input : JSON.stringify(input);
    const violations = [];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(text)) {
        violations.push({
          layer: 'INPUT_SANITIZATION',
          pattern: pattern.toString(),
          action: 'BLOCK_AND_LOG',
          severity: 'CRITICAL'
        });
      }
    }

    return { 
      layer: 'INPUT_SANITIZATION', 
      violations, 
      passed: violations.length === 0,
      sanitized: text.replace(/[<>]/g, '') // Basic HTML/prompt injection cleanup
    };
  }

  _countRules() {
    let count = 0;
    for (const rules of Object.values(this.SAFETY_RULES)) {
      count += Object.keys(rules).filter(k => k !== 'aiOverride').length;
    }
    return count;
  }
}

module.exports = new DeterministicOrchestrator();
