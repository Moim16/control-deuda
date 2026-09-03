// =============================================================================
//  Prueba de humo de la INTERFAZ, sin navegador.
//
//    node scripts/ui-check.mjs
//
//  Saca el <script> de index.html, lo corre en un DOM de mentira y llama a las
//  funciones que pintan cada pantalla con datos inventados. No comprueba como
//  se ve (para eso hay que abrirlo), sino que:
//
//    - el script se evalua sin reventar,
//    - cada pantalla se pinta sin lanzar excepciones,
//    - el texto que sale es el correcto para quien mira (dueño / solo lectura),
//    - y las cuentas que hace la app (saldos, presupuesto, proximo pago) dan.
//
//  Nacio de un rato peleando con el navegador: media hora de clicks para
//  descubrir un `t.loaned` mal escrito es una mala inversion.
// =============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import vm from "node:vm";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const html = readFileSync(join(ROOT, "index.html"), "utf8");

let fails = 0, total = 0;
function check(name, cond, extra = "") {
  total++;
  console.log(`${cond ? "  ok " : "FAIL "} ${name}${cond ? "" : "  <- " + extra}`);
  if (!cond) fails++;
}
function section(t) { console.log(`\n--- ${t} ${"-".repeat(Math.max(0, 58 - t.length))}`); }

/* ---------------------------------------------------------------- el DOM ---
   Un elemento que acepta todo lo que la app le pida y se acuerda de su
   innerHTML, que es lo unico que se quiere revisar. */
function fakeEl(id = "") {
  const el = {
    id, innerHTML: "", textContent: "", value: "", checked: false, placeholder: "",
    style: {}, dataset: {}, files: [], offsetWidth: 120, disabled: false, hidden: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, insertAdjacentHTML() {},
    focus() {}, click() {}, remove() {}, appendChild() {}, setAttribute() {}, removeAttribute() {},
    closest: () => null, requestSubmit() {},
    querySelector: () => fakeEl(), querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 200 }),
  };
  return el;
}
const els = new Map();
const byId = (id) => {
  if (!els.has(id)) els.set(id, fakeEl(id));
  return els.get(id);
};
const store = new Map();

const ctx = {
  console,
  document: {
    getElementById: byId,
    querySelector: () => fakeEl(),
    querySelectorAll: () => [],
    createElement: () => fakeEl(),
    addEventListener() {},
    body: { classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} },
    documentElement: { setAttribute() {}, removeAttribute() {}, getAttribute: () => null },
  },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  matchMedia: () => ({ matches: false }),
  navigator: { userAgent: "node", platform: "node", maxTouchPoints: 0 },
  addEventListener() {},
  fetch: () => Promise.reject(new Error("sin red en la prueba")),
  setTimeout, clearTimeout, Intl, Date, Math, JSON, Number, String, Boolean, Array, Object,
  URL, Blob: class {}, File: class {}, Image: class {}, FileReader: class {},
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  Uint8Array, Buffer, isNaN, parseInt, parseFloat, encodeURIComponent,
};
ctx.window = ctx;
ctx.globalThis = ctx;

// El segundo <script> es la app (el primero solo aplica el tema guardado).
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
check("index.html trae los dos <script> de siempre", scripts.length === 2, `hay ${scripts.length}`);

// Las funciones y constantes de la app son `const`/`function` de nivel superior,
// asi que no quedan en el objeto global: se las pide explicitamente al final.
const EXPORTS = ["S", "renderHome", "renderDebt", "renderSpend", "renderSettings", "renderMoves",
  "nextDue", "dueText", "SIDE", "T", "wordSide", "sideOf", "lastMonths", "monthKey", "shiftMonthKey",
  "catColor", "gastosHtml", "balances", "money", "simulate", "balanceByMonth", "withRunning", "niceTicks", "pickLabels",
  "incomeOf", "capacityOf", "debtFlowOf",
  "renderVeh", "taskStatus", "taskText", "taskUrgency", "VEH_META"];
const codigo = `${scripts[1]}\n;globalThis.__ui = { ${EXPORTS.join(", ")} };`;

vm.createContext(ctx);
try {
  vm.runInContext(codigo, ctx, { filename: "index.html:script" });
} catch (err) {
  console.error("\nEl script de la app revento al evaluarse:\n", err);
  process.exit(1);
}
const ui = ctx.__ui;
check("el script se evalua y expone sus funciones", !!ui && typeof ui.renderHome === "function");

/* ------------------------------------------------------------------ datos ---
   Un dueño con: una deuda en dos monedas, un cobro con acuerdo de pago
   atrasado, y gastos del mes con presupuesto. */
const hoy = ui.S ? null : null;
const T_HOY = new Date();
const dia = (n = 0) => {
  const d = new Date(T_HOY.getFullYear(), T_HOY.getMonth(), T_HOY.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const mesActual = dia(0).slice(0, 7);

const deuda = {
  id: 1, name: "Hermano", kind: "person", currency: "NIO", direction: "owe", counterpart: "Juan",
  note: null, interestRate: null, dueEvery: null, dueAmount: null, dueFrom: null, active: 1,
  totals: { NIO: { loaned: 13500, paid: 10000, balance: 3500 }, USD: { loaned: 150, paid: 50, balance: 100 } },
  currencies: ["NIO", "USD"], entries: 11, lastDay: dia(1), lastPaymentDay: dia(1), viewers: 1,
};
const cobro = {
  id: 2, name: "Primo Carlos", kind: "person", currency: "NIO", direction: "owed", counterpart: "Carlos",
  note: null, interestRate: null, dueEvery: "monthly", dueAmount: 1000, dueFrom: dia(75), active: 1,
  totals: { NIO: { loaned: 6000, paid: 2000, balance: 4000 } },
  currencies: ["NIO"], entries: 3, lastDay: dia(40), lastPaymentDay: dia(40), viewers: 0,
};
const movs = [
  { id: 11, debtId: 1, kind: "loan", currency: "NIO", day: dia(200), amount: 13500, reason: "Para la moto", hasReceipt: true },
  { id: 12, debtId: 1, kind: "payment", currency: "NIO", day: dia(1), amount: 10000, reason: "Abono", hasReceipt: false },
  { id: 13, debtId: 2, kind: "loan", currency: "NIO", day: dia(120), amount: 6000, reason: "Taller", hasReceipt: false },
];
const sum = { today: dia(0), debts: [deuda, cobro], entries: movs, comments: [] };
// El dia 1 del mes en curso: siempre existe y nunca es futuro, asi que la
// prueba da igual el dia que se corra (con `dia(2)` y compañia, corriendola un
// dia 3 los gastos se iban al mes anterior y no cuadraba nada).
const delMes = `${mesActual}-01`;
// El mes anterior, para tener un mes CERRADO con gastos.
const mesPrevio = (() => {
  const d = new Date(Number(mesActual.slice(0, 4)), Number(mesActual.slice(5, 7)) - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
})();
const spend = {
  today: dia(0), from: delMes,
  categories: [
    { id: 1, name: "Comida", budget: 9000, currency: "NIO", active: 1, expenses: 3 },
    { id: 2, name: "Transporte", budget: 2500, currency: "NIO", active: 1, expenses: 1 },
    { id: 3, name: "Salud", budget: null, currency: "NIO", active: 1, expenses: 0 },
  ],
  expenses: [
    { id: 21, categoryId: 1, day: delMes, amount: 12000, currency: "NIO", reason: "Supermercado", hasReceipt: true, createdBy: "moises", createdAt: new Date().toISOString() },
    { id: 22, categoryId: 2, day: delMes, amount: 900, currency: "NIO", reason: "Gasolina", hasReceipt: false, createdBy: "moises", createdAt: new Date().toISOString() },
    { id: 23, categoryId: null, day: delMes, amount: 45, currency: "USD", reason: "Café", hasReceipt: false, createdBy: "moises", createdAt: new Date().toISOString() },
    // Un mes cerrado, para que la capacidad de pago tenga de donde sacar el
    // promedio (el mes en curso no cuenta: va a medias).
    { id: 24, categoryId: 1, day: `${mesPrevio}-10`, amount: 15000, currency: "NIO", reason: "Supermercado", hasReceipt: false, createdBy: "moises", createdAt: new Date().toISOString() },
  ],
  incomes: [
    { id: 31, kind: "monthly", amount: 25000, currency: "NIO", day: "2020-01-01", source: "Salario", note: null },
    { id: 32, kind: "once", amount: 3000, currency: "NIO", day: delMes, source: "Trabajito", note: null },
  ],
};

const comoDueno = () => { ui.S.me = { id: 1, name: "moises", role: "admin" }; };
const comoLectura = () => { ui.S.me = { id: 2, name: "hermano", role: "viewer" }; };
const pintar = (fn, id) => { els.get(id) && (els.get(id).innerHTML = ""); fn(); return byId(id).innerHTML; };

/* ========================================================================== */
section("Resumen (dueño)");

ui.S.sum = sum; ui.S.account = { id: 1, name: "Deudas de Moisés" };
comoDueno();
ui.S.side = "owe"; ui.S.homeCur = "NIO";
let out = pintar(() => ui.renderHome(), "homeBody");
check("dice lo que debo, no lo que me deben", out.includes("Debo en total") && !out.includes("Me deben en total"), out.slice(0, 120));
check("con las pestañas Debo / Me deben", out.includes("data-side=\"owe\"") && out.includes("data-side=\"owed\""));
check("el saldo en cordobas es C$3,500", out.includes("3,500"), out.match(/[\d,]{4,}/g)?.join(" "));
check("y las etiquetas son de deuda", out.includes("Prestado") && out.includes("Abonado") && out.includes("Por pagar"));
check("la tarjeta de la deuda muestra las dos monedas", out.includes("C$3,500") && out.includes("US$100"));

ui.S.side = "owed"; ui.S.homeCur = "NIO";
out = pintar(() => ui.renderHome(), "homeBody");
check("en la pestaña de cobros cambia el vocabulario", out.includes("Me deben en total") && out.includes("Presté") && out.includes("Por cobrar"), out.slice(0, 140));
check("y avisa lo que toca cobrar, atrasado", out.includes("Lo que toca cobrar") && out.includes("Atrasado"), out.slice(0, 200));

/* ========================================================================== */
section("Resumen (solo lectura: la deuda se lee al reves)");

comoLectura();
ui.S.sum = { ...sum, debts: [deuda] };      // el servidor no le manda cobros
ui.S.side = "owe"; ui.S.homeCur = "NIO";
out = pintar(() => ui.renderHome(), "homeBody");
check("al de solo lectura le dice ME DEBEN", out.includes("Me deben en total") && !out.includes("Debo en total"), out.slice(0, 140));
check("con las etiquetas del acreedor", out.includes("Presté") && out.includes("Me han pagado") && out.includes("Por cobrar"));
check("sin las pestañas Debo / Me deben", !out.includes("data-side="));
check("y sin botón de crear", !out.includes("homeNew"));

/* ========================================================================== */
section("Ficha de la deuda");

comoDueno();
ui.S.sum = sum;
ui.S.debtId = 1; ui.S.debtCur = "NIO"; ui.S.debtTab = "moves"; ui.S.side = "owe";
ui.S.entries = { debtId: 1, list: movs.filter((m) => m.debtId === 1).map((m) => ({ ...m, comments: 0, note: null, createdBy: "moises", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })) };
out = pintar(() => ui.renderDebt(), "debtBody");
check("el dueño ve 'Debo actualmente' y puede registrar", out.includes("Debo actualmente") && out.includes("addLoan") && out.includes("addPay"), out.slice(0, 140));
check("y el saldo corrido de cada movimiento", byId("debtTab").innerHTML.includes("saldo"));

comoLectura();
out = pintar(() => ui.renderDebt(), "debtBody");
check("el de solo lectura ve 'Me deben actualmente'", out.includes("Me deben actualmente"), out.slice(0, 140));
check("y NO puede registrar ni editar", !out.includes("addLoan") && !out.includes("debtEdit"));

comoDueno();
ui.S.debtId = 2; ui.S.debtCur = "NIO";
ui.S.entries = { debtId: 2, list: movs.filter((m) => m.debtId === 2).map((m) => ({ ...m, comments: 0, note: null, createdBy: "moises", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })) };
out = pintar(() => ui.renderDebt(), "debtBody");
check("el cobro dice 'Me deben' y ofrece Recordar", out.includes("Me deben actualmente") && out.includes("Recordar"), out.slice(0, 160));
check("con el aviso de atraso", out.includes("Atrasado"));

/* ========================================================================== */
section("Gastos del hogar");

ui.S.spend = spend; ui.S.spendMonth = mesActual; ui.S.spendCur = "NIO";
out = pintar(() => ui.renderSpend(), "spendBody");
check("suma solo los gastos en cordobas: C$12,900", out.includes("12,900"), out.match(/[\d,]{4,}/g)?.slice(0, 6).join(" "));
check("compara con el presupuesto (C$11,500)", out.includes("11,500"), out.slice(0, 300));
check("y avisa que se paso", out.includes("Te pasaste"), out.slice(0, 400));
check("lista las categorias del mes", out.includes("Comida") && out.includes("Transporte"));
check("y ofrece anotar un gasto", out.includes("spAdd"));

ui.S.spendCur = "USD";
out = pintar(() => ui.renderSpend(), "spendBody");
check("en dolares no mezcla: US$45 y sin presupuesto", out.includes("45") && out.includes("Sin presupuesto puesto"), out.slice(0, 300));
check("el gasto sin categoria sale como 'Sin categoría'", out.includes("Sin categoría"));

ui.S.spend = { ...spend, categories: [], incomes: [] };
out = pintar(() => ui.renderSpend(), "spendBody");
check("sin categorias ni ingresos, ofrece crear las tipicas", out.includes("spSeed"), out.slice(0, 200));

/* ========================================================================== */
section("Ingreso y capacidad de pago");

ui.S.spend = spend; ui.S.spendMonth = mesActual; ui.S.spendCur = "NIO";
out = pintar(() => ui.renderSpend(), "spendBody");
check("suma sueldo + extra: C$28,000 entraron", out.includes("28,000"), out.match(/[\d,]{5,}/g)?.slice(0, 8).join(" "));
check("y dice cuanto queda del mes", out.includes("Te queda") || out.includes("Te faltó"), out.slice(0, 300));
check("con el aviso de cuanto se puede abonar", out.includes("puedes abonar"), out.slice(0, 400));

check("el sueldo vigente sale del mes que se mira", (() => {
  const i = ui.incomeOf(mesActual, "NIO");
  return i.fixed === 25000 && i.extra === 3000 && i.total === 28000;
})(), JSON.stringify(ui.incomeOf(mesActual, "NIO")));
check("un aumento manda desde su fecha, y lo viejo no se toca", (() => {
  ui.S.spend = { ...spend, incomes: [
    { id: 1, kind: "monthly", amount: 20000, currency: "NIO", day: "2026-01-01" },
    { id: 2, kind: "monthly", amount: 30000, currency: "NIO", day: `${mesActual}-01` },
  ] };
  const ahora = ui.incomeOf(mesActual, "NIO").fixed;
  const antes = ui.incomeOf("2026-03", "NIO").fixed;
  ui.S.spend = spend;
  return ahora === 30000 && antes === 20000;
})());
check("un mes anterior al primer sueldo cuenta igual ese primero",
  ui.incomeOf("2019-05", "NIO").fixed === 25000, String(ui.incomeOf("2019-05", "NIO").fixed));
check("sin ingreso en esa moneda, no inventa nada", (() => {
  const i = ui.incomeOf(mesActual, "USD");
  return i.total === 0 && i.has === false;
})());

check("la capacidad usa el gasto de los meses CERRADOS, no el que va a medias", (() => {
  const cap = ui.capacityOf("NIO");
  // Mes previo: C$15,000 de gasto. Sueldo: C$25,000 -> sobran C$10,000.
  return cap && cap.income === 25000 && cap.spend === 15000 && cap.free === 10000;
})(), JSON.stringify(ui.capacityOf("NIO")));
check("sin sueldo registrado no hay capacidad que calcular", (() => {
  ui.S.spend = { ...spend, incomes: [] };
  const cap = ui.capacityOf("NIO");
  ui.S.spend = spend;
  return cap === null;
})());
check("los abonos del mes salen de los movimientos ya cargados", (() => {
  const f = ui.debtFlowOf(ui.monthKey(dia(1)), "NIO");
  return f.pagado === 10000 && f.recibido === 0;
})(), JSON.stringify(ui.debtFlowOf(ui.monthKey(dia(1)), "NIO")));

/* ========================================================================== */
section("Mantenimiento del vehiculo");

// Una moto a 12.500 km. El aceite se le hizo a los 10.000 hace 200 dias
// (cada 3.000 km o 6 meses -> ya toca por las dos). Las llantas a los 12.000
// hace 10 dias (cada 15.000 km -> falta mucho). La bujia nunca.
const moto = { id: 1, name: "Mi moto", kind: "moto", plate: "M 123", year: 2019, note: null, active: 1, odometer: 12500, services: 2, lastDay: dia(10), spentNIO: 1700, spentUSD: 0 };
const vTasks = [
  { id: 1, vehicleId: 1, name: "Cambio de aceite", everyKm: 3000, everyMonths: 6, note: null, active: 1 },
  { id: 2, vehicleId: 1, name: "Llantas", everyKm: 15000, everyMonths: null, note: null, active: 1 },
  { id: 3, vehicleId: 1, name: "Bujía", everyKm: 10000, everyMonths: null, note: null, active: 1 },
  { id: 4, vehicleId: 1, name: "Seguro", everyKm: null, everyMonths: 12, note: null, active: 1 },
];
const vServices = [
  { id: 11, vehicleId: 1, taskId: 1, expenseId: null, day: dia(200), odometer: 10000, title: "Cambio de aceite", cost: 1200, currency: "NIO", place: "Taller Luis", note: null, hasReceipt: true, createdBy: "moises", createdAt: new Date().toISOString() },
  { id: 12, vehicleId: 1, taskId: 2, expenseId: 21, day: dia(10), odometer: 12000, title: "Llanta trasera", cost: 500, currency: "NIO", place: null, note: null, hasReceipt: false, createdBy: "moises", createdAt: new Date().toISOString() },
  { id: 13, vehicleId: 1, taskId: 4, expenseId: null, day: dia(60), odometer: 11500, title: "Seguro anual", cost: null, currency: "NIO", place: null, note: null, hasReceipt: false, createdBy: "moises", createdAt: new Date().toISOString() },
];
ui.S.veh = { today: dia(0), vehicles: [moto], tasks: vTasks, services: vServices };
ui.S.vehId = 1;
out = pintar(() => ui.renderVeh(), "vehBody");
check("muestra el kilometraje del vehiculo", out.includes("12,500"), out.slice(0, 300));
check("y avisa lo que YA TOCA", out.includes("Ya toca"), out.slice(0, 600));
check("el aceite esta entre lo que toca", out.includes("Cambio de aceite"));
check("la bujia (nunca hecha) tambien", out.includes("Bujía"));
check("ofrece anotar un servicio", out.includes("vhAdd"));
// El taller no va en la lista (ahi manda la fecha y el km); se ve al abrir el
// servicio.
check("y lista el historial con fecha y kilometraje",
  out.includes("Llanta trasera") && out.includes("12,000 km") && out.includes("Seguro anual"), out.slice(-500));
check("marca los servicios que ya estan en gastos", out.includes("en gastos"));

check("por km: pasado el intervalo, ya toca", (() => {
  const st = ui.taskStatus(vTasks[0], moto);   // aceite: 10.000 + 3.000 = 13.000 vs 12.500
  // Faltan 500 km, pero por FECHA ya se paso (200 dias > 6 meses).
  return st.due && st.by === "date" && st.kmLeft === 500;
})(), JSON.stringify(ui.taskStatus(vTasks[0], moto)));
check("manda lo que llegue primero, km o fecha", (() => {
  const t = { ...vTasks[0], everyMonths: null };     // solo por km
  const st = ui.taskStatus(t, moto);
  return !st.due && st.kmLeft === 500;
})(), JSON.stringify(ui.taskStatus({ ...vTasks[0], everyMonths: null }, moto)));
check("una tarea nunca hecha toca desde ya", (() => {
  const st = ui.taskStatus(vTasks[2], moto);
  return st.due && st.by === "never" && st.last === null;
})());
check("y lo dice con palabras", ui.taskText(vTasks[2], ui.taskStatus(vTasks[2], moto)) === "Nunca se le ha hecho");
check("las llantas, recien hechas, no tocan", (() => {
  const st = ui.taskStatus(vTasks[1], moto);   // 12.000 + 15.000 = 27.000 vs 12.500
  return !st.due && st.kmLeft === 14500;
})(), JSON.stringify(ui.taskStatus(vTasks[1], moto)));
check("lo mas urgente se ordena primero", (() => {
  const u1 = ui.taskUrgency(vTasks[2], ui.taskStatus(vTasks[2], moto));   // nunca
  const u2 = ui.taskUrgency(vTasks[1], ui.taskStatus(vTasks[1], moto));   // llantas
  return u1 < u2;
})());
check("sin kilometraje anotado no inventa km que faltan", (() => {
  const sinKm = { ...moto, odometer: null };
  const st = ui.taskStatus(vTasks[0], sinKm);
  return st.kmLeft === null && st.daysLeft !== null;
})(), JSON.stringify(ui.taskStatus(vTasks[0], { ...moto, odometer: null })));

ui.S.veh = { today: dia(0), vehicles: [], tasks: [], services: [] };
out = pintar(() => ui.renderVeh(), "vehBody");
check("sin vehiculos, ofrece agregar uno", out.includes("vhNew"), out.slice(0, 200));

/* ========================================================================== */
section("Las cuentas");

check("el proximo pago de un acuerdo mensual esta atrasado", (() => {
  const due = ui.nextDue(cobro);
  return due && due.vencido && due.dias < 0 && due.amount === 1000;
})(), JSON.stringify(ui.nextDue(cobro)));
check("sin acuerdo no hay recordatorio", ui.nextDue(deuda) === null);
check("un cobro saldado tampoco recuerda nada",
  ui.nextDue({ ...cobro, totals: { NIO: { loaned: 6000, paid: 6000, balance: 0 } } }) === null);

check("el saldo corrido va por moneda", (() => {
  const run = ui.withRunning([
    { id: 1, kind: "loan", currency: "NIO", day: "2026-01-01", amount: 100 },
    { id: 2, kind: "loan", currency: "USD", day: "2026-01-02", amount: 10 },
    { id: 3, kind: "payment", currency: "NIO", day: "2026-01-03", amount: 40 },
  ]);
  return run.get(1) === 100 && run.get(2) === 10 && run.get(3) === 60;
})());

check("el simulador termina y cuenta los pagos", (() => {
  const r = ui.simulate({ balance: 1000, amount: 250, freq: "monthly", start: dia(0), rate: 0 });
  return !r.never && r.n === 4 && Math.round(r.paid) === 1000 && r.interest === 0;
})(), JSON.stringify(ui.simulate({ balance: 1000, amount: 250, freq: "monthly", start: dia(0), rate: 0 })).slice(0, 160));
check("y avisa cuando el abono no alcanza ni al interes", (() => {
  const r = ui.simulate({ balance: 10000, amount: 1, freq: "monthly", start: dia(0), rate: 100 });
  return r.never === true;
})());

check("los ticks del eje Y son numeros redondos", (() => {
  const t = ui.niceTicks(12900);
  return t[0] === 0 && t[t.length - 1] >= 12900 && t.every((v) => Number.isInteger(v));
})(), JSON.stringify(ui.niceTicks(12900)));
check("las etiquetas del eje X no se apelotonan", (() => {
  const idx = ui.pickLabels(12);
  return idx[0] === 0 && idx[idx.length - 1] === 11 && idx.length <= 6;
})(), JSON.stringify(ui.pickLabels(12)));
check("nunca se suman monedas distintas en un total",
  ui.balances(deuda, " + ") === "C$3,500 + US$100", ui.balances(deuda, " + "));

/* ========================================================================== */
console.log(`\n${total - fails}/${total} comprobaciones pasaron${fails ? `  (${fails} FALLARON)` : ""}.`);
process.exit(fails ? 1 : 0);
