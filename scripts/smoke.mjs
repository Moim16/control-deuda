// =============================================================================
//  Prueba de humo de la API. Llama a los handlers serverless con req/res falsos,
//  sin levantar servidor. Sirve igual contra el SQLite local que contra Turso.
//
//    node scripts/smoke.mjs            -> corre y BORRA los datos de prueba
//    node scripts/smoke.mjs --keep     -> corre y deja los datos (para mirar la app:
//                                         usuario "moises" / "deuda1234", viewer
//                                         "hermano" / "deuda1234")
//
//  Requiere una base VACIA (la primera prueba crea la primera cuenta).
// =============================================================================

import auth from "../api/auth.js";
import debts from "../api/debts.js";
import entries from "../api/entries.js";
import comments from "../api/comments.js";
import summary from "../api/summary.js";
import categories from "../api/categories.js";
import expenses from "../api/expenses.js";
import { db, ensureSchema } from "../lib/db.js";

let fails = 0, total = 0;
function call(h, { method = "GET", query = {}, body, token } = {}) {
  return new Promise((resolve) => {
    const req = { method, query, body, headers: token ? { "x-session-token": token } : {} };
    const res = {
      _s: 200,
      status(c) { this._s = c; return this; },
      json(d) { resolve({ status: this._s, body: d }); return this; },
      setHeader() { return this; },
    };
    h(req, res).catch((e) => resolve({ status: 500, body: { error: String(e) } }));
  });
}
function check(name, cond, extra = "") {
  total++;
  console.log(`${cond ? "  ok " : "FAIL "} ${name}${cond ? "" : "  <- " + extra}`);
  if (!cond) fails++;
}
function section(t) { console.log(`\n--- ${t} ${"-".repeat(Math.max(0, 58 - t.length))}`); }
const j = (x) => JSON.stringify(x);

// Un JPEG minusculo valido como data URI (cabecera SOI + EOI): basta para las
// validaciones, que miran el prefijo y el tamaño, no el contenido.
const JPEG = "data:image/jpeg;base64," + Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xFF, 0xD9]).toString("base64");

await ensureSchema();
const yaHayUsuarios = Number((await db.execute("SELECT COUNT(*) c FROM users")).rows[0].c);
if (yaHayUsuarios) {
  console.error(`\nLa base ya tiene ${yaHayUsuarios} usuario(s). Estas pruebas necesitan una base VACIA.`);
  console.error("Vaciala primero (o usa otra base) y vuelve a correrlas.\n");
  process.exit(1);
}

/* ========================================================================== */
section("Cuentas y login");

let r = await call(auth, { method: "POST", query: { signup: "1" },
  body: { name: "moises", password: "deuda1234", fullName: "Moisés Martínez" } });
check("signup crea la cuenta y su dueño (admin)", r.status === 201 && r.body.user.role === "admin" && !!r.body.account.id, j(r.body));
check("entrega codigo de recuperacion", /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r.body.recovery || ""), j(r.body.recovery));
const A = { token: r.body.token, userId: r.body.user.id, accountId: r.body.account.id, recovery: r.body.recovery };

r = await call(auth, { method: "POST", query: { signup: "1" }, body: { name: "otra", password: "deuda1234" } });
check("segunda cuenta, aislada", r.status === 201 && r.body.account.id !== A.accountId, j(r.body));
const B = { token: r.body.token, userId: r.body.user.id, accountId: r.body.account.id };

check("usuario repetido -> 409",
  (await call(auth, { method: "POST", query: { signup: "1" }, body: { name: "MOISES", password: "deuda1234" } })).status === 409);
check("contraseña corta -> 400",
  (await call(auth, { method: "POST", query: { signup: "1" }, body: { name: "corto", password: "123" } })).status === 400);
check("usuario con espacios -> 400",
  (await call(auth, { method: "POST", query: { signup: "1" }, body: { name: "con espacio", password: "deuda1234" } })).status === 400);

r = await call(auth, { method: "POST", body: { name: "moises", password: "deuda1234" } });
check("login devuelve token y cuenta", r.status === 200 && !!r.body.token && !!r.body.account?.name, j(r.body));
A.token = r.body.token;
check("contraseña incorrecta -> 401", (await call(auth, { method: "POST", body: { name: "moises", password: "malamala" } })).status === 401);
check("usuario inexistente -> 401", (await call(auth, { method: "POST", body: { name: "nadie", password: "deuda1234" } })).status === 401);
check("sin token -> 401", (await call(debts, {})).status === 401);
check("token inventado -> 401", (await call(debts, { token: "x".repeat(64) })).status === 401);

r = await call(auth, { token: A.token });
check("GET /auth: me + recovery.has, sin el codigo", r.body.me?.id === A.userId && r.body.recovery?.has === true && !("code" in r.body.recovery), j(r.body));

/* ========================================================================== */
section("Codigo de recuperacion");

check("codigo equivocado -> 401",
  (await call(auth, { method: "POST", query: { recover: "1" }, body: { name: "moises", code: "AAAA-BBBB-CCCC", password: "nueva123" } })).status === 401);
r = await call(auth, { method: "POST", query: { recover: "1" },
  body: { name: "moises", code: A.recovery.toLowerCase().replace(/-/g, " "), password: "deuda1234" } });
check("con el codigo bueno (en minusculas y con espacios) se entra", r.status === 200 && !!r.body.token, j(r.body));
check("y se entrega un codigo NUEVO", !!r.body.recovery && r.body.recovery !== A.recovery);
A.token = r.body.token;
check("el codigo usado no sirve dos veces",
  (await call(auth, { method: "POST", query: { recover: "1" }, body: { name: "moises", code: A.recovery, password: "otra1234" } })).status === 401);
r = await call(auth, { method: "PUT", query: { recovery: "1" }, token: A.token, body: { currentPassword: "malamala" } });
check("renovar el codigo exige la contraseña actual", r.status === 401);
r = await call(auth, { method: "PUT", query: { recovery: "1" }, token: A.token, body: { currentPassword: "deuda1234" } });
check("con la contraseña se renueva", r.status === 200 && /^[A-Z0-9]{4}-/.test(r.body.recovery));

/* ========================================================================== */
section("Deudas");

r = await call(debts, { method: "POST", token: A.token,
  body: { name: "Hermano", kind: "person", currency: "NIO", counterpart: "Juan", interestRate: "" } });
check("crear deuda (NIO, sin interes)", r.status === 201 && r.body.debt.currency === "NIO" && r.body.debt.interestRate === null
  && r.body.debt.totals.NIO.balance === 0 && j(r.body.debt.currencies) === j(["NIO"]), j(r.body));
const D1 = r.body.debt.id;

r = await call(debts, { method: "POST", token: A.token,
  body: { name: "Tarjeta Amex", kind: "card", currency: "USD", interestRate: "42.5" } });
check("crear deuda (USD, con interes)", r.status === 201 && r.body.debt.currency === "USD" && r.body.debt.interestRate === 42.5, j(r.body));
const D2 = r.body.debt.id;

r = await call(debts, { method: "POST", token: A.token, body: { name: "Hermana", currency: "NIO" } });
const D3 = r.body.debt.id;

check("sin nombre -> 400", (await call(debts, { method: "POST", token: A.token, body: { name: "  " } })).status === 400);
check("interes absurdo -> 400", (await call(debts, { method: "POST", token: A.token, body: { name: "X", interestRate: 900 } })).status === 400);
check("moneda desconocida cae a NIO",
  (await call(debts, { method: "POST", token: A.token, body: { name: "Y", currency: "EUR" } })).body.debt.currency === "NIO");

r = await call(debts, { token: A.token });
check("el admin ve sus 4 deudas con viewers=0", r.body.debts.length === 4 && r.body.debts.every((d) => d.viewers === 0), j(r.body.debts.map((d) => d.name)));
const DEUDAS_BASE = 4;   // las de arriba; la seccion de cobros agrega mas
r = await call(debts, { token: B.token });
check("la otra cuenta no ve ninguna", r.body.debts.length === 0);
check("la otra cuenta no puede editar la deuda ajena (404)",
  (await call(debts, { method: "PUT", query: { id: String(D1) }, token: B.token, body: { name: "hack" } })).status === 404);
check("ni borrarla", (await call(debts, { method: "DELETE", query: { id: String(D1) }, token: B.token })).status === 404);

r = await call(debts, { method: "PUT", query: { id: String(D1) }, token: A.token, body: { name: "Mi hermano", note: "Le debo desde 2025" } });
check("editar nombre y nota", r.status === 200 && r.body.debt.name === "Mi hermano" && r.body.debt.note === "Le debo desde 2025", j(r.body));
check("una deuda nace como 'yo debo' y sin acuerdo de pago",
  r.body.debt.direction === "owe" && r.body.debt.dueEvery === null && r.body.debt.dueAmount === null);

/* ========================================================================== */
section("Cobros (me deben) y acuerdo de pago");

r = await call(debts, { method: "POST", token: A.token,
  body: { name: "Primo", direction: "owed", currency: "NIO", dueEvery: "monthly", dueAmount: "500", dueFrom: "2026-01-15" } });
check("crear un cobro con acuerdo mensual", r.status === 201 && r.body.debt.direction === "owed"
  && r.body.debt.dueEvery === "monthly" && r.body.debt.dueAmount === 500 && r.body.debt.dueFrom === "2026-01-15", j(r.body));
const D4 = r.body.debt.id;
check("direccion desconocida cae a 'owe'",
  (await call(debts, { method: "POST", token: A.token, body: { name: "Z", direction: "sideways" } })).body.debt.direction === "owe");
check("acuerdo sin monto -> 400",
  (await call(debts, { method: "POST", token: A.token, body: { name: "Z", dueEvery: "monthly", dueFrom: "2026-01-15" } })).status === 400);
check("acuerdo sin fecha -> 400",
  (await call(debts, { method: "POST", token: A.token, body: { name: "Z", dueEvery: "monthly", dueAmount: 10 } })).status === 400);
check("frecuencia invalida -> 400",
  (await call(debts, { method: "POST", token: A.token, body: { name: "Z", dueEvery: "daily", dueAmount: 10, dueFrom: "2026-01-15" } })).status === 400);
r = await call(entries, { method: "POST", token: A.token, body: { debtId: D4, kind: "loan", day: "2026-01-10", amount: 3000, reason: "Le presté" } });
r = await call(entries, { method: "POST", token: A.token, body: { debtId: D4, kind: "payment", day: "2026-02-14", amount: 500, reason: "Me abonó" } });
r = await call(debts, { token: A.token });
let d4 = r.body.debts.find((d) => d.id === D4);
check("el cobro lleva sus totales igual que una deuda y recuerda el ultimo abono",
  d4.totals.NIO.balance === 2500 && d4.lastPaymentDay === "2026-02-14", j(d4));
r = await call(debts, { method: "PUT", query: { id: String(D4) }, token: A.token, body: { dueEvery: "" } });
check("dueEvery vacio borra el acuerdo completo", r.body.debt.dueEvery === null && r.body.debt.dueAmount === null && r.body.debt.dueFrom === null, j(r.body.debt));
r = await call(debts, { method: "PUT", query: { id: String(D4) }, token: A.token, body: { direction: "owe" } });
check("cambiar la direccion no toca los movimientos", r.body.debt.direction === "owe" && r.body.debt.totals.NIO.balance === 2500);
await call(debts, { method: "PUT", query: { id: String(D4) }, token: A.token, body: { direction: "owed" } });

/* ========================================================================== */
section("Usuarios viewer y visibilidad");

r = await call(auth, { method: "POST", query: { new: "1" }, token: A.token,
  body: { name: "hermano", password: "deuda1234", fullName: "Juan", role: "viewer", debtIds: [D1] } });
check("admin crea un viewer asignado a una deuda", r.status === 201 && r.body.user.role === "viewer", j(r.body));
const V = { userId: r.body.user.id };
r = await call(auth, { method: "POST", body: { name: "hermano", password: "deuda1234" } });
V.token = r.body.token;
check("el viewer entra", r.status === 200 && !!V.token);

r = await call(debts, { token: V.token });
check("el viewer ve SOLO su deuda", r.body.debts.length === 1 && r.body.debts[0].id === D1, j(r.body.debts));
check("y sin el conteo de viewers", r.body.debts[0].viewers === undefined);
check("ni el acuerdo de pago (es cosa del dueño)",
  !("dueEvery" in r.body.debts[0]) && !("dueAmount" in r.body.debts[0]) && !("lastPaymentDay" in r.body.debts[0]), j(r.body.debts[0]));

// Los COBROS son solo del dueño: aunque se le asigne uno por error, no lo ve.
await call(auth, { method: "PUT", query: { id: String(V.userId) }, token: A.token, body: { debtIds: [D1, D4] } });
r = await call(debts, { token: V.token });
check("un cobro asignado por error no se le muestra al viewer",
  r.body.debts.length === 1 && r.body.debts[0].id === D1, j(r.body.debts.map((d) => d.name)));
check("y sus movimientos le dan 404", (await call(entries, { query: { debtId: String(D4) }, token: V.token })).status === 404);
check("y no puede comentarlo", (await call(comments, { method: "POST", token: V.token, body: { debtId: D4, text: "hola" } })).status === 404);
r = await call(summary, { token: V.token });
check("el resumen del viewer tampoco trae cobros", r.body.debts.every((d) => d.id === D1) && r.body.entries.every((e) => e.debtId === D1), j(r.body.debts.map((d) => d.name)));
await call(auth, { method: "PUT", query: { id: String(V.userId) }, token: A.token, body: { debtIds: [D1] } });
check("el viewer no puede crear deudas (403)",
  (await call(debts, { method: "POST", token: V.token, body: { name: "Z" } })).status === 403);
check("ni editar la suya (403)",
  (await call(debts, { method: "PUT", query: { id: String(D1) }, token: V.token, body: { name: "Z" } })).status === 403);
check("ni crear usuarios (403)",
  (await call(auth, { method: "POST", query: { new: "1" }, token: V.token, body: { name: "z", password: "deuda1234" } })).status === 403);
check("la deuda no asignada le da 404, no 403",
  (await call(entries, { query: { debtId: String(D2) }, token: V.token })).status === 404);

r = await call(auth, { token: A.token });
check("GET /auth (admin) lista usuarios con sus deudas",
  r.body.users?.length === 2 && j(r.body.users.find((u) => u.id === V.userId).debtIds) === j([D1]), j(r.body.users));
r = await call(debts, { token: A.token });
check("la deuda asignada cuenta 1 viewer", r.body.debts.find((d) => d.id === D1).viewers === 1);

// Reasignacion: se le da tambien la D3 y se le quita al ratito.
await call(auth, { method: "PUT", query: { id: String(V.userId) }, token: A.token, body: { debtIds: [D1, D3, 99999] } });
r = await call(debts, { token: V.token });
check("reasignar deudas (ids ajenos se ignoran)", r.body.debts.length === 2, j(r.body.debts.map((d) => d.id)));
await call(auth, { method: "PUT", query: { id: String(V.userId) }, token: A.token, body: { debtIds: [D1] } });

check("el admin de OTRA cuenta no puede tocar al viewer (404)",
  (await call(auth, { method: "PUT", query: { id: String(V.userId) }, token: B.token, body: { active: false } })).status === 404);

// Contraseña propia del viewer.
r = await call(auth, { method: "PUT", token: V.token, body: { currentPassword: "mala", password: "nueva1234" } });
check("cambiar mi contraseña exige la actual", r.status === 401);
r = await call(auth, { method: "PUT", token: V.token, body: { currentPassword: "deuda1234", password: "nueva1234" } });
check("con la actual se cambia y devuelve token nuevo", r.status === 200 && !!r.body.token && r.body.token !== V.token);
V.token = r.body.token;
r = await call(auth, { method: "PUT", query: { id: String(V.userId) }, token: A.token, body: { password: "deuda1234" } });
check("el admin resetea la contraseña del viewer", r.status === 200);
check("y eso cierra la sesion del viewer", (await call(debts, { token: V.token })).status === 401);
r = await call(auth, { method: "POST", body: { name: "hermano", password: "deuda1234" } });
V.token = r.body.token;

check("el admin no puede quedarse sin admin",
  (await call(auth, { method: "PUT", query: { id: String(A.userId) }, token: A.token, body: { role: "viewer" } })).status === 400);
check("ni desactivarse a si mismo",
  (await call(auth, { method: "DELETE", query: { id: String(A.userId) }, token: A.token })).status === 400);

/* ========================================================================== */
section("Movimientos");

r = await call(entries, { method: "POST", token: A.token,
  body: { debtId: D1, kind: "loan", day: "2026-01-10", amount: "5,000", reason: "Para la moto", receipt: JPEG } });
check("prestamo con comprobante", r.status === 201 && r.body.entry.amount === 5000 && r.body.entry.hasReceipt === true, j(r.body));
const E1 = r.body.entry.id;
r = await call(entries, { method: "POST", token: A.token,
  body: { debtId: D1, kind: "loan", day: "2026-02-15", amount: 2500.505, reason: "Universidad" } });
check("segundo prestamo, redondeado a 2 decimales", r.status === 201 && r.body.entry.amount === 2500.51 && r.body.entry.hasReceipt === false);
const E2 = r.body.entry.id;
r = await call(entries, { method: "POST", token: A.token,
  body: { debtId: D1, kind: "payment", day: "2026-03-01", amount: 1000, reason: "Abono de marzo" } });
check("abono", r.status === 201 && r.body.entry.kind === "payment");
const E3 = r.body.entry.id;

check("monto cero -> 400", (await call(entries, { method: "POST", token: A.token, body: { debtId: D1, kind: "loan", day: "2026-03-01", amount: 0 } })).status === 400);
check("fecha invalida -> 400", (await call(entries, { method: "POST", token: A.token, body: { debtId: D1, kind: "loan", day: "2026-02-31", amount: 10 } })).status === 400);
check("tipo invalido -> 400", (await call(entries, { method: "POST", token: A.token, body: { debtId: D1, kind: "gift", day: "2026-03-01", amount: 10 } })).status === 400);
check("comprobante PNG -> 400",
  (await call(entries, { method: "POST", token: A.token, body: { debtId: D1, kind: "loan", day: "2026-03-01", amount: 10, receipt: "data:image/png;base64,iVBORw0KGgo=" } })).status === 400);
check("comprobante muy pesado -> 400",
  (await call(entries, { method: "POST", token: A.token, body: { debtId: D1, kind: "loan", day: "2026-03-01", amount: 10, receipt: "data:image/jpeg;base64," + "A".repeat(1000 * 1024) } })).status === 400);
check("el viewer no registra movimientos (403)",
  (await call(entries, { method: "POST", token: V.token, body: { debtId: D1, kind: "payment", day: "2026-03-02", amount: 10 } })).status === 403);
check("otra cuenta no registra en deuda ajena (404)",
  (await call(entries, { method: "POST", token: B.token, body: { debtId: D1, kind: "loan", day: "2026-03-02", amount: 10 } })).status === 404);

r = await call(entries, { query: { debtId: String(D1) }, token: A.token });
check("lista del mas nuevo al mas viejo", r.body.entries.map((e) => e.id).join() === [E3, E2, E1].join(), j(r.body.entries.map((e) => e.day)));
check("la lista no arrastra la imagen, solo hasReceipt", !("image" in r.body.entries[2]) && r.body.entries[2].hasReceipt === true);
check("registra quien lo creo", r.body.entries[0].createdBy === "moises");

r = await call(entries, { query: { debtId: String(D1) }, token: V.token });
check("el viewer ve los movimientos de su deuda", r.status === 200 && r.body.entries.length === 3);
r = await call(entries, { query: { id: String(E1), receipt: "1" }, token: V.token });
check("y puede ver el comprobante", r.status === 200 && r.body.image === JPEG, j(r.body).slice(0, 80));
check("un movimiento sin comprobante -> 404", (await call(entries, { query: { id: String(E2), receipt: "1" }, token: A.token })).status === 404);
check("comprobante de deuda ajena -> 404", (await call(entries, { query: { id: String(E1), receipt: "1" }, token: B.token })).status === 404);

r = await call(debts, { token: A.token });
let d1 = r.body.debts.find((d) => d.id === D1);
check("totales: prestado 7500.51, abonado 1000, saldo 6500.51", d1.totals.NIO.loaned === 7500.51 && d1.totals.NIO.paid === 1000 && d1.totals.NIO.balance === 6500.51, j(d1.totals));
check("entries=3 y lastDay", d1.entries === 3 && d1.lastDay === "2026-03-01");
check("sin moneda explicita el movimiento toma la de la deuda", r.body.debts.find((d) => d.id === D1).currencies.join() === "NIO");

// Parte en dolares dentro de la MISMA deuda: los saldos van por separado.
r = await call(entries, { method: "POST", token: A.token,
  body: { debtId: D1, kind: "loan", currency: "USD", day: "2026-03-05", amount: 100, reason: "Pasaje" } });
check("prestamo en USD en una deuda NIO", r.status === 201 && r.body.entry.currency === "USD", j(r.body));
const E4 = r.body.entry.id;
r = await call(debts, { token: A.token });
d1 = r.body.debts.find((d) => d.id === D1);
check("la deuda ahora tiene dos monedas, sin mezclarlas",
  j(d1.currencies) === j(["NIO", "USD"]) && d1.totals.NIO.balance === 6500.51 && d1.totals.USD.balance === 100, j(d1.totals));
check("moneda invalida en un movimiento -> cae a la de la deuda",
  (await call(entries, { method: "POST", token: A.token, body: { debtId: D1, kind: "payment", currency: "EUR", day: "2026-03-06", amount: 1 } })).body.entry?.currency === "NIO");
r = await call(entries, { query: { debtId: String(D1) }, token: A.token });
const E5 = r.body.entries.find((e) => e.day === "2026-03-06").id;
await call(entries, { method: "DELETE", query: { id: String(E5) }, token: A.token });
r = await call(entries, { method: "PUT", query: { id: String(E4) }, token: A.token, body: { currency: "XXX" } });
check("editar a una moneda invalida -> 400", r.status === 400);
await call(entries, { method: "DELETE", query: { id: String(E4) }, token: A.token });

r = await call(entries, { method: "PUT", query: { id: String(E2) }, token: A.token, body: { amount: 2500, receipt: JPEG } });
check("editar monto y agregar comprobante", r.status === 200 && r.body.entry.amount === 2500 && r.body.entry.hasReceipt === true, j(r.body));
r = await call(entries, { method: "PUT", query: { id: String(E1) }, token: A.token, body: { receipt: null } });
check("quitar comprobante", r.status === 200 && r.body.entry.hasReceipt === false);
check("...y ya no esta", (await call(entries, { query: { id: String(E1), receipt: "1" }, token: A.token })).status === 404);
check("el viewer no edita (403)", (await call(entries, { method: "PUT", query: { id: String(E1) }, token: V.token, body: { amount: 1 } })).status === 403);
r = await call(debts, { token: A.token });
d1 = r.body.debts.find((d) => d.id === D1);
check("saldo recalculado: 6500", d1.totals.NIO.balance === 6500, j(d1.totals));

r = await call(debts, { method: "PUT", query: { id: String(D1) }, token: A.token, body: { currency: "USD" } });
check("cambiar la moneda por defecto no toca los movimientos",
  r.body.debt?.currency === "USD" && r.body.debt.totals.NIO.balance === 6500 && !r.body.debt.totals.USD, j(r.body.debt));
await call(debts, { method: "PUT", query: { id: String(D1) }, token: A.token, body: { currency: "NIO" } });

/* ========================================================================== */
section("Comentarios");

r = await call(comments, { method: "POST", token: V.token, body: { debtId: D1, entryId: E3, text: "  Ese abono lo hice el sábado  " } });
check("el viewer comenta un movimiento", r.status === 201 && r.body.comment.text === "Ese abono lo hice el sábado" && r.body.comment.mine === true, j(r.body));
const C1 = r.body.comment.id;
r = await call(comments, { method: "POST", token: V.token, body: { debtId: D1, text: "¿Cuándo cuadramos?" } });
check("y la deuda en general", r.status === 201 && r.body.comment.entryId === null);
const C2 = r.body.comment.id;
r = await call(comments, { method: "POST", token: A.token, body: { debtId: D1, entryId: E3, text: "Sí, quedó registrado" } });
check("el admin tambien comenta", r.status === 201);
const C3 = r.body.comment.id;

check("texto vacio -> 400", (await call(comments, { method: "POST", token: V.token, body: { debtId: D1, text: "   " } })).status === 400);
check("comentar deuda no asignada -> 404", (await call(comments, { method: "POST", token: V.token, body: { debtId: D2, text: "hola" } })).status === 404);
check("movimiento de OTRA deuda -> 404",
  (await call(comments, { method: "POST", token: A.token, body: { debtId: D2, entryId: E1, text: "cruzado" } })).status === 404);

r = await call(comments, { query: { debtId: String(D1), entryId: String(E3) }, token: A.token });
check("comentarios de un movimiento, en orden", r.body.comments.length === 2 && r.body.comments[0].id === C1 && r.body.comments[0].mine === false && r.body.comments[0].userName === "hermano", j(r.body.comments));
r = await call(comments, { query: { debtId: String(D1) }, token: A.token });
check("sin entryId: solo los generales", r.body.comments.length === 1 && r.body.comments[0].id === C2);
r = await call(comments, { query: { debtId: String(D1), entryId: "0" }, token: A.token });
check("entryId=0: todos, con el contexto del movimiento", r.body.comments.length === 3 && r.body.comments.find((c) => c.id === C1).entryAmount === 1000 && r.body.comments.find((c) => c.id === C1).entryCurrency === "NIO", j(r.body.comments));
r = await call(entries, { query: { debtId: String(D1) }, token: A.token });
check("la lista de movimientos cuenta los comentarios", r.body.entries.find((e) => e.id === E3).comments === 2);

check("el viewer no borra comentarios ajenos (403)", (await call(comments, { method: "DELETE", query: { id: String(C3) }, token: V.token })).status === 403);
check("pero si los suyos", (await call(comments, { method: "DELETE", query: { id: String(C2) }, token: V.token })).status === 200);
check("el admin borra cualquiera", (await call(comments, { method: "DELETE", query: { id: String(C1) }, token: A.token })).status === 200);
check("otra cuenta -> 404", (await call(comments, { method: "DELETE", query: { id: String(C3) }, token: B.token })).status === 404);

/* ========================================================================== */
section("Resumen");

await call(entries, { method: "POST", token: A.token, body: { debtId: D2, kind: "loan", day: "2026-04-01", amount: 300, reason: "Compra" } });
r = await call(summary, { token: A.token });
// 4 deudas base + el cobro "Primo" + la "Z" de la prueba de direccion; movimientos: 3 de D1 + 2 de D4 + 1 de D2.
check("resumen: deudas, movimientos y comentarios", r.status === 200 && r.body.debts.length === DEUDAS_BASE + 2 && r.body.entries.length === 6 && r.body.comments.length === 1, j({ d: r.body.debts.length, e: r.body.entries.length, c: r.body.comments.length }));
check("movimientos en orden cronologico y con moneda", r.body.entries[0].day === "2026-01-10" && r.body.entries[5].day === "2026-04-01" && r.body.entries.every((e) => e.currency));
check("el resumen trae la direccion y el acuerdo de cada deuda", r.body.debts.every((d) => "direction" in d && "dueEvery" in d));
check("today en YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(r.body.today));
r = await call(summary, { token: V.token });
check("el viewer solo recibe lo suyo", r.body.debts.length === 1 && r.body.entries.every((e) => e.debtId === D1) && r.body.comments.every((c) => c.debtId === D1));
check("solo GET", (await call(summary, { method: "POST", token: A.token })).status === 405);

/* ========================================================================== */
section("Gastos del hogar: categorias");

r = await call(categories, { token: A.token });
check("una cuenta nueva no tiene categorias", r.status === 200 && r.body.categories.length === 0, j(r.body));
r = await call(categories, { method: "POST", query: { seed: "1" }, token: A.token });
check("seed crea las categorias tipicas", r.status === 201 && r.body.categories.length === 6 && r.body.categories.every((c) => c.budget === null), j(r.body.categories?.map((c) => c.name)));
check("seed dos veces -> 409", (await call(categories, { method: "POST", query: { seed: "1" }, token: A.token })).status === 409);
const CAT = {}; for (const c of r.body.categories) CAT[c.name] = c.id;

r = await call(categories, { method: "POST", token: A.token, body: { name: "Mascotas", budget: "1,200.505", currency: "NIO" } });
check("crear categoria con presupuesto (redondeado)", r.status === 201 && r.body.category.budget === 1200.51, j(r.body));
CAT.Mascotas = r.body.category.id;
check("nombre repetido -> 409", (await call(categories, { method: "POST", token: A.token, body: { name: "mascotas" } })).status === 409);
check("sin nombre -> 400", (await call(categories, { method: "POST", token: A.token, body: { name: "  " } })).status === 400);
check("presupuesto cero -> 400", (await call(categories, { method: "POST", token: A.token, body: { name: "X", budget: 0 } })).status === 400);
check("el viewer no puede ni leer las categorias (403)", (await call(categories, { token: V.token })).status === 403);
check("ni crearlas", (await call(categories, { method: "POST", token: V.token, body: { name: "Z" } })).status === 403);
check("otra cuenta no puede editar mi categoria (404)",
  (await call(categories, { method: "PUT", query: { id: String(CAT.Comida) }, token: B.token, body: { name: "hack" } })).status === 404);

r = await call(categories, { method: "PUT", query: { id: String(CAT.Comida) }, token: A.token, body: { budget: 8000 } });
check("ponerle presupuesto a una categoria", r.status === 200 && r.body.category.budget === 8000, j(r.body));
r = await call(categories, { method: "PUT", query: { id: String(CAT.Salud) }, token: A.token, body: { budget: "" } });
check("presupuesto vacio lo quita", r.body.category.budget === null);

/* ========================================================================== */
section("Gastos del hogar: gastos");

const hoyISO = new Date().toISOString().slice(0, 10);
r = await call(expenses, { method: "POST", token: A.token, body: { categoryId: CAT.Comida, day: hoyISO, amount: "1,500.50", reason: "Supermercado", receipt: JPEG } });
check("anotar un gasto con captura", r.status === 201 && r.body.expense.amount === 1500.5 && r.body.expense.hasReceipt === true && r.body.expense.currency === "NIO", j(r.body));
const X1 = r.body.expense.id;
r = await call(expenses, { method: "POST", token: A.token, body: { day: hoyISO, amount: 300, reason: "No sé en qué", currency: "USD" } });
check("gasto sin categoria y en USD", r.status === 201 && r.body.expense.categoryId === null && r.body.expense.currency === "USD", j(r.body));
const X2 = r.body.expense.id;

check("monto cero -> 400", (await call(expenses, { method: "POST", token: A.token, body: { day: hoyISO, amount: 0 } })).status === 400);
check("fecha invalida -> 400", (await call(expenses, { method: "POST", token: A.token, body: { day: "2026-02-31", amount: 10 } })).status === 400);
check("categoria de otra cuenta -> 400",
  (await call(expenses, { method: "POST", token: B.token, body: { categoryId: CAT.Comida, day: hoyISO, amount: 10 } })).status === 400);
check("captura PNG -> 400",
  (await call(expenses, { method: "POST", token: A.token, body: { day: hoyISO, amount: 10, receipt: "data:image/png;base64,iVBORw0KGgo=" } })).status === 400);
check("el viewer no ve los gastos (403)", (await call(expenses, { token: V.token })).status === 403);
check("ni puede anotar (403)", (await call(expenses, { method: "POST", token: V.token, body: { day: hoyISO, amount: 10 } })).status === 403);

r = await call(expenses, { token: A.token });
check("GET trae categorias, gastos y hoy", r.status === 200 && r.body.categories.length === 7 && r.body.expenses.length === 2 && /^\d{4}-\d{2}-\d{2}$/.test(r.body.today), j({ c: r.body.categories?.length, e: r.body.expenses?.length }));
check("la lista no arrastra la imagen, solo hasReceipt", !("image" in r.body.expenses[0]) && r.body.expenses.some((e) => e.hasReceipt));
check("y dice quien lo anoto", r.body.expenses[0].createdBy === "moises");
check("Comida ya cuenta un gasto", r.body.categories.find((c) => c.id === CAT.Comida).expenses === 1);

r = await call(expenses, { query: { id: String(X1), receipt: "1" }, token: A.token });
check("la captura se pide aparte", r.status === 200 && r.body.image === JPEG);
check("un gasto sin captura -> 404", (await call(expenses, { query: { id: String(X2), receipt: "1" }, token: A.token })).status === 404);
check("captura de otra cuenta -> 404", (await call(expenses, { query: { id: String(X1), receipt: "1" }, token: B.token })).status === 404);

r = await call(expenses, { method: "PUT", query: { id: String(X1) }, token: A.token, body: { amount: 1600, categoryId: CAT.Transporte, receipt: null } });
check("editar monto, categoria y quitar la captura",
  r.status === 200 && r.body.expense.amount === 1600 && r.body.expense.categoryId === CAT.Transporte && r.body.expense.hasReceipt === false, j(r.body));
check("...y la captura ya no esta", (await call(expenses, { query: { id: String(X1), receipt: "1" }, token: A.token })).status === 404);
r = await call(expenses, { method: "PUT", query: { id: String(X1) }, token: A.token, body: { categoryId: "" } });
check("se puede dejar sin categoria", r.body.expense.categoryId === null);
check("moneda invalida al editar -> 400", (await call(expenses, { method: "PUT", query: { id: String(X1) }, token: A.token, body: { currency: "XXX" } })).status === 400);

// Borrar una categoria NO borra sus gastos: la plata se gasto igual.
await call(expenses, { method: "PUT", query: { id: String(X1) }, token: A.token, body: { categoryId: CAT.Mascotas } });
r = await call(categories, { method: "DELETE", query: { id: String(CAT.Mascotas), hard: "1" }, token: A.token });
check("borrar una categoria la elimina", r.status === 200 && r.body.deleted === true);
r = await call(expenses, { token: A.token });
check("y sus gastos quedan sin categoria, sin perderse",
  r.body.expenses.length === 2 && r.body.expenses.find((e) => e.id === X1).categoryId === null, j(r.body.expenses.map((e) => e.categoryId)));
r = await call(categories, { method: "DELETE", query: { id: String(CAT.Salud) }, token: A.token });
check("archivar una categoria no la borra", r.status === 200);
r = await call(categories, { token: A.token });
check("y deja de salir en la lista normal", !r.body.categories.some((c) => c.id === CAT.Salud), j(r.body.categories.map((c) => c.name)));
check("pero si con all=1", (await call(categories, { query: { all: "1" }, token: A.token })).body.categories.some((c) => c.id === CAT.Salud));

check("borrar un gasto", (await call(expenses, { method: "DELETE", query: { id: String(X2) }, token: A.token })).status === 200);
check("un gasto de otra cuenta -> 404", (await call(expenses, { method: "DELETE", query: { id: String(X1) }, token: B.token })).status === 404);
r = await call(expenses, { token: A.token });
check("queda un solo gasto", r.body.expenses.length === 1);

/* ========================================================================== */
section("Cerrar y borrar deudas");

r = await call(debts, { method: "DELETE", query: { id: String(D3) }, token: A.token });
check("cerrar deuda (active=0)", r.status === 200);
r = await call(debts, { token: A.token });
check("cerrada no sale por defecto", !r.body.debts.some((d) => d.id === D3));
r = await call(debts, { query: { all: "1" }, token: A.token });
check("con all=1 si", r.body.debts.some((d) => d.id === D3 && d.active === 0));
r = await call(debts, { method: "PUT", query: { id: String(D3) }, token: A.token, body: { active: true } });
check("reabrir", r.body.debt.active === 1);

r = await call(entries, { method: "DELETE", query: { id: String(E3) }, token: V.token });
check("el viewer no borra movimientos (403)", r.status === 403);
r = await call(entries, { method: "DELETE", query: { id: String(E3) }, token: A.token });
check("borrar movimiento", r.status === 200);
r = await call(comments, { query: { debtId: String(D1), entryId: "0" }, token: A.token });
check("se llevo sus comentarios", r.body.comments.length === 0, j(r.body.comments));
r = await call(debts, { token: A.token });
check("saldo vuelve a 7500", r.body.debts.find((d) => d.id === D1).totals.NIO.balance === 7500);

r = await call(debts, { method: "DELETE", query: { id: String(D2), hard: "1" }, token: A.token });
check("borrado definitivo", r.status === 200 && r.body.deleted === true);
const huerfanos = Number((await db.execute({ sql: `SELECT COUNT(*) c FROM entries WHERE debtId = ?`, args: [D2] })).rows[0].c);
check("sin movimientos huerfanos", huerfanos === 0);

/* ========================================================================== */
console.log(`\n${total - fails}/${total} pruebas pasaron${fails ? `  (${fails} FALLARON)` : ""}.`);

if (process.argv.includes("--keep")) {
  console.log("\n--keep: se dejan los datos. Entra con moises / deuda1234 (admin) o hermano / deuda1234 (viewer).");
} else {
  await db.batch([
    "DELETE FROM receipts", "DELETE FROM comments", "DELETE FROM entries",
    "DELETE FROM debt_users", "DELETE FROM debts",
    "DELETE FROM expense_receipts", "DELETE FROM expenses", "DELETE FROM categories",
    "DELETE FROM users", "DELETE FROM accounts",
  ], "write");
  console.log("Datos de prueba borrados.");
}
process.exit(fails ? 1 : 0);
