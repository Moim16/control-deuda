// =============================================================================
//  Deudas (el equivalente a un "proyecto": con mi hermano, con la tarjeta...).
//
//  GET    /api/debts[?all=1]   -> deudas visibles con sus totales (all=1 incluye
//                                 las cerradas). Cada una trae `totals` POR
//                                 MONEDA ({ NIO: {loaned, paid, balance}, USD }),
//                                 `currencies`, entries y lastDay.
//  POST   /api/debts           { name, kind, currency, counterpart, note,
//                                interestRate } -> crear (admin). `currency` es
//                                la moneda por defecto de los movimientos nuevos.
//  PUT    /api/debts?id=       { ...los mismos, active } -> editar (admin).
//  DELETE /api/debts?id=       -> cierra la deuda (active = 0). Con &hard=1 la
//                                 BORRA con todo su historial (admin).
//
//  Un viewer solo ve las deudas que le asignaron. Todo lo demas (movimientos,
//  comprobantes, comentarios) cuelga de la deuda, asi que este es el cerco.
// =============================================================================

import { db, ensureSchema, nowIso, KINDS, CURRENCIES } from "../lib/db.js";
import { readJson, clean, parseId } from "../lib/http.js";
import { currentUser, isAdmin, deny, notYours, debtScope, canSeeDebt } from "../lib/auth.js";

// Interes anual en %, opcional. Se acepta 0..200 con dos decimales.
function parseRate(v) {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 200) return { ok: false };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// Los totales van POR MONEDA: `totals.NIO` y/o `totals.USD`, solo las que
// tengan movimientos (o la moneda por defecto de la deuda si no tiene ninguno).
// `currency` es la moneda que se propone al registrar un movimiento nuevo.
export const rowToDebt = (d) => {
  const totals = {};
  for (const c of CURRENCIES) {
    const loaned = r2(d[`loaned${c}`]), paid = r2(d[`paid${c}`]);
    if (loaned || paid) totals[c] = { loaned, paid, balance: r2(loaned - paid) };
  }
  if (!Object.keys(totals).length) totals[d.currency] = { loaned: 0, paid: 0, balance: 0 };
  return {
    id: Number(d.id), name: d.name, kind: d.kind, currency: d.currency,
    counterpart: d.counterpart, note: d.note,
    interestRate: d.interestRate == null ? null : Number(d.interestRate),
    active: Number(d.active), createdAt: d.createdAt,
    totals, currencies: Object.keys(totals),
    entries: Number(d.entries || 0), lastDay: d.lastDay || null,
    viewers: d.viewers == null ? undefined : Number(d.viewers),
  };
};

// La consulta base con los totales, reutilizada por summary.js.
const sumOf = (cur, kind) =>
  `(SELECT COALESCE(SUM(e.amount), 0) FROM entries e WHERE e.debtId = d.id AND e.currency = '${cur}' AND e.kind = '${kind}')`;
export const DEBT_SELECT = `
  SELECT d.*,
    ${sumOf("NIO", "loan")}    AS loanedNIO,
    ${sumOf("NIO", "payment")} AS paidNIO,
    ${sumOf("USD", "loan")}    AS loanedUSD,
    ${sumOf("USD", "payment")} AS paidUSD,
    (SELECT COUNT(*) FROM entries e WHERE e.debtId = d.id)                                          AS entries,
    (SELECT MAX(e.day) FROM entries e WHERE e.debtId = d.id)                                        AS lastDay,
    (SELECT COUNT(*) FROM debt_users du JOIN users u ON u.id = du.userId
      WHERE du.debtId = d.id AND u.active = 1)                                                      AS viewers
  FROM debts d`;

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);
    const me = await currentUser(req, body);
    if (!me) return deny(res);

    /* ------------------------------------------------------------------ GET */
    if (req.method === "GET") {
      const all = !!req.query?.all;
      const scope = debtScope(me);
      const rs = await db.execute({
        sql: `${DEBT_SELECT} WHERE ${scope.sql} ${all ? "" : "AND d.active = 1"}
              ORDER BY d.active DESC, d.name COLLATE NOCASE`,
        args: scope.args,
      });
      return res.status(200).json({
        debts: rs.rows.map((d) => {
          const out = rowToDebt(d);
          if (!isAdmin(me)) delete out.viewers;      // al viewer no le importa quien mas ve
          return out;
        }),
      });
    }

    if (!isAdmin(me)) return deny(res, true);

    /* ----------------------------------------------------------------- POST */
    if (req.method === "POST") {
      const name = clean(body.name, 80);
      if (!name) return res.status(400).json({ error: "Ponle un nombre a la deuda." });
      const kind = KINDS.includes(body.kind) ? body.kind : "person";
      const currency = CURRENCIES.includes(body.currency) ? body.currency : "NIO";
      const rate = parseRate(body.interestRate);
      if (!rate.ok) return res.status(400).json({ error: "El interés anual debe ser un porcentaje entre 0 y 200." });
      const ins = await db.execute({
        sql: `INSERT INTO debts (accountId, name, kind, currency, counterpart, note, interestRate, createdAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [me.accountId, name, kind, currency, clean(body.counterpart, 80), clean(body.note, 300), rate.value, nowIso()],
      });
      const rs = await db.execute({ sql: `${DEBT_SELECT} WHERE d.id = ?`, args: [Number(ins.lastInsertRowid)] });
      return res.status(201).json({ debt: rowToDebt(rs.rows[0]) });
    }

    /* ------------------------------------------------------------------ PUT */
    if (req.method === "PUT") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (!(await canSeeDebt(me, id))) return notYours(res);
      const sets = [], args = [];
      if ("name" in body) {
        const name = clean(body.name, 80);
        if (!name) return res.status(400).json({ error: "Ponle un nombre a la deuda." });
        sets.push("name = ?"); args.push(name);
      }
      if ("kind" in body && KINDS.includes(body.kind)) { sets.push("kind = ?"); args.push(body.kind); }
      // Es solo la moneda POR DEFECTO de los movimientos nuevos: cada
      // movimiento guarda la suya, asi que cambiarla no toca nada registrado.
      if ("currency" in body && CURRENCIES.includes(body.currency)) { sets.push("currency = ?"); args.push(body.currency); }
      if ("counterpart" in body) { sets.push("counterpart = ?"); args.push(clean(body.counterpart, 80)); }
      if ("note" in body) { sets.push("note = ?"); args.push(clean(body.note, 300)); }
      if ("interestRate" in body) {
        const rate = parseRate(body.interestRate);
        if (!rate.ok) return res.status(400).json({ error: "El interés anual debe ser un porcentaje entre 0 y 200." });
        sets.push("interestRate = ?"); args.push(rate.value);
      }
      if ("active" in body) { sets.push("active = ?"); args.push(body.active ? 1 : 0); }
      if (!sets.length) return res.status(400).json({ error: "Nada que actualizar." });
      args.push(id);
      await db.execute({ sql: `UPDATE debts SET ${sets.join(", ")} WHERE id = ?`, args });
      const rs = await db.execute({ sql: `${DEBT_SELECT} WHERE d.id = ?`, args: [id] });
      return res.status(200).json({ ok: true, debt: rowToDebt(rs.rows[0]) });
    }

    /* --------------------------------------------------------------- DELETE */
    if (req.method === "DELETE") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (!(await canSeeDebt(me, id))) return notYours(res);
      if (req.query?.hard) {
        // Borrado real, en cascada y a mano: no se depende de que la base tenga
        // las claves foraneas encendidas.
        await db.batch([
          { sql: `DELETE FROM receipts WHERE entryId IN (SELECT id FROM entries WHERE debtId = ?)`, args: [id] },
          { sql: `DELETE FROM comments WHERE debtId = ?`, args: [id] },
          { sql: `DELETE FROM entries WHERE debtId = ?`, args: [id] },
          { sql: `DELETE FROM debt_users WHERE debtId = ?`, args: [id] },
          { sql: `DELETE FROM debts WHERE id = ?`, args: [id] },
        ], "write");
        return res.status(200).json({ ok: true, deleted: true });
      }
      const upd = await db.execute({ sql: `UPDATE debts SET active = 0 WHERE id = ?`, args: [id] });
      if (!upd.rowsAffected) return res.status(404).json({ error: "Deuda no encontrada." });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
