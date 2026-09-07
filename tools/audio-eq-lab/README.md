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

- ruta `Flat` seca y sin ninguna ecualización;
- perfiles Rock, Pop, Electrónica, Acústica y Clásica versionados;
- modo Automático que mezcla hasta tres perfiles usando etiquetas y rasgos
  acústicos de bajo peso;
- análisis local de pico de muestra, RMS, crest factor, muestras cercanas al
  límite, impulsos candidatos y distribución espectral;
- reducción estática conservadora de resonancias, sin boosts correctivos;
- tres bandas de EQ dinámica acotadas;
- reserva automática de preamp para las ganancias introducidas;
- comparación A/B con el mismo preamp en ambas rutas;
- prueba de cableado extrema que separa un fallo de ruteo de una curva musical
  demasiado sutil;
- exportación de análisis, evidencia y receta como JSON.

La señal técnica incorporada solo comprueba el cableado y la reacción del
motor. La aceptación de calidad debe hacerse con música real y distintos
dispositivos de salida.

Antes de evaluar perfiles, seleccionar **Prueba de cableado · cambio extremo**
y alternar A/B. No es una propuesta sonora: la diferencia debe ser radical. Si
no lo es, se debe tratar como un fallo técnico y no continuar la escucha.

## Límites deliberados

- El análisis del navegador no es EBU R128: muestra RMS y pico de muestra, no
  LUFS ni true peak.
- El compresor de seguridad de Web Audio no se presenta como limitador true
  peak.
- Los impulsos son candidatos heurísticos; este laboratorio no modifica ni
  repara el archivo.
- Las curvas son hipótesis iniciales moderadas, no estándares universales por
  género.
- No hay persistencia ni aprendizaje. El JSON exportado permite comparar
  resultados sin convertirlos todavía en estado de Hirmos.

## Verificación

```bash
npm run audio-lab:test
npm run audio-lab:typecheck
npm run audio-lab:build
```
