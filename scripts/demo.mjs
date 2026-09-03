// =============================================================================
//  Datos de demostracion para mirar la app con algo dentro.
//
//    node scripts/demo.mjs      -> requiere base VACIA
//
//  Crea la cuenta "moises" (dueño), el usuario "hermano" (solo lectura, ve una
//  deuda), tres deudas con movimientos repartidos en los ultimos meses y unos
//  comentarios. Contraseña de los dos: deuda1234.
// =============================================================================

import auth from "../api/auth.js";
import debts from "../api/debts.js";
import entries from "../api/entries.js";
import comments from "../api/comments.js";
import categories from "../api/categories.js";
import expenses from "../api/expenses.js";
import incomes from "../api/incomes.js";
import vehicles from "../api/vehicles.js";
import { db, ensureSchema } from "../lib/db.js";

function call(h, { method = "GET", query = {}, body, token } = {}) {
  return new Promise((resolve) => {
    const req = { method, query, body, headers: token ? { "x-session-token": token } : {} };
    const res = { _s: 200, status(c) { this._s = c; return this; }, json(d) { resolve({ status: this._s, body: d }); return this; }, setHeader() { return this; } };
    h(req, res).catch((e) => resolve({ status: 500, body: { error: String(e) } }));
  });
}

await ensureSchema();
if (Number((await db.execute("SELECT COUNT(*) c FROM users")).rows[0].c)) {
  console.error("La base ya tiene usuarios. La demo necesita una base vacia.");
  process.exit(1);
}

// Fechas relativas a hoy, para que los graficos de "ultimos 12 meses" tengan algo.
const hoy = new Date();
const mesAtras = (n, dia = 10) => {
  const d = new Date(hoy.getFullYear(), hoy.getMonth() - n, dia);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let r = await call(auth, { method: "POST", query: { signup: "1" }, body: { name: "moises", password: "deuda1234", fullName: "Moisés" } });
const A = r.body.token;
console.log(`Cuenta creada. Codigo de recuperacion: ${r.body.recovery}`);

r = await call(debts, { method: "POST", token: A, body: { name: "Hermano", kind: "person", currency: "NIO", counterpart: "Juan", note: "Sin interés, abonos cuando se pueda" } });
const D1 = r.body.debt.id;
r = await call(debts, { method: "POST", token: A, body: { name: "Tarjeta Amex", kind: "card", currency: "NIO", counterpart: "Banco", interestRate: 48 } });
const D2 = r.body.debt.id;
r = await call(debts, { method: "POST", token: A, body: { name: "Hermana", kind: "person", currency: "USD", counterpart: "Ana" } });
const D3 = r.body.debt.id;
// Un COBRO: plata que me deben a mi, con acuerdo de pago mensual (ya vencido).
r = await call(debts, { method: "POST", token: A, body: { name: "Primo Carlos", kind: "person", direction: "owed", currency: "NIO", counterpart: "Carlos",
  note: "Le presté para el taller", dueEvery: "monthly", dueAmount: 1000, dueFrom: mesAtras(3, 15) } });
const D4 = r.body.debt.id;

const movs = [
  [D1, "loan", mesAtras(9, 5), 8000, "Para la moto"],
  [D1, "loan", mesAtras(8, 20), 3500, "Universidad"],
  [D1, "payment", mesAtras(7, 15), 1500, "Abono"],
  [D1, "payment", mesAtras(6, 15), 1500, "Abono"],
  [D1, "loan", mesAtras(5, 2), 2000, "Emergencia médica"],
  [D1, "payment", mesAtras(4, 15), 2000, "Abono"],
  [D1, "payment", mesAtras(3, 15), 1500, "Abono"],
  [D1, "payment", mesAtras(1, 15), 2500, "Abono aguinaldo"],
  [D1, "payment", mesAtras(0, 1), 1000, "Abono"],
  // La misma deuda tiene una parte en dolares.
  [D1, "loan", mesAtras(2, 20), 150, "Compra en Amazon", "USD"],
  [D1, "payment", mesAtras(0, 1), 50, "Abono", "USD"],
  [D2, "loan", mesAtras(6, 12), 12500, "Compra laptop"],
  [D2, "payment", mesAtras(5, 28), 2500, "Pago mínimo"],
  [D2, "payment", mesAtras(4, 28), 2500, "Pago mínimo"],
  [D2, "loan", mesAtras(3, 9), 3200, "Supermercado"],
  [D2, "payment", mesAtras(3, 28), 3000, "Pago"],
  [D2, "payment", mesAtras(2, 28), 3000, "Pago"],
  [D2, "payment", mesAtras(1, 28), 2200, "Pago"],
  [D3, "loan", mesAtras(4, 1), 600, "Pasaje"],
  [D3, "payment", mesAtras(2, 10), 200, "Abono"],
  [D3, "payment", mesAtras(0, 1), 150, "Abono"],
  [D4, "loan", mesAtras(4, 2), 6000, "Herramientas para el taller"],
  [D4, "payment", mesAtras(3, 16), 1000, "Primer abono"],
  [D4, "payment", mesAtras(2, 14), 1000, "Abono"],
];
const ids = {};
for (const [debtId, kind, day, amount, reason, currency] of movs) {
  r = await call(entries, { method: "POST", token: A, body: { debtId, kind, day, amount, reason, currency } });
  if (r.status !== 201) console.error("mov fallo", r.body);
  ids[`${debtId}-${day}`] = ids[`${debtId}-${day}`] || r.body.entry?.id;
}

r = await call(auth, { method: "POST", query: { new: "1" }, token: A, body: { name: "hermano", password: "deuda1234", fullName: "Juan", role: "viewer", debtIds: [D1] } });
r = await call(auth, { method: "POST", body: { name: "hermano", password: "deuda1234" } });
const V = r.body.token;
await call(comments, { method: "POST", token: V, body: { debtId: D1, entryId: ids[`${D1}-${mesAtras(1, 15)}`], text: "Este fue el del aguinaldo, te lo pasé por transferencia." } });
await call(comments, { method: "POST", token: A, body: { debtId: D1, entryId: ids[`${D1}-${mesAtras(1, 15)}`], text: "Sí, ya quedó anotado 👍" } });
await call(comments, { method: "POST", token: V, body: { debtId: D1, text: "¿Cuadramos el mes que viene lo que falta?" } });

/* --------------------------------- gastos --------------------------------- */
r = await call(categories, { method: "POST", query: { seed: "1" }, token: A });
const CAT = {};
for (const c of r.body.categories) CAT[c.name] = c.id;
// Presupuesto mensual a las que se usan de verdad.
for (const [nombre, tope] of [["Comida", 9000], ["Casa y servicios", 5000], ["Transporte", 2500], ["Otros", 1500]]) {
  await call(categories, { method: "PUT", query: { id: String(CAT[nombre]) }, token: A, body: { budget: tope } });
}

// Gastos de los ultimos 5 meses. El mes en curso queda un poco pasado en
// Comida, para que se vea el aviso de que uno va sobre el presupuesto.
//
// En el mes EN CURSO los gastos se reparten entre los dias que YA pasaron: uno
// fechado la semana que viene se veria raro al lado de "va el 10% del mes".
// Si hoy es día 3, los dias 3, 7, 11... caen en 3, 1, 2, 3...
const diaDeHoy = hoy.getDate();
const dia = (mes, d) => mesAtras(mes, mes === 0 ? ((d - 1) % diaDeHoy) + 1 : d);
const gastos = [];
const receta = [
  ["Comida", [3200, 2100, 1800, 2400]], ["Casa y servicios", [2800, 1900]],
  ["Transporte", [900, 700]], ["Salud", [1200]], ["Otros", [600, 450]],
];
for (let m = 4; m >= 0; m--) {
  let d = 3;
  for (const [cat, montos] of receta) {
    for (const monto of montos) {
      const factor = m === 0 && cat === "Comida" ? 1.35 : 1;   // este mes se gasto mas en comida
      gastos.push([CAT[cat], dia(m, Math.min(28, d)), Math.round(monto * factor), {
        Comida: "Supermercado", "Casa y servicios": "Luz y agua", Transporte: "Gasolina",
        Salud: "Farmacia", Otros: "Varios",
      }[cat]]);
      d += 4;
    }
  }
}
gastos.push([null, dia(0, 6), 45, "Café", "USD"]);
for (const [categoryId, day, amount, reason, currency] of gastos) {
  r = await call(expenses, { method: "POST", token: A, body: { categoryId, day, amount, reason, currency } });
  if (r.status !== 201) console.error("gasto fallo", r.body);
}

/* -------------------------------- ingresos -------------------------------- */
// Un sueldo viejo y un aumento hace tres meses, para que se vea que los meses
// anteriores siguen contando lo de antes.
await call(incomes, { method: "POST", token: A, body: { kind: "monthly", amount: 22000, currency: "NIO", day: "2025-01-01", source: "Salario" } });
await call(incomes, { method: "POST", token: A, body: { kind: "monthly", amount: 26000, currency: "NIO", day: mesAtras(3, 1), source: "Salario (aumento)" } });
await call(incomes, { method: "POST", token: A, body: { kind: "once", amount: 4000, currency: "NIO", day: dia(0, 2), source: "Trabajo extra" } });

/* -------------------------------- vehiculo -------------------------------- */
// Una moto con historial: el aceite se le hizo hace rato (ya toca), las llantas
// hace poco (falta mucho), y la bujia nunca. Asi la pantalla tiene algo que
// decir en las tres situaciones.
r = await call(vehicles, { method: "POST", token: A, body: { name: "Mi moto", kind: "moto", plate: "M 123456", year: 2019, note: "Roja, 150cc" } });
const VEH = r.body.vehicle.id;
const TAREA = {};
for (const t of r.body.tasks) TAREA[t.name] = t.id;

for (const [tarea, mes, km, titulo, costo, lugar] of [
  ["Cambio de aceite", 8, 8000, "Cambio de aceite y filtro", 1200, "Taller de don Luis"],
  ["Frenos (pastillas)", 6, 9500, "Pastillas delanteras", 900, "Taller de don Luis"],
  ["Cambio de aceite", 4, 11000, "Cambio de aceite", 1250, "Taller de don Luis"],
  ["Llantas", 2, 12800, "Llanta trasera nueva", 3400, "Llantera El Rayo"],
  ["Seguro", 1, 13200, "Seguro anual", 4800, null],
  [null, 0, 13800, "Lavado y engrase", 250, null],
]) {
  r = await call(vehicles, { method: "POST", query: { service: "1" }, token: A, body: {
    vehicleId: VEH, taskId: tarea ? TAREA[tarea] : null, day: dia(mes, 12), odometer: km,
    title: titulo, cost: costo, currency: "NIO", place: lugar,
    // Los dos ultimos se anotan tambien como gasto del hogar, para que se vea
    // que la plata figura una sola vez.
    categoryId: mes <= 1 ? CAT.Transporte : null,
  } });
  if (r.status !== 201) console.error("servicio fallo", r.body);
}

console.log("\nDemo lista:");
console.log("  moises  / deuda1234   (dueño)");
console.log("  hermano / deuda1234   (solo lectura, ve 'Hermano')");
