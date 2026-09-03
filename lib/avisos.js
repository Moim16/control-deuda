// =============================================================================
//  Que hay que avisar y a quien.
//
//  Las reglas viven aqui, separadas del envio, para poder probarlas sin mandar
//  un push de verdad. Son las MISMAS que usa la app nativa para sus
//  recordatorios locales (`domain/avisos.dart`), asi que si un dia se cambia el
//  criterio hay que cambiarlo en los dos.
//
//  Tres clases de aviso:
//    - el pago acordado que se acerca o que ya se paso;
//    - la tarea del vehiculo que ya toca POR FECHA (lo de por kilometros no
//      tiene dia al que avisar: depende de cuanto se ande);
//    - el comentario que escribio otra persona, que es lo unico que no se puede
//      saber por adelantado y lo unico que justifica el push.
// =============================================================================

import { today } from "./day.js";

// Cuantos dias antes se avisa de un pago. Tres: da tiempo a mover la plata, y
// no tan pronto como para olvidarlo otra vez.
export const DIAS_ANTES = 3;

const toDate = (day) => { const [y, m, d] = day.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const ymd = (dt) => dt.toISOString().slice(0, 10);
export const shiftDays = (day, n) => { const d = toDate(day); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);

// Sumar meses respetando el fin de mes: el 31 mas un mes cae en el ultimo dia
// de febrero, no en el 3 de marzo.
export function shiftMonths(day, n) {
  const d = toDate(day);
  const destino = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const ultimo = new Date(Date.UTC(destino.getUTCFullYear(), destino.getUTCMonth() + 1, 0)).getUTCDate();
  return ymd(new Date(Date.UTC(destino.getUTCFullYear(), destino.getUTCMonth(), Math.min(d.getUTCDate(), ultimo))));
}

/* --------------------------------------------------------------- el pago ---
   El proximo pago esperado de una deuda con acuerdo, o null si no hay nada que
   recordar.

   La regla: se avanza por las fechas del acuerdo hasta pasar el ULTIMO PAGO
   recibido; si nunca pago, se queda en la primera. Asi quien va al dia ve la
   fecha que viene, y quien debe tres meses ve la que dejo de pagar — y no un
   "toca en 12 dias" que no dice nada.
-------------------------------------------------------------------------- */
export function proximoPago(debt, hoy = today()) {
  if (!debt.dueEvery || !debt.dueAmount || !debt.dueFrom) return null;
  if (!Number(debt.active)) return null;

  // Sin saldo no hay nada que reclamar.
  const pendiente = Object.values(debt.totals || {}).reduce((a, t) => a + Math.max(0, t.balance), 0);
  if (pendiente <= 0) return null;

  const ultimoPago = debt.lastPaymentDay || null;
  let day = debt.dueFrom;
  if (ultimoPago && ultimoPago >= debt.dueFrom) {
    // El tope de 600 vueltas es para que un acuerdo semanal viejisimo no deje
    // el cron dando vueltas: son mas de once años de pagos semanales.
    for (let i = 1; i < 600 && day <= ultimoPago; i++) {
      day = debt.dueEvery === "monthly" ? shiftMonths(debt.dueFrom, i)
          : debt.dueEvery === "weekly" ? shiftDays(debt.dueFrom, 7 * i)
          : shiftDays(debt.dueFrom, 14 * i);
    }
  }

  const dias = daysBetween(hoy, day);
  return {
    day, dias,
    vencido: dias < 0,
    amount: Number(debt.dueAmount),
    currency: debt.currency,
  };
}

/* --------------------------------------------------------- el vehiculo ---
   Cuando toca una tarea POR FECHA. Se mira la lista de tareas que cubrio cada
   servicio, no un campo suelto: en la casa comercial se paga un solo monto por
   aceite, filtro y cadena, y eso es un registro que cubre tres tareas.
-------------------------------------------------------------------------- */
export function tareaVencida(task, servicios, hoy = today()) {
  if (!task.everyMonths) return null;   // sin fecha no hay dia al que avisar
  const hechos = servicios
    .filter((s) => (s.taskIds || []).includes(task.id))
    .sort((a, b) => (a.day + String(a.id).padStart(9, "0")).localeCompare(b.day + String(b.id).padStart(9, "0")));
  if (!hechos.length) return null;      // "nunca se le ha hecho" se ve en la app

  const ultimo = hechos[hechos.length - 1];
  const proxima = shiftMonths(ultimo.day, task.everyMonths);
  const dias = daysBetween(hoy, proxima);
  return { day: proxima, dias, vencido: dias <= 0 };
}

/* --------------------------------------------------------------- textos --- */

const money = (n, cur) => `${cur === "USD" ? "US$" : "C$"}${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

/// Como se cuenta un pago segun quien lo lea. `cobro` es true para quien tiene
/// que RECIBIR la plata.
export function textoPago(debt, due, cobro) {
  const monto = money(due.amount, due.currency);
  if (due.vencido) {
    return cobro
      ? { title: `${debt.name} te debe un pago`,
          body: `${monto} que quedó para el ${due.day}. Lleva ${plural(-due.dias, "día", "días")} de atraso.` }
      : { title: `Pago atrasado: ${debt.name}`,
          body: `${monto} del ${due.day}, ${plural(-due.dias, "día", "días")} atrás.` };
  }
  if (due.dias === 0) {
    return cobro
      ? { title: `Hoy te toca cobrar: ${debt.name}`, body: `Son ${monto}.` }
      : { title: `Hoy toca el pago de ${debt.name}`, body: `${monto}. Al abonarlo, anótalo en la app.` };
  }
  return cobro
    ? { title: `${debt.name} te paga pronto`, body: `${monto} el ${due.day}, en ${plural(due.dias, "día", "días")}.` }
    : { title: `Se acerca el pago de ${debt.name}`, body: `${monto} el ${due.day}, en ${plural(due.dias, "día", "días")}.` };
}

export function textoTarea(vehiculo, task, st) {
  return {
    title: `${vehiculo.name}: le toca ${task.name.toLowerCase()}`,
    body: st.dias === 0 ? "Toca hoy." : `Lleva ${plural(-st.dias, "día", "días")} de atraso.`,
  };
}

export function textoComentario(c) {
  return {
    title: `${c.userName} escribió en ${c.debtName}`,
    // El texto entero no: un comentario largo llena la pantalla de bloqueo, y
    // la gracia es abrir la app para leerlo.
    body: c.text.length > 120 ? `${c.text.slice(0, 117)}…` : c.text,
  };
}

/// Un aviso por fecha sale UNA vez al dia. La clave lo dice todo: que aviso es,
/// de que fila y de que dia.
export const claveAviso = (que, id, dia) => `aviso:${que}:${id}:${dia}`;
