// =============================================================================
//  Ingresos: lo que entra.
//
//  GET    /api/incomes            -> todos los ingresos de la cuenta.
//  POST   /api/incomes            { kind, amount, currency, day, source, note }
//  PUT    /api/incomes?id=        { los mismos }
//  DELETE /api/incomes?id=
//
//  `kind`: 'monthly' (el sueldo: se repite cada mes y rige DESDE `day`) u 'once'
//  (lo que entro una sola vez ese dia: aguinaldo, un trabajito).
//
//  Son del DUEÑO: todo exige admin, incluso leer. Cuanto gana uno no es asunto
//  de quien entra a ver la deuda que le compartieron.
// =============================================================================

import { db, ensureSchema, nowIso, CURRENCIES, INCOME_KINDS } from "../lib/db.js";
import { readJson, clean, parseId, parseDay } from "../lib/http.js";
import { currentUser, isAdmin, deny, notYours } from "../lib/auth.js";

function parseAmount(v) {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) return null;
  return Math.round(n * 100) / 100;
}

const rowToIncome = (i) => ({
  id: Number(i.id), kind: i.kind, amount: Number(i.amount), currency: i.currency,
  day: i.day, source: i.source, note: i.note,
  createdBy: i.createdByName || null, createdAt: i.createdAt, updatedAt: i.updatedAt,
});

export const INC_SELECT = `
  SELECT i.*, u.name AS createdByName
  FROM incomes i LEFT JOIN users u ON u.id = i.createdBy`;

async function mine(user, id) {
  const rs = await db.execute({ sql: `SELECT 1 FROM incomes WHERE id = ? AND accountId = ?`, args: [id, user.accountId] });
  return rs.rows.length > 0;
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);
    const me = await currentUser(req, body);
    if (!me) return deny(res);
    if (!isAdmin(me)) return deny(res, true);

    /* ------------------------------------------------------------------ GET */
    if (req.method === "GET") {
      const rs = await db.execute({
        sql: `${INC_SELECT} WHERE i.accountId = ? ORDER BY i.day DESC, i.id DESC`,
        args: [me.accountId],
      });
      return res.status(200).json({ incomes: rs.rows.map(rowToIncome) });
    }

    /* ----------------------------------------------------------------- POST */
    if (req.method === "POST") {
      const kind = INCOME_KINDS.includes(body.kind) ? body.kind : "monthly";
      const amount = parseAmount(body.amount);
      if (!amount) return res.status(400).json({ error: "El monto debe ser mayor que cero." });
      const day = parseDay(body.day);
      if (!day) return res.status(400).json({ error: kind === "monthly" ? "Indica desde cuándo ganas eso." : "La fecha no es válida." });
      const currency = CURRENCIES.includes(body.currency) ? body.currency : "NIO";
      // Dos sueldos vigentes desde el mismo dia y en la misma moneda no tienen
      // sentido: seria no saber cual manda. Se corrige el que ya hay.
      if (kind === "monthly") {
        const dup = await db.execute({
          sql: `SELECT 1 FROM incomes WHERE accountId = ? AND kind = 'monthly' AND currency = ? AND day = ?`,
          args: [me.accountId, currency, day],
        });
        if (dup.rows.length) return res.status(409).json({ error: "Ya tienes un ingreso fijo que empieza ese día. Edítalo en vez de crear otro." });
      }
      const now = nowIso();
      const ins = await db.execute({
        sql: `INSERT INTO incomes (accountId, kind, amount, currency, day, source, note, createdBy, createdAt, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [me.accountId, kind, amount, currency, day, clean(body.source, 120), clean(body.note, 500), me.id, now, now],
      });
      const rs = await db.execute({ sql: `${INC_SELECT} WHERE i.id = ?`, args: [Number(ins.lastInsertRowid)] });
      return res.status(201).json({ income: rowToIncome(rs.rows[0]) });
    }

    /* ------------------------------------------------------------------ PUT */
    if (req.method === "PUT") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (!(await mine(me, id))) return notYours(res);
      const sets = [], args = [];
      if ("kind" in body) {
        if (!INCOME_KINDS.includes(body.kind)) return res.status(400).json({ error: "Tipo de ingreso inválido." });
        sets.push("kind = ?"); args.push(body.kind);
      }
      if ("amount" in body) {
        const amount = parseAmount(body.amount);
        if (!amount) return res.status(400).json({ error: "El monto debe ser mayor que cero." });
        sets.push("amount = ?"); args.push(amount);
      }
      if ("day" in body) {
        const day = parseDay(body.day);
        if (!day) return res.status(400).json({ error: "La fecha no es válida." });
        sets.push("day = ?"); args.push(day);
      }
      if ("currency" in body) {
        if (!CURRENCIES.includes(body.currency)) return res.status(400).json({ error: "Moneda inválida." });
        sets.push("currency = ?"); args.push(body.currency);
      }
      if ("source" in body) { sets.push("source = ?"); args.push(clean(body.source, 120)); }
      if ("note" in body) { sets.push("note = ?"); args.push(clean(body.note, 500)); }
      if (!sets.length) return res.status(400).json({ error: "Nada que actualizar." });
      sets.push("updatedAt = ?"); args.push(nowIso());
      args.push(id);
      await db.execute({ sql: `UPDATE incomes SET ${sets.join(", ")} WHERE id = ?`, args });
      const rs = await db.execute({ sql: `${INC_SELECT} WHERE i.id = ?`, args: [id] });
      return res.status(200).json({ ok: true, income: rowToIncome(rs.rows[0]) });
    }

    /* --------------------------------------------------------------- DELETE */
    if (req.method === "DELETE") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (!(await mine(me, id))) return notYours(res);
      await db.execute({ sql: `DELETE FROM incomes WHERE id = ?`, args: [id] });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
