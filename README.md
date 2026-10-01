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
- Hábitos por artista, álbum y canción con períodos de 7 días, 30 días, 12
  meses o todo el historial disponible.
- Adaptador genérico de fuentes musicales, actualmente implementado para
  Navidrome/OpenSubsonic.
- Streaming con rangos, carátulas, metadatos enriquecidos y letras con proveedor
  público y fallback de la fuente musical.
- Canciones populares cacheadas como IDs del catálogo, con actualización
  durable, vacíos no destructivos y revalidación administrativa en segundo
  plano.

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
