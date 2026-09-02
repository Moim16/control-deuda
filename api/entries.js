// =============================================================================
//  Movimientos de una deuda: prestamos (suben el saldo) y abonos (lo bajan).
//
//  GET    /api/entries?debtId=        -> movimientos de la deuda, del mas nuevo
//                                        al mas viejo, con cuantos comentarios
//                                        tiene cada uno y si trae comprobante.
//  GET    /api/entries?id=&receipt=1  -> { image } el comprobante (data URI JPEG).
//  POST   /api/entries                { debtId, kind, currency, day, amount, reason,
//                                       note, receipt } -> registrar (admin). Sin
//                                       `currency` se usa la de la deuda.
//  PUT    /api/entries?id=            { kind, currency, day, amount, reason, note, receipt }
//                                     -> editar (admin). `receipt` null borra el
//                                     comprobante; ausente no lo toca.
//  DELETE /api/entries?id=            -> borra el movimiento, su comprobante y
//                                        sus comentarios (admin).
//
//  El comprobante viaja aparte (tabla receipts) para que la lista sea liviana:
//  aqui solo se dice `hasReceipt`. El viewer puede VER todo esto pero no tocarlo.
// =============================================================================

import { db, ensureSchema, nowIso, ENTRY_KINDS, CURRENCIES } from "../lib/db.js";
import { readJson, clean, parseId, parseDay, parseDataJpeg } from "../lib/http.js";
import { currentUser, isAdmin, deny, notYours, canSeeDebt, debtOfEntry } from "../lib/auth.js";

// El navegador ya achica la captura antes de subirla; esto es el tope duro.
const MAX_RECEIPT = 900 * 1024;

// Monto positivo con dos decimales. Devuelve null si no sirve.
function parseAmount(v) {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) return null;
  return Math.round(n * 100) / 100;
}

const rowToEntry = (e) => ({
  id: Number(e.id), debtId: Number(e.debtId), kind: e.kind, currency: e.currency, day: e.day,
  amount: Number(e.amount), reason: e.reason, note: e.note,
  hasReceipt: !!Number(e.hasReceipt), comments: Number(e.comments || 0),
  createdBy: e.createdByName || null, createdAt: e.createdAt, updatedAt: e.updatedAt,
});

const ENTRY_SELECT = `
  SELECT e.*, u.name AS createdByName,
    (SELECT COUNT(*) FROM comments c WHERE c.entryId = e.id) AS comments
  FROM entries e LEFT JOIN users u ON u.id = e.createdBy`;

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);
    const me = await currentUser(req, body);
    if (!me) return deny(res);

    /* ------------------------------------------------------------------ GET */
    if (req.method === "GET") {
      // El comprobante de un movimiento.
      if (req.query?.receipt) {
        const id = parseId(req.query?.id);
        if (!id) return res.status(400).json({ error: "id inválido." });
        if (!(await debtOfEntry(me, id))) return notYours(res);
        const rs = await db.execute({ sql: `SELECT image, uploadedAt FROM receipts WHERE entryId = ?`, args: [id] });
        if (!rs.rows.length) return res.status(404).json({ error: "Este movimiento no tiene comprobante." });
        return res.status(200).json({ image: rs.rows[0].image, uploadedAt: rs.rows[0].uploadedAt });
      }
      const debtId = parseId(req.query?.debtId);
      if (!debtId) return res.status(400).json({ error: "debtId es obligatorio." });
      if (!(await canSeeDebt(me, debtId))) return notYours(res);
      const rs = await db.execute({
        sql: `${ENTRY_SELECT} WHERE e.debtId = ? ORDER BY e.day DESC, e.id DESC`,
        args: [debtId],
      });
      return res.status(200).json({ entries: rs.rows.map(rowToEntry) });
    }

    if (!isAdmin(me)) return deny(res, true);

    /* ----------------------------------------------------------------- POST */
    if (req.method === "POST") {
      const debtId = parseId(body.debtId);
      if (!debtId) return res.status(400).json({ error: "debtId es obligatorio." });
      if (!(await canSeeDebt(me, debtId))) return notYours(res);
      const kind = ENTRY_KINDS.includes(body.kind) ? body.kind : null;
      if (!kind) return res.status(400).json({ error: "Indica si es un préstamo o un abono." });
      const day = parseDay(body.day);
      if (!day) return res.status(400).json({ error: "La fecha no es válida." });
      const amount = parseAmount(body.amount);
      if (!amount) return res.status(400).json({ error: "El monto debe ser mayor que cero." });
      const receipt = parseDataJpeg(body.receipt, MAX_RECEIPT, "El comprobante");
      if (!receipt.ok) return res.status(400).json({ error: receipt.error });
      // Sin moneda explicita, la que tenga la deuda por defecto.
      let currency = CURRENCIES.includes(body.currency) ? body.currency : null;
      if (!currency) {
        currency = (await db.execute({ sql: `SELECT currency FROM debts WHERE id = ?`, args: [debtId] })).rows[0]?.currency || "NIO";
      }

      const now = nowIso();
      const ins = await db.execute({
        sql: `INSERT INTO entries (debtId, kind, currency, day, amount, reason, note, hasReceipt, createdBy, createdAt, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [debtId, kind, currency, day, amount, clean(body.reason, 120), clean(body.note, 500),
               receipt.value ? 1 : 0, me.id, now, now],
      });
      const id = Number(ins.lastInsertRowid);
      if (receipt.value) {
        await db.execute({ sql: `INSERT INTO receipts (entryId, image, uploadedAt) VALUES (?, ?, ?)`, args: [id, receipt.value, now] });
      }
      const rs = await db.execute({ sql: `${ENTRY_SELECT} WHERE e.id = ?`, args: [id] });
      return res.status(201).json({ entry: rowToEntry(rs.rows[0]) });
    }

    /* ------------------------------------------------------------------ PUT */
    if (req.method === "PUT") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (!(await debtOfEntry(me, id))) return notYours(res);
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
      if ("kind" in body) {
        if (!ENTRY_KINDS.includes(body.kind)) return res.status(400).json({ error: "Tipo de movimiento inválido." });
        sets.push("kind = ?"); args.push(body.kind);
      }
      if ("currency" in body) {
        if (!CURRENCIES.includes(body.currency)) return res.status(400).json({ error: "Moneda inválida." });
        sets.push("currency = ?"); args.push(body.currency);
      }
      if ("reason" in body) { sets.push("reason = ?"); args.push(clean(body.reason, 120)); }
      if ("note" in body) { sets.push("note = ?"); args.push(clean(body.note, 500)); }
      if ("receipt" in body) {
        const receipt = parseDataJpeg(body.receipt, MAX_RECEIPT, "El comprobante");
        if (!receipt.ok) return res.status(400).json({ error: receipt.error });
        if (receipt.value) {
          await db.execute({
            sql: `INSERT INTO receipts (entryId, image, uploadedAt) VALUES (?, ?, ?)
                  ON CONFLICT(entryId) DO UPDATE SET image = excluded.image, uploadedAt = excluded.uploadedAt`,
            args: [id, receipt.value, nowIso()],
          });
        } else {
          await db.execute({ sql: `DELETE FROM receipts WHERE entryId = ?`, args: [id] });
        }
        sets.push("hasReceipt = ?"); args.push(receipt.value ? 1 : 0);
      }
      if (!sets.length) return res.status(400).json({ error: "Nada que actualizar." });
      sets.push("updatedAt = ?"); args.push(nowIso());
      args.push(id);
      await db.execute({ sql: `UPDATE entries SET ${sets.join(", ")} WHERE id = ?`, args });
      const rs = await db.execute({ sql: `${ENTRY_SELECT} WHERE e.id = ?`, args: [id] });
      return res.status(200).json({ ok: true, entry: rowToEntry(rs.rows[0]) });
    }

    /* --------------------------------------------------------------- DELETE */
    if (req.method === "DELETE") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (!(await debtOfEntry(me, id))) return notYours(res);
      await db.batch([
        { sql: `DELETE FROM receipts WHERE entryId = ?`, args: [id] },
        { sql: `DELETE FROM comments WHERE entryId = ?`, args: [id] },
        { sql: `DELETE FROM entries WHERE id = ?`, args: [id] },
      ], "write");
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
