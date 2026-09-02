// =============================================================================
//  La fecha de la app.
//
//  Todo trabaja con la hora de NICARAGUA (America/Managua, UTC-6 todo el año,
//  sin horario de verano). Da igual donde este el servidor o como tenga la zona
//  el telefono: "hoy" significa lo mismo para quien presta y para quien debe.
// =============================================================================

export const TZ = "America/Managua";

// "en-CA" formatea como YYYY-MM-DD, que es justo como se guardan las fechas.
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
});

// Fecha de hoy, en YYYY-MM-DD.
export const today = (d = new Date()) => fmt.format(d);
