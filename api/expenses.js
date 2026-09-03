// =============================================================================
//  Gastos del hogar.
//
//  GET    /api/expenses[?months=13]   -> { categories, expenses, incomes, today }:
//                                        las categorias, los gastos de los
//                                        ultimos `months` meses (13 por defecto:
//                                        el año de graficos mas el mes en curso)
//                                        y los ingresos. Todo en una sola
//                                        llamada, que es lo que necesita la
//                                        pantalla para pintarse.
//                                        Los ingresos van COMPLETOS (son pocos, y
//                                        el sueldo fijo de hace dos años sigue
//                                        haciendo falta para saber que se ganaba
//                                        entonces).
//  GET    /api/expenses?id=&receipt=1  -> { image } la captura del recibo.
//  POST   /api/expenses                { categoryId, day, amount, currency,
//                                        reason, note, receipt } -> registrar.
//  PUT    /api/expenses?id=            { los mismos } -> editar. `receipt` null
//                                        borra la captura; ausente no la toca.
//  DELETE /api/expenses?id=            -> borra el gasto y su captura.
//
//  Son del DUEÑO: todo exige admin, incluso leer. Un usuario de solo lectura
//  entra a ver la deuda que le compartieron, no en que se gasta uno la plata.
//
//  Los montos NO se suman entre monedas en ningun lado: la pantalla los agrupa
//  por moneda, igual que las deudas.
// =============================================================================

import { db, ensureSchema, nowIso, CURRENCIES } from "../lib/db.js";
import { today } from "../lib/day.js";
import { readJson, clean, parseId, parseDay, parseDataJpeg } from "../lib/http.js";
import { currentUser, isAdmin, deny, notYours } from "../lib/auth.js";
import { INC_SELECT } from "./incomes.js";

const MAX_RECEIPT = 900 * 1024;   // el navegador ya achica; esto es el tope duro

function parseAmount(v) {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) return null;
  return Math.round(n * 100) / 100;
}

// El primer dia del mes que empieza `n` meses antes del actual.
function monthsAgo(n) {
  const [y, m] = today().split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

const rowToExpense = (e) => ({
  id: Number(e.id),
  categoryId: e.categoryId == null ? null : Number(e.categoryId),
  day: e.day, amount: Number(e.amount), currency: e.currency,
  reason: e.reason, note: e.note, hasReceipt: !!Number(e.hasReceipt),
  createdBy: e.createdByName || null, createdAt: e.createdAt, updatedAt: e.updatedAt,
});

const EXP_SELECT = `
  SELECT e.*, u.name AS createdByName
  FROM expenses e LEFT JOIN users u ON u.id = e.createdBy`;

// La categoria tiene que ser de la misma cuenta (o ninguna).
async function checkCategory(user, v) {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const id = parseId(v);
  if (!id) return { ok: false };
  const rs = await db.execute({ sql: `SELECT 1 FROM categories WHERE id = ? AND accountId = ?`, args: [id, user.accountId] });
  return rs.rows.length ? { ok: true, value: id } : { ok: false };
}

async function mine(user, id) {
  const rs = await db.execute({ sql: `SELECT 1 FROM expenses WHERE id = ? AND accountId = ?`, args: [id, user.accountId] });
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
      if (req.query?.receipt) {
        const id = parseId(req.query?.id);
        if (!id) return res.status(400).json({ error: "id inválido." });
        if (!(await mine(me, id))) return notYours(res);
        const rs = await db.execute({ sql: `SELECT image, uploadedAt FROM expense_receipts WHERE expenseId = ?`, args: [id] });
        if (!rs.rows.length) return res.status(404).json({ error: "Este gasto no tiene captura." });
        return res.status(200).json({ image: rs.rows[0].image, uploadedAt: rs.rows[0].uploadedAt });
      }
      const n = Math.min(60, Math.max(1, Number(req.query?.months) || 13));
      const desde = monthsAgo(n - 1);
      const cats = await db.execute({
        sql: `SELECT c.*, (SELECT COUNT(*) FROM expenses e WHERE e.categoryId = c.id) AS expenses
                FROM categories c WHERE c.accountId = ? ORDER BY c.id`,
        args: [me.accountId],
      });
      const exps = await db.execute({
        sql: `${EXP_SELECT} WHERE e.accountId = ? AND e.day >= ? ORDER BY e.day DESC, e.id DESC`,
        args: [me.accountId, desde],
      });
      const incs = await db.execute({
        sql: `${INC_SELECT} WHERE i.accountId = ? ORDER BY i.day DESC, i.id DESC`,
        args: [me.accountId],
      });
      return res.status(200).json({
        today: today(), from: desde,
        incomes: incs.rows.map((i) => ({
          id: Number(i.id), kind: i.kind, amount: Number(i.amount), currency: i.currency,
          day: i.day, source: i.source, note: i.note,
        })),
        categories: cats.rows.map((c) => ({
          id: Number(c.id), name: c.name, budget: c.budget == null ? null : Number(c.budget),
          currency: c.currency, active: Number(c.active), expenses: Number(c.expenses || 0),
        })),
        expenses: exps.rows.map(rowToExpense),
      });
    }

    /* ----------------------------------------------------------------- POST */
    if (req.method === "POST") {
      const day = parseDay(body.day);
      if (!day) return res.status(400).json({ error: "La fecha no es válida." });
      const amount = parseAmount(body.amount);
      if (!amount) return res.status(400).json({ error: "El monto debe ser mayor que cero." });
      const cat = await checkCategory(me, body.categoryId);
      if (!cat.ok) return res.status(400).json({ error: "Esa categoría no existe." });
      const currency = CURRENCIES.includes(body.currency) ? body.currency : "NIO";
      const receipt = parseDataJpeg(body.receipt, MAX_RECEIPT, "La captura");
      if (!receipt.ok) return res.status(400).json({ error: receipt.error });

      const now = nowIso();
      const ins = await db.execute({
        sql: `INSERT INTO expenses (accountId, categoryId, day, amount, currency, reason, note, hasReceipt, createdBy, createdAt, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [me.accountId, cat.value, day, amount, currency, clean(body.reason, 120), clean(body.note, 500),
               receipt.value ? 1 : 0, me.id, now, now],
      });
      const id = Number(ins.lastInsertRowid);
      if (receipt.value) {
        await db.execute({ sql: `INSERT INTO expense_receipts (expenseId, image, uploadedAt) VALUES (?, ?, ?)`, args: [id, receipt.value, now] });
      }
      const rs = await db.execute({ sql: `${EXP_SELECT} WHERE e.id = ?`, args: [id] });
      return res.status(201).json({ expense: rowToExpense(rs.rows[0]) });
    }

    /* ------------------------------------------------------------------ PUT */
    if (req.method === "PUT") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (!(await mine(me, id))) return notYours(res);
      const sets = [], args = [];
      if ("day" in body) {
        const day = parseDay(body.day);
        if (!day) return res.status(400).json({ error: "La fecha no es válida." });
        sets.push("day = ?"); args.push(day);
      }
      if ("amount" in body) {
        const amount = parseAmount(body.amount);
        if (!amount) return res.status(400).json({ error: "El monto debe ser mayor que cero." });
        sets.push("amount = ?"); args.push(amount);
      }
      if ("categoryId" in body) {
        const cat = await checkCategory(me, body.categoryId);
        if (!cat.ok) return res.status(400).json({ error: "Esa categoría no existe." });
        sets.push("categoryId = ?"); args.push(cat.value);
      }
      if ("currency" in body) {
        if (!CURRENCIES.includes(body.currency)) return res.status(400).json({ error: "Moneda inválida." });
        sets.push("currency = ?"); args.push(body.currency);
      }
      if ("reason" in body) { sets.push("reason = ?"); args.push(clean(body.reason, 120)); }
      if ("note" in body) { sets.push("note = ?"); args.push(clean(body.note, 500)); }
      if ("receipt" in body) {
        const receipt = parseDataJpeg(body.receipt, MAX_RECEIPT, "La captura");
        if (!receipt.ok) return res.status(400).json({ error: receipt.error });
        if (receipt.value) {
          await db.execute({
            sql: `INSERT INTO expense_receipts (expenseId, image, uploadedAt) VALUES (?, ?, ?)
                  ON CONFLICT(expenseId) DO UPDATE SET image = excluded.image, uploadedAt = excluded.uploadedAt`,
            args: [id, receipt.value, nowIso()],
          });
        } else {
          await db.execute({ sql: `DELETE FROM expense_receipts WHERE expenseId = ?`, args: [id] });
        }
        sets.push("hasReceipt = ?"); args.push(receipt.value ? 1 : 0);
      }
      if (!sets.length) return res.status(400).json({ error: "Nada que actualizar." });
      sets.push("updatedAt = ?"); args.push(nowIso());
      args.push(id);
      await db.execute({ sql: `UPDATE expenses SET ${sets.join(", ")} WHERE id = ?`, args });
      const rs = await db.execute({ sql: `${EXP_SELECT} WHERE e.id = ?`, args: [id] });
      return res.status(200).json({ ok: true, expense: rowToExpense(rs.rows[0]) });
    }

    /* --------------------------------------------------------------- DELETE */
    if (req.method === "DELETE") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (!(await mine(me, id))) return notYours(res);
      await db.batch([
        { sql: `DELETE FROM expense_receipts WHERE expenseId = ?`, args: [id] },
        { sql: `DELETE FROM expenses WHERE id = ?`, args: [id] },
      ], "write");
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
