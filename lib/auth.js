// =============================================================================
//  Autenticacion: hash de contraseña (scrypt) + token de sesion verificado en el
//  servidor. El token va en el header `x-session-token` y se exige en TODA lectura
//  y escritura: las deudas de uno no son publicas.
// =============================================================================

import crypto from "node:crypto";
import { db } from "./db.js";

const KEYLEN = 32;

// Devuelve "salt:hash" (nunca se guarda la contraseña en claro).
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

// Compara una contraseña con el "salt:hash" guardado (timing-safe).
export function verifyPassword(pw, stored) {
  if (!stored || typeof stored !== "string" || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  let calc;
  try { calc = crypto.scryptSync(String(pw), salt, KEYLEN).toString("hex"); } catch { return false; }
  const a = Buffer.from(hash, "hex"), b = Buffer.from(calc, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function tokenFromReq(req, body) {
  return (req.headers?.["x-session-token"] || body?.token || "").toString();
}

// Devuelve el usuario dueño del token, o null. Es la puerta de entrada de todos
// los endpoints: `const me = await currentUser(req, body); if (!me) -> 401`.
export async function currentUser(req, body) {
  const token = tokenFromReq(req, body);
  if (!token || token.length < 16) return null;
  const rs = await db.execute({
    sql: `SELECT id, name, fullName, role, active, accountId FROM users WHERE sessionToken = ? LIMIT 1`,
    args: [token],
  });
  const u = rs.rows[0];
  if (!u || !Number(u.active)) return null;
  return {
    id: Number(u.id), name: u.name, fullName: u.fullName, role: u.role,
    accountId: Number(u.accountId),
  };
}

export const isAdmin = (user) => user?.role === "admin";

/* ---------------------------------------------------------------------------
   Visibilidad de deudas

   Dos cercos, uno dentro del otro:
     1. CUENTA: nadie ve nada fuera de su cuenta. Es el cerco duro.
     2. ASIGNACION: dentro de la cuenta, el admin ve todas sus deudas y el
        viewer solo las que tenga en debt_users (sin asignaciones no ve ninguna).

   Los movimientos, comprobantes y comentarios cuelgan de la deuda, asi que
   basta con comprobar la deuda para cubrirlos a todos.
--------------------------------------------------------------------------- */

// Condicion SQL reutilizable. `alias` es la tabla de deudas en la consulta.
export function debtScope(user, alias = "d") {
  if (isAdmin(user)) {
    return { sql: `${alias}.accountId = ?`, args: [user.accountId] };
  }
  return {
    sql: `${alias}.accountId = ? AND EXISTS (
            SELECT 1 FROM debt_users du WHERE du.debtId = ${alias}.id AND du.userId = ?)`,
    args: [user.accountId, user.id],
  };
}

// True si el usuario puede ver esa deuda.
export async function canSeeDebt(user, debtId) {
  if (!user || !debtId) return false;
  const scope = debtScope(user);
  const rs = await db.execute({
    sql: `SELECT 1 FROM debts d WHERE d.id = ? AND ${scope.sql} LIMIT 1`,
    args: [debtId, ...scope.args],
  });
  return rs.rows.length > 0;
}

// Devuelve la deuda del movimiento si el usuario puede verla, o null.
export async function debtOfEntry(user, entryId) {
  if (!user || !entryId) return null;
  const scope = debtScope(user);
  const rs = await db.execute({
    sql: `SELECT d.id, d.currency, d.active FROM entries e JOIN debts d ON d.id = e.debtId
           WHERE e.id = ? AND ${scope.sql} LIMIT 1`,
    args: [entryId, ...scope.args],
  });
  const d = rs.rows[0];
  return d ? { id: Number(d.id), currency: d.currency, active: Number(d.active) } : null;
}

// Respuesta 401/403 estandar para no repetir el texto en cada endpoint.
export function deny(res, admin = false) {
  return admin
    ? res.status(403).json({ error: "Solo el dueño de la cuenta puede hacer esto." })
    : res.status(401).json({ error: "Sesión inválida. Vuelve a entrar." });
}

// Se responde 404 y no 403 a proposito: quien no tiene acceso a una deuda
// tampoco deberia poder deducir que existe.
export function notYours(res) {
  return res.status(404).json({ error: "No encontrado." });
}
