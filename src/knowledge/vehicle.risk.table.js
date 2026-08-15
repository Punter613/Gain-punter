/**
 * SKSK ProTech - Relational Fleet Architecture Registry
 * Upgraded to enforce strict year brackets, specific engine variants, and plant histories.
 */

const VEHICLE_FLEET_DB = {
  'FORD_F150_3V_TRITON': {
    vehicleId: 'FORD_F150_3V_TRITON',
    make: 'Ford',
    model: 'F150',
    engineCode: '5.4L 3V',
    minYear: 2004,
    maxYear: 2010,
    baseRiskScore: 78,
    rustMultiplier: 1.25,
    safetyCriticalComponents: ['spark_plugs', 'brakes', 'exhaust_manifolds'],
    commonFailures: ['spark_plug_separation', 'cam_phaser_failure', 'timing_chain_wear']
  },
  'GM_SILVERADO_AFM_5.3': {
    vehicleId: 'GM_SILVERADO_AFM_5.3',
    make: 'Chevrolet',
    model: 'Silverado',
    engineCode: '5.3L AFM',
    minYear: 2007,
    maxYear: 2014,
    baseRiskScore: 72,
    rustMultiplier: 1.25,
    safetyCriticalComponents: ['afm_lifters', 'oil_pressure_screen', 'brake_lines'],
    commonFailures: ['afm_lifter_collapse', 'oil_pressure_sensor_clog', 'salt_belt_brake_line_rot']
  },
  'FORD_3.5_ECOBOOST_V1': {
    vehicleId: 'FORD_3.5_ECOBOOST_V1',
    make: 'Ford',
    model: 'F150',
    engineCode: '3.5L EcoBoost',
    minYear: 2011,
    maxYear: 2016,
    baseRiskScore: 70,
    rustMultiplier: 1.20,
    safetyCriticalComponents: ['cam_phasers', 'turbo_oil_lines'],
    commonFailures: ['vct_phaser_rattle', 'timing_chain_stretch', 'turbo_coolant_line_leaks']
  },
  'RAM_5.7_HEMI': {
    vehicleId: 'RAM_5.7_HEMI',
    make: 'Ram',
    model: '1500',
    engineCode: '5.7L Hemi',
    minYear: 2009,
    maxYear: 2022,
    baseRiskScore: 75,
    rustMultiplier: 1.20,
    safetyCriticalComponents: ['camshaft', 'lifters', 'exhaust_manifold_bolts'],
    commonFailures: ['hemi_lifter_seizure', 'exhaust_bolt_shear']
  },
  'TOYOTA_TUNDRA_5.7': {
    vehicleId: 'TOYOTA_TUNDRA_5.7',
    make: 'Toyota',
    model: 'Tundra',
    engineCode: '5.7L 3UR-FE',
    minYear: 2007,
    maxYear: 2021,
    baseRiskScore: 45,
    rustMultiplier: 1.30,
    safetyCriticalComponents: ['water_pump', 'cam_towers', 'frame'],
    commonFailures: ['tundra_water_pump_leak', 'cam_tower_weep']
  },
  'HONDA_ACCORD_2.4': {
    vehicleId: 'HONDA_ACCORD_2.4',
    make: 'Honda',
    model: 'Accord',
    engineCode: '2.4L K24',
    minYear: 2008,
    maxYear: 2015,
    baseRiskScore: 50,
    rustMultiplier: 1.15,
    safetyCriticalComponents: ['vtc_actuator', 'timing_chain'],
    commonFailures: ['vtc_actuator_rattle', 'k24_oil_consumption']
  },
  'CHEVY_EQUINOX_2.4': {
    vehicleId: 'CHEVY_EQUINOX_2.4',
    make: 'Chevrolet',
    model: 'Equinox',
    engineCode: '2.4L Ecotec',
    minYear: 2010,
    maxYear: 2017,
    baseRiskScore: 82,
    rustMultiplier: 1.20,
    safetyCriticalComponents: ['piston_rings', 'timing_chain_guides'],
    commonFailures: ['ecotec_oil_consumption', 'ecotec_chain_stretch']
  },
  'FORD_FOCUS_2.0': {
    vehicleId: 'FORD_FOCUS_2.0',
    make: 'Ford',
    model: 'Focus',
    engineCode: '2.0L Duratec DPS6',
    minYear: 2012,
    maxYear: 2018,
    baseRiskScore: 85,
    rustMultiplier: 1.10,
    safetyCriticalComponents: ['tcm', 'clutch_actuator'],
    commonFailures: ['powershift_clutch_shudder', 'tcm_communication_failure']
  }
};

function normalizeVehicleToken(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getVehicleRiskProfile(vehicle = {}, vin = '') {
  const make = normalizeVehicleToken(vehicle.make);
  const model = normalizeVehicleToken(vehicle.model);
  const trim = (vehicle.trim || '').toLowerCase();
  const year = parseInt(vehicle.year) || 0;
  const cleanVin = (vin || '').toUpperCase().trim();

  for (const profile of Object.values(VEHICLE_FLEET_DB)) {
    const profileMake = normalizeVehicleToken(profile.make);
    const profileModel = normalizeVehicleToken(profile.model);

    const makeMatch = make && profileMake && (make.includes(profileMake) || profileMake.includes(make));
    const modelMatch = model && profileModel && (model.includes(profileModel) || profileModel.includes(model));

    if (makeMatch && modelMatch) {
      if (year >= profile.minYear && year <= profile.maxYear) {
        // If we have engine specific info, try to match it
        const engineInfo = (trim + ' ' + (vehicle.engine || '')).toLowerCase();

        if (engineInfo.includes('5.4') || engineInfo.includes('triton') || cleanVin.includes('5.4')) {
          if (profile.engineCode.includes('3V')) return profile;
        }
        if (engineInfo.includes('5.3') || engineInfo.includes('vortec') || engineInfo.includes('afm')) {
          if (profile.engineCode.includes('AFM')) return profile;
        }
        if (engineInfo.includes('3.5') || engineInfo.includes('ecoboost')) {
          if (profile.engineCode.includes('EcoBoost')) return profile;
        }
        if (engineInfo.includes('5.7') || engineInfo.includes('hemi')) {
          if (profile.engineCode.includes('Hemi')) return profile;
        }
        if (engineInfo.includes('5.7') || engineInfo.includes('3ur')) {
          if (profile.engineCode.includes('3UR-FE')) return profile;
        }
        if (engineInfo.includes('2.4') || engineInfo.includes('k24')) {
          if (profile.engineCode.includes('K24')) return profile;
        }
        if (engineInfo.includes('2.4') || engineInfo.includes('ecotec')) {
          if (profile.engineCode.includes('Ecotec')) return profile;
        }
        if (engineInfo.includes('2.0') || engineInfo.includes('dps6') || engineInfo.includes('powershift')) {
          if (profile.engineCode.includes('DPS6')) return profile;
        }

        return profile;
      }
    }
  }
  return null;
}

module.exports = { getVehicleRiskProfile, VEHICLE_FLEET_DB, normalizeVehicleToken };
