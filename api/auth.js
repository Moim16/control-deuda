// =============================================================================
//  Usuarios de la app.
//
//  POST   /api/auth                  { name, password }  -> login. Devuelve { user, token }.
//  POST   /api/auth?signup=1         { name, password, fullName, email } -> PIDE el
//                                    codigo: valida los datos, manda un codigo de 6
//                                    digitos al correo y NO crea nada todavia.
//                                    Responde { pending:true, email }.
//                                    Sin correo configurado crea la cuenta de una
//                                    (responde igual que ?verify=1).
//                                    Se puede cerrar con ALLOW_SIGNUP=0.
//  POST   /api/auth?verify=1         { email, code } -> confirma el codigo y CREA la
//                                    cuenta con su dueño. Devuelve { user, account,
//                                    token, recovery }.
//  POST   /api/auth?new=1            { name, password, fullName, role, debtIds }
//                                    -> el admin crea un usuario DE SU CUENTA.
//  POST   /api/auth?recover=1        { name, code, password } -> entrar con el
//                                    CODIGO DE RECUPERACION y poner contraseña
//                                    nueva. Devuelve sesion y un codigo nuevo.
//  PUT    /api/auth?recovery=1       { currentPassword } -> genera (o renueva) MI
//                                    codigo de recuperacion. Se enseña una sola vez.
//  GET    /api/auth                  -> { me, account, recovery, users? } (users solo si admin).
//  PUT    /api/auth?account=1        { name } -> el admin renombra su cuenta.
//  PUT    /api/auth?id=              { fullName, role, active, password, debtIds }
//                                    -> admin edita un usuario de su cuenta.
//                                    Sin ser admin solo puedes cambiar TU contraseña
//                                    mandando { currentPassword, password }.
//  DELETE /api/auth?id=              -> admin desactiva el usuario (no borra historial).
//
//  Cada cuenta es un espacio aislado: un admin nunca ve usuarios ni deudas de
//  otra cuenta. Dentro de la cuenta, al 'viewer' se le asignan deudas (debtIds);
//  sin asignaciones no ve ninguna. El viewer nunca escribe nada salvo comentarios.
//
//  Anti fuerza bruta: 5 fallos -> cuenta bloqueada 15 minutos. El codigo de
//  recuperacion usa el MISMO contador que la contraseña.
//
//  CODIGO DE RECUPERACION. Sin correo configurado, la unica forma de volver a
//  entrar si el dueño pierde su contraseña es un codigo guardado aparte, como los
//  codigos de respaldo de cualquier app con doble factor. Se genera al crear la
//  cuenta, se enseña UNA sola vez y se guarda hasheado. Es de un solo uso, y al
//  usarlo se entrega uno nuevo.
// =============================================================================

import { db, ensureSchema, nowIso, newRecoveryCode, normalizeRecovery } from "../lib/db.js";
import { readJson, clean, parseId } from "../lib/http.js";
import { mailListo, emailValido, limpiaEmail, enviarCodigo, nuevoCodigo } from "../lib/mail.js";
import {
  hashPassword, verifyPassword, newToken,
  currentUser, isAdmin, deny, notYours,
} from "../lib/auth.js";

// Crea la cuenta y su dueño, y responde con la sesion abierta. La usan los dos
// caminos del registro: con el correo confirmado y sin correo configurado, que
// hacen lo mismo una vez que se sabe que los datos son buenos.
async function crearCuenta(res, { name, pw, passwordHash, fullName, email }) {
  const now = nowIso();
  const acc = await db.execute({
    sql: `INSERT INTO accounts (name, createdAt) VALUES (?, ?)`,
    args: [`Deudas de ${fullName || name}`, now],
  });
  const accountId = Number(acc.lastInsertRowid);
  const token = newToken();
  // El dueño es el unico usuario al que nadie mas puede rescatar: se le entrega
  // su codigo aqui mismo, con la cuenta recien creada.
  const code = newRecoveryCode();
  const ins = await db.execute({
    sql: `INSERT INTO users (accountId, name, fullName, email, role, passwordHash, sessionToken, createdAt, recoveryHash, recoveryAt)
          VALUES (?, ?, ?, ?, 'admin', ?, ?, ?, ?, ?)`,
    args: [accountId, name, fullName, email, passwordHash || hashPassword(pw), token, now,
           hashPassword(normalizeRecovery(code)), now],
  });
  return res.status(201).json({
    user: { id: Number(ins.lastInsertRowid), name, fullName, role: "admin", active: 1, accountId },
    account: { id: accountId, name: `Deudas de ${fullName || name}` },
    token, created: true, recovery: code,
  });
}

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const NAME_RE = /^[\p{L}\p{N}._-]{2,20}$/u;
const SIGNUP_OPEN = process.env.ALLOW_SIGNUP !== "0";   // cerrar con ALLOW_SIGNUP=0

const publicUser = (u) => ({
  id: Number(u.id), name: u.name, fullName: u.fullName,
  role: u.role, active: Number(u.active ?? 1),
  accountId: Number(u.accountId),
});

const roleOf = (v) => (v === "admin" ? "admin" : "viewer");

async function accountOf(id) {
  const rs = await db.execute({ sql: `SELECT id, name FROM accounts WHERE id = ?`, args: [id] });
  return rs.rows[0] ? { id: Number(rs.rows[0].id), name: rs.rows[0].name } : null;
}

// Deja a `userId` con EXACTAMENTE las deudas indicadas, y solo las de esa cuenta
// (asi un admin no puede asignar la deuda de otra cuenta aunque mande su id).
async function setUserDebts(userId, debtIds, accountId) {
  await db.execute({ sql: `DELETE FROM debt_users WHERE userId = ?`, args: [userId] });
  const ids = [...new Set((debtIds || []).map(parseId).filter(Boolean))];
  if (!ids.length) return;
  const rs = await db.execute({
    sql: `SELECT id FROM debts WHERE accountId = ? AND id IN (${ids.map(() => "?").join(",")})`,
    args: [accountId, ...ids],
  });
  if (!rs.rows.length) return;
  await db.batch(rs.rows.map((r) => ({
    sql: `INSERT OR IGNORE INTO debt_users (debtId, userId) VALUES (?, ?)`,
    args: [Number(r.id), userId],
  })), "write");
}

// Un fallo mas de login (o de codigo); bloquea al llegar al tope.
async function registerFail(u) {
  const fails = Number(u.failedLogins || 0) + 1;
  const locked = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MS).toISOString() : null;
  await db.execute({ sql: `UPDATE users SET failedLogins = ?, lockedUntil = ? WHERE id = ?`, args: [fails, locked, u.id] });
}

const isLocked = (u) => u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now();

const badPassword = (pw) => pw.length < 6 || pw.length > 64;
const PW_MSG = "La contraseña debe tener entre 6 y 64 caracteres.";
const NAME_MSG = "Usuario de 2 a 20 caracteres, sin espacios (letras, números, . _ -).";

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);

    /* ------------------------------------------------------------------ GET */
    if (req.method === "GET") {
      const me = await currentUser(req, body);
      if (!me) return deny(res);
      const account = await accountOf(me.accountId);
      // Si tengo codigo de recuperacion o no; nunca el codigo, que se enseña una
      // sola vez al generarlo.
      const mio = await db.execute({ sql: `SELECT recoveryAt FROM users WHERE id = ?`, args: [me.id] });
      const recovery = { has: !!mio.rows[0]?.recoveryAt, at: mio.rows[0]?.recoveryAt || null };
      if (!isAdmin(me)) return res.status(200).json({ me, account, recovery });

      // Solo los usuarios de MI cuenta, cada uno con las deudas que tiene asignadas.
      const rs = await db.execute({
        sql: `SELECT id, name, fullName, role, active, accountId, createdAt
                FROM users WHERE accountId = ? ORDER BY name COLLATE NOCASE`,
        args: [me.accountId],
      });
      const asign = await db.execute({
        sql: `SELECT du.userId, du.debtId FROM debt_users du
                JOIN users u ON u.id = du.userId WHERE u.accountId = ?`,
        args: [me.accountId],
      });
      const porUsuario = new Map();
      for (const a of asign.rows) {
        const k = Number(a.userId);
        if (!porUsuario.has(k)) porUsuario.set(k, []);
        porUsuario.get(k).push(Number(a.debtId));
      }
      return res.status(200).json({
        me, account, recovery,
        users: rs.rows.map((u) => ({ ...publicUser(u), debtIds: porUsuario.get(Number(u.id)) || [] })),
      });
    }

    /* -------------------------------------------------- POST ?signup=1 ----- */
    if (req.method === "POST" && req.query?.signup) {
      // Con la base vacia SIEMPRE se deja crear la primera cuenta: si no, un
      // despliegue con ALLOW_SIGNUP=0 se quedaria sin ninguna forma de entrar.
      const totalUsers = Number((await db.execute(`SELECT COUNT(*) c FROM users`)).rows[0].c);
      if (!SIGNUP_OPEN && totalUsers > 0) {
        return res.status(403).json({ error: "El registro está cerrado." });
      }
      const name = (body.name ?? "").toString().trim();
      const pw = (body.password ?? "").toString();
      const fullName = clean(body.fullName, 80);
      const email = limpiaEmail(body.email);
      if (!NAME_RE.test(name)) return res.status(400).json({ error: NAME_MSG });
      if (badPassword(pw)) return res.status(400).json({ error: PW_MSG });
      const dup = await db.execute({ sql: `SELECT 1 FROM users WHERE name = ? COLLATE NOCASE`, args: [name] });
      if (dup.rows.length) return res.status(409).json({ error: "Ese usuario ya existe. Elige otro." });

      // Sin correo configurado se crea la cuenta de una, como antes: pedir un
      // codigo que no se puede enviar dejaria la app sin forma de arrancar.
      if (!mailListo()) return crearCuenta(res, { name, pw, fullName, email: null });

      if (!emailValido(email)) return res.status(400).json({ error: "Escribe un correo válido." });
      const dupMail = await db.execute({
        sql: `SELECT 1 FROM users WHERE email = ? COLLATE NOCASE`, args: [email],
      });
      if (dupMail.rows.length) {
        return res.status(409).json({ error: "Ya hay una cuenta con ese correo." });
      }

      const code = nuevoCodigo();
      const ahora = nowIso();
      // 15 minutos: suficiente para ir al correo y volver, y poco para que un
      // codigo que se filtre no sirva mañana.
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await db.execute({
        sql: `INSERT INTO signups (email, name, fullName, passwordHash, codeHash, tries, expiresAt, createdAt)
              VALUES (?, ?, ?, ?, ?, 0, ?, ?)
              ON CONFLICT(email) DO UPDATE SET
                name = excluded.name, fullName = excluded.fullName,
                passwordHash = excluded.passwordHash, codeHash = excluded.codeHash,
                tries = 0, expiresAt = excluded.expiresAt`,
        args: [email, name, fullName, hashPassword(pw), hashPassword(code), expiresAt, ahora],
      });

      const enviado = await enviarCodigo(email, code);
      if (!enviado.ok) {
        // Si no salio el correo, el registro pendiente no sirve para nada: se
        // borra para no dejar un usuario reservado por un correo que no llego.
        await db.execute({ sql: `DELETE FROM signups WHERE email = ?`, args: [email] });
        return res.status(502).json({ error: enviado.error });
      }
      return res.status(200).json({ pending: true, email });
    }

    /* -------------------------------------------------------- POST ?verify=1 */
    if (req.method === "POST" && req.query?.verify) {
      const email = limpiaEmail(body.email);
      const code = (body.code ?? "").toString().replace(/[^0-9]/g, "");
      const rs = await db.execute({ sql: `SELECT * FROM signups WHERE email = ?`, args: [email] });
      const p = rs.rows[0];
      if (!p) return res.status(404).json({ error: "No hay ningún registro para ese correo. Empieza de nuevo." });

      if (p.expiresAt < nowIso()) {
        await db.execute({ sql: `DELETE FROM signups WHERE email = ?`, args: [email] });
        return res.status(410).json({ error: "El código venció. Pide uno nuevo." });
      }
      // Cinco intentos y se tira el registro: es el mismo tope que la
      // contraseña, y sin el, seis digitos se prueban a mano.
      if (Number(p.tries) >= MAX_FAILS) {
        await db.execute({ sql: `DELETE FROM signups WHERE email = ?`, args: [email] });
        return res.status(429).json({ error: "Demasiados intentos. Pide un código nuevo." });
      }
      if (!verifyPassword(code, p.codeHash)) {
        await db.execute({ sql: `UPDATE signups SET tries = tries + 1 WHERE email = ?`, args: [email] });
        return res.status(401).json({ error: "El código no es correcto." });
      }

      // Entre pedir el codigo y confirmarlo alguien pudo tomar el usuario.
      const dup = await db.execute({ sql: `SELECT 1 FROM users WHERE name = ? COLLATE NOCASE`, args: [p.name] });
      if (dup.rows.length) {
        await db.execute({ sql: `DELETE FROM signups WHERE email = ?`, args: [email] });
        return res.status(409).json({ error: "Ese usuario ya existe. Empieza de nuevo con otro." });
      }

      await db.execute({ sql: `DELETE FROM signups WHERE email = ?`, args: [email] });
      return crearCuenta(res, {
        name: p.name, fullName: p.fullName, email,
        passwordHash: p.passwordHash,
      });
    }

    /* ----------------------------------------------------------- POST ?new=1 */
    if (req.method === "POST" && req.query?.new) {
      const me = await currentUser(req, body);
      if (!me) return deny(res);
      if (!isAdmin(me)) return deny(res, true);

      const name = (body.name ?? "").toString().trim();
      const pw = (body.password ?? "").toString();
      const role = roleOf(body.role);
      if (!NAME_RE.test(name)) return res.status(400).json({ error: NAME_MSG });
      if (badPassword(pw)) return res.status(400).json({ error: PW_MSG });
      const dup = await db.execute({ sql: `SELECT 1 FROM users WHERE name = ? COLLATE NOCASE`, args: [name] });
      if (dup.rows.length) return res.status(409).json({ error: "Ese usuario ya existe." });

      const ins = await db.execute({
        sql: `INSERT INTO users (accountId, name, fullName, role, passwordHash, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [me.accountId, name, clean(body.fullName, 80), role, hashPassword(pw), nowIso()],
      });
      const newId = Number(ins.lastInsertRowid);
      if ("debtIds" in body) await setUserDebts(newId, body.debtIds, me.accountId);
      return res.status(201).json({
        user: { id: newId, name, fullName: clean(body.fullName, 80), role, active: 1, accountId: me.accountId },
      });
    }

    /* ------------------------------------------------- POST ?recover=1 ----- */
    if (req.method === "POST" && req.query?.recover) {
      const name = (body.name ?? "").toString().trim();
      const code = normalizeRecovery(body.code);
      const pw = (body.password ?? "").toString();
      if (badPassword(pw)) return res.status(400).json({ error: PW_MSG });
      const found = await db.execute({
        sql: `SELECT id, name, fullName, role, active, accountId, recoveryHash, failedLogins, lockedUntil
                FROM users WHERE name = ? COLLATE NOCASE`,
        args: [name],
      });
      const u = found.rows[0];
      // El mismo texto exista o no el usuario: por aqui tampoco se averigua
      // quien tiene cuenta.
      const malo = () => res.status(401).json({ error: "Usuario o código incorrectos." });
      if (!u) return malo();
      if (!Number(u.active)) return res.status(403).json({ error: "Tu usuario está desactivado." });
      if (isLocked(u)) return res.status(429).json({ error: "Demasiados intentos. Espera unos minutos e intenta de nuevo." });
      if (!u.recoveryHash || !verifyPassword(code, u.recoveryHash)) {
        await registerFail(u);
        return malo();
      }

      // El codigo es de UN SOLO USO. Se entrega otro en el acto.
      const nuevo = newRecoveryCode();
      const token = newToken();
      await db.execute({
        sql: `UPDATE users SET passwordHash = ?, sessionToken = ?, failedLogins = 0, lockedUntil = NULL,
                     recoveryHash = ?, recoveryAt = ?
               WHERE id = ?`,
        args: [hashPassword(pw), token, hashPassword(normalizeRecovery(nuevo)), nowIso(), u.id],
      });
      return res.status(200).json({
        user: publicUser(u), account: await accountOf(u.accountId), token, recovery: nuevo,
      });
    }

    /* ---------------------------------------------------------- POST (login) */
    if (req.method === "POST") {
      const name = (body.name ?? "").toString().trim();
      const pw = (body.password ?? "").toString();
      if (!NAME_RE.test(name) || pw.length < 6) {
        return res.status(400).json({ error: "Usuario o contraseña inválidos." });
      }
      const found = await db.execute({
        sql: `SELECT id, name, fullName, role, active, accountId, passwordHash, failedLogins, lockedUntil
                FROM users WHERE name = ? COLLATE NOCASE`,
        args: [name],
      });
      if (!found.rows.length) return res.status(401).json({ error: "Usuario o contraseña incorrectos." });

      const u = found.rows[0];
      if (!Number(u.active)) return res.status(403).json({ error: "Tu usuario está desactivado." });
      if (isLocked(u)) return res.status(429).json({ error: "Demasiados intentos. Espera unos minutos e intenta de nuevo." });
      if (!verifyPassword(pw, u.passwordHash)) {
        await registerFail(u);
        return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
      }
      const token = newToken();
      await db.execute({
        sql: `UPDATE users SET sessionToken = ?, failedLogins = 0, lockedUntil = NULL WHERE id = ?`,
        args: [token, u.id],
      });
      return res.status(200).json({ user: publicUser(u), account: await accountOf(u.accountId), token });
    }

    /* ----------------------------------------------------- PUT ?recovery=1 */
    if (req.method === "PUT" && req.query?.recovery) {
      const me = await currentUser(req, body);
      if (!me) return deny(res);
      // Se pide la contraseña actual: con el telefono desbloqueado en la mano,
      // sacar un codigo nuevo seria quedarse con la cuenta para siempre.
      const rs = await db.execute({ sql: `SELECT passwordHash FROM users WHERE id = ?`, args: [me.id] });
      if (!verifyPassword((body.currentPassword ?? "").toString(), rs.rows[0]?.passwordHash)) {
        return res.status(401).json({ error: "La contraseña actual no coincide." });
      }
      // Generar uno nuevo INVALIDA el anterior.
      const code = newRecoveryCode();
      await db.execute({
        sql: `UPDATE users SET recoveryHash = ?, recoveryAt = ? WHERE id = ?`,
        args: [hashPassword(normalizeRecovery(code)), nowIso(), me.id],
      });
      return res.status(200).json({ ok: true, recovery: code });
    }

    /* ---------------------------------------------- PUT nombre de la cuenta */
    if (req.method === "PUT" && req.query?.account) {
      const me = await currentUser(req, body);
      if (!me) return deny(res);
      if (!isAdmin(me)) return deny(res, true);
      const name = clean(body.name, 80);
      if (!name) return res.status(400).json({ error: "El nombre es obligatorio." });
      await db.execute({ sql: `UPDATE accounts SET name = ? WHERE id = ?`, args: [name, me.accountId] });
      return res.status(200).json({ ok: true, account: await accountOf(me.accountId) });
    }

    /* ------------------------------------------------------------------ PUT */
    if (req.method === "PUT") {
      const me = await currentUser(req, body);
      if (!me) return deny(res);
      const id = parseId(req.query?.id) ?? me.id;

      // Un admin solo puede tocar usuarios de SU cuenta.
      if (isAdmin(me) && id !== me.id) {
        const t = await db.execute({ sql: `SELECT accountId FROM users WHERE id = ?`, args: [id] });
        if (!t.rows.length || Number(t.rows[0].accountId) !== me.accountId) return notYours(res);
      }

      // Cambio de contraseña propia (viewer, o admin sobre si mismo con
      // currentPassword): exige la contraseña actual.
      if (!isAdmin(me) || (id === me.id && "currentPassword" in body)) {
        if (id !== me.id) return deny(res, true);
        const pw = (body.password ?? "").toString();
        if (badPassword(pw)) return res.status(400).json({ error: PW_MSG });
        const rs = await db.execute({ sql: `SELECT passwordHash FROM users WHERE id = ?`, args: [id] });
        if (!verifyPassword((body.currentPassword ?? "").toString(), rs.rows[0]?.passwordHash)) {
          return res.status(401).json({ error: "La contraseña actual no coincide." });
        }
        // Cambiar la contraseña cierra las demas sesiones (token nuevo).
        const token = newToken();
        await db.execute({ sql: `UPDATE users SET passwordHash = ?, sessionToken = ? WHERE id = ?`, args: [hashPassword(pw), token, id] });
        return res.status(200).json({ ok: true, token });
      }

      // Admin: edita datos, rol, estado y puede resetear la contraseña.
      const sets = [], args = [];
      if ("fullName" in body) { sets.push("fullName = ?"); args.push(clean(body.fullName, 80)); }
      if ("role" in body) { sets.push("role = ?"); args.push(roleOf(body.role)); }
      if ("active" in body) { sets.push("active = ?"); args.push(body.active ? 1 : 0); }
      if (body.password) {
        const pw = String(body.password);
        if (badPassword(pw)) return res.status(400).json({ error: PW_MSG });
        // Reset de contraseña -> se invalida la sesion del usuario afectado.
        sets.push("passwordHash = ?", "sessionToken = NULL", "failedLogins = 0", "lockedUntil = NULL");
        args.push(hashPassword(pw));
      }
      // Reasignacion de deudas: puede venir sola, sin ningun otro cambio.
      if ("debtIds" in body) await setUserDebts(id, body.debtIds, me.accountId);
      if (!sets.length) return res.status(200).json({ ok: true });

      // La CUENTA no puede quedarse sin ningun admin activo.
      if (id === me.id && (body.role === "viewer" || body.active === false || body.active === 0)) {
        const others = Number((await db.execute({
          sql: `SELECT COUNT(*) c FROM users WHERE role = 'admin' AND active = 1 AND accountId = ? AND id <> ?`,
          args: [me.accountId, id],
        })).rows[0].c);
        if (!others) return res.status(400).json({ error: "Debe quedar al menos un administrador activo." });
      }

      args.push(id);
      const upd = await db.execute({ sql: `UPDATE users SET ${sets.join(", ")} WHERE id = ?`, args });
      if (!upd.rowsAffected) return res.status(404).json({ error: "Usuario no encontrado." });
      return res.status(200).json({ ok: true });
    }

    /* --------------------------------------------------------------- DELETE */
    if (req.method === "DELETE") {
      const me = await currentUser(req, {});
      if (!me) return deny(res);
      if (!isAdmin(me)) return deny(res, true);
      const id = parseId(req.query?.id);
      if (!id) return res.status(400).json({ error: "id inválido." });
      if (id === me.id) return res.status(400).json({ error: "No puedes desactivar tu propio usuario." });
      const t = await db.execute({ sql: `SELECT accountId FROM users WHERE id = ?`, args: [id] });
      if (!t.rows.length || Number(t.rows[0].accountId) !== me.accountId) return notYours(res);
      // Desactivar, no borrar: sus comentarios siguen teniendo autor.
      const upd = await db.execute({ sql: `UPDATE users SET active = 0, sessionToken = NULL WHERE id = ?`, args: [id] });
      if (!upd.rowsAffected) return res.status(404).json({ error: "Usuario no encontrado." });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return res.status(405).json({ error: "Método no permitido" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
