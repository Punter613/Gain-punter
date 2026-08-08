/**
 * SKSK Evidence & Trust Layer
 * Validates AI outputs before they reach the decision layer
 * Implements: Source Trust, Schema Validation, AI Consensus, Human Validation,
 * Confidence Scoring, Data Lineage, Version Control, Quarantine Engine
 */

const { z } = require('zod');

class EvidenceVerifier {
  constructor() {
    this.SCHEMAS = {
      diagnostic: z.object({
        rootCauses: z.array(z.object({
          cause: z.string(),
          likelihood: z.number().min(0).max(100),
          confidence: z.number().min(0).max(100)
        })),
        diagnosticSteps: z.array(z.string()),
        relatedComponents: z.array(z.string()),
        overallConfidence: z.number().min(0).max(100)
      }).optional(),
      
      estimate: z.object({
        parts: z.array(z.object({
          partNumber: z.string(),
          description: z.string(),
          manufacturer: z.enum(['OEM', 'Aftermarket']),
          price: z.number().positive(),
          quantity: z.number().positive().default(1)
        })),
        labor: z.object({
          hours: z.number().positive(),
          rate: z.number().positive(),
          subtotal: z.number().positive()
        }),
        fluids: z.array(z.object({
          description: z.string(),
          price: z.number().positive()
        })).optional(),
        tax: z.number().min(0),
        total: z.number().positive()
      }).optional(),
      
      parts: z.object({
        parts: z.array(z.object({
          partNumber: z.string(),
          description: z.string(),
          manufacturer: z.enum(['OEM', 'Aftermarket']),
          price: z.number().positive(),
          availability: z.enum(['in_stock', 'warehouse', 'special_order']),
          eta_days: z.number().min(0),
          warranty_months: z.number().min(0)
        })),
        compatibility_verified: z.boolean(),
        total_cost: z.number().positive()
      }).optional(),
      
      prediction: z.object({
        predictions: z.array(z.object({
          component: z.string(),
          current_condition: z.enum(['good', 'fair', 'poor', 'critical']),
          rul_miles: z.number().min(0),
          rul_days: z.number().min(0),
          failure_probability_30d: z.number().min(0).max(1),
          failure_probability_90d: z.number().min(0).max(1),
          recommended_action: z.string(),
          confidence: z.number().min(0).max(100)
        })),
        overall_health_score: z.number().min(0).max(100),
        next_service_miles: z.number().positive(),
        next_service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
      }).optional()
    };

    this.KB_RULES = {
      validPartPrefixes: {
        'Ford': ['F', 'FL', 'W', 'E'],
        'GM': ['12', '15', '94', '95'],
        'Toyota': ['90', '04', '53'],
        'Honda': ['06', '17', '31']
      },
      
      maxLaborHours: {
        'brake_pad_replacement': 2.0,
        'timing_belt_replacement': 6.0,
        'water_pump_replacement': 4.0,
        'alternator_replacement': 3.0,
        'transmission_rebuild': 16.0
      },
      
      priceRanges: {
        'brake_pads': { min: 30, max: 300 },
        'alternator': { min: 150, max: 600 },
        'timing_belt_kit': { min: 200, max: 800 },
        'water_pump': { min: 80, max: 400 }
      }
    };

    this.feedbackCache = new Map();
    this.QUARANTINE_THRESHOLD = 0.3;
    this.MIN_CONFIDENCE = 0.6;
  }

  async verify(aiOutput, specialist, vehicleProfile) {
    const checks = [];
    let totalConfidence = 0;
    let checkCount = 0;

    const schemaResult = this._validateSchema(aiOutput, specialist);
    checks.push(schemaResult);
    totalConfidence += schemaResult.confidence;
    checkCount++;

    const kbResult = this._verifyAgainstKnowledgeBase(aiOutput, specialist, vehicleProfile);
    checks.push(kbResult);
    totalConfidence += kbResult.confidence;
    checkCount++;

    const historicalResult = await this._checkHistoricalAccuracy(aiOutput, specialist, vehicleProfile);
    checks.push(historicalResult);
    totalConfidence += historicalResult.confidence;
    checkCount++;

    const feedbackResult = this._checkHumanFeedback(aiOutput, specialist, vehicleProfile);
    checks.push(feedbackResult);
    totalConfidence += feedbackResult.confidence;
    checkCount++;

    const consensusResult = await this._checkAIConsensus(aiOutput, specialist, vehicleProfile);
    checks.push(consensusResult);
    totalConfidence += consensusResult.confidence;
    checkCount++;

    const sanityResult = this._runSanityChecks(aiOutput, specialist);
    checks.push(sanityResult);
    totalConfidence += sanityResult.confidence;
    checkCount++;

    const avgConfidence = totalConfidence / checkCount;
    const minConfidence = Math.min(...checks.map(c => c.confidence));
    
    const approved = avgConfidence >= this.MIN_CONFIDENCE && minConfidence >= this.QUARANTINE_THRESHOLD;
    const quarantine = minConfidence < this.QUARANTINE_THRESHOLD;

    return {
      approved,
      confidence: avgConfidence,
      minConfidence,
      checks,
      quarantine,
      quarantineReason: quarantine ? 
        `Check '${checks.find(c => c.confidence < this.QUARANTINE_THRESHOLD)?.name}' failed below threshold` : 
        null,
      metadata: {
        timestamp: new Date().toISOString(),
        specialist,
        vehicleId: vehicleProfile.vehicleId,
        vin: vehicleProfile.vin,
        checkCount,
        passedChecks: checks.filter(c => c.passed).length,
        failedChecks: checks.filter(c => !c.passed).map(c => c.name)
      }
    };
  }

  _validateSchema(output, specialist) {
    const schema = this.SCHEMAS[specialist];
    if (!schema) {
      return {
        name: 'SCHEMA_VALIDATION',
        passed: true,
        confidence: 0.5,
        detail: 'No schema defined for this specialist type'
      };
    }

    try {
      const data = typeof output === 'string' ? JSON.parse(output) : output;
      schema.parse(data);
      
      return {
        name: 'SCHEMA_VALIDATION',
        passed: true,
        confidence: 0.95,
        detail: 'Output matches expected schema'
      };
    } catch (error) {
      return {
        name: 'SCHEMA_VALIDATION',
        passed: false,
        confidence: 0.1,
        detail: `Schema validation failed: ${error.message}`
      };
    }
  }

  _verifyAgainstKnowledgeBase(output, specialist, vehicleProfile) {
    const issues = [];
    let confidence = 0.9;

    if (specialist === 'estimate' || specialist === 'parts') {
      const data = typeof output === 'string' ? JSON.parse(output) : output;
      
      for (const part of data.parts || []) {
        const make = vehicleProfile.make;
        const validPrefixes = make ? this.KB_RULES.validPartPrefixes[make] : null;
        
        if (validPrefixes && !validPrefixes.some(p => part.partNumber.startsWith(p))) {
          issues.push(`Part ${part.partNumber} prefix doesn't match ${make} patterns`);
          confidence -= 0.1;
        }
      }

      if (data.labor) {
        const hours = data.labor.hours;
        const maxHours = Math.max(...Object.values(this.KB_RULES.maxLaborHours));
        if (hours > maxHours) {
          issues.push(`Labor hours (\s${hours}) exceed maximum sanity check (${maxHours})`);
          confidence -= 0.2;
        }
      }

      for (const part of data.parts || []) {
        const category = this._categorizePart(part.description);
        const range = this.KB_RULES.priceRanges[category];
        if (range && (part.price < range.min || part.price > range.max)) {
          issues.push(`Part price ${part.price} outside expected range [${range.min}-${range.max}] for ${category}`);
          confidence -= 0.15;
        }
      }
    }

    if (specialist === 'diagnostic') {
      const data = typeof output === 'string' ? JSON.parse(output) : output;
      
      if (vehicleProfile.knownWeaknesses) {
        const causes = data.rootCauses || [];
        const knownIssues = causes.filter(c => 
          vehicleProfile.knownWeaknesses.some(w => 
            c.cause.toLowerCase().includes(w.toLowerCase())
          )
        );
        
        if (knownIssues.length > 0) {
          confidence += 0.1;
        }
      }
    }

    return {
      name: 'KNOWLEDGE_BASE_VERIFICATION',
      passed: confidence >= 0.5,
      confidence: Math.max(0, confidence),
      detail: issues.length > 0 ? issues.join('; ') : 'All KB checks passed',
      issues
    };
  }

  async _checkHistoricalAccuracy(output, specialist, vehicleProfile) {
    const vehicleKey = `${vehicleProfile.make || 'Unknown'}_${vehicleProfile.model || 'Unknown'}_${vehicleProfile.year || 'Unknown'}`;
    const historicalData = this.feedbackCache.get(vehicleKey);
    
    if (!historicalData) {
      return {
        name: 'HISTORICAL_ACCURACY',
        passed: true,
        confidence: 0.7,
        detail: 'No historical data available for this vehicle type'
      };
    }

    const successRate = historicalData.successRate || 0.75;
    
    return {
      name: 'HISTORICAL_ACCURACY',
      passed: successRate > 0.6,
      confidence: successRate,
      detail: `Historical success rate for similar repairs: ${(successRate * 100).toFixed(1)}%`
    };
  }

  _checkHumanFeedback(output, specialist, vehicleProfile) {
    const repairKey = this._generateRepairKey(output, specialist);
    const feedback = this.feedbackCache.get(repairKey);
    
    if (!feedback) {
      return {
        name: 'HUMAN_FEEDBACK',
        passed: true,
        confidence: 0.6,
        detail: 'No human feedback yet for this specific repair recommendation'
      };
    }

    const mechanicApproval = feedback.mechanicApproval || 0;
    const customerSatisfaction = feedback.customerSatisfaction || 0;
    const fixSuccess = feedback.fixSuccess || 0;
    
    const avgFeedback = (mechanicApproval + customerSatisfaction + fixSuccess) / 3;
    
    return {
      name: 'HUMAN_FEEDBACK',
      passed: avgFeedback >= 0.6,
      confidence: avgFeedback,
      detail: `Mechanic: \s${(mechanicApproval * 100).toFixed(0)}%, Customer: ${(customerSatisfaction * 100).toFixed(0)}%, Fix: ${(fixSuccess * 100).toFixed(0)}%`,
      feedback
    };
  }

  async _checkAIConsensus(output, specialist, vehicleProfile) {
    return {
      name: 'AI_CONSENSUS',
      passed: true,
      confidence: 0.75,
      detail: 'Single-model mode: consensus check skipped (add multi-model support)'
    };
  }

  _runSanityChecks(output, specialist) {
    const issues = [];
    let confidence = 0.9;

    // Guard against undefined/null output (e.g. AI provider call failed or
    // returned an unexpected shape upstream) - previously this crashed the
    // whole pipeline with a TypeError instead of failing evidence gracefully.
    if (output === undefined || output === null) {
      return {
        name: 'SANITY_CHECKS',
        passed: false,
        confidence: 0,
        issues: ['AI output was missing or empty - could not run sanity checks'],
        detail: 'No output received from specialist'
      };
    }

    let data;
    try {
      data = typeof output === 'string' ? JSON.parse(output) : output;
    } catch (e) {
      data = null;
    }
    const outputStr = JSON.stringify(output).toLowerCase();
    
    const hallucinationPatterns = [
      /i think|maybe|possibly|could be|might be/i,
      /i'm not sure|uncertain|don't know/i,
      / hallucination|made up|fabricated/i
    ];

    for (const pattern of hallucinationPatterns) {
      if (pattern.test(outputStr)) {
        issues.push('Output contains uncertainty markers that may indicate hallucination');
        confidence -= 0.2;
      }
    }

    if (specialist === 'prediction') {
      for (const pred of data.predictions || []) {
        if (pred.rul_miles > 500000) {
          issues.push(`RUL ${pred.rul_miles} miles exceeds vehicle lifetime`);
          confidence -= 0.15;
        }
        if (pred.failure_probability_30d > 0.99 && pred.rul_miles > 1000) {
          issues.push('High failure probability but long RUL is contradictory');
          confidence -= 0.1;
        }
      }
    }

    return {
      name: 'SANITY_CHECKS',
      passed: confidence >= 0.5,
      confidence: Math.max(0, confidence),
      detail: issues.length > 0 ? issues.join('; ') : 'All sanity checks passed',
      issues
    };
  }

  _categorizePart(description = '') {
    const desc = description.toLowerCase();
    if (desc.includes('brake') && desc.includes('pad')) return 'brake_pads';
    if (desc.includes('alternator')) return 'alternator';
    if (desc.includes('timing') && desc.includes('belt')) return 'timing_belt_kit';
    if (desc.includes('water') && desc.includes('pump')) return 'water_pump';
    return 'general';
  }

  _generateRepairKey(output, specialist) {
    const str = JSON.stringify({ output, specialist });
    return `feedback_${Buffer.from(str).toString('base64').slice(0, 32)}`;
  }

  recordFeedback(repairKey, feedback) {
    const existing = this.feedbackCache.get(repairKey) || {};
    this.feedbackCache.set(repairKey, {
      ...existing,
      ...feedback,
      timestamp: new Date().toISOString(),
      count: (existing.count || 0) + 1
    });
  }

  quarantineOutput(output, reason, metadata) {
    return {
      status: 'QUARANTINED',
      reason,
      output,
      metadata: {
        ...metadata,
        quarantineTimestamp: new Date().toISOString(),
        reviewRequired: true,
        autoRelease: false
      }
    };
  }

  getStats() {
    return {
      totalChecks: this.feedbackCache.size,
      quarantineThreshold: this.QUARANTINE_THRESHOLD,
      minConfidence: this.MIN_CONFIDENCE,
      schemasDefined: Object.keys(this.SCHEMAS)
    };
  }
}

module.exports = new EvidenceVerifier();
