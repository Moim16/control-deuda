// =============================================================================
//  Mandar un correo. Ahora mismo solo hace falta para una cosa: el codigo que
//  confirma un registro nuevo.
//
//  Se usa Resend por su API HTTP: en serverless, una llamada `fetch` es lo que
//  funciona bien — un envio por SMTP mantiene una conexion abierta y en una
//  funcion que muere al responder eso es fragil y lento.
//
//  Sin RESEND_API_KEY no se envia nada y se dice (`enabled: false`). El
//  registro entonces sigue funcionando SIN confirmar el correo, igual que
//  antes: si no, un despliegue sin la clave se quedaria sin ninguna forma de
//  crear la primera cuenta. Es la misma decision que con las llaves de push.
// =============================================================================

const API = "https://api.resend.com/emails";

// Sin dominio propio verificado, Resend deja enviar desde su remitente de
// pruebas. Con dominio, se pone FROM_EMAIL y ya.
const FROM = process.env.FROM_EMAIL || "Deudas <onboarding@resend.dev>";

export const mailListo = () => Boolean(process.env.RESEND_API_KEY);

// Un correo con pinta de correo: minusculas, con arroba y con punto despues.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const emailValido = (v) => EMAIL_RE.test((v ?? "").toString().trim().toLowerCase());
export const limpiaEmail = (v) => (v ?? "").toString().trim().toLowerCase();

/// Manda el codigo de confirmacion. Devuelve { ok } o { ok:false, error }.
///
/// El texto va en las dos formas (HTML y plano) porque hay clientes de correo
/// que no muestran HTML, y un correo con el codigo invisible no sirve de nada.
export async function enviarCodigo(email, codigo) {
  if (!mailListo()) return { ok: false, error: "El correo no está configurado." };

  const asunto = `${codigo} es tu código de Deudas`;
  const texto = [
    `Tu código para crear la cuenta es: ${codigo}`,
    ``,
    `Escríbelo en la app para terminar. Vence en 15 minutos.`,
    ``,
    `Si no fuiste tú, ignora este correo: sin el código no se crea nada.`,
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:440px;margin:0 auto;padding:24px;color:#18181b;">
      <p style="font-size:15px;line-height:1.5;margin:0 0 18px;">Tu código para crear la cuenta en <b>Deudas</b>:</p>
      <div style="font-size:30px;font-weight:700;letter-spacing:6px;text-align:center;padding:18px;background:#fafafa;border:1px solid #e8e8eb;border-radius:10px;">${codigo}</div>
      <p style="font-size:13.5px;line-height:1.5;color:#71717a;margin:18px 0 0;">Escríbelo en la app para terminar. Vence en 15 minutos.</p>
      <p style="font-size:13.5px;line-height:1.5;color:#71717a;margin:10px 0 0;">Si no fuiste tú, ignora este correo: sin el código no se crea nada.</p>
    </div>`;

  try {
    const r = await fetch(API, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: FROM, to: [email], subject: asunto, text: texto, html }),
    });
    if (r.ok) return { ok: true };
    // El mensaje de Resend es util (dominio sin verificar, destinatario
    // rechazado) pero no se le pasa al usuario tal cual: se registra y se le
    // dice algo que pueda entender.
    const detalle = await r.text().catch(() => "");
    console.error("resend fallo", r.status, detalle.slice(0, 300));
    return { ok: false, error: "No se pudo enviar el correo. Revisa la dirección." };
  } catch (err) {
    console.error("resend error", String(err));
    return { ok: false, error: "No se pudo enviar el correo. Intenta de nuevo." };
  }
}

/// Un codigo de seis digitos. Se lee y se dicta por telefono sin equivocarse,
/// que es para lo que sirve; la seguridad la pone el tope de intentos y los 15
/// minutos de vida, no el largo.
export function nuevoCodigo() {
  const b = crypto.getRandomValues(new Uint32Array(1));
  return String(b[0] % 1000000).padStart(6, "0");
}
