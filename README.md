# Deudas

PWA personal para llevar **lo que debo, a quién y cómo va bajando**: préstamos con su motivo y comprobante, abonos, saldo por deuda y en total, gráficos, un simulador de "¿y si abono X cada tanto?" y acceso de **solo lectura** para la otra persona (mi hermano entra, ve su deuda y puede comentar, pero no toca nada).

Mismo stack que `asistencia-obra`: un solo `index.html` sin frameworks, funciones serverless de Vercel y Turso/libSQL.

---

## Cómo funciona

### Cuenta, deudas y usuarios

Al entrar por primera vez se usa **Crear mi cuenta**: eso crea la cuenta y su **dueño** (admin). Dentro de la cuenta se crean **deudas**, que son el equivalente a "proyectos": una con el hermano, otra con la hermana, otra por la tarjeta.

| Rol | Puede |
|---|---|
| **Dueño** | Todo: crear deudas, registrar préstamos y abonos, subir comprobantes, crear usuarios y decidir qué deuda ve cada uno |
| **Solo lectura** | Ver **únicamente las deudas que le asignaron** (movimientos, comprobantes, gráficos, simulador) y **escribir comentarios**. Nada más |

Los usuarios los crea el dueño desde *Ajustes → Usuarios con acceso*, marcando qué deudas verá cada uno. Sin ninguna marcada no ve nada. Una deuda de tarjeta simplemente no se le asigna a nadie.

Con `ALLOW_SIGNUP=0` se cierra el registro público (la primera cuenta siempre se puede crear).

### Préstamos y abonos

Cada deuda tiene **movimientos**: un **préstamo** sube el saldo, un **abono** lo baja.

```
saldo = Σ préstamos − Σ abonos
```

Cada movimiento lleva fecha, monto, motivo, una nota opcional y, si existe, el **comprobante** (captura de la transferencia o foto del recibo). La captura se achica y se convierte a JPEG en el teléfono antes de subirla, así que pesa unos cientos de KB y no la foto de 4 MB.

**La moneda va en cada movimiento.** Una misma deuda puede tener una parte en **córdobas (C$)** y otra en **dólares (US$)**: los saldos se llevan **por separado y nunca se suman ni se convierten** (no hay tipo de cambio). La deuda guarda solo una "moneda habitual", que es la que se propone al registrar. Donde hay dos monedas, la pantalla lo dice: *C$3,500 + US$100*.

En la lista, cada movimiento muestra el **saldo después de ese movimiento** en su moneda, así se ve la historia sin calcular nada.

### Comentarios

Lo único que puede escribir un usuario de solo lectura. Van sobre la deuda en general (*Comentarios*) o sobre un préstamo o abono concreto (abriendo el movimiento): "este abono fue el del sábado", "¿y los 500 del mes pasado?". Cada quien borra los suyos; el dueño, cualquiera. Los últimos aparecen en el Resumen.

### Gráficos

Sin librerías (la CSP no permite scripts externos y en SVG cabe en 200 líneas):

- **Resumen:** cómo ha ido el saldo en los últimos 12 meses, una línea por deuda (hasta 4) o el total.
- **Deuda:** saldo al cierre de cada mes y préstamos vs. abonos por mes.
- **Simulador:** cómo bajaría el saldo con cada escenario.

Cada gráfico tiene su tabla gemela (*Ver como tabla*) y tooltip al pasar el dedo. La paleta es la del método `dataviz` (validada para daltonismo en los dos temas): azul para préstamos/saldo, verde-aqua para abonos, naranja para el segundo escenario.

### Simulador

*Simular*: se elige una deuda (y su moneda, si tiene dos), cada cuánto se paga (semanal / quincenal / mensual), cuánto, desde cuándo y un interés anual opcional. Se pueden comparar **hasta 3 montos** a la vez. Devuelve cuándo termina, cuántos pagos, total pagado e intereses, más el calendario pago a pago.

El interés se calcula día a día (tasa anual / 365) sobre el saldo y se capitaliza en cada pago. Si el abono no cubre ni el interés del período, avisa que la deuda no baja. Entre familia el interés va en 0 y todo es lineal.

El **interés anual** de la deuda es solo un dato para el simulador: el saldo registrado no cambia solo.

### Estado de cuenta y WhatsApp

Desde la deuda:

- **Estado de cuenta** → PDF con resumen y todos los movimientos con su saldo corrido (una sección por moneda), con la opción de **adjuntar los comprobantes** al final, uno por página. El PDF se genera sin librerías (`MiniPdf`); los JPEG entran tal cual (`DCTDecode`).
- **Resumen** → abre WhatsApp con el texto ya escrito (saldos, prestado, abonado y los últimos movimientos).

### Si se pierde la contraseña

Al crear la cuenta se entrega un **código de recuperación** (`XXXX-XXXX-XXXX`) que no se puede volver a ver: solo queda su hash. *¿Olvidaste tu contraseña?* pide usuario, código y contraseña nueva. Es de un solo uso (al usarlo se entrega otro), generar uno nuevo invalida el anterior, y comparte el contador de intentos con el login (5 fallos, 15 minutos). A un usuario de solo lectura siempre lo puede rescatar el dueño desde *Usuarios con acceso*.

### Instalar en el teléfono

*Ajustes → Instalar en el teléfono* (Android) o *Compartir → Añadir a pantalla de inicio* (iPhone, desde Safari). Los iconos PNG los genera `node scripts/make-icons.mjs`.

### La fecha

Todo usa la hora de **Nicaragua** (`America/Managua`), en el servidor y en la app: "hoy" significa lo mismo para quien presta y para quien debe.

---

## Stack

Sin build ni framework:

- **Front**: un solo `index.html` (HTML + CSS + JS vanilla) + PWA (`manifest.webmanifest`, `sw.js`). Tema claro/oscuro con opción Automático
- **Back**: funciones serverless de Vercel en `api/*.js` (ESM, `export default handler`)
- **DB**: **Turso / libSQL** (SQLite). En local cae solo a `data/deudas.db` si no hay credenciales
- **Auth**: propia — scrypt (`salt:hash`) + `sessionToken` en el header `x-session-token`. Lockout de 5 intentos / 15 min
- **Esquema**: se auto-crea con `ensureSchema()` (`CREATE TABLE IF NOT EXISTS` + `ALTER` idempotentes). No hay migraciones

### Funciones serverless (5 de las 12 del plan Hobby)

| Endpoint | Qué hace |
|---|---|
| `api/auth.js` | Alta de cuenta, login, usuarios, asignación de deudas y código de recuperación |
| `api/debts.js` | Deudas, con totales por moneda |
| `api/entries.js` | Préstamos y abonos, y el comprobante de cada uno |
| `api/comments.js` | Comentarios sobre la deuda o sobre un movimiento |
| `api/summary.js` | Todo lo que necesita el Resumen en una sola llamada |

### Tablas

```
accounts     cuentas (el cerco duro: nadie ve fuera de la suya)
users        quienes entran (admin / viewer) + código de recuperación
debts        deudas: nombre, tipo (persona / tarjeta / otra), moneda habitual,
             a quién, interés anual opcional, abierta/cerrada
debt_users   qué deudas ve cada viewer
entries      préstamos y abonos: kind (loan / payment), currency (NIO / USD),
             day, amount, reason, note, hasReceipt
receipts     el comprobante (data URI JPEG), misma clave que entries
comments     comentarios; entryId NULL = sobre la deuda en general
```

Decisiones que importan:

- El **comprobante va en tabla aparte**: la lista de movimientos se pide todo el tiempo y no tiene por qué arrastrar imágenes; solo viaja `hasReceipt`.
- La **moneda va en el movimiento**, no en la deuda, y los totales salen del servidor ya separados por moneda (`totals.NIO`, `totals.USD`).
- Los permisos se comprueban **por deuda** (`canSeeDebt` / `debtOfEntry` en `lib/auth.js`): movimientos, comprobantes y comentarios cuelgan de ella. Quien no tiene acceso recibe **404, no 403**.
- Borrar un movimiento se lleva su comprobante y sus comentarios; borrar una deuda (*Borrar definitivamente*) se lleva todo. Cerrar una deuda solo la esconde.

---

## Desarrollo local

```bash
npm install
node scripts/dev.mjs                    # http://localhost:3000  (base local en data/deudas.db)
node --env-file=.env scripts/dev.mjs    # igual, pero contra Turso
```

`scripts/dev.mjs` sirve los estáticos y enruta `/api/<x>` a `api/<x>.js` igual que Vercel, con las mismas cabeceras de seguridad de `vercel.json`. Cachea los handlers: si tocas `api/` o `lib/`, reinícialo.

```bash
node scripts/smoke.mjs        # 105 pruebas contra los handlers reales (base VACÍA); borra lo que crea
node scripts/demo.mjs         # datos de muestra: moises / deuda1234 (dueño), hermano / deuda1234 (lectura)
```

Las pruebas cubren, entre otras cosas, que una cuenta no vea ni toque nada de otra, que un viewer vea solo lo asignado y no pueda escribir salvo comentarios, que los saldos por moneda no se mezclen, que el comprobante viaje aparte y solo en JPEG, que borrar un movimiento se lleve sus comentarios, y que el código de recuperación sirva una sola vez.

---

## Despliegue

1. **Crear la base en Turso** — [turso.tech](https://turso.tech) → *Create Database*. Copiar la URL `libsql://…` y generar un token.
2. **Importar el repo en Vercel** ([vercel.com/new](https://vercel.com/new)) con *Framework Preset* = **Other**, sin Build Command ni Output Directory.
3. **Environment Variables**: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` y, una vez creada tu cuenta, `ALLOW_SIGNUP=0`.
4. Deploy → abrir la URL → **Crear mi cuenta** → guardar el código de recuperación → crear la primera deuda.
5. *Ajustes → Usuarios con acceso* → dar acceso al hermano marcando su deuda.

---

## Convenciones

- Todo el color sale de tokens CSS en `:root` (`--ink`, `--muted`, `--line`, `--card`…). El color con significado se reserva para el sentido del movimiento (rojo préstamo / verde abono) y para las series de los gráficos (`--s1`…`--s6`).
- **Nada de diálogos del navegador**: `await ask({...})` para confirmar y `toast(texto, "ok" | "err")` para avisar.
- **Nunca calcular "hoy" con UTC**: `today()` en el servidor y `todayApp()` en la app dan la fecha de Nicaragua.
- **Nunca sumar monedas distintas.** Si algo muestra un total, es de una sola moneda.
