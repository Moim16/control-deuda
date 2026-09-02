// =============================================================================
//  Resumen para la pantalla de inicio: todas las deudas visibles con sus
//  totales, los movimientos en forma compacta (para los graficos) y los ultimos
//  comentarios.
//
//  GET /api/summary[?all=1] -> { debts, entries, comments, today }
//
//  Los movimientos van completos y no agregados por mes a proposito: son pocos
//  (es una cuenta personal), y con la lista cruda la app puede armar cualquier
//  grafico o rango sin volver a pedir nada.
// =============================================================================

import { db, ensureSchema } from "../lib/db.js";
import { today } from "../lib/day.js";
import { currentUser, isAdmin, deny, debtScope } from "../lib/auth.js";
import { DEBT_SELECT, rowToDebt } from "./debts.js";

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const me = await currentUser(req, {});
    if (!me) return deny(res);
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Método no permitido" });
    }
    const all = !!req.query?.all;
    const scope = debtScope(me);

    const debts = await db.execute({
      sql: `${DEBT_SELECT} WHERE ${scope.sql} ${all ? "" : "AND d.active = 1"}
            ORDER BY d.active DESC, d.name COLLATE NOCASE`,
      args: scope.args,
    });
    const entries = await db.execute({
      sql: `SELECT e.id, e.debtId, e.kind, e.currency, e.day, e.amount, e.reason, e.hasReceipt
              FROM entries e JOIN debts d ON d.id = e.debtId
             WHERE ${scope.sql} ${all ? "" : "AND d.active = 1"}
             ORDER BY e.day ASC, e.id ASC`,
      args: scope.args,
    });
    const comments = await db.execute({
      sql: `SELECT c.id, c.debtId, c.entryId, c.userId, c.text, c.createdAt,
                   u.name AS userName, u.role, d.name AS debtName
              FROM comments c
              JOIN debts d ON d.id = c.debtId
              LEFT JOIN users u ON u.id = c.userId
             WHERE ${scope.sql}
             ORDER BY c.createdAt DESC, c.id DESC LIMIT 8`,
      args: scope.args,
    });

    return res.status(200).json({
      today: today(),
      debts: debts.rows.map((d) => {
        const out = rowToDebt(d);
        if (!isAdmin(me)) delete out.viewers;
        return out;
      }),
      entries: entries.rows.map((e) => ({
        id: Number(e.id), debtId: Number(e.debtId), kind: e.kind, currency: e.currency, day: e.day,
        amount: Number(e.amount), reason: e.reason, hasReceipt: !!Number(e.hasReceipt),
      })),
      comments: comments.rows.map((c) => ({
        id: Number(c.id), debtId: Number(c.debtId), debtName: c.debtName,
        entryId: c.entryId == null ? null : Number(c.entryId),
        userId: Number(c.userId), userName: c.userName || "—", role: c.role || null,
        mine: Number(c.userId) === me.id, text: c.text, createdAt: c.createdAt,
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
