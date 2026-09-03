// =============================================================================
//  Categorias del gasto del hogar (Comida, Casa, Transporte...), con su
//  presupuesto mensual opcional.
//
//  GET    /api/categories[?all=1]  -> categorias activas (all=1 incluye las
//                                     archivadas), con cuantos gastos tiene cada una.
//  POST   /api/categories          { name, budget, currency } -> crear.
//  POST   /api/categories?seed=1   -> crea las categorias tipicas de una casa,
//                                     solo si la cuenta todavia no tiene ninguna.
//  PUT    /api/categories?id=      { name, budget, currency, active } -> editar.
//  DELETE /api/categories?id=      -> archiva (active = 0). Con &hard=1 la borra:
//                                     sus gastos quedan "sin categoria", no se
//                                     borran (la plata se gasto igual).
//
//  Los gastos del hogar son del DUEÑO: un usuario de solo lectura entra a ver la
//  deuda que le compartieron, no en qué se gasta uno la plata. Todo aqui exige
//  admin, incluso la lectura.
// =============================================================================

import { db, ensureSchema, nowIso, CURRENCIES, DEFAULT_CATEGORIES } from "../lib/db.js";
import { readJson, clean, parseId } from "../lib/http.js";
import { currentUser, isAdmin, deny, notYours } from "../lib/auth.js";

// Presupuesto mensual: numero positivo o nada.
function parseBudget(v) {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const n = Number(String(v).replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) return { ok: false };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

const rowToCat = (c) => ({
  id: Number(c.id), name: c.name,
  budget: c.budget == null ? null : Number(c.budget),
  currency: c.currency, active: Number(c.active),
  expenses: Number(c.expenses || 0), createdAt: c.createdAt,
});

const CAT_SELECT = `
  SELECT c.*, (SELECT COUNT(*) FROM expenses e WHERE e.categoryId = c.id) AS expenses
  FROM categories c`;

// True si la categoria es de la cuenta de este usuario.
async function mine(user, id) {
  const rs = await db.execute({ sql: `SELECT 1 FROM categories WHERE id = ? AND accountId = ?`, args: [id, user.accountId] });
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
      const all = !!req.query?.all;
      const rs = await db.execute({
        sql: `${CAT_SELECT} WHERE c.accountId = ? ${all ? "" : "AND c.active = 1"} ORDER BY c.id`,
        args: [me.accountId],
      });
      return res.status(200).json({ categories: rs.rows.map(rowToCat) });
    }

    /* --------------------------------------------------- POST ?seed=1 ----- */
    if (req.method === "POST" && req.query?.seed) {
      const n = Number((await db.execute({ sql: `SELECT COUNT(*) c FROM categories WHERE accountId = ?`, args: [me.accountId] })).rows[0].c);
      if (n) return res.status(409).json({ error: "Ya tienes categorías creadas." });
      const now = nowIso();
      await db.batch(DEFAULT_CATEGORIES.map((name) => ({
        sql: `INSERT INTO categories (accountId, name, currency, createdAt) VALUES (?, ?, 'NIO', ?)`,
        args: [me.accountId, name, now],
      })), "write");
      const rs = await db.execute({ sql: `${CAT_SELECT} WHERE c.accountId = ? ORDER BY c.id`, args: [me.accountId] });
      return res.status(201).json({ categories: rs.rows.map(rowToCat) });
    }

    /* ----------------------------------------------------------------- POST */
    if (req.method === "POST") {
      const name = clean(body.name, 60);
      if (!name) return res.status(400).json({ error: "Ponle un nombre a la categoría." });
      const budget = parseBudget(body.budget);
      if (!budget.ok) return res.status(400).json({ error: "El presupuesto debe ser un monto mayor que cero." });
      const currency = CURRENCIES.includes(body.currency) ? body.currency : "NIO";
      const dup = await db.execute({
        sql: `SELECT 1 FROM categories WHERE accountId = ? AND name = ? COLLATE NOCASE`,
        args: [me.accountId, name],
      });
      if (dup.rows.length) return res.status(409).json({ error: "Ya tienes una categoría con ese nombre." });
      const ins = await db.execute({
        sql: `INSERT INTO categories (accountId, name, budget, currency, createdAt) VALUES (?, ?, ?, ?, ?)`,
        args: [me.accountId, name, budget.value, currency, nowIso()],
      });
      const rs = await db.execute({ sql: `${CAT_SELECT} WHERE c.id = ?`, args: [Number(ins.lastInsertRowid)] });
      return res.status(201).json({ category: rowToCat(rs.rows[0]) });
    }

    /* ------------------------------------------------------------------ PUT */
    if (req.method === "PUT") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (!(await mine(me, id))) return notYours(res);
      const sets = [], args = [];
      if ("name" in body) {
        const name = clean(body.name, 60);
        if (!name) return res.status(400).json({ error: "Ponle un nombre a la categoría." });
        const dup = await db.execute({
          sql: `SELECT 1 FROM categories WHERE accountId = ? AND name = ? COLLATE NOCASE AND id <> ?`,
          args: [me.accountId, name, id],
        });
        if (dup.rows.length) return res.status(409).json({ error: "Ya tienes una categoría con ese nombre." });
        sets.push("name = ?"); args.push(name);
      }
      if ("budget" in body) {
        const budget = parseBudget(body.budget);
        if (!budget.ok) return res.status(400).json({ error: "El presupuesto debe ser un monto mayor que cero." });
        sets.push("budget = ?"); args.push(budget.value);
      }
      if ("currency" in body && CURRENCIES.includes(body.currency)) { sets.push("currency = ?"); args.push(body.currency); }
      if ("active" in body) { sets.push("active = ?"); args.push(body.active ? 1 : 0); }
      if (!sets.length) return res.status(400).json({ error: "Nada que actualizar." });
      args.push(id);
      await db.execute({ sql: `UPDATE categories SET ${sets.join(", ")} WHERE id = ?`, args });
      const rs = await db.execute({ sql: `${CAT_SELECT} WHERE c.id = ?`, args: [id] });
      return res.status(200).json({ ok: true, category: rowToCat(rs.rows[0]) });
    }

    /* --------------------------------------------------------------- DELETE */
    if (req.method === "DELETE") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (!(await mine(me, id))) return notYours(res);
      if (req.query?.hard) {
        // Los gastos NO se borran: quedan sin categoria. Se hace a mano para no
        // depender de que la base tenga las claves foraneas encendidas.
        await db.batch([
          { sql: `UPDATE expenses SET categoryId = NULL WHERE categoryId = ?`, args: [id] },
          { sql: `DELETE FROM categories WHERE id = ?`, args: [id] },
        ], "write");
        return res.status(200).json({ ok: true, deleted: true });
      }
      const upd = await db.execute({ sql: `UPDATE categories SET active = 0 WHERE id = ?`, args: [id] });
      if (!upd.rowsAffected) return res.status(404).json({ error: "Categoría no encontrada." });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
