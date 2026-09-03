// =============================================================================
//  Capa de datos (libSQL / SQLite).
//
//   - LOCAL (scripts/dev.mjs): archivo dentro del proyecto -> data/deudas.db
//     (cero cuenta, cero setup; el archivo NO se commitea, ver .gitignore).
//   - PRODUCCION (Vercel): Turso via TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.
//
//  El esquema se crea solo (CREATE TABLE IF NOT EXISTS) la primera vez que se usa.
// =============================================================================

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import crypto from "node:crypto";

const url = process.env.TURSO_DATABASE_URL || "file:./data/deudas.db";
const isRemote = !url.startsWith("file:");

// Remoto (Turso): cliente WEB (JS puro sobre HTTP). El cliente con binding nativo
// no se empaqueta bien en Vercel y hace crashear la funcion al cargar el modulo.
const { createClient } = await import(isRemote ? "@libsql/client/web" : "@libsql/client");

if (!isRemote) {
  try { mkdirSync(dirname(url.slice("file:".length)), { recursive: true }); } catch {}
}

export const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

// Inicializacion del esquema: una sola vez por instancia (promesa cacheada).
let schemaReady = null;
export function ensureSchema() {
  if (!schemaReady) schemaReady = initSchema();
  return schemaReady;
}

async function initSchema() {
  // ----------------------------------------------------------------- cuentas
  // Cada cuenta es un espacio aislado: sus deudas y sus usuarios. Quien crea la
  // cuenta es su dueño (admin) y es el unico que puede escribir.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS accounts (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )`);

  // ---------------------------------------------------------------- usuarios
  // role: 'admin' (dueño de la cuenta: crea deudas, registra prestamos y abonos)
  // o 'viewer' (solo mira las deudas que le asignaron y puede comentar).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      accountId    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,                  -- nombre de usuario para entrar
      fullName     TEXT,
      role         TEXT NOT NULL DEFAULT 'viewer',
      passwordHash TEXT,
      sessionToken TEXT,
      failedLogins INTEGER DEFAULT 0,
      lockedUntil  TEXT,
      active       INTEGER NOT NULL DEFAULT 1,
      recoveryHash TEXT,                           -- codigo de recuperacion, hasheado
      recoveryAt   TEXT,
      createdAt    TEXT NOT NULL
    )`);
  await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name ON users (name COLLATE NOCASE)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_users_account ON users (accountId)`);

  // ------------------------------------------------------------------ deudas
  // El equivalente a un "proyecto": una deuda con alguien o con algo. kind:
  // 'person' (hermano, hermana, un amigo), 'card' (tarjeta de credito) u
  // 'other'. currency: 'NIO' (cordobas) o 'USD'. interestRate es el interes
  // ANUAL en %, opcional: sirve al simulador, no cambia el saldo registrado.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS debts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      accountId    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      kind         TEXT NOT NULL DEFAULT 'person',
      currency     TEXT NOT NULL DEFAULT 'NIO',
      counterpart  TEXT,                           -- a quien se le debe
      note         TEXT,
      interestRate REAL,                           -- % anual, NULL = sin interes
      active       INTEGER NOT NULL DEFAULT 1,
      createdAt    TEXT NOT NULL
    )`);
  // Direccion: 'owe' = yo debo (deuda), 'owed' = me deben (cobro). Un cobro es
  // exactamente una deuda vista desde el otro lado: los mismos movimientos,
  // comprobantes y comentarios, solo cambian las palabras.
  try { await db.execute(`ALTER TABLE debts ADD COLUMN direction TEXT NOT NULL DEFAULT 'owe'`); } catch { /* ya existe */ }
  // Acuerdo de pago, opcional: "cada mes, C$500, desde el 15 de septiembre".
  // Con esto la app calcula el proximo pago esperado y si ya se paso, y arma
  // el recordatorio para WhatsApp. No hay notificaciones push a proposito.
  try { await db.execute(`ALTER TABLE debts ADD COLUMN dueEvery TEXT`); } catch { /* weekly | biweekly | monthly */ }
  try { await db.execute(`ALTER TABLE debts ADD COLUMN dueAmount REAL`); } catch { /* ya existe */ }
  try { await db.execute(`ALTER TABLE debts ADD COLUMN dueFrom TEXT`); } catch { /* YYYY-MM-DD del primer pago */ }
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_debts_account ON debts (accountId, active)`);

  // Que deudas ve cada usuario 'viewer'. El admin ve TODAS las de su cuenta y
  // no necesita filas aqui. Sin filas, el viewer no ve ninguna.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS debt_users (
      debtId INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (debtId, userId)
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_debt_users_user ON debt_users (userId)`);

  // ------------------------------------------------------------- movimientos
  // Una fila por prestamo o abono. kind: 'loan' (sube la deuda) o 'payment'
  // (la baja). La MONEDA va en cada movimiento: una misma deuda puede tener una
  // parte en cordobas y otra en dolares, y los saldos se llevan por separado
  // (no se convierte nada): saldo[moneda] = SUM(loan) - SUM(payment).
  // `day` es la fecha LOCAL en YYYY-MM-DD. El comprobante NO va aqui a
  // proposito: la lista se pide todo el tiempo y no tiene por que arrastrar
  // imagenes; solo viaja `hasReceipt`.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      debtId     INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,                    -- loan | payment
      currency   TEXT NOT NULL DEFAULT 'NIO',      -- NIO | USD
      day        TEXT NOT NULL,                    -- YYYY-MM-DD
      amount     REAL NOT NULL,
      reason     TEXT,                             -- motivo del prestamo / del abono
      note       TEXT,
      hasReceipt INTEGER NOT NULL DEFAULT 0,
      createdBy  INTEGER,
      createdAt  TEXT NOT NULL,
      updatedAt  TEXT NOT NULL
    )`);
  // Bases creadas antes de que la moneda fuera por movimiento.
  try { await db.execute(`ALTER TABLE entries ADD COLUMN currency TEXT NOT NULL DEFAULT 'NIO'`); } catch { /* ya existe */ }
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_entries_debt ON entries (debtId, day)`);

  // Comprobante (captura de la transferencia, foto del recibo) como data URI
  // JPEG. Tabla aparte con la misma clave: se pide solo cuando se quiere ver.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS receipts (
      entryId    INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
      image      TEXT NOT NULL,
      uploadedAt TEXT NOT NULL
    )`);

  // ------------------------------------------------------------- categorias
  // Las "gavetas" del gasto del hogar: Comida, Casa, Transporte... Cada una
  // puede llevar un presupuesto MENSUAL con su moneda. El presupuesto es un
  // tope que uno se propone, no una regla: gastar de mas no bloquea nada, solo
  // se ve en rojo.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS categories (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      accountId INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      budget    REAL,                              -- mensual; NULL = sin tope
      currency  TEXT NOT NULL DEFAULT 'NIO',       -- en que moneda es el tope
      active    INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_cats_account ON categories (accountId, active)`);

  // ----------------------------------------------------------------- gastos
  // Un gasto por linea, con su dia, su monto en la moneda que se pago y, si
  // hay, la captura del recibo. categoryId puede quedar NULL: borrar una
  // categoria no borra el gasto, lo deja "sin categoria" (la plata se gasto
  // igual, y perderla del total seria mentir).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS expenses (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      accountId  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      categoryId INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      day        TEXT NOT NULL,                    -- YYYY-MM-DD
      amount     REAL NOT NULL,
      currency   TEXT NOT NULL DEFAULT 'NIO',
      reason     TEXT,                             -- en que se gasto
      note       TEXT,
      hasReceipt INTEGER NOT NULL DEFAULT 0,
      createdBy  INTEGER,
      createdAt  TEXT NOT NULL,
      updatedAt  TEXT NOT NULL
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_exp_account ON expenses (accountId, day)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_exp_cat ON expenses (categoryId)`);

  // La captura del recibo, aparte igual que los comprobantes de las deudas: la
  // lista del mes se pide todo el tiempo y no tiene por que arrastrar imagenes.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS expense_receipts (
      expenseId  INTEGER PRIMARY KEY REFERENCES expenses(id) ON DELETE CASCADE,
      image      TEXT NOT NULL,
      uploadedAt TEXT NOT NULL
    )`);

  // ---------------------------------------------------------------- ingresos
  // Lo que entra. Dos formas, porque son dos cosas distintas:
  //
  //   'monthly' -> el sueldo: se repite cada mes y rige DESDE `day`. Si te
  //                aumentan, se agrega otra fila con la fecha del aumento y los
  //                meses viejos siguen contando el sueldo que habia entonces.
  //   'once'    -> lo que entro una sola vez ese dia: aguinaldo, un trabajito,
  //                la venta de algo.
  //
  // Con esto la app puede decir lo unico que uno quiere saber antes de prometer
  // un abono: cuanto te queda al mes despues de vivir.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS incomes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      accountId INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind      TEXT NOT NULL DEFAULT 'monthly',   -- monthly | once
      amount    REAL NOT NULL,
      currency  TEXT NOT NULL DEFAULT 'NIO',
      day       TEXT NOT NULL,                     -- monthly: rige desde; once: la fecha
      source    TEXT,                              -- de donde viene
      note      TEXT,
      createdBy INTEGER,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_inc_account ON incomes (accountId, day)`);

  // -------------------------------------------------------------- vehiculos
  // La moto, el carro. `odometer` es el kilometraje de la ultima vez que se
  // anoto algo, y sirve para calcular cuando toca el proximo servicio.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS vehicles (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      accountId INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      kind      TEXT NOT NULL DEFAULT 'moto',     -- moto | car | other
      plate     TEXT,
      year      INTEGER,
      note      TEXT,
      active    INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_veh_account ON vehicles (accountId, active)`);

  // ------------------------------------------------------ tareas del vehiculo
  // Lo que hay que repetir: "aceite cada 3.000 km", "seguro cada año". Se puede
  // poner por kilometros, por meses, o los dos (toca lo que llegue primero, que
  // es como funciona de verdad un manual de mantenimiento).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS vehicle_tasks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicleId  INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      everyKm    INTEGER,                          -- cada cuantos km
      everyMonths INTEGER,                         -- o cada cuantos meses
      note       TEXT,
      active     INTEGER NOT NULL DEFAULT 1,
      createdAt  TEXT NOT NULL
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_vtask_vehicle ON vehicle_tasks (vehicleId, active)`);

  // ------------------------------------------------------------- servicios
  // Lo que se le hizo al vehiculo: cambio de aceite, llantas, el seguro, la
  // revision. Cada uno con su fecha, su kilometraje y lo que costo.
  //
  // `taskId` apunta a la tarea recurrente que atiende (cambio de aceite, por
  // ejemplo), si es una de ellas. Puede ser NULL: una reparacion suelta no
  // pertenece a ninguna rutina.
  //
  // `expenseId` guarda el gasto que se creo en el hogar, si se pidio anotarlo:
  // asi la plata aparece UNA sola vez en los totales del mes y borrar el
  // servicio se lleva su gasto.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS services (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicleId  INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      taskId     INTEGER REFERENCES vehicle_tasks(id) ON DELETE SET NULL,
      expenseId  INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
      day        TEXT NOT NULL,                    -- YYYY-MM-DD
      odometer   INTEGER,                          -- km al momento del servicio
      title      TEXT NOT NULL,                    -- que se hizo
      cost       REAL,                             -- puede no haber costado (garantia)
      currency   TEXT NOT NULL DEFAULT 'NIO',
      place      TEXT,                             -- taller
      note       TEXT,
      hasReceipt INTEGER NOT NULL DEFAULT 0,
      createdBy  INTEGER,
      createdAt  TEXT NOT NULL,
      updatedAt  TEXT NOT NULL
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_srv_vehicle ON services (vehicleId, day)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_srv_task ON services (taskId, day)`);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS service_receipts (
      serviceId  INTEGER PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
      image      TEXT NOT NULL,
      uploadedAt TEXT NOT NULL
    )`);

  // -------------------------------------------------------------- comentarios
  // Lo unico que puede ESCRIBIR un viewer. entryId NULL = comentario sobre la
  // deuda en general; con entryId, sobre ese prestamo o abono en particular.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS comments (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      debtId    INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
      entryId   INTEGER REFERENCES entries(id) ON DELETE CASCADE,
      userId    INTEGER NOT NULL,
      text      TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_comments_debt ON comments (debtId, createdAt)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_comments_entry ON comments (entryId)`);
}

// Alfabeto sin caracteres que se confundan (nada de I, O, 0, 1).
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// Codigo de recuperacion: 12 caracteres en grupos de cuatro para poder dictarlo
// o copiarlo de un papel sin equivocarse. 32^12 = 60 bits: no se adivina.
export function newRecoveryCode() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(b, (x) => ALFABETO[x % ALFABETO.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

// Como se guarda y se compara: sin guiones, en mayusculas.
export const normalizeRecovery = (v) =>
  (v ?? "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "");

export const nowIso = () => new Date().toISOString();

export const KINDS = ["person", "card", "other"];
export const DIRECTIONS = ["owe", "owed"];
export const DUE_EVERY = ["weekly", "biweekly", "monthly"];

// Las categorias que se ofrecen la primera vez, para no arrancar en blanco.
// Son las del gasto de una casa en Nicaragua, sin presupuesto puesto: el tope
// lo decide cada quien.
export const DEFAULT_CATEGORIES = [
  "Comida", "Casa y servicios", "Transporte", "Salud", "Educación", "Otros",
];
export const CURRENCIES = ["NIO", "USD"];
export const ENTRY_KINDS = ["loan", "payment"];
export const INCOME_KINDS = ["monthly", "once"];
export const VEHICLE_KINDS = ["moto", "car", "other"];

// Las tareas que se ofrecen al crear un vehiculo, para no arrancar en blanco.
// Los intervalos son los tipicos de un manual; cada uno los ajusta.
export const DEFAULT_TASKS = {
  moto: [
    { name: "Cambio de aceite", everyKm: 3000, everyMonths: 6 },
    { name: "Filtro de aire", everyKm: 6000, everyMonths: null },
    { name: "Cadena y sprockets", everyKm: 8000, everyMonths: null },
    { name: "Llantas", everyKm: 15000, everyMonths: null },
    { name: "Frenos (pastillas)", everyKm: 10000, everyMonths: null },
    { name: "Seguro", everyKm: null, everyMonths: 12 },
  ],
  car: [
    { name: "Cambio de aceite", everyKm: 5000, everyMonths: 6 },
    { name: "Filtro de aire", everyKm: 10000, everyMonths: null },
    { name: "Rotación de llantas", everyKm: 10000, everyMonths: null },
    { name: "Frenos (pastillas)", everyKm: 20000, everyMonths: null },
    { name: "Batería", everyKm: null, everyMonths: 24 },
    { name: "Seguro", everyKm: null, everyMonths: 12 },
    { name: "Revisión vehicular", everyKm: null, everyMonths: 12 },
  ],
  other: [
    { name: "Mantenimiento general", everyKm: null, everyMonths: 6 },
  ],
};
