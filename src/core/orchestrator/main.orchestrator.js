/**
 * SKSK Main Orchestrator
 * Integrates all layers: Deterministic → Evidence Collection → AI Router → Evidence → Economic → Output
 * This is the single entry point for all SKSK intelligence requests
 */

const deterministicOrchestrator = require('./deterministic.orchestrator');
const aiRouter = require('../../services/ai/ai.specialist.router');
const evidenceVerifier = require('../evidence/evidence.verifier');
const economicEngine = require('../economic/economic.engine');
const { decodeVinNhtsa } = require('../../services/vin');
const { scrapeLEMONManuals } = require('../../services/lemon');

class SKSKOrchestrator {
  constructor() {
    this.pipelineStats = {
      totalRequests: 0,
      deterministicOverrides: 0,
      aiProcessed: 0,
      evidenceCollected: 0,
      scraperCacheHits: 0,
      scraperLiveScrapes: 0,
      evidenceRejected: 0,
      economicAnalyzed: 0,
      errors: 0
    };
  }

  async process(request) {
    const startTime = Date.now();
    this.pipelineStats.totalRequests++;

    try {
      const { input, vehicleProfile = {}, context = {} } = request;

      console.log('[ORCHESTRATOR] Step 1: Running deterministic checks...');
      const deterministicResult = await deterministicOrchestrator.process(vehicleProfile, input);

      if (!deterministicResult.approved) {
        this.pipelineStats.deterministicOverrides++;
        return this._buildDeterministicResponse(deterministicResult, vehicleProfile);
      }

      const safetyConstraints = (deterministicResult.overrides || []).filter(o => o.severity === 'CRITICAL');

      // Evidence collection happens before AI so factory documentation can ground the diagnosis.
      console.log('[ORCHESTRATOR] Step 2: Collecting vehicle/factory evidence...');
      const evidenceContext = await this._collectEvidence(vehicleProfile, context);
      this.pipelineStats.evidenceCollected++;
      if (evidenceContext.manualData?.fromCache) this.pipelineStats.scraperCacheHits++;
      else if (evidenceContext.manualData?.scraped) this.pipelineStats.scraperLiveScrapes++;

      const enrichedContext = {
        ...context,
        ...evidenceContext,
        vehicleProfile
      };

      console.log('[ORCHESTRATOR] Step 3: Running routing assignment to AI specialist...');
      const routingResult = await aiRouter.route(input, {
        ...enrichedContext,
        forceSpecialist: context.forceSpecialist
      });

      console.log(`[ORCHESTRATOR] Step 4: Executing ${(routingResult && routingResult.specialist) || 'general'} specialist...`);
      let aiOutput = await aiRouter.execute(routingResult, input, {
        ...enrichedContext,
        safetyConstraints
      });

      this.pipelineStats.aiProcessed++;

      if (routingResult && routingResult.suggestedChain) {
        console.log(`[ORCHESTRATOR] Multi-intent detected: ${routingResult.suggestedChain.join(' → ')}`);
        aiOutput = await this._executeChain(routingResult.suggestedChain, input, enrichedContext, vehicleProfile);
      }

      const targetPayloadText = typeof aiOutput === 'object' && aiOutput !== null ? aiOutput.output : aiOutput;
      const targetSpecialistKey = (routingResult && routingResult.specialist) || 'general';

      console.log('[ORCHESTRATOR] Step 5: Running evidence verification protocols...');
      const evidenceResult = await evidenceVerifier.verify(
        targetPayloadText,
        targetSpecialistKey,
        vehicleProfile
      );

      if (!evidenceResult.approved) {
        this.pipelineStats.evidenceRejected++;

        if (evidenceResult.quarantine) {
          return this._buildQuarantineResponse(evidenceResult, aiOutput, vehicleProfile);
        }

        console.log('[ORCHESTRATOR] Evidence failed validation tests, dropping back to fallback runner...');
        const fallbackRouting = await aiRouter.route(input, {
          ...enrichedContext,
          vehicleProfile,
          forceSpecialist: 'receptionist'
        });
        aiOutput = await aiRouter.execute(fallbackRouting, input, {
          ...enrichedContext,
          vehicleProfile,
          fallback: true
        });
      }

      console.log('[ORCHESTRATOR] Step 6: Dispatched parsing control loop to economic engine...');
      const verifiedOutputText = typeof aiOutput === 'object' && aiOutput !== null ? aiOutput.output : aiOutput;
      const recommendation = this._parseAIOutput(verifiedOutputText, targetSpecialistKey);
      recommendation.component = recommendation.component || this._inferComponent(input);

      const economicResult = await economicEngine.analyze(recommendation, vehicleProfile);
      this.pipelineStats.economicAnalyzed++;

      console.log('[ORCHESTRATOR] Step 7: Packaging dynamic runtime execution tracking frame...');

      const targetSpecialistName = routingResult && routingResult.config && routingResult.config.name
        ? routingResult.config.name
        : targetSpecialistKey;

      const finalDecision = {
        status: 'SUCCESS',
        pipeline: {
          deterministic: deterministicResult,
          evidenceCollection: evidenceContext,
          routing: routingResult,
          ai: aiOutput,
          evidence: evidenceResult,
          economic: economicResult
        },
        decision: {
          action: economicResult.recommendation?.optimalAction || 'MONITOR',
          urgency: economicResult.recommendation?.urgency || 'LOW',
          confidence: this._calculateOverallConfidence(deterministicResult, evidenceResult, economicResult),
          reasoning: economicResult.recommendation?.reasoning || recommendation.description,
          specialist: targetSpecialistName,
          aiOutput: verifiedOutputText,
          economicAnalysis: economicResult
        },
        metadata: {
          latencyMs: Date.now() - startTime,
          pipelineVersion: '1.1.0-lemon-evidence',
          requestId: this._generateRequestId(),
          timestamp: new Date().toISOString()
        }
      };

      console.log(`[ORCHESTRATOR] Complete. Latency: ${finalDecision.metadata.latencyMs}ms`);
      return finalDecision;

    } catch (error) {
      this.pipelineStats.errors++;
      console.error('[ORCHESTRATOR] Pipeline error:', error);

      return {
        status: 'ERROR',
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        fallback: {
          action: 'HUMAN_HANDOFF',
          message: 'An error occurred during processing. A human service advisor has been notified.',
          urgency: 'HIGH'
        },
        metadata: {
          latencyMs: Date.now() - startTime,
          requestId: this._generateRequestId(),
          timestamp: new Date().toISOString()
        }
      };
    }
  }

  async _collectEvidence(vehicleProfile, context = {}) {
    let resolvedVehicle = { ...vehicleProfile };

    // Prefer supplied decoded vehicle data; otherwise decode the VIN once here.
    if ((!resolvedVehicle.make || !resolvedVehicle.model || !resolvedVehicle.year) && resolvedVehicle.vin) {
      try {
        const decoded = await decodeVinNhtsa(resolvedVehicle.vin);
        if (decoded) resolvedVehicle = { ...resolvedVehicle, ...decoded };
      } catch (error) {
        console.warn('[ORCHESTRATOR] VIN evidence lookup failed:', error.message);
      }
    }

    let manualData = { items: [], error: 'Vehicle data unavailable for LEMON scrape' };
    if (resolvedVehicle.make && resolvedVehicle.year && resolvedVehicle.model) {
      try {
        manualData = await scrapeLEMONManuals(resolvedVehicle);
        manualData = { ...manualData, scraped: !manualData.fromCache && !manualData.error };
        console.log(`[ORCHESTRATOR] LEMON evidence: ${manualData.fromCache ? 'CACHE HIT' : manualData.scraped ? 'LIVE SCRAPE' : 'UNAVAILABLE'} (${manualData.items?.length || 0} items)`);
      } catch (error) {
        console.warn('[ORCHESTRATOR] LEMON evidence collection failed:', error.message);
        manualData = { items: [], error: error.message, fromCache: false, scraped: false };
      }
    }

    return {
      vehicleData: resolvedVehicle,
      manualData,
      evidence: {
        factoryManuals: manualData.items || [],
        source: manualData.fromCache ? 'lemon_cache' : 'lemon_live',
        available: (manualData.items || []).length > 0
      },
      evidenceVehicleProfile: resolvedVehicle,
      ...(context || {})
    };
  }

  _buildDeterministicResponse(deterministicResult, vehicleProfile) {
    const overrides = deterministicResult.overrides || [];
    const critical = overrides.filter(o => o.severity === 'CRITICAL');

    return {
      status: 'DETERMINISTIC_OVERRIDE',
      decision: {
        action: critical.length > 0 ? 'MANDATORY_ACTION_REQUIRED' : 'SAFETY_ADVISORY',
        urgency: critical.length > 0 ? 'CRITICAL' : 'HIGH',
        confidence: 1.0,
        reasoning: deterministicResult.reason || 'Safety firewall restriction applied.',
        overrides: overrides.map(o => ({
          component: o.component,
          metric: o.metric,
          value: o.value,
          threshold: o.threshold,
          requiredAction: o.action,
          severity: o.severity
        }))
      },
      aiBypassed: true,
      humanReviewRequired: critical.length > 0,
      metadata: {
        ...deterministicResult.metadata,
        overrideType: critical.length > 0 ? 'CRITICAL_SAFETY' : 'ADVISORY'
      }
    };
  }

  _buildQuarantineResponse(evidenceResult, aiOutput, vehicleProfile) {
    const verifiedOutputText = typeof aiOutput === 'object' && aiOutput !== null ? aiOutput.output : aiOutput;
    return {
      status: 'QUARANTINED',
      decision: {
        action: 'HUMAN_REVIEW_REQUIRED',
        urgency: 'HIGH',
        confidence: evidenceResult.confidence || 0,
        reasoning: `AI output failed evidence verification: ${evidenceResult.quarantineReason}`,
        quarantineDetails: evidenceResult
      },
      aiOutput: verifiedOutputText,
      humanReviewRequired: true,
      metadata: {
        timestamp: new Date().toISOString(),
        quarantineReason: evidenceResult.quarantineReason
      }
    };
  }

  async _executeChain(chain, input, context, vehicleProfile) {
    let currentOutput = null;
    const chainResults = [];

    for (const specialistKey of chain) {
      const routing = await aiRouter.route(input, {
        ...context,
        vehicleProfile,
        forceSpecialist: specialistKey
      });

      const enrichedContext = {
        ...context,
        vehicleProfile,
        previousOutput: currentOutput
      };

      const result = await aiRouter.execute(routing, input, enrichedContext);
      chainResults.push({ specialist: specialistKey, result });
      currentOutput = result && result.output ? result.output : result;
    }

    return {
      success: true,
      chainResults,
      output: currentOutput,
      chain: chain.join(' → ')
    };
  }

  _parseAIOutput(output, specialist) {
    try {
      const data = typeof output === 'string' ? JSON.parse(output) : output;

      let computedPartsCost = 0;
      if (Array.isArray(data.parts)) {
        computedPartsCost = data.parts.reduce((sum, p) => sum + ((p.price || 0) * (p.quantity || 1)), 0);
      }

      return {
        component: data.component || data.predictions?.[0]?.component || 'general',
        partsCost: computedPartsCost || data.partsCost || 0,
        laborHours: data.labor?.hours || data.laborHours || 2,
        description: data.description || 'AI-generated recommendation',
        confidence: data.confidence || data.overallConfidence || 75
      };
    } catch (e) {
      return {
        component: 'general',
        partsCost: 0,
        laborHours: 2,
        description: typeof output === 'string' ? output : 'Failed parsing raw specialist string format.',
        confidence: 50
      };
    }
  }

  _inferComponent(input) {
    if (!input || typeof input !== 'string') return 'general';
    const text = input.toLowerCase();
    if (text.includes('brake') || text.includes('rotor') || text.includes('pad')) return 'brakes';
    if (text.includes('belt') || text.includes('timing')) return 'timing_belt';
    if (text.includes('tire') || text.includes('tread')) return 'tires';
    if (text.includes('oil') || text.includes('lubrication')) return 'engine_oil';
    return 'general';
  }

  _calculateOverallConfidence(deterministicResult, evidenceResult, economicResult) {
    const scores = [
      deterministicResult?.confidence,
      evidenceResult?.confidence,
      economicResult?.recommendation?.confidence
    ].filter(v => typeof v === 'number');

    if (scores.length === 0) return 75;
    return Math.round(scores.reduce((sum, v) => sum + v, 0) / scores.length);
  }

  _generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}

module.exports = SKSKOrchestrator;
