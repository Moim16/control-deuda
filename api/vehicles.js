// =============================================================================
//  Vehiculos, sus tareas de mantenimiento y sus servicios.
//
//  GET    /api/vehicles[?all=1]      -> { vehicles, tasks, services, today }: todo
//                                       lo que necesita la pantalla, en una llamada.
//                                       Cada vehiculo trae su `odometer` (el km mas
//                                       alto anotado) y sus totales gastados.
//  GET    /api/vehicles?id=&receipt=1 -> { image } la factura de un servicio.
//
//  POST   /api/vehicles              { name, kind, plate, year, note } -> crear.
//                                     Crea tambien las tareas tipicas de ese tipo
//                                     de vehiculo (aceite, llantas, seguro...).
//  PUT    /api/vehicles?id=          -> editar el vehiculo.
//  DELETE /api/vehicles?id=          -> archiva; con &hard=1 borra con todo.
//
//  POST   /api/vehicles?task=1       { vehicleId, name, everyKm, everyMonths, note }
//  PUT    /api/vehicles?task=        -> editar la tarea.
//  DELETE /api/vehicles?task=        -> archiva; con &hard=1 la borra (sus
//                                       servicios quedan sin tarea, no se borran).
//
//  POST   /api/vehicles?service=1    { vehicleId, taskId, day, odometer, title,
//                                      cost, currency, place, note, receipt,
//                                      categoryId } -> registrar un servicio.
//                                      Con `categoryId` se anota tambien como
//                                      GASTO del hogar en esa categoria, y el
//                                      servicio se queda con su id: asi la plata
//                                      aparece una sola vez y borrar el servicio
//                                      se lleva el gasto.
//  PUT    /api/vehicles?service=     -> editar el servicio (y su gasto, si tiene).
//  DELETE /api/vehicles?service=     -> borrarlo (y su gasto y su factura).
//
//  Todo es del DUEÑO: exige admin, incluso leer.
// =============================================================================

import { db, ensureSchema, nowIso, CURRENCIES, VEHICLE_KINDS, DEFAULT_TASKS } from "../lib/db.js";
import { today } from "../lib/day.js";
import { readJson, clean, parseId, parseDay, parseDataJpeg } from "../lib/http.js";
import { currentUser, isAdmin, deny, notYours } from "../lib/auth.js";

const MAX_RECEIPT = 900 * 1024;

// Monto opcional (un servicio en garantia no costo nada).
function parseCost(v) {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const n = Number(String(v).replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 1e9) return { ok: false };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

// Entero opcional y positivo: kilometraje, año, intervalos.
function parseInt0(v, max = 9999999) {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) return { ok: false };
  return { ok: true, value: n };
}

const rowToVehicle = (v) => ({
  id: Number(v.id), name: v.name, kind: v.kind, plate: v.plate,
  year: v.year == null ? null : Number(v.year), note: v.note, active: Number(v.active),
  odometer: v.odometer == null ? null : Number(v.odometer),
  services: Number(v.services || 0), lastDay: v.lastDay || null,
  spentNIO: Number(v.spentNIO || 0), spentUSD: Number(v.spentUSD || 0),
  createdAt: v.createdAt,
});
const rowToTask = (t) => ({
  id: Number(t.id), vehicleId: Number(t.vehicleId), name: t.name,
  everyKm: t.everyKm == null ? null : Number(t.everyKm),
  everyMonths: t.everyMonths == null ? null : Number(t.everyMonths),
  note: t.note, active: Number(t.active),
});
const rowToService = (s) => ({
  id: Number(s.id), vehicleId: Number(s.vehicleId),
  taskId: s.taskId == null ? null : Number(s.taskId),
  expenseId: s.expenseId == null ? null : Number(s.expenseId),
  day: s.day, odometer: s.odometer == null ? null : Number(s.odometer),
  title: s.title, cost: s.cost == null ? null : Number(s.cost), currency: s.currency,
  place: s.place, note: s.note, hasReceipt: !!Number(s.hasReceipt),
  createdBy: s.createdByName || null, createdAt: s.createdAt, updatedAt: s.updatedAt,
});

// El kilometraje del vehiculo es el mas alto que se haya anotado, y los totales
// gastados van por moneda (aqui tampoco se suman entre si).
const VEH_SELECT = `
  SELECT v.*,
    (SELECT MAX(s.odometer) FROM services s WHERE s.vehicleId = v.id)                       AS odometer,
    (SELECT COUNT(*) FROM services s WHERE s.vehicleId = v.id)                              AS services,
    (SELECT MAX(s.day) FROM services s WHERE s.vehicleId = v.id)                            AS lastDay,
    (SELECT COALESCE(SUM(s.cost), 0) FROM services s WHERE s.vehicleId = v.id AND s.currency = 'NIO') AS spentNIO,
    (SELECT COALESCE(SUM(s.cost), 0) FROM services s WHERE s.vehicleId = v.id AND s.currency = 'USD') AS spentUSD
  FROM vehicles v`;

const SRV_SELECT = `
  SELECT s.*, u.name AS createdByName
  FROM services s LEFT JOIN users u ON u.id = s.createdBy`;

const mineVehicle = async (user, id) =>
  (await db.execute({ sql: `SELECT 1 FROM vehicles WHERE id = ? AND accountId = ?`, args: [id, user.accountId] })).rows.length > 0;

const mineTask = async (user, id) =>
  (await db.execute({
    sql: `SELECT 1 FROM vehicle_tasks t JOIN vehicles v ON v.id = t.vehicleId WHERE t.id = ? AND v.accountId = ?`,
    args: [id, user.accountId],
  })).rows.length > 0;

// Devuelve el servicio si es de la cuenta (hace falta su expenseId para
// mantener el gasto en sincronia).
async function mineService(user, id) {
  const rs = await db.execute({
    sql: `SELECT s.id, s.vehicleId, s.expenseId FROM services s JOIN vehicles v ON v.id = s.vehicleId
           WHERE s.id = ? AND v.accountId = ?`,
    args: [id, user.accountId],
  });
  const s = rs.rows[0];
  return s ? { id: Number(s.id), vehicleId: Number(s.vehicleId), expenseId: s.expenseId == null ? null : Number(s.expenseId) } : null;
}

async function checkCategory(user, v) {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const id = parseId(v);
  if (!id) return { ok: false };
  const rs = await db.execute({ sql: `SELECT 1 FROM categories WHERE id = ? AND accountId = ?`, args: [id, user.accountId] });
  return rs.rows.length ? { ok: true, value: id } : { ok: false };
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
        if (!(await mineService(me, id))) return notYours(res);
        const rs = await db.execute({ sql: `SELECT image, uploadedAt FROM service_receipts WHERE serviceId = ?`, args: [id] });
        if (!rs.rows.length) return res.status(404).json({ error: "Este servicio no tiene factura." });
        return res.status(200).json({ image: rs.rows[0].image, uploadedAt: rs.rows[0].uploadedAt });
      }
      const all = !!req.query?.all;
      const veh = await db.execute({
        sql: `${VEH_SELECT} WHERE v.accountId = ? ${all ? "" : "AND v.active = 1"} ORDER BY v.active DESC, v.id`,
        args: [me.accountId],
      });
      const tasks = await db.execute({
        sql: `SELECT t.* FROM vehicle_tasks t JOIN vehicles v ON v.id = t.vehicleId
               WHERE v.accountId = ? ORDER BY t.id`,
        args: [me.accountId],
      });
      const srv = await db.execute({
        sql: `${SRV_SELECT} JOIN vehicles v ON v.id = s.vehicleId
               WHERE v.accountId = ? ORDER BY s.day DESC, s.id DESC`,
        args: [me.accountId],
      });
      return res.status(200).json({
        today: today(),
        vehicles: veh.rows.map(rowToVehicle),
        tasks: tasks.rows.map(rowToTask),
        services: srv.rows.map(rowToService),
      });
    }

    /* ------------------------------------------------------- POST ?task=1 -- */
    if (req.method === "POST" && req.query?.task) {
      const vehicleId = parseId(body.vehicleId);
      if (!vehicleId || !(await mineVehicle(me, vehicleId))) return notYours(res);
      const name = clean(body.name, 80);
      if (!name) return res.status(400).json({ error: "Ponle un nombre a la tarea." });
      const km = parseInt0(body.everyKm), meses = parseInt0(body.everyMonths, 600);
      if (!km.ok || !meses.ok) return res.status(400).json({ error: "Los intervalos deben ser números enteros." });
      if (!km.value && !meses.value) return res.status(400).json({ error: "Indica cada cuántos kilómetros o cada cuántos meses toca." });
      const ins = await db.execute({
        sql: `INSERT INTO vehicle_tasks (vehicleId, name, everyKm, everyMonths, note, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [vehicleId, name, km.value, meses.value, clean(body.note, 300), nowIso()],
      });
      const rs = await db.execute({ sql: `SELECT * FROM vehicle_tasks WHERE id = ?`, args: [Number(ins.lastInsertRowid)] });
      return res.status(201).json({ task: rowToTask(rs.rows[0]) });
    }

    /* -------------------------------------------------------- PUT ?task= --- */
    if (req.method === "PUT" && req.query?.task) {
      const id = parseId(req.query.task);
      if (!id) return res.status(400).json({ error: "task inválido." });
      if (!(await mineTask(me, id))) return notYours(res);
      const sets = [], args = [];
      if ("name" in body) {
        const name = clean(body.name, 80);
        if (!name) return res.status(400).json({ error: "Ponle un nombre a la tarea." });
        sets.push("name = ?"); args.push(name);
      }
      if ("everyKm" in body) {
        const km = parseInt0(body.everyKm);
        if (!km.ok) return res.status(400).json({ error: "Los kilómetros deben ser un número entero." });
        sets.push("everyKm = ?"); args.push(km.value);
      }
      if ("everyMonths" in body) {
        const m = parseInt0(body.everyMonths, 600);
        if (!m.ok) return res.status(400).json({ error: "Los meses deben ser un número entero." });
        sets.push("everyMonths = ?"); args.push(m.value);
      }
      if ("note" in body) { sets.push("note = ?"); args.push(clean(body.note, 300)); }
      if ("active" in body) { sets.push("active = ?"); args.push(body.active ? 1 : 0); }
      if (!sets.length) return res.status(400).json({ error: "Nada que actualizar." });
      args.push(id);
      await db.execute({ sql: `UPDATE vehicle_tasks SET ${sets.join(", ")} WHERE id = ?`, args });
      const rs = await db.execute({ sql: `SELECT * FROM vehicle_tasks WHERE id = ?`, args: [id] });
      // Una tarea sin intervalos no sabe cuando toca: no se deja llegar a eso.
      const t = rowToTask(rs.rows[0]);
      if (!t.everyKm && !t.everyMonths) return res.status(400).json({ error: "La tarea tiene que decir cada cuántos kilómetros o meses toca." });
      return res.status(200).json({ ok: true, task: t });
    }

    /* ----------------------------------------------------- DELETE ?task= --- */
    if (req.method === "DELETE" && req.query?.task) {
      const id = parseId(req.query.task);
      if (!id) return res.status(400).json({ error: "task inválido." });
      if (!(await mineTask(me, id))) return notYours(res);
      if (req.query?.hard) {
        // Los servicios NO se borran: quedan sin tarea. Se hizo el trabajo y se
        // pago; perderlo del historial seria perder el kilometraje.
        await db.batch([
          { sql: `UPDATE services SET taskId = NULL WHERE taskId = ?`, args: [id] },
          { sql: `DELETE FROM vehicle_tasks WHERE id = ?`, args: [id] },
        ], "write");
        return res.status(200).json({ ok: true, deleted: true });
      }
      await db.execute({ sql: `UPDATE vehicle_tasks SET active = 0 WHERE id = ?`, args: [id] });
      return res.status(200).json({ ok: true });
    }

    /* ---------------------------------------------------- POST ?service=1 -- */
    if (req.method === "POST" && req.query?.service) {
      const vehicleId = parseId(body.vehicleId);
      if (!vehicleId || !(await mineVehicle(me, vehicleId))) return notYours(res);
      const day = parseDay(body.day);
      if (!day) return res.status(400).json({ error: "La fecha no es válida." });
      const title = clean(body.title, 120);
      if (!title) return res.status(400).json({ error: "Escribe qué se le hizo." });
      const cost = parseCost(body.cost);
      if (!cost.ok) return res.status(400).json({ error: "El costo no es válido." });
      const odo = parseInt0(body.odometer);
      if (!odo.ok) return res.status(400).json({ error: "El kilometraje debe ser un número entero." });
      const currency = CURRENCIES.includes(body.currency) ? body.currency : "NIO";
      const receipt = parseDataJpeg(body.receipt, MAX_RECEIPT, "La factura");
      if (!receipt.ok) return res.status(400).json({ error: receipt.error });
      let taskId = null;
      if (body.taskId) {
        taskId = parseId(body.taskId);
        if (!taskId || !(await mineTask(me, taskId))) return res.status(400).json({ error: "Esa tarea no existe." });
      }
      const cat = await checkCategory(me, body.categoryId);
      if (!cat.ok) return res.status(400).json({ error: "Esa categoría de gasto no existe." });

      const now = nowIso();
      // Si se pidio anotarlo como gasto del hogar, primero el gasto: el
      // servicio se queda con su id para que la plata figure una sola vez.
      let expenseId = null;
      if (cat.value && cost.value) {
        const ge = await db.execute({
          sql: `INSERT INTO expenses (accountId, categoryId, day, amount, currency, reason, note, hasReceipt, createdBy, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          args: [me.accountId, cat.value, day, cost.value, currency, title, clean(body.place, 120), me.id, now, now],
        });
        expenseId = Number(ge.lastInsertRowid);
      }
      const ins = await db.execute({
        sql: `INSERT INTO services (vehicleId, taskId, expenseId, day, odometer, title, cost, currency, place, note, hasReceipt, createdBy, createdAt, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [vehicleId, taskId, expenseId, day, odo.value, title, cost.value, currency,
               clean(body.place, 120), clean(body.note, 500), receipt.value ? 1 : 0, me.id, now, now],
      });
      const id = Number(ins.lastInsertRowid);
      if (receipt.value) {
        await db.execute({ sql: `INSERT INTO service_receipts (serviceId, image, uploadedAt) VALUES (?, ?, ?)`, args: [id, receipt.value, now] });
      }
      const rs = await db.execute({ sql: `${SRV_SELECT} WHERE s.id = ?`, args: [id] });
      return res.status(201).json({ service: rowToService(rs.rows[0]) });
    }

    /* ----------------------------------------------------- PUT ?service= --- */
    if (req.method === "PUT" && req.query?.service) {
      const id = parseId(req.query.service);
      if (!id) return res.status(400).json({ error: "service inválido." });
      const mio = await mineService(me, id);
      if (!mio) return notYours(res);
      const sets = [], args = [];
      if ("day" in body) {
        const day = parseDay(body.day);
        if (!day) return res.status(400).json({ error: "La fecha no es válida." });
        sets.push("day = ?"); args.push(day);
      }
      if ("title" in body) {
        const title = clean(body.title, 120);
        if (!title) return res.status(400).json({ error: "Escribe qué se le hizo." });
        sets.push("title = ?"); args.push(title);
      }
      if ("cost" in body) {
        const cost = parseCost(body.cost);
        if (!cost.ok) return res.status(400).json({ error: "El costo no es válido." });
        sets.push("cost = ?"); args.push(cost.value);
      }
      if ("odometer" in body) {
        const odo = parseInt0(body.odometer);
        if (!odo.ok) return res.status(400).json({ error: "El kilometraje debe ser un número entero." });
        sets.push("odometer = ?"); args.push(odo.value);
      }
      if ("currency" in body) {
        if (!CURRENCIES.includes(body.currency)) return res.status(400).json({ error: "Moneda inválida." });
        sets.push("currency = ?"); args.push(body.currency);
      }
      if ("taskId" in body) {
        let taskId = null;
        if (body.taskId) {
          taskId = parseId(body.taskId);
          if (!taskId || !(await mineTask(me, taskId))) return res.status(400).json({ error: "Esa tarea no existe." });
        }
        sets.push("taskId = ?"); args.push(taskId);
      }
      if ("place" in body) { sets.push("place = ?"); args.push(clean(body.place, 120)); }
      if ("note" in body) { sets.push("note = ?"); args.push(clean(body.note, 500)); }
      if ("receipt" in body) {
        const receipt = parseDataJpeg(body.receipt, MAX_RECEIPT, "La factura");
        if (!receipt.ok) return res.status(400).json({ error: receipt.error });
        if (receipt.value) {
          await db.execute({
            sql: `INSERT INTO service_receipts (serviceId, image, uploadedAt) VALUES (?, ?, ?)
                  ON CONFLICT(serviceId) DO UPDATE SET image = excluded.image, uploadedAt = excluded.uploadedAt`,
            args: [id, receipt.value, nowIso()],
          });
        } else {
          await db.execute({ sql: `DELETE FROM service_receipts WHERE serviceId = ?`, args: [id] });
        }
        sets.push("hasReceipt = ?"); args.push(receipt.value ? 1 : 0);
      }
      if (!sets.length) return res.status(400).json({ error: "Nada que actualizar." });
      sets.push("updatedAt = ?"); args.push(nowIso());
      args.push(id);
      await db.execute({ sql: `UPDATE services SET ${sets.join(", ")} WHERE id = ?`, args });

      // Si este servicio tiene un gasto en el hogar, se mueve con el: si no, la
      // plata del mes diria una cosa y el taller otra.
      if (mio.expenseId) {
        const s = (await db.execute({ sql: `SELECT day, cost, currency, title, place FROM services WHERE id = ?`, args: [id] })).rows[0];
        if (s.cost == null) {
          await db.batch([
            { sql: `DELETE FROM expenses WHERE id = ?`, args: [mio.expenseId] },
            { sql: `UPDATE services SET expenseId = NULL WHERE id = ?`, args: [id] },
          ], "write");
        } else {
          await db.execute({
            sql: `UPDATE expenses SET day = ?, amount = ?, currency = ?, reason = ?, note = ?, updatedAt = ? WHERE id = ?`,
            args: [s.day, Number(s.cost), s.currency, s.title, s.place, nowIso(), mio.expenseId],
          });
        }
      }
      const rs = await db.execute({ sql: `${SRV_SELECT} WHERE s.id = ?`, args: [id] });
      return res.status(200).json({ ok: true, service: rowToService(rs.rows[0]) });
    }

    /* -------------------------------------------------- DELETE ?service= --- */
    if (req.method === "DELETE" && req.query?.service) {
      const id = parseId(req.query.service);
      if (!id) return res.status(400).json({ error: "service inválido." });
      const mio = await mineService(me, id);
      if (!mio) return notYours(res);
      const ops = [
        { sql: `DELETE FROM service_receipts WHERE serviceId = ?`, args: [id] },
        { sql: `DELETE FROM services WHERE id = ?`, args: [id] },
      ];
      // El gasto que nacio de este servicio se va con el: no se gasto dos veces.
      if (mio.expenseId) ops.unshift({ sql: `DELETE FROM expenses WHERE id = ?`, args: [mio.expenseId] });
      await db.batch(ops, "write");
      return res.status(200).json({ ok: true });
    }

    /* --------------------------------------------------- POST (vehiculo) --- */
    if (req.method === "POST") {
      const name = clean(body.name, 80);
      if (!name) return res.status(400).json({ error: "Ponle un nombre al vehículo." });
      const kind = VEHICLE_KINDS.includes(body.kind) ? body.kind : "moto";
      const year = parseInt0(body.year, 2100);
      if (!year.ok) return res.status(400).json({ error: "El año no es válido." });
      const ins = await db.execute({
        sql: `INSERT INTO vehicles (accountId, name, kind, plate, year, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [me.accountId, name, kind, clean(body.plate, 20), year.value, clean(body.note, 300), nowIso()],
      });
      const id = Number(ins.lastInsertRowid);
      // Las tareas tipicas de ese tipo de vehiculo, para no arrancar en blanco.
      // Se pueden borrar o ajustar despues.
      const tipicas = DEFAULT_TASKS[kind] || [];
      if (tipicas.length) {
        await db.batch(tipicas.map((t) => ({
          sql: `INSERT INTO vehicle_tasks (vehicleId, name, everyKm, everyMonths, createdAt) VALUES (?, ?, ?, ?, ?)`,
          args: [id, t.name, t.everyKm, t.everyMonths, nowIso()],
        })), "write");
      }
      const rs = await db.execute({ sql: `${VEH_SELECT} WHERE v.id = ?`, args: [id] });
      const tasks = await db.execute({ sql: `SELECT * FROM vehicle_tasks WHERE vehicleId = ? ORDER BY id`, args: [id] });
      return res.status(201).json({ vehicle: rowToVehicle(rs.rows[0]), tasks: tasks.rows.map(rowToTask) });
    }

    /* ---------------------------------------------------- PUT (vehiculo) --- */
    if (req.method === "PUT") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (!(await mineVehicle(me, id))) return notYours(res);
      const sets = [], args = [];
      if ("name" in body) {
        const name = clean(body.name, 80);
        if (!name) return res.status(400).json({ error: "Ponle un nombre al vehículo." });
        sets.push("name = ?"); args.push(name);
      }
      if ("kind" in body && VEHICLE_KINDS.includes(body.kind)) { sets.push("kind = ?"); args.push(body.kind); }
      if ("plate" in body) { sets.push("plate = ?"); args.push(clean(body.plate, 20)); }
      if ("year" in body) {
        const year = parseInt0(body.year, 2100);
        if (!year.ok) return res.status(400).json({ error: "El año no es válido." });
        sets.push("year = ?"); args.push(year.value);
      }
      if ("note" in body) { sets.push("note = ?"); args.push(clean(body.note, 300)); }
      if ("active" in body) { sets.push("active = ?"); args.push(body.active ? 1 : 0); }
      if (!sets.length) return res.status(400).json({ error: "Nada que actualizar." });
      args.push(id);
      await db.execute({ sql: `UPDATE vehicles SET ${sets.join(", ")} WHERE id = ?`, args });
      const rs = await db.execute({ sql: `${VEH_SELECT} WHERE v.id = ?`, args: [id] });
      return res.status(200).json({ ok: true, vehicle: rowToVehicle(rs.rows[0]) });
    }

    /* ------------------------------------------------- DELETE (vehiculo) --- */
    if (req.method === "DELETE") {
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (!(await mineVehicle(me, id))) return notYours(res);
      if (req.query?.hard) {
        await db.batch([
          // Los gastos del hogar que nacieron de sus servicios tambien se van.
          { sql: `DELETE FROM expenses WHERE id IN (SELECT expenseId FROM services WHERE vehicleId = ? AND expenseId IS NOT NULL)`, args: [id] },
          { sql: `DELETE FROM service_receipts WHERE serviceId IN (SELECT id FROM services WHERE vehicleId = ?)`, args: [id] },
          { sql: `DELETE FROM services WHERE vehicleId = ?`, args: [id] },
          { sql: `DELETE FROM vehicle_tasks WHERE vehicleId = ?`, args: [id] },
          { sql: `DELETE FROM vehicles WHERE id = ?`, args: [id] },
        ], "write");
        return res.status(200).json({ ok: true, deleted: true });
      }
      await db.execute({ sql: `UPDATE vehicles SET active = 0 WHERE id = ?`, args: [id] });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
