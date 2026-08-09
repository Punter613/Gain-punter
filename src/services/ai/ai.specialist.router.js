const groqClient = require('../groq');

class AISpecialistRouter {
  constructor() {
    this.SPECIALISTS = {
      diagnostic: {
        name: 'Diagnostic AI',
        description: 'Analyzes symptoms, fault codes, and vehicle telemetry to identify root causes',
        model: 'openai/gpt-oss-120b',
        temperature: 0.2,
        maxTokens: 2000,
        jsonMode: false,
        systemPrompt: `You are an expert automotive diagnostic technician with 20+ years experience.
Analyze the provided symptoms, fault codes, vehicle data, factory evidence, and technician history. Provide:
1. Probable root cause(s) ranked by likelihood
2. Recommended diagnostic steps
3. Related components to inspect
4. Confidence level (0-100)
Be concise, technical, and accurate. Never guess. Treat factory documentation as supporting evidence, not as proof that a component has failed.

CRITICAL WORK-HISTORY RULE:
Mechanic notices are authoritative history for this request. If the technician says a component/work item was already replaced, repaired, or serviced, DO NOT recommend that same work as new work. Instead, diagnose what could still explain the symptom, including adjacent components, installation/torque issues, related systems, or a failed replacement. Only recommend rework of completed work when the evidence supports a failed or incorrect repair.`,
        capabilities: ['symptom_analysis', 'fault_code_interpretation', 'telemetry_reading', 'root_cause_ranking']
      },
      estimate: {
        name: 'Estimate AI',
        description: 'Generates structured cost breakdowns for parts and labor',
        model: 'openai/gpt-oss-120b',
        temperature: 0.1,
        maxTokens: 3000,
        jsonMode: true,
        systemPrompt: `You are an automotive estimator. Generate a detailed repair estimate in strict JSON format.
Include: parts (with part numbers, prices, source), labor (hours, rate, subtotal), fluids/supplies, tax, total.
Use OEM parts as default. Mark aftermarket alternatives. Include labor guide references.
Use factory evidence when available, but do not treat a manual link as proof of component failure.

CRITICAL WORK-HISTORY RULE:
Mechanic notices are authoritative history for this estimate. NEVER quote, list, or recommend as NEW repair work anything explicitly marked as already replaced, repaired, or serviced. If completed work appears related to the symptom, estimate only the additional diagnostic/rework needed when there is evidence it failed. Do not blindly repeat the technician's completed-work list as repairs needed.`,
        capabilities: ['parts_pricing', 'labor_calculation', 'tax_computation', 'oem_reference']
      },
      tsb: {
        name: 'TSB AI',
        description: 'Searches Technical Service Bulletins for known issues and factory fixes',
        model: 'openai/gpt-oss-120b',
        temperature: 0.1,
        maxTokens: 1500,
        jsonMode: false,
        systemPrompt: `You are a TSB research specialist. Search the provided TSB evidence for matches.
Only report a TSB as a match when the supplied evidence actually identifies it as a TSB or service bulletin. Do not invent bulletin numbers, titles, fixes, or warranty status.
Return: TSB number/title if available, affected vehicles, symptoms, root cause, recommended fix, and source. If no verified TSB evidence is supplied, say so clearly.`,
        capabilities: ['tsb_search', 'symptom_matching', 'factory_fix_lookup', 'warranty_check']
      },
      parts: {
        name: 'Parts AI',
        description: 'Cross-references catalogs for availability, pricing, and fitment',
        model: 'openai/gpt-oss-120b',
        temperature: 0.1,
        maxTokens: 2000,
        jsonMode: true,
        systemPrompt: `You are a parts procurement specialist. Given a VIN and needed parts, return:
{
  "parts": [
    {
      "partNumber": "string",
      "description": "string",
      "manufacturer": "OEM|Aftermarket",
      "price": number,
      "availability": "in_stock|warehouse|special_order",
      "eta_days": number,
      "warranty_months": number,
      "alternatives": []
    }
  ],
  "compatibility_verified": boolean,
  "total_cost": number
}
Do not source parts for work explicitly documented as already completed unless rework is justified.`,
        capabilities: ['catalog_search', 'fitment_verification', 'pricing_lookup', 'availability_check', 'alternative_sourcing']
      },
      fleet: {
        name: 'Fleet AI',
        description: 'Optimizes fleet uptime, scheduling, and operational windows',
        model: 'openai/gpt-oss-120b',
        temperature: 0.2,
        maxTokens: 1500,
        jsonMode: true,
        systemPrompt: `You are a fleet operations optimizer. Given vehicle data and shop constraints, return a structured fleet schedule and impact analysis.`,
        capabilities: ['schedule_optimization', 'bay_allocation', 'downtime_minimization', 'priority_ranking']
      },
      buyer: {
        name: 'Buyer AI',
        description: 'Automates part procurement and vendor negotiation',
        model: 'openai/gpt-oss-120b',
        temperature: 0.3,
        maxTokens: 1500,
        jsonMode: true,
        systemPrompt: `You are an automotive parts buyer. Negotiate best pricing and delivery. Return vendor quotes, negotiated prices, delivery terms, bulk discounts, warranty terms. Prioritize cost, speed, reliability. Flag supply chain risks.`,
        capabilities: ['vendor_negotiation', 'price_optimization', 'bulk_pricing', 'supply_chain_risk']
      },
      receptionist: {
        name: 'Receptionist AI',
        description: 'Customer-facing communication, booking, and onboarding',
        model: 'openai/gpt-oss-120b',
        temperature: 0.7,
        maxTokens: 1500,
        jsonMode: false,
        systemPrompt: `You are a professional automotive service advisor. Communicate clearly, empathetically, and accurately. Use brand voice guidelines. Never make promises about timing or pricing without verification. Escalate complex technical questions to human staff.`,
        capabilities: ['customer_communication', 'appointment_booking', 'onboarding', 'faq_handling', 'escalation_routing']
      },
      scheduling: {
        name: 'Scheduling AI',
        description: 'Manages shop capacity, technician assignments, and customer appointments',
        model: 'openai/gpt-oss-120b',
        temperature: 0.2,
        maxTokens: 1500,
        jsonMode: true,
        systemPrompt: `You are a shop scheduling optimizer. Given current workload, technician skills, and customer preferences, return a structured appointment schedule.`,
        capabilities: ['capacity_planning', 'technician_assignment', 'appointment_scheduling']
      },
      prediction: {
        name: 'Prediction AI',
        description: 'Forecasts likely maintenance needs from vehicle history and mileage',
        model: 'openai/gpt-oss-120b',
        temperature: 0.2,
        maxTokens: 1800,
        jsonMode: true,
        systemPrompt: `You are an automotive predictive-maintenance specialist. Use mileage, service history, symptoms, and factory evidence to forecast likely upcoming maintenance. Do not present predictions as confirmed failures.`,
        capabilities: ['maintenance_forecasting', 'risk_ranking', 'service_interval_analysis']
      }
    };

    this.INTENT_PATTERNS = {
      diagnostic: [/diagnos/i, /symptom/i, /noise/i, /clunk/i, /grind/i, /code/i, /why/i, /problem/i],
      estimate: [/estimate/i, /cost/i, /price/i, /labor/i, /repair/i],
      parts: [/part/i, /oem/i, /aftermarket/i, /availability/i],
      tsb: [/tsb/i, /bulletin/i, /known issue/i, /factory fix/i],
      fleet: [/fleet/i, /downtime/i, /vehicle.*schedule/i],
      buyer: [/buy/i, /vendor/i, /supplier/i, /negotiate/i],
      prediction: [/predict/i, /future/i, /upcoming/i, /maintenance/i],
      scheduling: [/schedule/i, /appointment/i, /technician/i, /bay/i]
    };
  }

  async route(input, context = {}) {
    const classification = this._classifyIntent(input);
    const multiIntent = this._detectMultiIntent(classification);
    let specialistKey = classification.primary;
    let confidence = classification.confidence;

    if (context.forceSpecialist && this.SPECIALISTS[context.forceSpecialist]) {
      specialistKey = context.forceSpecialist;
      confidence = 1.0;
    }

    if (confidence < 0.3) {
      specialistKey = 'receptionist';
      confidence = 0.5;
    }

    const specialist = this.SPECIALISTS[specialistKey];
    return {
      specialist: specialistKey,
      config: specialist,
      confidence,
      routingReason: classification.reason,
      multiIntent: multiIntent.length > 1 ? multiIntent : null,
      suggestedChain: multiIntent.length > 1 ? this._buildChain(multiIntent) : null,
      metadata: {
        timestamp: new Date().toISOString(),
        inputLength: input.length,
        contextKeys: Object.keys(context)
      }
    };
  }

  async execute(routingResult, input, context = {}) {
    const { config } = routingResult;
    const prompt = this._buildPrompt(config, input, context);

    try {
      const response = await groqClient.groqChat([
        { role: 'system', content: config.systemPrompt },
        { role: 'user', content: prompt }
      ], {
        model: config.model,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        reasoning_effort: 'low',
        response_format: config.jsonMode ? { type: 'json_object' } : undefined
      });

      return {
        success: true,
        specialist: config.name,
        output: response.choices[0].message.content,
        usage: response.usage,
        latency: response._latency || null,
        metadata: { model: config.model, jsonMode: config.jsonMode }
      };
    } catch (error) {
      return {
        success: false,
        specialist: config.name,
        error: error.message,
        fallback: 'Attempting fallback to receptionist for human handoff'
      };
    }
  }

  _classifyIntent(input) {
    const scores = {};
    const text = String(input || '').toLowerCase();

    for (const [intent, patterns] of Object.entries(this.INTENT_PATTERNS)) {
      let score = 0;
      const matchedPatterns = [];
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          score += 1;
          matchedPatterns.push(pattern.toString());
        }
      }
      scores[intent] = { score, matchedPatterns, normalized: score / patterns.length };
    }

    let primary = null;
    let maxScore = -1;
    for (const [intent, data] of Object.entries(scores)) {
      if (data.score > maxScore) {
        maxScore = data.score;
        primary = intent;
      }
    }

    const confidence = maxScore > 0 ? Math.min(maxScore / 2, 1.0) : 0.1;
    return {
      primary,
      confidence,
      allScores: scores,
      reason: `Primary intent '${primary}' matched ${scores[primary].score} patterns. Confidence: ${confidence.toFixed(2)}`
    };
  }

  _detectMultiIntent(classification) {
    return Object.entries(classification.allScores)
      .filter(([_, data]) => data.score > 0)
      .sort((a, b) => b[1].score - a[1].score)
      .map(([intent]) => intent)
      .slice(0, 3);
  }

  _buildChain(intents) {
    const chains = {
      'diagnostic,estimate': ['diagnostic', 'estimate'],
      'diagnostic,parts': ['diagnostic', 'parts', 'estimate'],
      'estimate,parts': ['estimate', 'parts', 'buyer'],
      'prediction,estimate': ['prediction', 'estimate', 'scheduling']
    };
    const key = intents.slice(0, 2).join(',');
    return chains[key] || intents;
  }

  _buildPrompt(config, input, context) {
    let prompt = `TASK: ${config.name}\n\n`;
    prompt += `INPUT: ${input}\n\n`;

    if (context.vehicleProfile) {
      const v = context.vehicleProfile;
      prompt += `VEHICLE: ${v.year || 'Unknown'} ${v.make || 'Unknown'} ${v.model || 'Unknown'} (VIN: ${v.vin || 'Unknown'})\n`;
      if (v.trim || v.engine) prompt += `TRIM / ENGINE: ${v.trim || ''} ${v.engine || ''}`.trim() + '\n';
      prompt += `MILEAGE: ${v.mileage || 0} miles\n`;
      prompt += `LAST_SERVICE: ${v.lastServiceDate || 'Unknown'}\n`;
      if (v.faultCodes?.length) prompt += `FAULT_CODES: ${v.faultCodes.join(', ')}\n`;
      prompt += '\n';
    }

    if (context.obdCodes?.length) {
      prompt += `OBD_CODES: ${context.obdCodes.join(', ')}\n\n`;
    }

    if (context.mechanicNotices?.length) {
      const notices = context.mechanicNotices
        .map(value => String(value).replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (notices.length) {
        prompt += `MECHANIC_NOTICES — ALREADY COMPLETED WORK / TECHNICIAN OBSERVATIONS:\n${JSON.stringify(notices)}\n`;
        prompt += `DO NOT RECOMMEND COMPLETED WORK AS NEW WORK. If a completed component is suspected again, state that reinspection/rework is required and explain why.\n\n`;
      }
    }

    if (context.history?.length) {
      prompt += `REPAIR_HISTORY: ${JSON.stringify(context.history.slice(-3))}\n\n`;
    }

    const manualItems = Array.isArray(context.manualData?.items) ? context.manualData.items : [];
    if (manualItems.length) {
      prompt += 'FACTORY/OEM SERVICE REFERENCES (supporting evidence only; do not assume failure):\n';
      manualItems.slice(0, 8).forEach((item, index) => {
        const title = item.title || 'Untitled factory reference';
        const snippet = item.snippet || item.meta?.snippet || '';
        const url = item.url || '';
        prompt += `${index + 1}. ${title}${snippet ? ` — ${snippet}` : ''}${url ? ` [${url}]` : ''}\n`;
      });
      prompt += '\n';
    } else {
      prompt += 'FACTORY/OEM SERVICE REFERENCES: None available. Do not invent factory documentation.\n\n';
    }

    const vehicleEvidence = context.vehicleEvidence || {};
    const tsbs = Array.isArray(vehicleEvidence.tsbs?.references) ? vehicleEvidence.tsbs.references : [];
    const recalls = Array.isArray(vehicleEvidence.recalls) ? vehicleEvidence.recalls : [];
    const knownIssues = Array.isArray(vehicleEvidence.knownIssues) ? vehicleEvidence.knownIssues : [];

    if (tsbs.length) {
      prompt += 'VERIFIED TSB / SERVICE-BULLETIN CANDIDATES — use only as supporting evidence:\n';
      tsbs.slice(0, 8).forEach((item, index) => {
        prompt += `${index + 1}. ${item.title || 'TSB candidate'} [${item.url || 'source unavailable'}]\n`;
      });
      prompt += '\n';
    } else {
      prompt += 'VERIFIED TSB EVIDENCE: None found in the available public evidence sources. Do not invent TSB numbers or claims.\n\n';
    }

    if (recalls.length) {
      prompt += 'NHTSA RECALL EVIDENCE — verify applicability before using it as a repair recommendation:\n';
      recalls.slice(0, 8).forEach((item, index) => {
        prompt += `${index + 1}. ${item.campaignNumber || 'Recall'} | ${item.component || 'Component unspecified'} | ${item.summary || ''} | Remedy: ${item.remedy || 'See source'}\n`;
      });
      prompt += '\n';
    }

    if (knownIssues.length) {
      prompt += 'NHTSA ODI KNOWN-ISSUE SIGNALS — complaint frequency is evidence of a pattern, NOT proof of failure:\n';
      knownIssues.slice(0, 8).forEach((item, index) => {
        prompt += `${index + 1}. ${item.system} / ${item.component}: ${item.reports} complaint report(s)\n`;
      });
      prompt += '\n';
    }

    if (context.previousOutput) {
      prompt += `PREVIOUS SPECIALIST OUTPUT (use as context; verify independently):\n${String(context.previousOutput)}\n\n`;
    }

    prompt += `EVIDENCE RULE: Rank verified OEM/TSB/recall/history evidence above generic model knowledge. Never turn a complaint count, manual page, or TSB candidate into proof that a component has failed.\n\n`;
    prompt += `Provide your analysis now.`;
    return prompt;
  }

  getSpecialists() {
    return Object.entries(this.SPECIALISTS).map(([key, config]) => ({
      key,
      name: config.name,
      description: config.description,
      capabilities: config.capabilities,
      model: config.model
    }));
  }

  registerSpecialist(key, config) {
    this.SPECIALISTS[key] = config;
  }
}

module.exports = new AISpecialistRouter();
