# Divisor de imágenes CUE

Herramienta independiente para convertir una imagen lossless FLAC o APE
acompañada por un archivo `.cue` en pistas FLAC etiquetadas. No forma parte del
backend ni del flujo de reproducción de Hirmos.

## Requisitos

- Node.js 24;
- `ffmpeg` y `ffprobe` disponibles en `PATH`;
- un directorio con exactamente un `.cue` y la imagen FLAC o APE que este
  declara.

Admite una única imagen FLAC o APE por `.cue`. Decodifica y vuelve a codificar
en FLAC, por lo que conserva las muestras y la calidad originales. No convierte
fuentes con pérdida.

## Uso seguro

Primero se ejecuta el análisis, que no escribe archivos:

```bash
npm run cue:split -- "/music/Artist/Album"
```

Para crear las pistas después de revisar el plan:

```bash
npm run cue:split -- --apply "/music/Artist/Album"
```

Antes de escribir, la herramienta examina todos los audios existentes y los
compara por número, título y duración. Si encuentra solo parte de las pistas o
una coincidencia ambigua, se detiene. Nunca sobrescribe deliberadamente un
audio existente.

También detecta un caso de cabecera CUE posiblemente invertida: todas las
pistas declaran el mismo artista, pero ese nombre figura como título del álbum
y la cabecera declara otro artista. Se detiene para revisar el CUE; no adivina
ni corrige etiquetas automáticamente. Esta comprobación no sustituye revisar
el plan y los metadatos antes de aplicar.

Se rechazan números TRACK repetidos, descendentes o fuera de 1–99, índices
duplicados/incoherentes y CUE que mezclen audio con datos. No se ignoran
silenciosamente las pistas no soportadas.

Los cortes se calculan desde `INDEX 01` en muestras completas. Un `INDEX 00`
intermedio permanece al final de la pista anterior, igual que en la tabla de
contenidos del CD. Cada salida recibe título, artista, álbum, artista del álbum,
número/total de pista, fecha, género, ISRC y número/total de disco cuando están
disponibles en el CUE o, para el disco, en la imagen fuente. Si existe audio
antes del primer `INDEX 01`, se conserva al inicio de la primera pista y se
anuncia en el plan; no se descarta audio oculto ni silencio inicial. La
comparación PCM comprende la imagen completa.

Para la portada se prefieren imágenes externas JPG/JPEG/PNG llamadas `cover`,
`folder` o `front`; también sirve una única imagen con otro nombre. Si no hay
selección externa, se aprovecha la portada incrustada de la fuente. Varias
imágenes sin prioridad y sin portada incrustada requieren identificar una con
uno de esos nombres. Las imágenes se incrustan como PNG; no se modifica el
audio. Una repetición sobre pistas completas no reetiqueta ni añade portadas
a archivos existentes.

Las pistas se generan en un directorio temporal del sistema y se validan
mediante `ffprobe` antes de tocar el destino. Además, la herramienta decodifica
la imagen y las salidas a una representación PCM común y exige que su SHA-256
concatenado sea idéntico. Solo entonces copia cada archivo secuencialmente a la
carpeta de trabajo oculta del álbum, verifica SHA-256 y publica por creación
exclusiva (`wx`): nunca reemplaza un destino existente mediante `rename`.
Este staging local evita depender de `seek` o reescrituras no
admitidas por algunos montajes SMB/GVFS. El sistema temporal debe disponer de
espacio suficiente para todas las pistas durante la ejecución.
El destino necesita espacio para las salidas y sus copias de recuperación
hasta que termine la operación.
Se puede elegir otro disco local mediante `TMPDIR=/ruta/temporal` antes del
comando; debe ser un sistema de archivos con escritura y posicionamiento normales.

Un bloqueo por carpeta impide dos ejecuciones del splitter sobre el mismo
álbum. Un diario registra la propiedad y huellas de las salidas. Si falla la
generación, validación o copia, revierte solo archivos demostrablemente propios;
si detecta cambios ajenos, se detiene y conserva el registro para revisión.
Una ejecución exitosa crea
`.hirmos-cue-split.json` con las huellas de la fuente, del `.cue` y del PCM,
además de los límites de cada pista. Como último paso crea o amplía `.ndignore`
con una regla exacta para la imagen fuente: Navidrome ignora la imagen, pero
puede indexar las pistas separadas. Repetir `--apply` también repara esa regla
si falta, sin regenerar el audio.

La regla usa el nombre del archivo **sin barra inicial**: Navidrome 0.63.2 no
rebasa las reglas ancladas de un `.ndignore` anidado al directorio que lo
contiene. Escapa los caracteres especiales según su matcher. Una repetición
con `--apply` añade la regla efectiva sin regenerar pistas ni reemplazar el
contenido de `.ndignore`. La regla antigua puede quedar como historial inocuo;
no se reescriben ni eliminan reglas del usuario.

La herramienta preserva las demás reglas previas de `.ndignore`. Si encuentra
uno vacío o con solo comentarios se detiene antes de generar, porque Navidrome interpreta ese estado
como exclusión del directorio completo. La imagen FLAC o APE y el `.cue`
originales no se eliminan ni se mueven.

## Interrupciones y recuperación

`SIGINT`/`SIGTERM` cancelan el trabajo y permiten revertirlo. Tras `SIGKILL` o
una interrupción brusca puede quedar `.hirmos-cue-work`. No la borres a ciegas:

```bash
npm run cue:split -- --recover "/music/Artist/Album"
```

Ejecuta la recuperación desde el mismo host y solo cuando el proceso anterior
haya terminado. Antes de la fase final, valida identidad/contenido y retira
las salidas propias (incluso una copia parcial), además del temporal local
registrado; después puedes repetir `--apply`. Si ya se verificaron las salidas
y solo faltaba cerrar `.ndignore`, conserva las pistas y termina la exclusión.
No elimina archivos ajenos ni usa únicamente el nombre para asumir propiedad.

La publicación no es atómica para el álbum entero: un escáner concurrente
podría observar salidas mientras se están copiando. El escaneo definitivo debe
hacerse después del éxito. El bloqueo es cooperativo: no edites la carpeta
desde otro programa durante el proceso. Si falta información de propiedad,
el diario está dañado, el PID sigue activo, cambió un archivo o se interrumpió
la propia recuperación, se requiere inspección manual. El diario usa `fsync`,
pero no garantiza supervivencia ante fallos de hardware/servidor SMB; si el
sistema de archivos no soporta las operaciones necesarias, falla de forma
conservadora. No se purgan registros ausentes de Navidrome.

## Verificación

`npm run cue:split:test` ejecuta pruebas unitarias e integrales (necesita
ffmpeg/ffprobe y permitir subprocesos Node). Las integrales usan audio sintético
y directorios temporales: PCM completo, portadas, metadata, colisiones,
interrupciones y recuperación. `HIRMOS_CUE_TEST_DIR` permite elegir un
directorio **de pruebas**, por ejemplo un montaje SMB; nunca la biblioteca
real. La prueba optativa
`npm run cue:split:test:navidrome` necesita Docker, ffmpeg y sqlite3: levanta un
Navidrome aislado, sin red ni biblioteca real, comprueba diez casos con su
escáner y elimina únicamente el contenedor y los temporales propios. Usa
`deluan/navidrome:0.63.2`; `NAVIDROME_TEST_IMAGE` permite probar otra versión.
Incluye el fallo antiguo como control negativo y nombres con puntuación para
evitar aceptar una corrección probada solo contra un matcher simulado.
