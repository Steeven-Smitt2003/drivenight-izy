const REGISTRATION_MIN = 3;
const REGISTRATION_MAX = 20;

function clean(value) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return text === '' ? null : text;
}

function missing(field) {
  return { ok: false, error: 'DRIVER_VEHICLE_REQUIRED', field };
}

export function normalizeVehicleDetails({ category, color, make, registration }) {
  const cleanColor = clean(color);
  const cleanMake = clean(make);
  const cleanRegistration = clean(registration);

  if (category === 'moto') {
    if (!cleanColor) return missing('color');
    return {
      ok: true,
      vehicle: { category, color: cleanColor, make: cleanMake, registration: null },
    };
  }

  if (!cleanMake) return missing('make');
  if (
    !cleanRegistration
    || cleanRegistration.length < REGISTRATION_MIN
    || cleanRegistration.length > REGISTRATION_MAX
  ) {
    return missing('registration');
  }
  if (!cleanColor) return missing('color');
  return {
    ok: true,
    vehicle: { category, color: cleanColor, make: cleanMake, registration: cleanRegistration },
  };
}

export function vehicleSignupMetadata({ category, color, make, registration }) {
  const metadata = { vehicle_category: category, vehicle_color: clean(color) };
  if (category === 'moto') {
    const cleanMake = clean(make);
    if (cleanMake) metadata.vehicle_make = cleanMake;
    return metadata;
  }
  metadata.vehicle_make = clean(make);
  metadata.vehicle_registration = clean(registration);
  return metadata;
}

export function vehicleSummary(vehicle) {
  if (!vehicle) return '';
  const label = vehicle.category === 'moto' ? 'Moto' : 'Voiture';
  const name = [vehicle.make, vehicle.model].filter(Boolean).join(' ');
  return [label, name, vehicle.color, vehicle.registration].filter(Boolean).join(' · ');
}
