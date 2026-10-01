# Guía de lectura del código

## Ejecución

En Windows, `run.bat` inicia el servidor y habilita la red local. La consola muestra el título, la conexión local y una IPv4 detectada del equipo. El puerto anunciado respeta la configuración. Si hay varias interfaces, se prioriza una interfaz no virtual con dirección privada; no se verifica conectividad desde otros equipos. Si el sistema no permite consultar interfaces, se informa que la IPv4 no está disponible sin interrumpir el servicio.

El frontend compilado se encuentra en `dist/`. Para recompilar fuentes: `npm.cmd ci` y `npm.cmd run build` en Windows, o `npm ci` y `npm run build` en otros sistemas. `package.json` define dependencias y scripts; `package-lock.json` fija versiones. Ambos conservan JSON válido, sin comentarios. `tsconfig.json` define las comprobaciones de TypeScript.

## Recorrido principal

1. `server.mjs` sirve la web, inicia el CSV y adjunta el transporte.
2. `control/websocket.mjs` recibe la ESP32 en `/ws/esp32` y los navegadores en `/ws/ui`.
3. `shared/control-protocol.mjs` valida comandos y telemetría; `control/telemetry.mjs` calibra POS.
4. `control/pid.mjs` observa los datos, calcula el perfil de aproximación y el PID de velocidad, y simula G(s) por separado.
5. La muestra real y la predicción se registran juntas mediante `control/speed-csv.mjs` y se difunden a la web.
6. `app/use-lab.ts` recibe el estado; `app/lab-state.ts` conserva mediciones, historial, mandos y estado visual.
7. `app/control-dashboard.tsx` compone paneles; `app/trend-chart.tsx` dibuja las curvas; `app/viewer.tsx` mantiene la escena Three.js.

## Distinción entre magnitudes

- **Encoder físico:** `RPM_R` y `VEL_R`; no se reemplazan por una simulación.
- **Referencia ESP32:** `RPM_T` y `VEL_T`, calculadas a partir del motor y la transmisión en el firmware.
- **Modelo G(s):** predicción independiente obtenida con el comando aplicado; se compara en cm/s y con tiempo común.
- **Movimiento 3D:** observador `shared/encoder-motion.mjs`, que usa encoder y estado nativo para conciliar la ventana de medición con las transiciones.
- **Posición:** el firmware calcula POS a partir del ultrasónico y un offset. El backend aplica además su calibración existente de +3,7 cm; DIST no se altera. La OLED representa la POS del firmware y la web la POS calibrada por el backend.

## Control y fallas

El PID se ejecuta en el servidor. El perfil de distancia usa DIST y valida detección mediante POS; el lazo de velocidad usa VEL_R. La selección PID permanece hasta desactivación manual; las pausas y esperas no equivalen a desactivarlo.

Pérdida y sobrecarga reducen el comando físico mediante `control/faults.mjs`. El PID respeta el límite. Deslizamiento modifica la copia visual de posición y el cubo, no los datos físicos. Los comentarios describen esta separación aunque la etiqueta de la interfaz sea abreviada.

## Representación 3D

`app/transmission.ts` mantiene pivotes CAD y relaciones de engranajes. `app/belt.ts` desplaza texturas según el rodillo. `app/support-materials.ts` protege electrónica y ensambles por nombre. `app/rotor-materials.ts` aplica acabados y UV. `app/detected-object.ts` crea el cubo una sola vez y suaviza exclusivamente su movimiento visual.

Los radios del CAD usados para representar la correa pertenecen al modelo exportado; las conversiones de velocidad del firmware y de G(s) utilizan el diámetro físico configurado de 2,95 cm. Esta entrega documenta esas constantes sin modificarlas.

## Firmware entregado como main.c

Los comentarios describen pines, estructuras, secciones críticas, interrupciones, intérprete de comandos y tareas FreeRTOS. `control_task` concentra la actuación y adquisición; las tareas de pantalla y transporte leen copias o colas. STEP usa GPTimer; encoder y ECHO se capturan mediante interrupciones. USB, Bluetooth SPP y WebSocket comparten intérprete. No se ha añadido control PID dentro de la ESP32.

El archivo requiere las dependencias y configuración del proyecto ESP-IDF existente; no constituye por sí solo un proyecto completo. Se verificó que sus tokens ejecutables coinciden con el adjunto original. No se realizó compilación ESP-IDF en este entorno.

## Alcance de la documentación y validación

Se comentaron los módulos propios del frontend, backend, protocolo, estilos, scripts de arranque y pruebas. Los archivos de `vendor/`, los decodificadores Draco y `node_modules/` conservan su código y licencias de terceros. `dist/` contiene el resultado generado, que debe regenerarse desde las fuentes al modificarlas.

La aplicación web compiló correctamente. Pasaron las 87 pruebas existentes y las 2 pruebas del mensaje de inicio. El servidor arrancó, respondió HTTP y cerró ordenadamente. El JavaScript y CSS compilados coinciden con los del adjunto; el backend de control y main.c conservan su código ejecutable. La modificación funcional se limita al aviso de inicio y la consulta tolerante de IPv4. Las pruebas automatizadas no sustituyen la comprobación física del prototipo.
