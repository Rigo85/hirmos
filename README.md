# Hirmos

> Tu música, sin perder el hilo.

Hirmos es un reproductor web para servidores compatibles con OpenSubsonic.
Mantiene una cola y una sesión de reproducción por usuario para que otro
navegador pueda controlar el dispositivo activo o continuar la música mediante
**Reproducir aquí**.

La instancia en producción está disponible en
[hirmos.rji-services.org](https://hirmos.rji-services.org). El acceso requiere
una invitación.

## Funciones actuales

Estas funciones describen el código de esta revisión. La instancia publicada
puede usar una versión anterior; un push no implica despliegue automático.

- Interfaz Angular responsive con biblioteca, búsqueda y detalles de artistas y
  álbumes.
- API Fastify y coordinación en tiempo real mediante Socket.IO.
- Autenticación propia multiusuario con invitaciones y recuperación.
- Cola, posición, dispositivo activo y actividad guardados en PostgreSQL.
- Playlists personales privadas: crear, duplicar, editar, ordenar y añadir pistas
  o álbumes. Hasta 5.000 entradas, búsqueda y paginación; reproducir materializa
  una copia completa sin que las ediciones cambien la cola activa.
- Cola editable: solicitudes manuales prioritarias, reproducir a continuación,
  añadir al final, mover por arrastre o destino explícito, quitar apariciones,
  vaciar siguientes y guardar como playlist. Reemplazo confirmado y deshacer
  eliminaciones durante 30 segundos si la cola/reproducción no cambió.
- Descargas de originales y modo offline independiente, con biblioteca local,
  cola propia y reporte de escuchas al regresar explícitamente online.
- Gestión de cuentas y sesiones, renovación de acceso sin expulsar del modo
  local y estado administrativo de backups.
- Hábitos por artista, álbum y canción con períodos de 7 días, 30 días, 12
  meses o todo el historial disponible.
- Adaptador genérico de fuentes musicales, actualmente implementado para
  Navidrome/OpenSubsonic.
- Streaming con rangos, carátulas, metadatos enriquecidos y letras con proveedor
  público y fallback de la fuente musical.
- Canciones populares cacheadas como IDs del catálogo, con actualización
  durable, vacíos no destructivos y revalidación administrativa en segundo
  plano.

La búsqueda de letras mantiene el orden AMLL → LRCLIB → OpenSubsonic.
LRCLIB intenta los metadatos originales, una limpieza conservadora de etiquetas
editoriales del álbum y finalmente búsqueda por artista/título. Valida identidad,
versión y duración; no elige a ciegas entre letras contradictorias. Las consultas
comparten un presupuesto de 6,5 segundos y un solo reintento adicional. Una caída
no se guarda como ausencia ni elimina letras válidas. Cambiar la estrategia de
búsqueda invalida únicamente los resultados negativos antiguos, no las letras
descargadas ni sus ajustes personales.

## Estructura

```text
apps/web            Aplicación Angular
apps/api            API Fastify y Socket.IO
packages/contracts  Contratos compartidos
packages/domain     Reglas puras del dominio
database/migrations Migraciones PostgreSQL
scripts             Utilidades de desarrollo y pruebas
tools/cue-splitter  Divisor manual y seguro de imágenes FLAC/APE con CUE
```

## Desarrollo local

Requiere Node.js 24 y Docker.

```bash
docker compose -f compose.dev.yml up -d --wait
npm install
npm run build
DATABASE_URL=postgres://hirmos_app:hirmos-dev-only@127.0.0.1:55432/hirmos npm run db:migrate
```

Copia `.env.example` y genera una clave `DATA_ENCRYPTION_KEY` base64url de 32
bytes. El administrador inicial se crea mediante `npm run auth:bootstrap-admin`;
la contraseña se suministra por entrada estándar y nunca se guarda en el
repositorio.

Para trabajar en desarrollo:

```bash
npm run dev:api
npm run dev:web
```

## Verificación

```bash
npm run build
npm run typecheck
npm test
npm run test:e2e
```

`npm run test:backup` prueba validación de manifiestos, conexión, retención y
protección de archivos ajenos. `npm run test:cache:pg` verifica referencias,
gracia y concurrencia contra la base local desechable descrita abajo; requiere
`npm run build:api`. `npm run test:backup:pg` usa esa misma conexión para crear
y eliminar **dos bases sintéticas adicionales**, con prefijos `hirmos_backup_test_`
y `hirmos_restore_test_`:
requiere CREATEDB, `pg_dump`/`pg_restore` y `/dev/shm` montado. Es una restauración
real aislada, no un backup de la base de trabajo. No apuntar estos tests a producción.

## Base de descargas (experimental)

La API autenticada `GET /api/music/tracks/:reference/download` obtiene el
original a través de `MusicSourceAdapter` y la operación pública
[download de OpenSubsonic](https://opensubsonic.netlify.app/docs/endpoints/download/).
No usa el hilo de reproducción, no registra escuchas y no conserva audio en el
servidor. La sección **Descargas** permite guardar originales de pistas,
álbumes, playlists y Favoritos, ver progreso/espacio, verificar archivos y borrarlos con
confirmación. Las marcas de descarga también aparecen en las listas online.
La navegación local ofrece Álbumes, Artistas, Playlists y Canciones, búsqueda
completa, ordenación y páginas de50 elementos. Transferencias y Almacenamiento
son herramientas separadas de esa navegación. Agrupar por álbum no solicita
descargarlo entero. Las descargas anteriores pueden actualizar sus fichas sin
volver a transferir audio; los archivos existentes se conservan.
En **Favoritos → Descargar originales** se prepara toda la selección actual
(hasta5.000 canciones), no solo la página visible. Se guarda como **Favoritos**
en **Descargas → Playlists**. **Actualizar descarga** renueva esa selección
manualmente: reutiliza originales completos y conserva como pistas individuales
las canciones desmarcadas. Cambiar el corazón no descarga ni elimina archivos.
Una preparación incompleta no reemplaza la selección anterior; una transferencia
ya preparada se retoma desde **Transferencias → Continuar**. No se descarga una
selección parcial cuando supera el límite.
El perfil local y el inventario se conservan tras caducar o cerrar la sesión
online. La renovación se ofrece dentro de la aplicación, sin cambiar de modo ni
reanudar transferencias. `/local` reproduce los originales desde OPFS, con cola,
posición, shuffle y repetición independientes del hilo online. Recuperar conexión
no abandona ese modo. La cola local se restaura en pausa; el perfil local no
autoriza llamadas a la API.
En modo offline no se permite marcar ni desmarcar favoritos. Las escuchas locales
se registran aparte de la cola: avances reales de audio, sin contar saltos de seek.
El reporte se conserva por cuenta al cerrar sesión y solo se envía al volver
explícitamente online con sesión válida de esa misma cuenta. Reintentar no duplica
estadísticas; se usa la fecha de escucha, no la de envío. No altera el hilo online
ni envía scrobbles a terceros. **Descargas → Almacenamiento** muestra tramos
pendientes y retenidos para revisión, sin activar envíos al consultar el panel.
Las respuestas de favoritos quedan aisladas por contexto de acceso. Al reintentar
una descarga inválida se completa primero la limpieza recuperable del intento
anterior; los archivos desconocidos no se eliminan automáticamente. Pausa cancela
un Play pendiente de obtener control local, sin alterar la cola online.

El panel de cola también funciona en la isla: añadir sin reproducir, seleccionar
una pista de la cola, mover siguientes, quitar entradas y vaciar siguientes.
Mantiene una sola aparición por pista y hasta5.000 canciones, con páginas de50.
Quitar de la cola no elimina archivos; quitar la actual pide confirmación y
conserva la pausa si estaba pausada. Cambiar siguientes no reinicia la actual.

La compilación de producción incluye un service worker de Angular para el
código, estilos e iconos de la aplicación, también sus pantallas diferidas.
Requiere HTTPS (o loopback) y una primera preparación con conexión. Después
permite abrir o recargar Descargas sin servidor; no basta `ng serve` para probarlo.
No cachea API, sesiones, audio remoto ni Socket.IO. Los originales e índices
locales se conservan aparte: cambiar la versión de la aplicación no los elimina.
Las actualizaciones no fuerzan recargas ni interrumpen una reproducción abierta.
No borres los datos del sitio para actualizar: también eliminarías tus descargas.
El navegador todavía puede retirar datos por cuota o acciones del usuario.
**Descargas → Almacenamiento → Comprobar aplicación offline** verifica los hashes
de los archivos públicos guardados. La primera comprobación necesita modo online
para obtener el manifiesto; después puede revisar la última referencia guardada
sin red. No recarga, activa versiones ni borra datos. Es una comprobación puntual,
no una garantía frente a futuras expulsiones del navegador. «Verificar archivos»
comprueba la música por separado.

Las descargas preparan portadas y letras después del audio. Para archivos
anteriores, **Descargas → Transferencias → Preparar portadas y letras** conserva
los originales. Los auxiliares se guardan junto al audio: cerrar sesión no los
elimina y eliminar la descarga también los retira. Una letra solo se sustituye
si mejora de texto a líneas o palabras; el ajuste de sincronía offline es local.
En la isla, portadas y letras nunca consultan servidores. Fallar estos auxiliares
no invalida música descargada. Los tamaños por canción corresponden al audio;
los auxiliares consumen también cuota del navegador.

La recuperación y la concurrencia cuentan con pruebas automatizadas y ensayos
aislados. Sigue pendiente la validación física y prolongada en Android
Chrome/Brave, incluidos cortes durante la preparación. Esas pruebas no se dan
por superadas únicamente por compilar o desplegar la aplicación.
No hay conversión de formatos. El reporte offline no se envía por recuperar red
mientras se permanece en la isla. No sincroniza cola, posición ni favoritos.
Sus checkpoints normalmente se guardan cada5s: un cierre forzado puede perder el
último tramo no confirmado; suspensión del navegador o fallo de almacenamiento
pueden ampliar esa ventana. La reproducción no depende de poder enviar el reporte.
Las migraciones incluyen0022 para recibos y ejecuciones offline. No se infieren
skips ni finalizaciones a partir de cierres técnicos. No hay una purga automática
de los recibos de deduplicación.
`npm run build:web && npm run test:offline-shell` comprueba la precarga,
integridad del build y exclusión del tráfico privado del worker.
`npm run test:offline-listens:pg` usa `HIRMOS_TEST_DATABASE_URL` exclusivamente
contra una base sintética local `hirmos_core_test`, en un esquema desechable.
`npm run test:offline-listens:browser` valida IndexedDB/reinicio en un perfil
temporal de Chromium; permite `CHROME_PATH` para usar un Chrome instalado.
En loopback, `/lab/local-session` comprueba renovación/cancelación con audio
sintético y transporte simulado, sin modificar cuentas, cookies o música real.

Transfiere por streaming con backpressure, dos descargas por usuario y ocho
globales en el proceso. Presupuesto de cabeceras12s con dos intentos; cuerpo
máximo30min e inactividad60s. Cancelar cliente cancela proveedor. Rechaza errores
XML/JSON/HTML presentados como HTTP200, respuestas parciales inesperadas y tamaños
inconsistentes. `no-store` impide que la caché HTTP sustituya el inventario offline.
En este corte solo archivos completos: `Range`/`If-Range` se rechazan explícitamente,
sin empalmar versiones. Una reanudación futura necesita validadores estables.

`npm run build:api && npm run test:downloads` prueba transporte HTTP real con
servidores efímeros loopback y audio sintético, sin PostgreSQL ni fuentes reales.
Incluye cancelación, límite simultáneo, truncamiento y `Retry-After`.

El almacenamiento experimental usa IndexedDB para el inventario y OPFS para
los bytes, separados por identidad estable de cuenta, nunca por sesión HTTP.
No convierte audio ni elimina descargas por logout o falta de espacio. Solo
marca un archivo listo después de cerrar/verificar su escritura y publicar un
manifiesto de recuperación; detecta ausencia, tamaño incorrecto y alteraciones
mediante una huella SHA-256 por bloques versionada (no es un checksum del origen).
La conciliación recupera un índice perdido cuando quedan manifiesto y archivo
válidos; conserva sin adoptar archivos ambiguos, sin borrarlos automáticamente.

Las colecciones comparten una copia de cada pista por cuenta. Una playlist se
lee completa a una revisión fija, no solo su página visible; se guarda esa
selección sin seguir ediciones remotas automáticamente. Tras recargar o volver
a entrar, continuar una descarga pendiente requiere una acción explícita.
Las completas se reutilizan; un archivo interrumpido se descarga desde el inicio.
El gestor cancela transferencias al cambiar de cuenta, respeta `Retry-After` y
comprueba que la respuesta pertenece a la cuenta solicitante. Borrar un archivo
local actualiza todas sus colecciones, nunca la biblioteca remota. El borrado
se registra antes de tocar los bytes para poder completarlo tras un corte.
Quitar una selección descargada conserva los archivos usados también por otras
selecciones o guardados individualmente. Eliminar archivos de todas las
selecciones requiere una confirmación distinta. Ambas operaciones se coordinan
con los escritores para que un trabajo anterior no restaure lo eliminado.

En un laboratorio local autenticado, `/lab/download-storage` permite ejecutar
pruebas con archivos sintéticos en un espacio separado y volver a inspeccionarlos
tras recargar. Ejecutar pruebas reemplaza únicamente sus datos sintéticos.
Requiere contexto seguro, IndexedDB, OPFS, Web Locks y WebCrypto; no tiene fallback
en memoria que simule persistencia. No prueba todavía reproducción, apertura sin
red, permiso de almacenamiento persistente ni compatibilidad Android/Brave real.
`npm test` incluye las pruebas unitarias de esta base.

## Backups del servidor

`npm run backup` crea un respaldo **sin cifrar** de una base Hirmos: dump custom,
originales de letras referenciados en el mismo snapshot, configuración elegida
explícitamente y manifiesto SHA-256. Requiere PostgreSQL cliente compatible,
Linux con `findmnt`, Node.js y acceso de lectura a datos/configuración Hirmos.
Requiere la migración `0021_backup_status.sql`; el rol de backup necesita además
SELECT/INSERT/UPDATE sobre `backup_status`, y el rol de API solo SELECT sobre ella.
No respalda la música del servidor musical ni descargas guardadas en navegadores.

Configura `HIRMOS_BACKUP_CONFIG` con la ruta absoluta de un JSON basado en
`tools/backup/config.example.json`, y `HIRMOS_BACKUP_DATABASE_URL` con la conexión
privada. Guarda ambos fuera del repositorio. Incluye en `files` los archivos
runtime necesarios para restaurar, especialmente la clave de cifrado de
credenciales de fuentes; `release` identifica la versión desplegada.

El destino debe estar dentro de un volumen montado distinto de `/`, separado de
la caché, y su nombre comenzar por `hirmos-backups`. Si falta montaje, falla sin
escribir en la partición del sistema. Los backups contienen datos sensibles:
restringe acceso al volumen. Se solicitan permisos privados, pero no todos los
filesystems los respetan; **esto no sustituye cifrado ni copia externa**.

Publica la copia solo tras verificar archivos/hashes y `pg_restore --list`.
Mantiene 14 representantes diarios, 8 semanales y 6 mensuales sin duplicarlos;
rota únicamente generaciones verificadas propias y aborta ante archivos ajenos.
Los `.pending-*` de fallos quedan para inspección manual, nunca se consideran
válidos. `--list` no reemplaza una restauración real periódica en una base aislada.
El lock PostgreSQL impide respaldos solapados y libera al morir el proceso.

`deploy/hirmos-backup.service.example` y `.timer.example` son **plantillas**, no
instalación automática. Ajusta usuario, runtime y rutas antes de instalar. No se
incluye todavía restauración productiva automatizada. Una copia en el mismo host
no protege contra perder todo el equipo.

### Recuperación controlada

No restaures sobre una base en uso ni arranques la aplicación inmediatamente
después de importar el dump. Procedimiento para el esquema actual:

1. Usa una copia confiable, verifica su manifiesto con `verifyBackup` de
   `tools/backup/backup.mjs` y comprueba la versión de aplicación/migraciones.
   Un dump puede ejecutar SQL: sus hashes detectan corrupción, no acreditan su
   procedencia. Usa clientes PostgreSQL de la misma versión mayor que el servidor
   de origen para este procedimiento; no supongas compatibilidad hacia atrás.
2. Crea una base **nueva, vacía y aislada**, llamada `hirmos_restore_<identificador>`.
   No conectes API, workers ni correo a ella. Restaura con `pg_restore`, usando
   `--single-transaction --exit-on-error --no-owner --no-acl`. Confirma el destino
   explícitamente y prepara los roles/grants exclusivos de Hirmos por separado.
3. Recupera la configuración privada sin imprimirla ni copiarla al repositorio.
   En una caché nueva, copia cada `lyrics/<hash>` del backup a
   `objects/sha256/<primeros 2>/<siguientes 2>/<hash>` y verifica su SHA-256.
   Comprueba que la clave respaldada permite descifrar las credenciales; no
   reemplaces archivos ni configuración de una instancia existente.
4. Define `HIRMOS_RESTORE_DATABASE_URL` de forma privada apuntando a esa copia y
   ejecuta `node tools/backup/prepare-restored.mjs --confirm-database hirmos_restore_<identificador>`.
   Rechaza otros nombres, discrepancias y clientes ya conectados. Revoca sesiones,
   invitaciones y recuperaciones anteriores, cancela correos pendientes y libera
   leases, dejando la reproducción pausada y conservando cola/posición. Conserva
   estadísticas, playlists, favoritos y recibos de idempotencia. Un fallo de
   esquema revierte toda esta preparación. La comprobación de conexiones no
   sustituye mantener la copia aislada durante el procedimiento.
5. Valida integridad, contenidos y permisos antes de autorizar la promoción.
   Revisa usuarios/contraseñas/accesos modificados después del snapshot: una copia
   antigua no puede conocer esas revocaciones. Reactivar servicio y programadores
   es otra operación; esta herramienta no cambia PM2 ni conexiones de producción.

`npm run test:backup:pg` ensaya backup y restore completos con datos sintéticos,
configuración, letras, estado de acceso y colecciones, y limpia sus bases y
archivos temporales. Requiere `HIRMOS_TEST_DATABASE_URL` en loopback, base
`hirmos_core_test`, clientes PG compatibles y un destino temporal montado.
La copia representa el instante del snapshot, no los cambios posteriores;
la prueba no equivale a una restauración productiva ni a una tarea mensual activa.

Los administradores pueden consultar `/admin/backups`: último intento, etapa,
fecha del snapshot verificado, tamaño y duración. Avisa tras 36 horas sin copia
nueva. Un único registro PostgreSQL conserva el último éxito aunque falle un
intento posterior; el bloqueo del trabajo distingue ejecución activa de un corte.
Un fallo de retención posterior a publicar una copia se muestra como advertencia,
no borra el último éxito. No expone rutas, conexión ni errores crudos.

El panel se actualiza cada minuto mientras está visible, no instala la tarea ni
envía correo. Si el proceso no llega a conectar a PostgreSQL o leer su configuración,
no puede registrar ese intento: revisar también el registro de la tarea. El
estado acredita la verificación al crear la copia, no su integridad continua ni
una restauración posterior. El respaldo contiene un estado de trabajo en curso;
tras restaurar se verá interrumpido hasta ejecutar un nuevo respaldo.

La limpieza de caché requiere migración `0020`: registra objetos sin referencia
y espera siete días desde su detección antes de eliminarlos. Publicación y GC
se coordinan con PostgreSQL; un hash republicado pierde su marca de huérfano.
Los temporales cuentan para cuota pero no se borran ciegamente; letras vigentes
y miniaturas protegidas no se expulsan para cumplirla. Los backups mantienen
sus letras referenciadas mientras copian el snapshot.

### Pruebas transaccionales de reproducción

`npm run test:sessions:pg` usa también `HIRMOS_TEST_DATABASE_URL` local/desechable
y un esquema temporal propio. Comprueba listado privado, cierre selectivo/global,
auditoría atómica, concurrencia y desconexión real de sockets. Mi cuenta (`/account`)
permite gestionar sesiones del navegador; no son dispositivos ni pestañas. Cerrar
una no elimina playlists, cola o historial y cerrar las demás conserva la actual.
No expone tokens ni IPs. Mi cuenta permite cambiar contraseña confirmando la
actual: renueva esa sesión, cierra las anteriores y conserva la cola.
Administración/Cuentas permite buscar usuarios, modificar rol/activación con
reautenticación, reenviar/revocar invitaciones y consultar eventos de seguridad.
Nunca permite eliminar el último administrador activo. Reactivar una cuenta
no revive sus sesiones anteriores. No incluye borrado de cuentas ni MFA.

`npm run test:accounts:pg` verifica estas operaciones, carreras de credenciales,
versiones de edición, enlaces de un solo uso y rollback de auditoría en esquemas
temporales de la misma base local desechable. No envía correos ni usa datos reales.

Las garantías transaccionales de reproducción tienen una batería adicional con
PostgreSQL real y sockets locales. Tras `npm run build:api`, configura
`HIRMOS_TEST_DATABASE_URL` apuntando a una base **desechable** llamada
`hirmos_core_test` en `127.0.0.1` o `localhost` y ejecuta
`npm run test:playback:pg`. El script crea y elimina únicamente su esquema
temporal; rechaza otros hosts/nombres de base. No utiliza usuarios ni música
reales, ni necesita un servidor musical.

`npm run test:playlists:pg` usa la misma restricción de base desechable y un
esquema temporal independiente. Comprueba propietarios, reintentos, conflictos,
duplicados, ausencias y una lista de 5.000 entradas completa. Las playlists
requieren además la migración `0016`; no reutilizan listas de la cuenta musical
compartida.

`npm run test:queue:pg` valida prioridad, concurrencia, reintentos, confirmaciones,
guardado, deshacer, rollback y capacidad con la misma base desechable. La cola
requiere `0017`; `0018` conserva la procedencia de las nuevas listas guardadas
desde la cola para reanudar su aparición actual sin reemplazarla. Listas previas
sin procedencia no se emparejan por título o posición. La vista carga bloques de 100 filas; los mensajes periódicos
de progreso no retransmiten la cola completa. Favoritos y playlists resuelven
su colección completa en el servidor, sin limitarla a la página visible.

Playlists y cola admiten una sola entrada por pista de una fuente. Añadir un
álbum incorpora solo las que faltan, sin mover las existentes; un lote A–B–A
conserva A–B. Versiones distintas no se fusionan por título. La migración `0019`
normaliza datos anteriores: en playlists conserva la primera aparición; en una
cola conserva preferentemente la que está sonando, sin cambiar posición,
ejecución o historial. Requiere respaldo y despliegue coordinado. Descarta los
deshacer anteriores para que no restauren duplicados. `npm run test:unique:pg`
verifica la migración y esta política en esquemas locales desechables.

La repetición pertenece al hilo: desactivada, toda la cola o una pista. Se
conserva al pausar, recargar y transferir; iniciar otro contexto la desactiva.
Siguiente manual sale de repetir una pista sin apagar el modo. Toda la cola
recorre el orden visible, también si fue barajado, sin volver a sortearlo.
Anterior reinicia después de tres segundos; antes retrocede y solo vuelve al
final con repetición de cola. No se usa `audio.loop` independiente del servidor.
`npm run test:repeat:pg` comprueba estas reglas, ejecuciones nuevas, reintentos,
concurrencia, fallos e historial en la misma base desechable. Se reutiliza la
columna reservada `repeat_mode`; no requiere una migración adicional.

Vaciar siguientes conserva la pista actual. Quitar la última pista seleccionada
detiene y limpia el reproductor; no queda un Play habilitado sin destino.
Añadir a una cola vacía prepara las canciones sin iniciar audio; Play comienza
por la primera pendiente del orden existente. Las anteriores no se vuelven a
reproducir implícitamente. Los reportes tardíos no reactivan una ejecución detenida.

Para una prueba manual integrada con navegador, `scripts/serve-playback-fixture.mjs`
sirve el build final, autenticación y sockets reales contra esa misma base
**desechable**, previamente migrada. Usa los puertos locales 3313/3314 y genera
audio sintético; no contacta proveedores públicos. Ejecutar con
`HIRMOS_TEST_DATABASE_URL` y abrir `http://127.0.0.1:3313`; la consola indica la
cuenta ficticia. Dos pestañas nuevas representan dos reproductores independientes.
El control local `POST http://127.0.0.1:3314/__fixture/state` acepta JSON
`{"mode":"missing","track":"2"}`; modos: `healthy`, `missing`, `unavailable`,
`stall` y `corrupt`. `SIGUSR2` al proceso de este fixture corta sus sockets, no
el audio HTTP. Detenerlo y retirar únicamente su base/contenedor desechable al
terminar. No es parte del servidor productivo ni una prueba automática completa.

Con ese laboratorio activo y el build web actualizado, la regresión visual de
álbum y encabezado se ejecuta desde la raíz del repositorio:

```bash
HIRMOS_ALBUM_LAYOUT_LAB=1 HIRMOS_E2E_ORIGIN=http://127.0.0.1:3313 npm run e2e -w @hirmos/web -- album-mobile.spec.ts
```

Comprueba desbordamiento móvil (320/360/390 px), búsqueda y menú hasta 760 px,
texto ampliado, botones de descarga y escritorio con menú expandido/contraído.
Usa cuentas y descargas sintéticas en contextos aislados de Chrome; no sustituye
la validación física en Android. Rechaza orígenes distintos del laboratorio.

Para revisar la legibilidad móvil de recientes y pistas de álbum, iniciar el
mismo fixture con `--track-layout`. Añade títulos largos y un artista distinto
al conjunto sintético, y puebla recientes sin generar escuchas reales. No usar
esta opción para validar estadísticas de historial.

```bash
HIRMOS_TRACK_LAYOUT_LAB=1 HIRMOS_E2E_ORIGIN=http://127.0.0.1:3313 npm run e2e -w @hirmos/web -- track-layout.spec.ts
```

Comprueba títulos y controles a 320/360/390/412 px, texto ampliado, indicadores
de descarga, Play/Pausa, favoritos y conservación del diseño de álbum en escritorio.

El fixture admite además `HIRMOS_FIXTURE_CATALOG_FILE` con una muestra JSON
privada fuera de este repositorio (versión1, `albums`, `songs` y `covers` con
raster base64). Importa solo campos permitidos de metadatos y portadas, con
límites de tamaño; no importa URLs, credenciales, cuentas ni audio. Mantener
las muestras reales fuera de Git público. El audio sigue siendo un tono
sintético de180segundos, no la grabación ni su duración real. La cola, favoritos
y escuchas de prueba permanecen en la base desechable. Los recientes se pueblan
artificialmente: este modo no valida estadísticas reales.
`catalog-layout.spec.ts` usa esa misma variable y origen loopback para comprobar
la presentación con la muestra, incluidas portadas y ausencia de requests externos.
También verifica escritorio a 1077/1280/1920 px con menú lateral expandido y
contraído: metadatos, favorito directo, controles alineados y barra de 76 px.
Las tarjetas de recientes comparten distribución en móvil y escritorio:
portada e identidad arriba, controles debajo y título de hasta dos líneas.
El diseño compacto de las listas sigue limitado a móvil; en álbum móvil,
el favorito se gestiona desde las opciones de cada canción.

Las listas compartidas (populares de artista, Biblioteca→Canciones, búsqueda,
Favoritos, géneros, actividad y canciones de hábitos) usan también la fila
compacta móvil. Conservan sus vínculos y métricas; el carrusel de recientes
tiene su propia distribución. Escritorio conserva metadatos y favorito directo.
Quitar desde el menú de Favoritos retira la fila solo tras confirmación; ante
fallo conserva la canción. Al retirarla se cierra su menú.

```bash
HIRMOS_FIXTURE_CATALOG_FILE=/ruta/privada/muestra.json HIRMOS_E2E_ORIGIN=http://127.0.0.1:3313 npm run e2e -w @hirmos/web -- shared-track-lists.spec.ts catalog-layout.spec.ts
```

La regresión de listas recorre las ocho vistas a320/360/390/412 y1077/1280px,
incluye scroll de populares, texto ampliado, navegación al álbum y favorito
desde menú/directo. Usa datos visuales simulados en actividad/hábitos/género,
sin insertar escuchas ni conectar el laboratorio a producción. Playlists,
cola y Descargas tienen componentes propios; no se rediseñan en este ajuste.

El protocolo de reproducción v5 y las playlists requieren las migraciones `0013` a `0019`, API y web de la
misma versión. Las pestañas anteriores deben recargarse; no se admiten comandos
antiguos sin identidad de ejecución. El registro de actividad se confirma junto
con cada comando y un trabajador interno actualiza el historial después, sin
añadir Redis ni otro proceso de despliegue.

Los fallos aislados de audio admiten recuperación acotada y después un salto
registrado al siguiente elemento del orden actual. Tres fallos consecutivos o
el presupuesto compartido agotado detienen los saltos; los bloqueos confirmados
de servicio, sesión o conexión local no recorren la cola. La interfaz
ofrece motivo, detalle de incidentes y reintento explícito. Los fallos técnicos
no se contabilizan como rechazo musical ni como finalización. Las pruebas
automáticas cubren concurrencia, rollback, intentos tardíos y límites; no
sustituyen pruebas de audio en dispositivos y navegadores reales.

El permiso de autoplay es un estado de espera, no un fallo de pista. Conserva
cola y posición confirmada y ofrece continuar mediante un gesto local cuando el
navegador lo exige. No genera incidentes ni saltos. Los avisos técnicos se pueden
cerrar por completo y recuerdan el cierre por cuenta/navegador; su historial
queda accesible en la cola. No se garantiza autoplay sin interacción en todos
los navegadores.

La resolución por lote conserva resultados parciales y causas por pista: una
caída temporal no se presenta como contenido inexistente. La recuperación y
precarga respetan la espera solicitada por el proveedor; una pausa concurrente
con un fallo conserva la pausa y habilita el reintento explícito. No se añaden
servicios ni dependencias de infraestructura para este mecanismo.

Los archivos de este repositorio no incluyen credenciales, inventario de
infraestructura ni configuración real de producción.

## Imágenes lossless con CUE

El repositorio incluye una herramienta independiente para materializar una
imagen FLAC o APE acompañada por `.cue` como pistas FLAC que Navidrome pueda indexar.
No forma parte del backend ni convierte a Hirmos en servidor de archivos.

El análisis predeterminado no escribe nada:

```bash
npm run cue:split -- "/music/Artist/Album"
```

Después de revisar el plan, la creación se solicita explícitamente:

```bash
npm run cue:split -- --apply "/music/Artist/Album"
```

La herramienta acepta imágenes lossless FLAC o APE, comprueba si las pistas ya
existen, rechaza conjuntos parciales o ambiguos, produce FLAC, escribe metadata
y portada, y valida tanto cada salida como la identidad del PCM concatenado
antes de publicarla. Nunca elimina ni mueve la imagen o el `.cue` originales.
La generación y las validaciones ocurren primero en almacenamiento temporal
local; después copia cada resultado a un nombre oculto, verifica su SHA-256 y
lo publica. Esto permite usar destinos SMB/GVFS que no ofrecen las operaciones
de reescritura que el muxer FLAC necesita al cerrar un archivo. Conserva el
audio anterior al primer `INDEX 01`, admite portadas incrustadas e ISRC/disco,
y publica sin reemplazar destinos existentes. Usa un bloqueo por carpeta y
diario para recuperación explícita con `--recover` tras una interrupción.
Al finalizar crea o actualiza `.ndignore` para que Navidrome excluya solamente
la imagen original y continúe indexando las pistas separadas.

Las capacidades, límites y procedimiento completo están en
[`tools/cue-splitter/README.md`](tools/cue-splitter/README.md).

## Importación de historial

Hirmos puede incorporar escuchas anteriores sin depender en tiempo de ejecución
de una API privada del servidor musical. El archivo de entrada es JSON Lines y
cada línea contiene `externalEventId`, `remoteTrackId` y `occurredAt`. La
operación exige asociar explícitamente el archivo con un usuario Hirmos, una
fuente y un proveedor; es transaccional e idempotente.

```bash
DATABASE_URL=postgres://hirmos_app:example@127.0.0.1:5432/hirmos \
HIRMOS_HISTORY_USER_EMAIL=listener@example.test \
HIRMOS_HISTORY_PROVIDER=example-export \
HIRMOS_HISTORY_FILE=/secure/path/history.jsonl \
npm run history:import
```

Los alias confirmados de un artista pueden agruparse sin alterar los metadatos
del servidor original mediante `npm run catalog:link-artists`. No se realiza
unión automática sólo por semejanza textual.

MusicBrainz es una fuente opcional de identificadores públicos: consultar su
API no exige una cuenta y Hirmos no depende de ella para calcular hábitos. Las
uniones dudosas siempre requieren confirmación explícita.

## Licencia

Hirmos se distribuye bajo la
[GNU Affero General Public License v3.0](LICENSE), exclusivamente en su versión
3 (`AGPL-3.0-only`).
