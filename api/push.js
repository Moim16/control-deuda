// =============================================================================
//  Avisos del navegador (Web Push).
//
//  GET    /api/push              -> { enabled, publicKey } para suscribirse.
//  POST   /api/push              { subscription } -> guarda este dispositivo.
//  DELETE /api/push              { endpoint } -> lo quita.
//  GET    /api/push?cron=1&token= -> el MOTOR: mira que hay que avisar y envia.
//
//  El motor va aqui y no en su propio archivo porque el plan Hobby de Vercel
//  deja 12 funciones; una ruta con `?cron=1` no cuesta ninguna.
//
//  Serverless no tiene proceso de fondo, asi que un cron EXTERNO y gratis
//  (cron-job.org) pega a esa ruta. Cada cuanto:
//    - cada pocos minutos, si se quieren los comentarios al instante;
//    - una vez al dia basta para los pagos, que salen una sola vez al dia por
//      diseño (ver `claveAviso`).
//
//  Sin VAPID configurado no hace nada y lo dice, en vez de fallar: asi un
//  despliegue sin las llaves sigue funcionando, solo que sin avisos.
//
//  Web Push a proposito, no Firebase: no hace falta cuenta de Google ni SDK,
//  y funciona en la PWA instalada. La app nativa no usa esto — se programa sus
//  recordatorios ella misma, porque las fechas ya las sabe.
// =============================================================================

import webpush from "web-push";
import { db, ensureSchema, nowIso } from "../lib/db.js";
import { today } from "../lib/day.js";
import { readJson } from "../lib/http.js";
import { currentUser, deny } from "../lib/auth.js";
import { DEBT_SELECT, rowToDebt } from "./debts.js";
import {
  proximoPago, textoPago, textoComentario, claveAviso, DIAS_ANTES,
} from "../lib/avisos.js";

// Configura VAPID una vez por instancia. Devuelve false si faltan las llaves.
function vapidListo() {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:avisos@control-deuda.app", pub, priv);
  return true;
}

/* ------------------------------------------------------------------ envio -- */

// Manda un aviso a todos los dispositivos de estos usuarios y limpia los
// muertos. Devuelve cuantos salieron.
async function enviar(userIds, { title, body, url = "/" }) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return 0;

  const rs = await db.execute({
    sql: `SELECT endpoint, data FROM push_subs WHERE userId IN (${ids.map(() => "?").join(",")})`,
    args: ids,
  });
  if (!rs.rows.length) return 0;

  const payload = JSON.stringify({ title, body, url, tag: url });
  let enviados = 0;
  const muertos = [];

  await Promise.all(rs.rows.map(async (s) => {
    try {
      await webpush.sendNotification(JSON.parse(s.data), payload);
      enviados++;
    } catch (err) {
      // 404/410 = la suscripcion caduco o la revocaron: a limpiar.
      if (err.statusCode === 404 || err.statusCode === 410) muertos.push(s.endpoint);
    }
  }));

  for (const ep of muertos) {
    await db.execute({ sql: `DELETE FROM push_subs WHERE endpoint = ?`, args: [ep] });
  }
  return enviados;
}

// True si este aviso todavia no ha salido; lo marca de una vez. Es lo que evita
// repetir el mismo recordatorio en cada tick del cron.
async function marcarSiEsNuevo(clave) {
  try {
    await db.execute({
      sql: `INSERT INTO push_state (k, v, at) VALUES (?, '1', ?)`,
      args: [clave, nowIso()],
    });
    return true;
  } catch {
    // La clave ya estaba: ya se aviso.
    return false;
  }
}

async function leerCursor(k) {
  const rs = await db.execute({ sql: `SELECT v FROM push_state WHERE k = ?`, args: [k] });
  return rs.rows.length ? Number(rs.rows[0].v) || 0 : 0;
}

async function guardarCursor(k, v) {
  await db.execute({
    sql: `INSERT INTO push_state (k, v, at) VALUES (?, ?, ?)
          ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at`,
    args: [k, String(v), nowIso()],
  });
}

/* ------------------------------------------------------------------ motor -- */

// Quien ve una deuda: su dueño (admin de la cuenta) y los usuarios asignados.
async function quienVe(debtId, accountId) {
  const rs = await db.execute({
    sql: `SELECT id, role FROM users WHERE active = 1 AND accountId = ? AND (
            role = 'admin' OR id IN (SELECT userId FROM debt_users WHERE debtId = ?))`,
    args: [accountId, debtId],
  });
  return rs.rows.map((r) => ({ id: Number(r.id), admin: r.role === "admin" }));
}

async function motor() {
  const hoy = today();
  let avisos = 0, enviados = 0;

  /* --- comentarios: lo unico que no se sabe por adelantado --- */
  const cursor = await leerCursor("cursor:comments");
  const nuevos = await db.execute({
    sql: `SELECT c.id, c.debtId, c.userId, c.text, u.name AS userName, d.name AS debtName,
                 d.accountId
            FROM comments c
            JOIN users u ON u.id = c.userId
            JOIN debts d ON d.id = c.debtId
           WHERE c.id > ? ORDER BY c.id LIMIT 50`,
    args: [cursor],
  });

  for (const c of nuevos.rows) {
    const gente = await quienVe(Number(c.debtId), Number(c.accountId));
    // A quien lo escribio no se le avisa de lo que acaba de escribir.
    const destino = gente.filter((g) => g.id !== Number(c.userId)).map((g) => g.id);
    if (destino.length) {
      const t = textoComentario({
        userName: c.userName, debtName: c.debtName, text: String(c.text),
      });
      enviados += await enviar(destino, { ...t, url: `/?debt=${c.debtId}` });
      avisos++;
    }
  }
  if (nuevos.rows.length) {
    await guardarCursor("cursor:comments", nuevos.rows[nuevos.rows.length - 1].id);
  }

  /* --- pagos acordados --- */
  const deudas = await db.execute({
    sql: `${DEBT_SELECT} WHERE d.active = 1 AND d.dueEvery IS NOT NULL`,
    args: [],
  });

  for (const row of deudas.rows) {
    const d = rowToDebt(row);
    const due = proximoPago({ ...d, active: 1 }, hoy);
    if (!due) continue;

    // Solo tres momentos: unos dias antes, el mismo dia, o ya pasado. Un aviso
    // cada dia desde que falta un mes seria ruido y se acabaria silenciando.
    const cuando = due.vencido ? "atraso" : due.dias === 0 ? "hoy" : due.dias === DIAS_ANTES ? "antes" : null;
    if (!cuando) continue;
    if (!(await marcarSiEsNuevo(claveAviso(`pago-${cuando}`, d.id, hoy)))) continue;

    const gente = await quienVe(d.id, Number(row.accountId));
    // La misma deuda se cuenta al reves segun quien mire: el dueño de un cobro
    // recibe la plata; a un viewer, la deuda que le compartieron le suena a que
    // se la deben a el.
    const esCobro = (g) => (g.admin ? d.direction === "owed" : d.direction !== "owed");
    for (const g of gente) {
      const t = textoPago(d, due, esCobro(g));
      enviados += await enviar([g.id], { ...t, url: `/?debt=${d.id}` });
    }
    avisos++;
  }

  return { avisos, enviados };
}

/* ---------------------------------------------------------------- handler -- */

export default async function handler(req, res) {
  try {
    await ensureSchema();

    // --- el motor, que llama el cron externo ---
    if (req.query?.cron) {
      const secret = process.env.CRON_SECRET;
      const dado = req.headers["x-cron-secret"] || req.query?.token;
      if (secret && dado !== secret) return res.status(401).json({ error: "no autorizado" });
      if (!vapidListo()) return res.status(200).json({ ok: false, reason: "VAPID no configurado" });

      const r = await motor();
      return res.status(200).json({ ok: true, ...r });
    }

    // --- la configuracion, para que el navegador pueda suscribirse ---
    if (req.method === "GET") {
      const publicKey = process.env.VAPID_PUBLIC_KEY || "";
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.status(200).json({ enabled: Boolean(publicKey), publicKey });
    }

    // Suscribirse y desuscribirse son cosas de un usuario concreto: hay que
    // saber a quien avisar.
    const body = req.method === "DELETE" ? await readJson(req) : await readJson(req);
    const me = await currentUser(req, body);
    if (!me) return deny(res);

    if (req.method === "POST") {
      const sub = body.subscription || body;
      if (!sub?.endpoint || !sub?.keys) {
        return res.status(400).json({ error: "Suscripción inválida." });
      }
      await db.execute({
        sql: `INSERT INTO push_subs (endpoint, data, userId, accountId, createdAt)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(endpoint) DO UPDATE SET
                data = excluded.data, userId = excluded.userId, accountId = excluded.accountId`,
        args: [sub.endpoint, JSON.stringify(sub), me.id, me.accountId, nowIso()],
      });
      return res.status(201).json({ ok: true });
    }

    if (req.method === "DELETE") {
      const endpoint = body.endpoint || body.subscription?.endpoint;
      if (endpoint) {
        // Solo el dueño del dispositivo puede quitarlo.
        await db.execute({
          sql: `DELETE FROM push_subs WHERE endpoint = ? AND userId = ?`,
          args: [endpoint, me.id],
        });
      }
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
