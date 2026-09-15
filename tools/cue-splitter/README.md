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

Los cortes se calculan desde `INDEX 01` en muestras completas. Un `INDEX 00`
intermedio permanece al final de la pista anterior, igual que en la tabla de
contenidos del CD. Cada salida recibe título, artista, álbum, artista del álbum,
número/total, fecha, género y portada cuando están disponibles.

Las pistas se generan con nombres temporales y se validan mediante `ffprobe`
antes de tomar el nombre final. Además, la herramienta decodifica la imagen y
las salidas a una representación PCM común y exige que su SHA-256 concatenado
sea idéntico antes de publicar las pistas. Una ejecución exitosa crea
`.hirmos-cue-split.json` con las huellas de la fuente, del `.cue` y del PCM,
además de los límites de cada pista. Como último paso crea o amplía `.ndignore`
con una regla exacta para la imagen fuente: Navidrome ignora la imagen, pero
puede indexar las pistas separadas. Repetir `--apply` también repara esa regla
si falta, sin regenerar el audio.

La herramienta preserva cualquier regla previa de `.ndignore`. Si encuentra
uno vacío se detiene antes de generar, porque Navidrome interpreta ese estado
como exclusión del directorio completo. La imagen FLAC o APE y el `.cue`
originales no se eliminan ni se mueven.
