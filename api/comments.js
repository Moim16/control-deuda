// =============================================================================
//  Comentarios: lo unico que puede escribir un viewer. "Este abono fue el del
//  sabado", "¿y los 500 del mes pasado?"... Sirven sobre la deuda en general o
//  sobre un movimiento en particular.
//
//  GET    /api/comments?debtId=[&entryId=]  -> comentarios (los de la deuda en
//                                              general si no se manda entryId;
//                                              con entryId=0, TODOS los de la deuda).
//  POST   /api/comments   { debtId, entryId?, text } -> escribir (cualquiera que
//                                                       vea la deuda).
//  DELETE /api/comments?id=  -> borrar: el autor su propio comentario, el admin
//                               cualquiera de su cuenta.
// =============================================================================

import { db, ensureSchema, nowIso } from "../lib/db.js";
import { readJson, clean, parseId } from "../lib/http.js";
import { currentUser, isAdmin, deny, notYours, canSeeDebt, debtOfEntry } from "../lib/auth.js";

const rowToComment = (c, meId) => ({
  id: Number(c.id), debtId: Number(c.debtId),
  entryId: c.entryId == null ? null : Number(c.entryId),
  userId: Number(c.userId), userName: c.userName || "—",
  role: c.role || null, mine: Number(c.userId) === meId,
  text: c.text, createdAt: c.createdAt,
  // Para poder decir "sobre el abono del 12 de mayo" en la lista general.
  entryKind: c.entryKind || null, entryDay: c.entryDay || null,
  entryAmount: c.entryAmount == null ? null : Number(c.entryAmount), entryCurrency: c.entryCurrency || null,
});

const COMMENT_SELECT = `
  SELECT c.*, u.name AS userName, u.role,
         e.kind AS entryKind, e.day AS entryDay, e.amount AS entryAmount, e.currency AS entryCurrency
  FROM comments c
  LEFT JOIN users u ON u.id = c.userId
  LEFT JOIN entries e ON e.id = c.entryId`;

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);
    const me = await currentUser(req, body);
    if (!me) return deny(res);

    /* ------------------------------------------------------------------ GET */
    if (req.method === "GET") {
      const debtId = parseId(req.query?.debtId);
      if (!debtId) return res.status(400).json({ error: "debtId es obligatorio." });
      if (!(await canSeeDebt(me, debtId))) return notYours(res);
      let where = `c.debtId = ? AND c.entryId IS NULL`, args = [debtId];
      if (req.query?.entryId === "0" || req.query?.entryId === "all") {
        where = `c.debtId = ?`;
      } else if (req.query?.entryId) {
        const entryId = parseId(req.query.entryId);
        if (!entryId) return res.status(400).json({ error: "entryId inválido." });
        where = `c.debtId = ? AND c.entryId = ?`; args = [debtId, entryId];
      }
      const rs = await db.execute({
        sql: `${COMMENT_SELECT} WHERE ${where} ORDER BY c.createdAt ASC, c.id ASC`,
        args,
      });
      return res.status(200).json({ comments: rs.rows.map((c) => rowToComment(c, me.id)) });
    }

    /* ----------------------------------------------------------------- POST */
    if (req.method === "POST") {
      const debtId = parseId(body.debtId);
      if (!debtId) return res.status(400).json({ error: "debtId es obligatorio." });
      if (!(await canSeeDebt(me, debtId))) return notYours(res);
      const text = clean(body.text, 500);
      if (!text) return res.status(400).json({ error: "Escribe algo." });
      let entryId = null;
      if (body.entryId != null && body.entryId !== "") {
        entryId = parseId(body.entryId);
        // El movimiento tiene que ser de ESA deuda.
        const d = entryId ? await debtOfEntry(me, entryId) : null;
        if (!d || d.id !== debtId) return notYours(res);
      }
      const ins = await db.execute({
        sql: `INSERT INTO comments (debtId, entryId, userId, text, createdAt) VALUES (?, ?, ?, ?, ?)`,
        args: [debtId, entryId, me.id, text, nowIso()],
      });
      const rs = await db.execute({ sql: `${COMMENT_SELECT} WHERE c.id = ?`, args: [Number(ins.lastInsertRowid)] });
      return res.status(201).json({ comment: rowToComment(rs.rows[0], me.id) });
    }

    /* --------------------------------------------------------------- DELETE */
    if (req.method === "DELETE") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      const rs = await db.execute({
        sql: `SELECT c.userId, c.debtId FROM comments c WHERE c.id = ?`, args: [id],
      });
      const c = rs.rows[0];
      if (!c || !(await canSeeDebt(me, Number(c.debtId)))) return notYours(res);
      if (Number(c.userId) !== me.id && !isAdmin(me)) return deny(res, true);
      await db.execute({ sql: `DELETE FROM comments WHERE id = ?`, args: [id] });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
