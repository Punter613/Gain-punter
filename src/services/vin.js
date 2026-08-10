async function decodeVinNhtsa(vin) {
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`VIN decode failed: ${res.status}`);
  const data = await res.json();

  const v = data?.Results?.[0];
  if (!v || !v.Make) return null;

  return {
    year: v.ModelYear || '',
    make: v.Make || '',
    model: v.Model || '',
    trim: v.Trim || '',
    engine: v.DisplacementL ? `${v.DisplacementL}L` : (v.EngineModel || ''),
    engineCylinders: v.EngineCylinders || '',
    driveType: v.DriveType || '',
    bodyClass: v.BodyClass || '',
    transmissionStyle: v.TransmissionStyle || ''
  };
}

module.exports = { decodeVinNhtsa };
