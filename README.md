# Deudas

PWA personal para llevar **lo que debo, lo que me deben, en qué se me va la plata y qué le toca al vehículo**: préstamos con su motivo y comprobante, abonos, saldo por cuenta y en total, gráficos, un simulador de "¿y si abono X cada tanto?", recordatorios de cuándo toca pagar (o cobrar) y acceso de **solo lectura** para la otra persona (mi hermano entra, ve su deuda y puede comentar, pero no toca nada).

Mismo stack que `asistencia-obra`: un solo `index.html` sin frameworks, funciones serverless de Vercel y Turso/libSQL.

---

## Cómo funciona

### Cuenta, deudas y usuarios

Al entrar por primera vez se usa **Crear mi cuenta**: eso crea la cuenta y su **dueño** (admin). Dentro de la cuenta se crean **deudas y cobros**, que son el equivalente a "proyectos": una con el hermano, otra con la hermana, otra por la tarjeta, y las que te deben a ti.

| Rol | Puede |
|---|---|
| **Dueño** | Todo: crear deudas, registrar préstamos y abonos, subir comprobantes, crear usuarios y decidir qué deuda ve cada uno |
| **Solo lectura** | Ver **únicamente las deudas que le asignaron** (movimientos, comprobantes, gráficos, simulador) y **escribir comentarios**. Nada más. No ve los cobros ni los recordatorios: eso es del dueño |

Los usuarios los crea el dueño desde *Ajustes → Usuarios con acceso*, marcando qué deudas verá cada uno. Sin ninguna marcada no ve nada. Una deuda de tarjeta simplemente no se le asigna a nadie.

Con `ALLOW_SIGNUP=0` se cierra el registro público (la primera cuenta siempre se puede crear).

### Los dos lados: deudas y cobros

El Resumen tiene dos pestañas, **Debo** y **Me deben**. Son la misma ficha contada desde el otro lado: los mismos movimientos, comprobantes, gráficos y simulador; lo único que cambia son las palabras.

| | Debo (`direction: 'owe'`) | Me deben (`direction: 'owed'`) |
|---|---|---|
| El préstamo | *Préstamo* — me prestaron | *Préstamo que hice* — yo presté |
| El pago | *Abono* — yo pago | *Pago recibido* — me pagan |
| Totales | Prestado / Abonado / Por pagar | Presté / Me han pagado / Por cobrar |
| WhatsApp | *Resumen* | *Recordar* — el mensaje de cobro ya escrito |

Todo el vocabulario vive en la constante `SIDE` de `index.html`, así que no hay "si es cobro entonces…" repartido por la app. La dirección se elige al crear (o se corrige después, sin tocar los movimientos).

**La misma deuda se lee al revés según quién mire.** El dueño registra "le debo a mi hermano C$3,500"; cuando el hermano entra, él es el acreedor, así que ve *"Me deben C$3,500"*, *"Presté"* y *"Me han pagado"*. No son dos registros: es la misma fila contada desde el otro lado. Eso lo decide `wordSide(d)` — la dirección tal cual para el dueño, invertida para quien entra de solo lectura.

**Los cobros son solo del dueño.** Un usuario de solo lectura entra a ver *su* deuda, no la contabilidad de a quién más le presta uno. El filtro está en el servidor (`debtScope` en `lib/auth.js` agrega `direction = 'owe'` para los viewers), así que aunque por error se le asigne un cobro, no lo recibe: ni la deuda, ni sus movimientos, ni sus comentarios. Tampoco le llega el acuerdo de pago (`publicDebt` lo quita), así que no ve recordatorios ni pestañas *Debo / Me deben*.

### Recordatorios: cuándo toca

A una deuda o cobro se le puede cargar un **acuerdo de pago**: *cada semana / quincena / mes*, *cuánto* y *desde cuándo*. Con eso la app calcula la fecha que toca ahora — la primera del acuerdo posterior al último pago registrado — y lo muestra:

- En el Resumen, arriba de todo, la sección **"Lo que toca pagar"** (o cobrar) con lo que vence en los próximos 7 días o ya está atrasado.
- En cada tarjeta, una etiqueta *"Toca en 3 días"* / *"Atrasado 50 días"*.
- En la ficha, una banda de color con la fecha y el monto.
- En un cobro, el botón **Recordar** abre WhatsApp con el mensaje ya escrito: *"Hola Carlos, te escribo por el pago de C$1,000 que quedó para el 15 de julio (50 días atrás)"*, seguido del estado de cuenta.

> **No hay notificaciones push a propósito.** Una PWA no las tiene garantizadas en iPhone y obligarían a depender de un servicio aparte. El aviso vive en la pantalla, que es donde uno lo va a ver, y el cobro se manda por WhatsApp, que es como se cobra de verdad. Si el saldo está en cero, no hay recordatorio: no hay nada que reclamar.

### Préstamos y abonos

Cada deuda o cobro tiene **movimientos**: un **préstamo** sube el saldo, un **abono/pago** lo baja.

```
saldo = Σ préstamos − Σ abonos
```

Cada movimiento lleva fecha, monto, motivo, una nota opcional y, si existe, el **comprobante** (captura de la transferencia o foto del recibo). La captura se achica y se convierte a JPEG en el teléfono antes de subirla, así que pesa unos cientos de KB y no la foto de 4 MB.

**La moneda va en cada movimiento.** Una misma deuda puede tener una parte en **córdobas (C$)** y otra en **dólares (US$)**: los saldos se llevan **por separado y nunca se suman ni se convierten** (no hay tipo de cambio). La deuda guarda solo una "moneda habitual", que es la que se propone al registrar. Donde hay dos monedas, la pantalla lo dice: *C$3,500 + US$100*.

En la lista, cada movimiento muestra el **saldo después de ese movimiento** en su moneda, así se ve la historia sin calcular nada.

### Ingresos y capacidad de pago

Sin saber lo que entra, "cuánto puedo abonar" no se puede contestar. En *Gastos → Ingresos* (o *Ajustes → Mis ingresos*) se registran dos cosas distintas:

- **Ingreso fijo** — el sueldo. Se cuenta en todos los meses **desde la fecha que le pongas**. Si te aumentan, agregas otro con la fecha del aumento y los meses viejos siguen contando lo de antes. Igual que el pago por día en `asistencia-obra`, **el primer sueldo cubre hacia atrás**: uno anota su sueldo hoy y no espera que los meses anteriores aparezcan en cero.
- **Ingreso extra** — lo que entró una sola vez ese día: aguinaldo, un trabajito, la venta de algo.

Con eso, la pestaña Gastos muestra **cómo va el mes**, como una cuenta de papel:

```
Entró (sueldo C$26,000 + extras C$4,000)   +C$30,000
Gastos del hogar                           −C$21,375
Abonado a deudas                            −C$1,000
─────────────────────────────────────────────────────
Te queda                                     C$7,625
```

Y debajo, la **capacidad de pago**: *"Ganando C$26,000 y gastando C$18,050 al mes (promedio de 3 meses), puedes abonar hasta C$7,950 al mes sin apretarte"*, con un botón que abre el simulador con ese monto ya puesto. El simulador también lo enseña arriba y lo propone como abono por defecto.

> **El promedio es de los meses CERRADOS, no del mes en curso.** Un mes que va por el día 3 siempre se ve mejor de lo que es, y prometer un abono con ese número es cómo uno queda mal. Tampoco se descuenta lo que ya abonas: la pregunta es cuánto puedes comprometer en total, y lo que ya pagas es parte de eso.

Los ingresos son del dueño, como los gastos: quien entra de solo lectura no ve cuánto gana uno.

### Gastos del hogar

La pestaña **Gastos** (solo del dueño) lleva el gasto del mes contra un presupuesto.

- **Categorías** — las gavetas del gasto: Comida, Casa y servicios, Transporte… La primera vez la app ofrece crear las típicas de un tiro. Cada una puede llevar un **presupuesto mensual** con su moneda; el que no lo tenga simplemente no suma al tope.
- **Anotar un gasto** — monto, moneda, fecha, categoría, en qué fue, nota y la **captura del recibo** (misma conversión a JPEG que los comprobantes).
- **El mes manda.** Se elige un mes con las flechas y todo lo de abajo habla de ese mes.

Arriba va lo único que uno quiere saber al abrir esto: **cuánto llevas y si te estás pasando**. La barra se pinta verde, ámbar o roja, y debajo dice *"Te quedan C$2,100 · C$150 por día"* o *"Te pasaste por C$1,400"*.

> **El porcentaje del mes está al lado a propósito.** "Llevo el 60% del presupuesto" no dice nada por sí solo; "llevo el 60% y va el 30% del mes" sí. Por eso la app muestra los dos.

Debajo, **en qué se fue**: una fila por categoría, ordenadas de mayor a menor, con su barra y su porcentaje (del presupuesto si lo tiene, del gasto del mes si no). Tocando una se abre su detalle con los últimos 6 meses, que es donde se ve si algo se disparó. Y al final, la lista del mes agrupada por día.

El gráfico de barras muestra el gasto de los últimos 12 meses con **el presupuesto como una línea** sobre las mismas barras: la misma escala, un solo eje.

Dos decisiones que importan:

- **Borrar una categoría no borra sus gastos**: quedan como *"Sin categoría"* y siguen contando en los totales. La plata se gastó igual; quitarla del total sería mentir. Si solo quieres dejar de usarla, se archiva.
- **El presupuesto es un tope que uno se propone, no una regla.** Pasarse no bloquea nada ni impide anotar: solo se pinta en rojo.

### Mantenimiento del vehículo

La pestaña **Vehículo** (solo del dueño) responde una sola pregunta: **¿qué le toca ya?**

- **Vehículos** — la moto, el carro. Al crear uno se le cargan las **tareas típicas** de su tipo con sus intervalos (aceite cada 3.000 km o 6 meses, llantas cada 15.000, seguro cada año…), listas para ajustar.
- **Tareas** — lo que hay que repetir. Se define **por kilómetros, por meses, o los dos**; con los dos, toca **lo que llegue primero**, que es como funciona un manual de verdad.
- **Servicios** — lo que se le hizo: fecha, kilometraje, qué fue, costo, taller y la **factura**. Un servicio puede no haber costado nada (garantía).

El **kilometraje del vehículo** es el más alto que se haya anotado en un servicio; de ahí sale todo el cálculo. Una tarea que nunca se ha hecho **toca desde ya**. Arriba se muestran *"Ya toca"* y *"Pronto"* (a menos del 25% del intervalo), ordenadas por urgencia; el resto se pliega.

> **Un servicio puede anotarse también como gasto del hogar.** Al registrarlo eliges la categoría (Transporte, por ejemplo) y la app crea el gasto, guardando su id en el servicio. Así la plata **figura una sola vez** en los totales del mes, editar el costo mueve las dos cosas, y borrar el servicio se lleva el gasto. Sin eso habría que anotarlo dos veces y las cuentas del mes dirían una cosa y el taller otra.

Borrar una tarea **no borra sus servicios**: quedan en el historial sin tarea. Se hizo el trabajo y se pagó; perderlo sería perder el kilometraje.

### Comentarios

Lo único que puede escribir un usuario de solo lectura. Van sobre la deuda en general (*Comentarios*) o sobre un préstamo o abono concreto (abriendo el movimiento): "este abono fue el del sábado", "¿y los 500 del mes pasado?". Cada quien borra los suyos; el dueño, cualquiera. Los últimos aparecen en el Resumen.

### Gráficos

Sin librerías (la CSP no permite scripts externos y en SVG cabe en 200 líneas):

- **Resumen:** cómo ha ido el saldo en los últimos 12 meses, una línea por deuda (hasta 4) o el total.
- **Deuda:** saldo al cierre de cada mes y préstamos vs. abonos por mes.
- **Gastos:** gasto por mes con el presupuesto como línea de referencia, y por categoría.
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

### Funciones serverless (9 de las 12 del plan Hobby)

| Endpoint | Qué hace |
|---|---|
| `api/auth.js` | Alta de cuenta, login, usuarios, asignación de deudas y código de recuperación |
| `api/debts.js` | Deudas y cobros, con totales por moneda |
| `api/entries.js` | Préstamos y abonos, y el comprobante de cada uno |
| `api/comments.js` | Comentarios sobre la deuda o sobre un movimiento |
| `api/summary.js` | Todo lo que necesita el Resumen en una sola llamada |
| `api/categories.js` | Categorías del gasto y su presupuesto mensual (solo dueño) |
| `api/expenses.js` | Gastos del hogar y la captura de cada recibo (solo dueño) |
| `api/incomes.js` | Ingresos: el sueldo con su historial y los extras (solo dueño) |
| `api/vehicles.js` | Vehículos, sus tareas de mantenimiento y sus servicios (solo dueño) |

### Tablas

```
accounts     cuentas (el cerco duro: nadie ve fuera de la suya)
users        quienes entran (admin / viewer) + código de recuperación
debts        deudas Y cobros: nombre, tipo (persona / tarjeta / otra), moneda
             habitual, a quién, interés anual opcional, abierta/cerrada,
             direction (owe = yo debo / owed = me deben) y el acuerdo de pago
             (dueEvery / dueAmount / dueFrom)
debt_users   qué deudas ve cada viewer
entries      préstamos y abonos: kind (loan / payment), currency (NIO / USD),
             day, amount, reason, note, hasReceipt
receipts     el comprobante (data URI JPEG), misma clave que entries
comments     comentarios; entryId NULL = sobre la deuda en general
categories   gavetas del gasto del hogar + presupuesto mensual y su moneda
expenses     un gasto por fila; categoryId NULL = sin categoría
expense_receipts  la captura del recibo, misma idea que receipts
incomes      ingresos: kind monthly (el sueldo, rige DESDE day) u once
vehicles     la moto, el carro
vehicle_tasks lo que hay que repetir: everyKm y/o everyMonths
services     lo que se le hizo; expenseId ata el gasto del hogar que generó
service_receipts  la factura del taller
```

Decisiones que importan:

- El **comprobante va en tabla aparte**: la lista de movimientos se pide todo el tiempo y no tiene por qué arrastrar imágenes; solo viaja `hasReceipt`.
- La **moneda va en el movimiento**, no en la deuda, y los totales salen del servidor ya separados por moneda (`totals.NIO`, `totals.USD`).
- Un **cobro no es una tabla aparte**: es una deuda con `direction = 'owed'`. La aritmética, los permisos, los comprobantes y los gráficos ya estaban resueltos; duplicarlos habría sido mantener dos veces lo mismo. El acuerdo de pago se guarda completo o no se guarda (los tres campos juntos).
- Los permisos se comprueban **por deuda** (`canSeeDebt` / `debtOfEntry` en `lib/auth.js`): movimientos, comprobantes y comentarios cuelgan de ella. Quien no tiene acceso recibe **404, no 403**.
- Borrar un movimiento se lleva su comprobante y sus comentarios; borrar una deuda (*Borrar definitivamente*) se lleva todo. Cerrar una deuda solo la esconde.

---

## Desarrollo local

```bash
npm install
node scripts/dev.mjs                    # http://localhost:3000  (base local en data/deudas.db)
node --env-file=.env scripts/dev.mjs    # igual, pero contra Turso
```

`scripts/dev.mjs` sirve los estáticos y enruta `/api/<x>` a `api/<x>.js` igual que Vercel, con las mismas cabeceras de seguridad de `vercel.json`.

> **Cachea los handlers: si tocas `api/` o `lib/`, reinícialo.** Si no, la app sigue hablando con la versión anterior del backend y uno se pasa un rato buscando un fallo que no existe (pasó: la pantalla decía "anota tu ingreso" mientras el ingreso ya estaba guardado).

```bash
node scripts/smoke.mjs        # 216 pruebas contra los handlers reales (base VACÍA); borra lo que crea
node scripts/ui-check.mjs     # 61 comprobaciones de la interfaz, sin navegador
node scripts/demo.mjs         # datos de muestra: moises / deuda1234 (dueño), hermano / deuda1234 (lectura)
```

`ui-check.mjs` saca el `<script>` de `index.html`, lo corre en un DOM de mentira y llama a las funciones que pintan cada pantalla con datos inventados. No comprueba cómo se ve — para eso hay que abrirlo — sino que se pinta sin reventar, que **el texto es el correcto para quien mira** (el dueño ve *"Debo"*, el de solo lectura ve *"Me deben"*) y que las cuentas dan (saldo corrido por moneda, presupuesto, próximo pago, simulador, ejes de los gráficos).

> Nació de un rato peleando con el navegador: media hora de clicks para descubrir un nombre de variable mal escrito es una mala inversión. Corre en dos segundos.

Las pruebas cubren, entre otras cosas, que una cuenta no vea ni toque nada de otra, que un viewer vea solo lo asignado y no pueda escribir salvo comentarios, que los saldos por moneda no se mezclen, que el comprobante viaje aparte y solo en JPEG, que borrar un movimiento se lleve sus comentarios, que el código de recuperación sirva una sola vez, que un cobro lleve sus totales igual que una deuda, con el acuerdo de pago validado completo y la dirección cambiable sin tocar el historial, que a un viewer no le lleguen los cobros, los gastos, los ingresos ni los vehículos ni aunque se le asignen por error, y que el gasto que nace de un servicio del taller se mueva y se borre con él.

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
- **El vocabulario de "debo" vs. "me deben" va en `SIDE`**, nunca en un `if` suelto: si hay que agregar una palabra, se agrega a las dos entradas. Para saber cuál usar, `wordSide(d)` / `T(d)`, nunca `d.direction` directo — el viewer lo ve invertido.
- **Lo que un rol no debe ver se filtra en el servidor**, no escondiendo botones: `debtScope` y `publicDebt` en el back, y la app además no pinta lo que no le sirve.
- **Nada de diálogos del navegador**: `await ask({...})` para confirmar y `toast(texto, "ok" | "err")` para avisar.
- **Nunca calcular "hoy" con UTC**: `today()` en el servidor y `todayApp()` en la app dan la fecha de Nicaragua.
- **Nunca sumar monedas distintas.** Si algo muestra un total, es de una sola moneda.
