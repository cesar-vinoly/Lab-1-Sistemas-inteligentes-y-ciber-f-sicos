# Comunicación con la ESP32

Se conservan los enlaces y comandos existentes. El PID y el modelo dinámico
se ejecutan en Node.js. No se incluye ni modifica el firmware de la ESP32.

## Conexión

1. Iniciar `INICIAR_RED_WINDOWS.bat`, o ejecutar:
   `node server.mjs --host 0.0.0.0 --port 8000`.
2. PC y ESP32 deben poder comunicarse en la misma red.
3. La **ESP32 actúa como cliente WebSocket** y se conecta a
   `ws://IP_DE_LA_PC:8000/ws/esp32`. Usar la IPv4 de la PC, no `127.0.0.1`.
4. El navegador se conecta automáticamente al mismo servidor en `/ws/ui`.

Se admite una ESP32 a la vez y varios paneles de navegador. Al conectar el
dispositivo se solicita `STATUS`. Al reconectar no se recuperan órdenes
pendientes. Si el PID seguía habilitado, conserva su configuración y espera
telemetría nueva antes de calcular salidas; una pausa manual sigue en pausa.
El firmware debe admitir WebSocket y los mensajes descritos aquí: el código
serie/Bluetooth del adjunto no se convierte automáticamente a WebSocket.

El servidor utiliza el puerto HTTP elegido también para WebSocket. Para un
puerto distinto, ajustar la URL del dispositivo. Por defecto escucha solo en
esta PC; el inicio de red habilita el acceso desde otros equipos.

## Mandos del servidor a la ESP32

Cada comando se envía como un **mensaje de texto WebSocket**, terminado en `\n`.

| Mensaje | Acción | Respuesta de texto esperada |
| --- | --- | --- |
| `F` | Adelante | `Direccion: ADELANTE` |
| `R` | Reversa | `Direccion: REVERSA` |
| `S` | Detención normal | `STOP` |
| `E` | Paro inmediato | `STOP INMEDIATO` |
| `V0` … `V100` | Porcentaje de la velocidad máxima del motor | `Velocidad: 50%` para `V50` |
| `M2`, `M4`, `M8`, `M16` | Micropaso | `Microstep: 1/8` para `M8` |
| `STATUS` | Solicitar telemetría | Una trama de telemetría válida |

Se conserva el límite de 150 RPM del mando de referencia: `V50` solicita el
50 % de esa consigna. Las rampas, los pasos y la ejecución del motor pertenecen
al dispositivo. El visor integra el ángulo a partir del encoder y el estado
nativo recibido, sin generar pasos ni anticipar el movimiento desde un mando.

El micropaso solo se habilita con telemetría reciente, `DIR=STOP` y `RPM_M=0`.
Tras un mando de movimiento se espera una nueva medición de parada.
La respuesta `Detener (S) antes de cambiar M` se registra como rechazo.

Las órdenes se distinguen entre enviadas, confirmadas, rechazadas y sin
respuesta. El límite de respuesta es 2 s, sin reenvío automático.
`S` y `E` se transmiten inmediatamente y cancelan la espera de confirmación
de órdenes previas. La latencia se mide solo con respuestas reconocidas;
`STATUS` no produce una latencia porque la telemetría periódica no lleva ID.

## Telemetría de la ESP32 al servidor

Formato compatible con el servidor antiguo, en una sola línea por mensaje:

```text
DIR=FWD,V=50,M=8,RPM_M=75.0,RPM_T=35.6,RPM_R=35.5,VEL_T=5.50,VEL_R=5.48,DIST=14.0,POS=10.0,ERR=0.3,STATE=OK
```

Estos valores son un ejemplo de formato, no una calibración de la cinta.

| Campo | Significado |
| --- | --- |
| `DIR` | `FWD`, `REV` o `STOP` |
| `V` | Consigna de velocidad, 0–100 % |
| `M` | Micropaso: 2, 4, 8 o 16 |
| `RPM_M` | RPM comandadas al motor, reportadas por la ESP32 |
| `RPM_R` | RPM medidas del rodillo |
| `VEL_R` | Velocidad medida de la banda, cm/s |
| `DIST` | Distancia bruta del HC-SR04, cm; puede retener la última lectura cuando falla el eco |
| `POS` | Posición medida del objeto, cm; `NA` si no hay objeto |
| `STATE` | `OK`, `RAMP` o `DIVERG` |
| `RPM_T` | Referencia de giro enviada por la ESP32, opcional |
| `VEL_T` | Referencia de velocidad enviada por la ESP32, opcional |
| `ERR` | Error de velocidad en porcentaje reportado por la ESP32, opcional |

`DIST` y `POS` también pueden omitirse. Las referencias ausentes se muestran
como `—`. No se estiman a partir del porcentaje del mando, el diámetro ni los
engranajes. Se mantiene la escala de posición 0–45 cm de los paneles antiguos;
no se altera ninguna dimensión del modelo 3D.

El servidor calibra `POS` una sola vez al recibirla: `pos = POS_ESP + 3.7 cm`,
según la referencia física 6,3 → 10 cm. `control/telemetry.mjs` contiene el
offset. La trama ESP conserva su formato; los mensajes a la web y las
instantáneas ya contienen la posición calibrada. React no vuelve a sumarlo.
No se cambian `DIST`, encoder ni referencias de velocidad. `NA`, null y
ausencia permanecen null. No se limita POS a 45 para fabricar detecciones;
las posiciones calibradas fuera de 0–45 cm no muestran el cubo ni habilitan
el frenado por objeto. La pantalla de la ESP conserva su referencia original:
este cambio modifica el servidor, no el firmware.

También se admite un mensaje JSON compacto, con los mismos campos en minúscula
o mayúscula, directamente o dentro de `{"type":"telemetry","data":{...}}`.
Usar `null` para posiciones o referencias ausentes. Enviar normalmente una
trama cada 200–300 ms; después de 3 s sin telemetría válida los indicadores
pasan a “Sin datos”. Las líneas incompletas o no numéricas se descartan.

## Paneles y comparación

- La tabla muestra las mediciones físicas y referencias recibidas. La tendencia
  de velocidad superpone `VEL_R` del encoder y la respuesta de G(s) en cm/s.
- Ambas se muestrean con el mismo reloj monótono del servidor. El error es
  `VEL_R - abs(velocidad_modelo)`; el porcentaje usa el modelo como denominador
  y queda vacío si su magnitud es menor que 0,01 cm/s. Error numérico en Modelo
  y en el cursor de la gráfica. Ninguna simulación sustituye `VEL_R`.
- Las curvas comparan magnitudes porque el encoder transmite `VEL_R >= 0`;
  el modelo también expone su salida con signo (`signedSpeedCmS`).
- Velocidad: espera de régimen de 1,5 s, referencia superior a 5 RPM, error
  mayor de 15 % durante 1 s. `STATE=DIVERG` activa el aviso directamente.
- Posición: se conserva la medición ultrasónica. G(s) es el modelo de velocidad;
  no se inventa una predicción de posición del objeto ni su divergencia.
- Pérdida de velocidad y sobrecarga reducen el comando físico con el protocolo
  existente. El PID limita su referencia y salida, sin adulterar el encoder.
  Deslizamiento modifica únicamente la copia visual de posición y el cubo;
  tabla, CSV, controlador y observador de giro conservan datos reales.
- Existe un único mando para ESP32 y visor. Los botones y la consigna muestran
  la orden compartida; el movimiento 3D se basa exclusivamente en telemetría.
- El arranque usa el estado recibido: `RPM_M > 0` y `DIR=FWD/REV`, mientras
  llega la primera medición positiva del encoder. Enviar `F/R`, recibir su ACK
  o calcular una salida PID no inicia la animación por sí solo.
- `shared/encoder-motion.mjs` ejecuta un único observador visual en el servidor.
  En régimen aplica exactamente `RPM_R/(19/40)` al eje motriz. Durante rampas,
  un cambio de lectura del encoder se compara con las RPM_M medias de la misma
  ventana de 1 s; la ganancia medida corrige las RPM_M actuales. Se conserva
  la última ganancia si la ventana no es suficiente o no resulta coherente.
  Al primer arranque, antes de poder medirla, se utiliza ganancia nominal 1.
- La velocidad se aplica en el mismo mensaje, sin filtro visual, rampa extra
  ni espera de 300 ms. Se mantiene entre muestras e integra el ángulo con
  deltaTime en el bucle original. El observador no usa la consigna anticipada.
  `data`, gráficas, PID y G(s) permanecen independientes de esa estimación.
- El encoder es de un canal y entrega magnitudes; el sentido proviene de
  `DIR` físico. FWD conserva signo CAD negativo y REV positivo. Al ordenar una
  reversa, la animación solo invierte cuando la ESP32 reporta el cambio.
- `DIR=STOP` o `RPM_M=0` detienen el visor aun con un encoder retenido positivo.
  `RPM_R=0` o `VEL_R=0` después de confirmar movimiento también lo detienen,
  aun con RPM_M positiva. Una parada medida termina la gracia inicial; más
  muestras en cero no vuelven a arrancar la estimación visual.
  Sin pulsos iniciales, se limita la espera nominal a 2,5 s; a baja velocidad
  se amplía según el tiempo para dos pulsos (20 pulsos/vuelta). S/E y su ACK
  no sustituyen los estados recibidos.
- Al aplicar una velocidad visual cero, `setMotion` congela la fase antes de
  integrar el intervalo pendiente. Cancela la trayectoria anterior y actualiza
  el reloj: no hay giro final, inercia ni avance UV añadido al recibir la parada.
  Los frames con una marca temporal anterior se descartan sin retroceder el
  reloj. Un rearranque usa solo el tiempo posterior a la nueva medición.
- Las relaciones 19/40, geometrías, materiales y sincronización UV permanecen.
  Las fallas simuladas no alteran las mediciones usadas para animar.
- El firmware calcula el encoder cada **1000 ms** y emite tramas cada **250 ms**.
  En transiciones el servidor consulta el comando existente `STATUS` como
  máximo cada **50 ms**, con una única consulta pendiente y reintento a 250 ms
  si no hay respuesta. Suspende esas consultas 2,25 s después de estabilizarse.
  No genera mandos ni ACK visibles adicionales, ni reproduce órdenes al reconectar.
- STATUS acelera la lectura del estado de rampa/STEP, no la adquisición del
  encoder. RPM_M no es otra medición física: durante transitorios hay una
  estimación visual corregida por el encoder. No se promete precisión instantánea
  ante cambios de carga o deslizamientos que todavía no fueron medidos.
- Las confirmaciones tardías no vuelven a aplicar movimientos anteriores.
  Si se rechaza una orden, vence o se pierde el enlace, se descarta su vista
  provisional. Sin datos recientes el visor queda congelado y la web indica
  que el estado físico es desconocido, sin afirmar una parada del hardware.

Se eliminaron de la web Registro de eventos y Conexión WebSocket de la ESP32,
con sus estilos y estado de presentación. El servidor conserva los mensajes
y el registro interno del protocolo; conexión y reconexión siguen iguales.

Los parámetros de panel están centralizados en `shared/control-protocol.mjs`.
Los gráficos usan SVG y el cliente usa WebSocket nativo. El servidor incluye
`ws` 8.21.3 con su licencia en `vendor/ws/`, para iniciar sin instalar paquetes.

## PID de aproximación y velocidad

Se conserva el protocolo ESP32: `Vabs(u)` y `F/R`, y `S` al llegar a cero.
Se envía magnitud antes de dirección, se evitan órdenes idénticas y se espera
confirmación antes de la siguiente salida. La llegada al objetivo puede
interrumpir esa espera para parar. `S/E` web tienen prioridad: paran la cinta
y pausan la salida, pero mantienen `controller.enabled=true`. `F/R` reanudan
o cambian el sentido sin desactivar el PID. Velocidad manual y micropaso
requieren desactivarlo primero. Solo `action:disable`, enviado al desmarcar
la casilla, cambia `enabled` a false. La selección se conserva entre sesiones
de la ESP32 y desconexiones del navegador mientras el servidor siga abierto.

El PID se puede habilitar sin objeto: basta con telemetría reciente y valores
finitos no negativos de `RPM_R` y `VEL_R`, incluso cero. Sin eco, distancia
fuera de rango o `POS=NA`, puede mantener crucero y el mismo PID corrige con
el encoder. Si ya frenaba o estaba detenido por un objeto, primero confirma
el despeje descrito abajo. Una DIST retenida con POS=NA no inicia frenado.
Al detectar un objeto se aplica el perfil existente de aproximación.

El control tiene dos etapas, ambas en `control/pid.mjs`:

1. **Perfil por distancia.** `restante = DIST - targetCm`. La consigna base y
   máxima es siempre **100 %**. Su velocidad nominal usa 150 RPM de
   motor, reducción 19/40 y diámetro físico de 2,95 cm. La referencia disminuye
   siguiendo `v*T + v²/(2*a) <= restante - tolerancia/2`, con
   `a = velocidad_maxima_nominal*0.25 cm/s²` y
   `T = max(muestreo_configurado, intervalo_real) + 0.25 s`.
   Se considera el mayor entre velocidad del encoder y la nominal de `RPM_M`
   al decidir el frenado. El techo no sube hasta confirmar que el objeto salió
   de la zona o detectar una nueva pieza lejana. Entonces se calcula una
   salida nueva desde la consigna y el encoder actuales, sin heredar el
   techo de frenado ni el porcentaje reducido del objeto anterior.
2. **PID de velocidad.** Usa `VEL_R`, filtrada con constante de 0,5 s, y
   `e_v = (referencia_cm_s - encoder_filtrado_cm_s)/velocidad_maxima_nominal`.
   Salida porcentual = `100*referencia/velocidad_maxima_nominal + Kp*e_v + I + D`.
   `I` integra `Ki*e_v*deltaTime` con anti-windup considerando saturación, perfil
   y límites de cambio. No integra ceros retenidos del encoder durante arranque
   ni durante `STATE=RAMP`. `D` deriva la medición normalizada, filtrada con
   constante de 0,5 s; el primer término es cero, sin golpe por consigna.

Las ganancias iniciales son **113.8, 235.7, 10.35**; ahora son configurables.
Se aplican al error de velocidad **normalizado**, no al antiguo error en cm.
`errorCm` conserva `targetCm-DIST` por compatibilidad de estado; ya no entra
como error directo del PID. El panel expone referencia, error de velocidad y
centímetros restantes. El modelo G(s) conserva sus unidades y ecuaciones.

El comando entero se limita al techo fijo del 100 % y al máximo físico.
Puede recuperar velocidad hasta ese techo antes
del frenado. En frenado solo puede bajar para evitar oscilaciones por el
encoder retenido. Dentro del mismo ciclo, el cambio normal se limita a
25 puntos porcentuales/s; un descenso necesario para respetar el perfil
tiene prioridad. Ese límite no demora la recuperación entre objetos: el
nuevo cálculo puede solicitar directamente el crucero fijo, hasta
100 %, respetando el encoder y el perfil de la pieza nueva. El firmware
aplica además sus rampas nativas. La cuantización es de 1 % como antes.
Fuera de la zona de parada se conserva un avance mínimo de 1 % para no quedar detenido
antes del objetivo; dentro se ordena 0. Este avance requiere que el equipo
pueda mover la cinta con esa consigna.

Al llegar a `DIST <= targetCm+toleranceCm`, la parada se mantiene hasta
confirmar la zona despejada. El PID permanece habilitado y **reanuda solo**:

- Se confirman 200 ms de ausencia con al menos dos lecturas separadas por
  100 ms; normalmente son 250 ms con la telemetría periódica. STATUS no cuenta
  repetidamente una sola trama. Un eco cercano cancela una pérdida breve.
- Una detección nueva después de una trama ausente recalcula inmediatamente
  el perfil si está más allá de `target + tolerancia + max(1 cm, 2*tolerancia)`.
  Si continúa dentro de esa zona, mantiene el frenado/parada.
- Si no hubo trama ausente, un aumento sobre la menor distancia del objeto
  de más de `max(3 cm, 2*tolerancia)` requiere la misma confirmación de 200 ms
  y estar más allá de la zona anterior. Esto permite cambiar de pieza aunque
  la distancia de frenado a crucero supere el recorrido de la cinta.
- Los cambios de presencia reinician integral, derivada y filtro del PID.
  El nuevo ciclo también libera parada retenida y techo de frenado, y reinicia
  el muestreo para que el tiempo detenido no se acumule. La primera salida
  se recalcula sin el límite impuesto por la salida baja anterior. Las rampas
  físicas de la ESP32 se conservan. No se reinicia G(s) ni el observador del
  encoder; la saturación y el anti-windup siguen activos.
- No invierte el sentido al alcanzar o sobrepasar la meta. Detener/E pausan
  la salida sin desactivar el PID; retirar un objeto no cancela una pausa
  manual. F/R permiten reanudar. Fallos y desconexiones tampoco desactivan
  el PID: su salida espera realimentación válida.

El servidor utiliza solo muestras nuevas y tiempo real transcurrido. Un
muestreo menor que la adquisición no crea lecturas nuevas del encoder: el
firmware sigue calculando esa velocidad cada 1000 ms, aunque STATUS lea antes
otros estados. No hay PID en React.

Parámetros editables desde **Modelo**, con el PID desactivado:

La función de transferencia se presenta como una fracción accesible, sin
dependencias nuevas. Distancia objetivo y muestreo van en una fila; Kp, Ki y
Kd van debajo. Es una reorganización visual: los parámetros y el PID conservan
su significado y comportamiento.

| Parámetro | Inicial | Rango / función |
| --- | --- | --- |
| `targetCm` | 20 | 2–400 cm; alcanzable dentro del montaje real |
| `kp` / `ki` / `kd` | 113.8 / 235.7 / 10.35 | 0–10000; error de velocidad normalizado |
| `sampleMs` | 250 | 50–2000 ms; también limitado por la telemetría |
| `toleranceCm` | 0.5 | 0.1–5 cm antes del objetivo |
| `forwardIncreasesDistance` | true | false si Adelante acerca al sensor |
| `inputScale` | 40 | Hz equivalentes a micropaso 1/8 por 1 % de mando |
| `outputScale` | π × 2.95 / 60 ≈ 0.1544616388 | cm/s por RPM de rodillo |

`initialPercent`, `minPercent` y `maxPercent` permanecen en el estado/configuración
por compatibilidad, pero el servidor los fija siempre a **100, 0 y 100**.
Ya no son editables en el panel. La velocidad manual solo aparece con PID apagado.

El código del ensayo `main_wifi_corregido.c` y `respuesta_escalon.csv` usan
entrada `step_hz` y salida `rpm` del encoder del rodillo. El escalón es de
1500 Hz, con micropaso 1/8; el régimen medido ronda 27 RPM. Para 150 RPM de
motor y 200 pasos/vuelta, 1 % equivale a `150*200*8/(60*100) = 40 Hz`.
La salida se convierte con `π*2.95/60` cm/s por RPM. G(s) ya incluye la
transmisión mecánica del ensayo; no se vuelve a aplicar 19/40 a su salida.
El modelo usa frecuencia equivalente a 1/8 al cambiar el micropaso físico:
la misma consigna porcentual representa las mismas RPM de motor.
Así, 100 % produce aproximadamente 10,93 cm/s en régimen; la referencia
nominal es 11,01 cm/s. Se conserva esta diferencia, sin ajustar al encoder.
Estas escalas afectan la simulación; no cambian ganancias ni la medición del
encoder. No calibrarlas copiando el encoder instantáneo: eso falsearía la
comparación. El modelo usa condiciones iniciales cero al conectar la ESP32
(y al cambiar escalas), por lo que puede tener un transitorio si conecta en marcha.

La polaridad del sensor se configura según el montaje físico y es independiente
del signo visual CAD para Adelante/Reversa. Al activar el automático elige
el sentido que reduce DIST. Un mando posterior F/R cambia el sentido elegido
sin desactivarlo; no invierte por sí solo al alcanzar la meta.

La detección exige `DIST` entre 2 y 400 cm y `POS` entre 0 y 45 cm. El
firmware marca `POS=NA` cuando no hay eco/objeto, pudiendo conservar DIST.
El protocolo no permite distinguir esos dos casos: ambos son marcha sin
objeto, no una emergencia ultrasónica. Tras frenar/parar se aplica la
confirmación temporal de despeje; un eco fallido persistente sigue siendo
indistinguible de ausencia. No se inventan distancias ni lecturas del encoder.

Telemetría vencida (3 s), ACK vencido, encoder inválido o una interrupción
del ciclo mayor que el máximo entre 1 s y tres periodos paran la salida,
conservando `enabled=true` y estado `waiting`. Se envía E una sola vez por
incidente; si no se confirma, se cierra el enlace. La recuperación requiere
una muestra válida posterior a la pausa y ninguna orden de motor pendiente.
También `RPM_M > 20` con `VEL_R < 0.01` durante más de 2.5 s pausa la salida
con estado `fault`, manteniendo PID activo; espera pulsos o un nuevo F/R.
Una pausa manual tiene estado `paused` y se conserva al reconectar.
Los cambios locales de sentido reconocidos se adoptan sin desactivar PID.
Las confirmaciones recientes duplicadas/tardías se descartan para no
confundir una respuesta antigua con una nueva parada local.
Cerrar la web no detiene ni desactiva el PID del servidor.

## Objeto sobre la cinta 3D

El cubo usa exclusivamente `POS` real, válida en el intervalo cerrado 0–45 cm.
`POS=NA`, null, ausente o fuera de rango lo ocultan aunque `DIST` sea numérica.
También se oculta sin telemetría reciente. Funciona en manual y con PID activo.

El mapeo es `Z = 0.040974631906 + 0.425000026822 * POS_calibrada / 45`,
limitado al recorrido Z original de la banda. Se elimina la antigua corrección
exclusivamente visual de +5,5 cm: ahora se usa la posición física calibrada
en el backend, compartida con los paneles y el historial, sin segundo offset.
Se conserva el mismo grupo CAD.
Su lado mide 35 mm y tiene opacidad 0,30. Se centra en el
ancho de la correa y su base se apoya en la cara superior real; no se alteran
modelos, encuadre ni materiales existentes. Geometría/material se crean una
sola vez. El bucle de render suaviza solo su posición visual, con tiempo real
y constante de 0,12 s; no cambia telemetría, PID, gráficas ni la animación de
la transmisión. La visibilidad se actualiza inmediatamente.

## Modelo dinámico

```text
G(s) = (0.004656*s + 0.1425) / (s*s + 4.286*s + 8.058)
x1' = x2
x2' = -8.058*x1 - 4.286*x2 + inputScale*u
y   = 0.1425*x1 + 0.004656*x2
velocidad_modelo_cm_s = outputScale*y
```

`control/pid.mjs` calcula exactamente la evolución con entrada constante
por tramos (ZOH). Mantiene el estado al detener e invertir y usa el tiempo
monótono real. Se integra hasta el instante de cada cambio de mando y cada
telemetría. El modelo recibe el comando del servidor, no datos del encoder.
En manual también se actualiza con los comandos y estados locales recibidos.
Para mostrar RPM se usa el diámetro de 29.5 mm definido en el firmware:
`RPM = abs(velocidad_modelo_cm_s) * 60 / (pi*2.95)`.
Esto no cambia las dimensiones CAD ni el radio usado por el desplazamiento UV.

## Mensajes adicionales entre navegador y servidor

Solo `/ws/ui`; no se mandan estos JSON a la ESP32:

```json
{"type":"pid","id":"config-1","action":"configure","config":{"targetCm":20,"kp":113.8,"ki":235.7,"kd":10.35,"sampleMs":250}}
{"type":"pid","id":"start-1","action":"enable"}
{"type":"pid","id":"stop-1","action":"disable"}
```

La respuesta `pid-result` contiene `id`, `status` (`ack`/`rejected`) y `response`.
Los mensajes `controller` y la instantánea inicial comparten el estado del PID
y configuración entre todos los navegadores. Cada trama `telemetry` conserva
`data` e incorpora `timeMs` del servidor, `model` y `controller`. La instantánea
contiene `clockMs` para alinear el eje temporal al reloj del navegador.
Los mensajes `command` conservan sus campos y añaden `source` (`web` o `pid`).
El estado `controller` añade `speedReferenceCmS`, `speedErrorCmS`, `remainingCm`,
`commandPercent` (último V, incluso durante S) y `motion` con RPM actuales,
RPM objetivo, sentido solicitado y tiempo del servidor. Se conserva este
estado de mando por compatibilidad. Se añade `feedback.driveRpm`: velocidad
visual del observador común, actualizada solo al recibir telemetría. La web
usa esa magnitud con `data.DIR`, no las RPM anticipadas de `motion`. Clientes
anteriores pueden ignorar el campo; no se modifica `/ws/esp32`.
No existe un segundo mando del gemelo ni un PID ejecutado en React.

## Desarrollo y verificación

Para modificar la interfaz: `npm ci`, iniciar `node server.mjs` y, en otra
terminal, `npm run dev`. Vite reenvía `/ws` al servidor local del puerto 8000.
El cambio de puerto para desarrollo se configura en `vite.config.ts`.

Pruebas: `node --experimental-strip-types --test tests/*.test.mjs`.
Incluyen clientes WebSocket locales de prueba, sin dispositivo físico.
Para actualizar la versión ejecutable: `npm run build`.

Las pruebas incluyen el protocolo, múltiples webs, rampas a distintos FPS,
encoder con actualización cada segundo, marcha sin objeto, aparición y
pérdida del objeto, ruido ultrasónico acotado, ciclos de parada/rearranque,
consultas rápidas acotadas, ambos sentidos y límites. El modelo dinámico se valida contra una
exponencial matricial independiente. No hubo pruebas con una cinta física.
Verificar polaridad, velocidad nominal, tolerancia, rampas y ganancias con el
equipo real. Al iniciar el proceso del servidor el PID parte desactivado;
una vez activado, perder el enlace no cambia esa selección.

### Solicitudes de simulación (solo navegador-servidor)

`{"type":"fault","id":"id-unico","key":"perdida_vel","enabled":true}`

Claves: `perdida_vel`, `sobrecarga`, `deslizamiento`. Requiere telemetría
reciente. Respuesta `fault-result` con `ack` o `rejected`; difusión `faults`
con `state` (claves activas y tiempo de activación). El snapshot inicial
incluye `faults`. No cambia el protocolo de la ESP32. Los comandos físicos
manuales generados por la simulación llevan `source: "fault"` en la web.
Al perder el enlace con la ESP32 se limpian las fallas y se difunde el estado.
