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
export const CURRENCIES = ["NIO", "USD"];
export const ENTRY_KINDS = ["loan", "payment"];
