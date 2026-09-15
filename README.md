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
tools/cue-splitter  Divisor manual y seguro de imágenes FLAC con CUE
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

Los archivos de este repositorio no incluyen credenciales, inventario de
infraestructura ni configuración real de producción.

## Imágenes FLAC con CUE

El repositorio incluye una herramienta independiente para materializar una
imagen FLAC acompañada por `.cue` como pistas FLAC que Navidrome pueda indexar.
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
