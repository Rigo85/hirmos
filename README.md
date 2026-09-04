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

## Estructura

```text
apps/web            Aplicación Angular
apps/api            API Fastify y Socket.IO
packages/contracts  Contratos compartidos
packages/domain     Reglas puras del dominio
database/migrations Migraciones PostgreSQL
scripts             Utilidades de desarrollo y pruebas
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

Todavía no se ha seleccionado una licencia. Hasta que se añada una, no se
concede una licencia de uso, modificación o redistribución del código.
