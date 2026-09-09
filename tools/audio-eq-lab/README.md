# Hirmos Audio Lab

Laboratorio local y aislado para validar procesamiento de audio antes de
integrarlo en el reproductor de Hirmos. No consume la API, PostgreSQL,
Navidrome ni credenciales; los archivos elegidos permanecen en el navegador.

## Ejecutar

Desde la raíz pública `app/`:

```bash
npm run audio-lab
```

Abrir la URL local que muestra Vite. Para probar desde un teléfono en la misma
red puede usarse expresamente `npm run audio-lab -- --host 0.0.0.0`; no se debe
exponer el laboratorio a Internet.

## Qué valida esta versión

- ruta `Sin EQ` seca y sin ninguna ecualización;
- control tonal manual de tres bandas anchas y tres coberturas temporales para
  comparar: Hi-Fi (100 Hz/1 kHz/10 kHz), Amplia (120 Hz/1 kHz/6 kHz) y Más
  perceptible (150 Hz/1,2 kHz/4 kHz);
- controles centrados en 0 dB, con rango de -6 a +6 dB y pasos de 0,5 dB;
- rango diagnóstico temporal de ±12 dB con contrastes grave arriba/agudo abajo
  y el inverso; `Restablecer` recupera el modo, rango y curva anteriores;
- modos `Sin EQ`, `General` y `Según la música`;
- ajustes contextuales para canción, álbum, artista y género, resueltos con la
  precedencia canción → álbum → artista → género → general;
- persistencia exclusivamente local al navegador para probar la interacción;
- reserva común de preamp en ambas rutas cuando existe boost, para reducir el
  riesgo de saturación sin favorecer A/B por volumen;
- comparación directa entre Original y Con EQ;
- curva de respuesta visible y actualización suave de los filtros.

La señal técnica incorporada comprueba el cableado y permite reconocer cada
banda. La aceptación de preferencia debe hacerse con música real y distintos
dispositivos de salida.

## Límites deliberados

- No analiza ni repara chasquidos, clipping o defectos del archivo.
- No compensa una pérdida auditiva ni reemplaza una evaluación audiológica.
- El género no genera curvas automáticamente; solo identifica un ajuste que el
  usuario creó de forma explícita.
- La persistencia usa `localStorage`: no representa todavía sincronización por
  usuario, dispositivo ni PostgreSQL.
- El rango ±12 dB solo descarta un procesamiento demasiado sutil o un fallo de
  ruteo; no debe guardarse como recomendación musical sin pruebas posteriores.
- La cadena automática anterior se conserva en módulos y pruebas como
  exploración, pero ya no dirige la interfaz principal del laboratorio.

## Verificación

```bash
npm run audio-lab:test
npm run audio-lab:typecheck
npm run audio-lab:build
```
