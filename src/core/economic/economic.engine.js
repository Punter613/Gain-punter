/**
 * SKSK Economic Engine
 * Calculates financial impact of maintenance decisions
 * ECF = Expected Cost of Failure
 * EVP = Expected Value of Proactive Maintenance
 * ROI = Return on Investment
 * TCO = Total Cost of Ownership
 */

class EconomicEngine {
  constructor() {
    this.DEFAULTS = {
      averageLaborRate: 125,
      emergencyPremium: 1.5,
      towCost: 150,
      rentalCarCost: 65,
      lostRevenuePerHour: 0,
      downtimeCostPerHour: 50,
      partsMarkup: 0.25,
      taxRate: 0.08,
      inflationRate: 0.03
    };

    this.FAILURE_CURVES = {
      brakes: { baseRate: 0.001, wearFactor: 0.0001, criticalThreshold: 50000 },
      timing_belt: { baseRate: 0.0005, wearFactor: 0.0002, criticalThreshold: 100000 },
      tires: { baseRate: 0.002, wearFactor: 0.00015, criticalThreshold: 40000 },
      transmission: { baseRate: 0.0003, wearFactor: 0.00005, criticalThreshold: 150000 },
      alternator: { baseRate: 0.0004, wearFactor: 0.00008, criticalThreshold: 120000 },
      water_pump: { baseRate: 0.0005, wearFactor: 0.0001, criticalThreshold: 100000 },
      battery: { baseRate: 0.003, wearFactor: 0.0002, criticalThreshold: 48 },
      coolant: { baseRate: 0.001, wearFactor: 0.0001, criticalThreshold: 24 },
      suspension: { baseRate: 0.0002, wearFactor: 0.00003, criticalThreshold: 80000 },
      engine_oil: { baseRate: 0.005, wearFactor: 0.0005, criticalThreshold: 5000 }
    };

    this.FAILURE_COSTS = {
      brakes: { parts: 400, labor: 3, consequential: 0, description: 'Brake failure - collision risk' },
      timing_belt: { parts: 800, labor: 6, consequential: 3000, description: 'Interference engine valve damage' },
      tires: { parts: 600, labor: 1, consequential: 0, description: 'Blowout - collision risk' },
      transmission: { parts: 3500, labor: 12, consequential: 0, description: 'Complete rebuild/replacement' },
      alternator: { parts: 450, labor: 2, consequential: 200, description: 'Battery drain, stranded' },
      water_pump: { parts: 350, labor: 4, consequential: 2500, description: 'Overheat, head gasket damage' },
      battery: { parts: 200, labor: 0.5, consequential: 150, description: 'Stranded, tow required' },
      coolant: { parts: 150, labor: 2, consequential: 2000, description: 'Overheat, engine damage' },
      suspension: { parts: 800, labor: 4, consequential: 0, description: 'Handling degradation' },
      engine_oil: { parts: 100, labor: 1, consequential: 5000, description: 'Engine seizure' }
    };
  }

  async analyze(recommendation, vehicleProfile) {
    const component = recommendation.component || 'general';
    const profile = vehicleProfile || {};
    const fleet = profile.fleetData || {};
    
    const failureProb = this._calculateFailureProbability(component, profile);
    
    const replaceToday = this._calculateReplaceToday(recommendation, profile, failureProb);
    const wait30Days = this._calculateWait30Days(recommendation, profile, failureProb);
    const waitUntilFailure = this._calculateWaitUntilFailure(recommendation, profile, failureProb);
    
    const optimal = this._determineOptimalAction(replaceToday, wait30Days, waitUntilFailure);
    const fleetImpact = fleet.isFleet ? this._calculateFleetImpact(recommendation, profile) : null;
    
    return {
      component,
      vehicle: {
        vin: profile.vin,
        make: profile.make,
        model: profile.model,
        year: profile.year,
        mileage: profile.mileage
      },
      currentFailureProbability: failureProb,
      timelines: {
        replaceToday,
        wait30Days,
        waitUntilFailure
      },
      optimal,
      fleetImpact,
      economicScores: {
        ecf: waitUntilFailure.totalCost,
        evp: waitUntilFailure.totalCost - replaceToday.totalCost,
        roi: (waitUntilFailure.totalCost - replaceToday.totalCost) / replaceToday.totalCost,
        tco: this._calculateTCO(profile, component)
      },
      recommendation: {
        action: optimal.action,
        urgency: optimal.urgency,
        confidence: optimal.confidence,
        reasoning: optimal.reasoning
      },
      metadata: {
        timestamp: new Date().toISOString(),
        engineVersion: '1.0.0',
        assumptions: this.DEFAULTS
      }
    };
  }

  _calculateFailureProbability(component, profile) {
    const curve = this.FAILURE_CURVES[component];
    if (!curve) return 0.1;
    
    const usage = this._getUsageMetric(component, profile);
    const wear = Math.max(0, usage - (curve.criticalThreshold * 0.5));
    const probability = curve.baseRate + (curve.wearFactor * wear);
    
    let multiplier = 1.0;
    if (profile.drivingStyle === 'aggressive') multiplier += 0.3;
    if (profile.drivingStyle === 'towing') multiplier += 0.4;
    if (profile.climate === 'extreme_hot') multiplier += 0.2;
    if (profile.climate === 'extreme_cold') multiplier += 0.15;
    if (profile.climate === 'salt_road') multiplier += 0.25;
    
    if (profile.maintenanceHistory === 'poor') multiplier += 0.3;
    if (profile.maintenanceHistory === 'excellent') multiplier -= 0.2;
    
    return Math.min(0.99, probability * multiplier);
  }

  _getUsageMetric(component, profile) {
    switch (component) {
      case 'battery':
      case 'coolant':
        return profile.componentData?.[component]?.ageMonths ??
               (profile.lastServiceDate ? this._monthsSince(profile.lastServiceDate) : 12);
      case 'engine_oil':
        return profile.mileage - (profile.lastOilChangeMiles || profile.mileage - 3000);
      default:
        return profile.mileage || 0;
    }
  }

  _monthsSince(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    return (now - date) / (1000 * 60 * 60 * 24 * 30);
  }

  _calculateReplaceToday(recommendation, profile, failureProb) {
    const costs = this.FAILURE_COSTS[recommendation.component] || { parts: 300, labor: 2, consequential: 0 };
    const laborRate = profile.shopLaborRate || this.DEFAULTS.averageLaborRate;
    
    const partsCost = (recommendation.partsCost || costs.parts) * (1 + this.DEFAULTS.partsMarkup);
    const laborCost = (recommendation.laborHours || costs.labor) * laborRate;
    const tax = (partsCost + laborCost) * this.DEFAULTS.taxRate;
    
    const totalCost = partsCost + laborCost + tax;
    
    const downtimeHours = (recommendation.laborHours || costs.labor) + 0.5;
    const downtimeCost = profile.isFleet ? 
      (profile.dailyRevenue / 8) * downtimeHours : 
      this.DEFAULTS.downtimeCostPerHour * downtimeHours;
    
    return {
      timeline: 'Replace Today',
      partsCost: Math.round(partsCost * 100) / 100,
      laborCost: Math.round(laborCost * 100) / 100,
      tax: Math.round(tax * 100) / 100,
      downtimeCost: Math.round(downtimeCost * 100) / 100,
      totalCost: Math.round((totalCost + downtimeCost) * 100) / 100,
      primaryDriver: 'ROI',
      coreImpact: 'Minimized vehicle downtime via planned depot scheduling',
      failureProbability: failureProb,
      riskLevel: 'LOW',
      confidence: 0.95
    };
  }

  _calculateWait30Days(recommendation, profile, failureProb) {
    const today = this._calculateReplaceToday(recommendation, profile, failureProb);
    const prob30d = Math.min(0.99, failureProb * 1.5);
    
    const failureCosts = this.FAILURE_COSTS[recommendation.component] || { parts: 300, labor: 2, consequential: 0 };
    const laborRate = profile.shopLaborRate || this.DEFAULTS.averageLaborRate;
    
    const emergencyParts = (failureCosts.parts + failureCosts.consequential) * this.DEFAULTS.emergencyPremium;
    const emergencyLabor = failureCosts.labor * laborRate * this.DEFAULTS.emergencyPremium;
    const towCost = this.DEFAULTS.towCost;
    const rentalCost = this.DEFAULTS.rentalCarCost * 2;
    
    const expectedFailureCost = (emergencyParts + emergencyLabor + towCost + rentalCost) * prob30d;
    const expectedNoFailureCost = today.totalCost * (1 - prob30d);
    
    const totalCost = expectedFailureCost + expectedNoFailureCost;
    
    return {
      timeline: 'Wait 30 Days',
      expectedFailureCost: Math.round(expectedFailureCost * 100) / 100,
      expectedNoFailureCost: Math.round(expectedNoFailureCost * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      primaryDriver: 'Failure Probability (Pf)',
      coreImpact: 'Moderate downtime risk with compounding component exposure',
      failureProbability: prob30d,
      riskLevel: prob30d > 0.5 ? 'HIGH' : 'MODERATE',
      confidence: 0.75 - (prob30d * 0.3)
    };
  }

  _calculateWaitUntilFailure(recommendation, profile, failureProb) {
    const failureCosts = this.FAILURE_COSTS[recommendation.component] || { parts: 300, labor: 2, consequential: 0 };
    const laborRate = profile.shopLaborRate || this.DEFAULTS.averageLaborRate;
    
    const emergencyParts = (failureCosts.parts + failureCosts.consequential) * this.DEFAULTS.emergencyPremium;
    const emergencyLabor = failureCosts.labor * laborRate * this.DEFAULTS.emergencyPremium;
    const towCost = this.DEFAULTS.towCost;
    const rentalCost = this.DEFAULTS.rentalCarCost * 5;
    
    const businessLoss = profile.isFleet ? 
      (profile.dailyRevenue * 5) + (profile.reputationCost || 0) : 0;
    
    const totalCost = emergencyParts + emergencyLabor + towCost + rentalCost + businessLoss;
    
    return {
      timeline: 'Wait Until Failure',
      emergencyParts: Math.round(emergencyParts * 100) / 100,
      emergencyLabor: Math.round(emergencyLabor * 100) / 100,
      towCost: Math.round(towCost * 100) / 100,
      rentalCost: Math.round(rentalCost * 100) / 100,
      businessLoss: Math.round(businessLoss * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      primaryDriver: 'Business Loss',
      coreImpact: 'Critical roadside vehicle breakdown and operational asset disruption',
      failureProbability: 1.0,
      riskLevel: 'CRITICAL',
      confidence: 0.5
    };
  }

  _determineOptimalAction(today, wait30, waitUntil) {
    const costs = [today, wait30, waitUntil];
    const sorted = costs.sort((a, b) => a.totalCost - b.totalCost);
    const best = sorted[0];
    
    let action, urgency, confidence, reasoning;
    
    if (best.timeline === 'Replace Today') {
      action = 'PROCEED_IMMEDIATELY';
      urgency = 'HIGH';
      confidence = today.confidence;
      reasoning = `Proactive repair at $${today.totalCost} is cheaper than expected failure cost of $${waitUntil.totalCost}. ROI: ${((waitUntil.totalCost - today.totalCost) / today.totalCost * 100).toFixed(0)}%`;
    } else if (best.timeline === 'Wait 30 Days') {
      action = 'SCHEDULE_SOON';
      urgency = 'MEDIUM';
      confidence = wait30.confidence;
      reasoning = `30-day window is economically optimal. Monitor closely. Expected cost: $${wait30.totalCost}`;
    } else {
      action = 'MONITOR_ONLY';
      urgency = 'LOW';
      confidence = 0.6;
      reasoning = `Failure cost ($${waitUntil.totalCost}) is not significantly higher than proactive repair. Continue monitoring.`;
    }
    
    if (today.riskLevel === 'CRITICAL' || wait30.riskLevel === 'HIGH') {
      action = 'PROCEED_IMMEDIATELY';
      urgency = 'CRITICAL';
      reasoning = 'SAFETY OVERRIDE: Component failure poses immediate safety risk. Economic analysis secondary.';
    }
    
    return { action, urgency, confidence, reasoning, optimalTimeline: best.timeline };
  }

  _calculateFleetImpact(recommendation, profile) {
    const fleet = profile.fleetData || {};
    const downtimeHours = recommendation.laborHours || 2;
    
    return {
      vehiclesDown: 1,
      revenueAtRisk: Math.round((fleet.dailyRevenue || 500) * (downtimeHours / 8) * 100) / 100,
      contingencyRequired: (fleet.dailyRevenue || 500) > 1000,
      recommendedContingency: (fleet.dailyRevenue || 500) > 1000 ? 
        'Activate backup vehicle or subcontract route' : 
        'Standard scheduling sufficient',
      fleetUtilizationImpact: Math.round((1 / (fleet.totalVehicles || 10)) * 100 * 100) / 100
    };
  }

  _calculateTCO(profile, component) {
    const annualMiles = profile.annualMiles || 12000;
    const yearsOwned = profile.yearsOwned || 1;
    const maintenanceCost = profile.maintenanceCost || 0;
    
    const depreciation = (profile.purchasePrice || 30000) * 0.15 * yearsOwned;
    const fuelCost = (annualMiles / (profile.mpg || 25)) * 3.50 * yearsOwned;
    const insuranceCost = (profile.annualInsurance || 1200) * yearsOwned;
    
    return {
      depreciation: Math.round(depreciation * 100) / 100,
      fuel: Math.round(fuelCost * 100) / 100,
      insurance: Math.round(insuranceCost * 100) / 100,
      maintenance: Math.round(maintenanceCost * 100) / 100,
      total: Math.round((depreciation + fuelCost + insuranceCost + maintenanceCost) * 100) / 100,
      perMile: Math.round(((depreciation + fuelCost + insuranceCost + maintenanceCost) / (annualMiles * yearsOwned)) * 100) / 100
    };
  }

  async analyzeBatch(recommendations, vehicleProfile) {
    const results = await Promise.all(
      recommendations.map(r => this.analyze(r, vehicleProfile))
    );
    
    return results.sort((a, b) => {
      const urgencyOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
      const urgencyDiff = urgencyOrder[a.recommendation.urgency] - urgencyOrder[b.recommendation.urgency];
      if (urgencyDiff !== 0) return urgencyDiff;
      return b.economicScores.evp - a.economicScores.evp;
    });
  }

  getAssumptions() {
    return { ...this.DEFAULTS };
  }

  updateAssumptions(updates) {
    Object.assign(this.DEFAULTS, updates);
  }
}

module.exports = new EconomicEngine();
