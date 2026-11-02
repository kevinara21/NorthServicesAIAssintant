# Plan de mejoras — North Services AI Assistant

**Objetivo:** que el sistema responda rápido, sea estable y no pierda información.

**Restricciones acordadas:**

- No borrar datos antes de copiarlos y verificarlos. La limpieza de colecciones antiguas solo se ejecuta con `--eliminar-legacy --confirmar` y después de que la verificación dé todo `OK`.
- La reestructuración de conocimientos se hará re-subiendo archivos manualmente desde la página.
- El OTP por SMS se revisará después; el teléfono actual está en tus manos.
- `server.js` se dividirá más adelante.
- La limpieza de comentarios innecesarios se hará al final, sin cambiar comportamiento.
- Prioridad: velocidad percibida del chat, velocidad de MongoDB y OTP con reenvío cada 2 minutos.

---

## 0. Resumen ejecutivo

El plan se ejecuta en 6 fases. Las tres primeras son las que más mejoran la velocidad:

| Fase | Qué se hace | Tiempo estimado | Riesgo |
|---|---|---:|---|
| 0 | Respaldo, baseline y congelar scripts destructivos | 1-2 días | Bajo |
| 1 | MongoDB rápido sin borrar datos: índices, pool, cachés, consultas | 3-5 días | Bajo |
| 2 | RAG unificado: una colección y una sola búsqueda | 5-7 días | Medio |
| 3 | OTP con reenvío cada 120 s y contador | 2-3 días | Bajo |
| 4 | Frontend rápido y menos re-renders | 3-5 días | Bajo |
| 5 | Seguridad, observabilidad y operación | 2-3 días | Bajo |
| 6 | División de `server.js` y limpieza de comentarios | Posterior | Medio |

**Mayor impacto esperado:**

1. Pasar de N consultas vectoriales a **una sola**.
2. Eliminar los escaneos de 4.000 documentos con embeddings en memoria.
3. Poner índices correctos y pool de conexiones caliente.
4. Cachear permisos, categorías, índices y datos que casi no cambian.
5. Subir de tier de Atlas si hoy está en uno compartido.
6. Reducir re-renders del chat durante el streaming.

---

## 1. Diagnóstico

### 1.1 Mapa de datos actual

| Almacén | Colecciones / documentos | Uso |
|---|---|---|
| Firestore | `users`, `archivos`, `recursos`, `manuales`, `monitoreoPozos`, `facturacionStarlink`, `otpCodes`, `otpCooldowns`, `estado_web_empresa` | Autenticación, archivos, recursos, facturación, OTP y estado de la web |
| MongoDB `north_services_db` | `rag_documents`, `categorias_conocimiento`, `permisos_rag_roles`, `starlink_bot` | RAG unificado, permisos y Starlink |
| MongoDB `inventarios` | `inventario_mwd`, `inventario_motores`, `inventario_sync_status` | Inventario y estado de sincronización |

La reorganización del 02/11/2026 eliminó las bases `mwd` y `motores` y las colecciones vectoriales por categoría, después de copiar y verificar todos los documentos en `inventarios` y `rag_documents`. El detalle está en la sección 15.

### 1.2 Cuellos de botella detectados

| # | Problema | Dónde | Efecto |
|---|---|---|---|
| 1 | Una consulta vectorial por cada categoría autorizada | `server.js:4375-4494` | N viajes, N índices, N resultados que compiten |
| 2 | Fallback que trae hasta 4.000 documentos con embedding | `server.js:3553-3595` | ~98 MB por colección con 3.072 dimensiones; bloquea el event loop |
| 3 | `listSearchIndexes()` recorriendo colecciones | `ragCategorias.service.js:963` | Primer request de cada minuto puede tardar segundos |
| 4 | `starlink_bot.find({})` en cada pregunta | `server.js:4837` | Trae toda la colección aunque la pregunta sea de un solo kit |
| 5 | Lectura de Firestore del usuario en cada request | `verifyToken.js:17` | +20-100 ms por request |
| 6 | Búsquedas de texto que cargan colecciones completas | `server.js:3615`, `inventorySync.service.js` | CPU y memoria innecesarios |
| 7 | Scores de fuentes distintas ordenados juntos | `server.js:4558` | Ranking sesgado; respuestas peores |
| 8 | Sin métricas de tokens ni de etapas | Ruta `/api/chat` | No se puede medir ni priorizar |
| 9 | Migraciones que hacen `deleteMany` / `dropCollection` | `inventorySync.service.js:137-142`, `webEmpresa.service.js:303-310` | Riesgo de pérdida si se ejecutan sin respaldo |
| 10 | Atlas posiblemente en tier compartido | Infraestructura | Latencia variable e impredecible |

### 1.3 Lo que no se toca en este plan

- Infobip / SMS: se deja como está hasta que lo revises.
- El teléfono fijo de OTP: lo tienes tú; no se cambia ahora.
- División de `server.js`: fase 6.
- Limpieza de comentarios: fase 6, al final.
- Borrado de colecciones antiguas: **no se hará**.

---

## 2. Fase 0 — Respaldo, baseline y seguridad de datos

**Duración:** 1-2 días.

### 2.1 Respaldos antes de tocar nada

1. Atlas: crear un snapshot manual del clúster.
2. Firestore: exportar a un bucket de Cloud Storage.
3. MongoDB: si tienes `mongodump`, exportar `north_services_db`, `mwd` y `motores`.
4. Guardar copia de `.env` fuera del repositorio.
5. Verificar que el respaldo se puede restaurar en un entorno de prueba.

### 2.2 Congelar scripts destructivos

Revisar y proteger con variable de entorno:

- `inventorySync.service.js:137` (`deleteMany`) y `:142` (`dropCollection`).
- `webEmpresa.service.js:303` y `:310` (`deleteMany`).
- `ragCategorias.service.js:382` y `:498` (`deleteMany`, `drop`).

Propuesta:

```js
const PERMITIR_LIMPIEZA = process.env.PERMITIR_LIMPIEZA === 'true';
if (!PERMITIR_LIMPIEZA) {
  console.warn('[SEGURIDAD] Limpieza omitida. Define PERMITIR_LIMPIEZA=true para habilitarla.');
  return;
}
```

No cambia el comportamiento normal; solo evita ejecuciones accidentales.

### 2.3 Baseline de rendimiento

Antes de optimizar, medir 20-30 preguntas reales y registrar:

```text
embed_ms
rag_search_ms
context_ms
llm_ttfb_ms
total_ms
prompt_tokens
output_tokens
resultados
fallback_usado
```

Sin baseline no se puede demostrar la mejora.

### 2.4 Criterio de salida

- Respaldo verificado.
- Scripts destructivos protegidos.
- Baseline documentado.
- Ningún dato borrado.

---

## 3. Fase 1 — MongoDB rápido sin borrar datos

**Duración:** 3-5 días.

### 3.1 Conexión: pool caliente, timeouts y compresión

`backend/src/db/mongodb.js` hoy crea el cliente sin opciones. Propuesta:

```js
const client = new MongoClient(process.env.MONGODB_URI, {
  maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 20),
  minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 5),
  maxIdleTimeMS: 60_000,
  serverSelectionTimeoutMS: 5_000,
  connectTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
  retryWrites: true,
  retryReads: true,
  compressors: ['zlib'],
});
```

Y en `connectDB()`:

```js
async function connectDB() {
  if (dbInstance) return dbInstance;

  await client.connect();
  dbInstance = client.db('north_services_db');
  await dbInstance.command({ ping: 1 });
  console.log('MongoDB Atlas conectado y verificado.');
  return dbInstance;
}
```

Ventajas:

- `minPoolSize` mantiene conexiones calientes.
- `compressors: ['zlib']` reduce bytes en documentos grandes.
- Timeouts evitan requests colgados.
- `retryWrites`/`retryReads` toleran fallos transitorios.

También conviene cerrar el cliente en `SIGTERM`/`SIGINT`.

### 3.2 Índices recomendados

Crear índices es aditivo: no borra ni modifica documentos.

| Base | Colección | Índice | Para qué |
|---|---|---|---|
| north_services_db | `categorias_conocimiento` | `{ id: 1 }` único | Buscar categoría por id |
| north_services_db | `categorias_conocimiento` | `{ activa: 1, nombre: 1 }` | Listar activas ordenadas |
| north_services_db | `permisos_rag_roles` | `{ rol: 1 }` único | Permisos por rol |
| north_services_db | `starlink_bot` | `{ codigoKit: 1 }` | Búsqueda exacta por kit |
| north_services_db | `starlink_bot` | `{ serieAntena: 1 }` | Búsqueda exacta por serie |
| north_services_db | `starlink_bot` | `{ ubicacion: 1 }` | Filtro por ubicación |
| north_services_db | `starlink_bot` | `{ estadoPago: 1, diaPago: 1 }` | Vencimientos y pagos |
| north_services_db | `rag_documents` | `{ archivoId: 1, indiceFragmento: 1 }` único | Idempotencia de ingesta |
| north_services_db | `rag_documents` | `{ archivoId: 1 }` | Borrar/reindexar un archivo |
| north_services_db | `rag_documents` | `{ hashContenido: 1 }` | Evitar re-embeddear |
| north_services_db | `rag_documents` | `{ categoriaId: 1, activo: 1 }` | Filtros de recuperación |
| north_services_db | `rag_documents` | `{ tipoFuente: 1, activo: 1 }` | Separar categorías de la web |
| north_services_db | `rag_documents` | `{ origen: 1, fechaIndexacion: 1 }` | Limpieza de la web por versión |
| north_services_db | `rag_documents` | `{ documentoId: 1 }` | Trazabilidad |
| inventarios | `inventario_sync_status` | `{ tipo: 1 }` único | Estado por inventario |
| inventarios | `inventario_mwd` | `{ codigo: 1 }` | Búsqueda exacta |
| inventarios | `inventario_mwd` | `{ tool_id: 1 }` | Búsqueda exacta |
| inventarios | `inventario_mwd` | `{ status: 1 }` | Filtros operativos |
| inventarios | `inventario_motores` | `{ codigo: 1 }` | Búsqueda exacta |
| inventarios | `inventario_motores` | `{ serial_number: 1 }` | Búsqueda exacta |
| inventarios | `inventario_motores` | `{ estado: 1 }` | Filtros operativos |

Antes de crear índices únicos, auditar duplicados:

```js
db.collection('categorias_conocimiento').aggregate([
  { $group: { _id: '$id', n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
]);
```

Si hay duplicados, crear el índice sin `unique`, corregir los datos con calma y luego volver a crearlo.

### 3.3 Script de índices

El plan vigente vive en `backend/scripts/crearIndices.js` y apunta a las dos bases actuales (`north_services_db` e `inventarios`). Es aditivo: crea índices, nunca borra documentos.

```bash
node backend/scripts/crearIndices.js
```

La lista de índices está en la tabla de la sección 3.2. Los índices vectoriales se crean aparte con `node backend/scripts/reorganizarEstructura.js --crear-indices` y se esperan con `--esperar-indices` (ver sección 15).

### 3.4 Optimización de consultas

1. **Reemplazar `starlink_bot.find({})`** por filtros reales:

```js
const filtro = { $or: [
  { codigoKit: { $regex: escapeRegex(termino), $options: 'i' } },
  { serieAntena: { $regex: escapeRegex(termino), $options: 'i' } },
  { ubicacion: { $regex: escapeRegex(termino), $options: 'i' } },
]};
const datos = await coleccion.find(filtro).limit(50).toArray();
```

Si de verdad necesita toda la colección para conteos, cachear 60 s y invalidar al editar.

2. **Proyecciones:** nunca traer `embedding` si no se va a usar.

```js
.find(filtro, { projection: { embedding: 0 } })
```

3. **Evitar `countDocuments` en listados grandes:** usar `estimatedDocumentCount()` para totales aproximados y `countDocuments` solo con filtros indexados.

4. **Paginación:** en paneles de administración, `limit` + `skip` o cursor por `_id`/fecha. No cargar colecciones completas.

5. **Escrituras por lote:** `bulkWrite` en ingesta y sincronización, lotes de 100-500.

6. **`maxTimeMS`:** en consultas de chat, ingesta y reportes.

7. **`explain('executionStats')`:** revisar las 10 consultas más frecuentes. Señales de alarma:
   - `COLLSCAN` en colecciones grandes.
   - `docsExamined` mucho mayor que `nReturned`.
   - `SORT` en memoria.
   - `hasSortStage: true` sin índice.

8. **Evitar `$regex` sin ancla** en campos no indexados. Para texto libre, usar Atlas Search o un campo normalizado.

### 3.5 Atlas: el ajuste que más impacta

Si el clúster está en un tier compartido (M0/Flex), la latencia es variable y ningún índice compensa del todo. Recomendación:

- Producción: tier dedicado (M10 o superior) en la misma región que el backend.
- Habilitar backups automáticos.
- Revisar `Performance Advisor` después de una semana de tráfico.
- Índice vectorial con 768 dimensiones (o 1.536), no 3.072 salvo necesidad.
- `numCandidates` 150-250 para `limit` 12.
- Evaluar cuantización escalar si el corpus crece.

### 3.6 Firestore también cuenta

1. **Cachear el usuario de `verifyToken`** 30-60 s por UID. Invalidar al cambiar rol/estado.
2. **No cargar colecciones completas** en paneles: `users.get()`, `facturacionStarlink.get()`, `archivos.where(...).get()`. Paginar o usar `count()`.
3. **Índices compuestos** para consultas frecuentes:
   - `archivos`: `activo + eliminado + fechaCreacion`.
   - `archivos`: `categoriaId + activo`.
   - `otpCodes`: `uid + proposito + usado + creadoEn` (si se mantiene la consulta actual).
   - `facturacionStarlink`: `diaPago + estadoPago`.
4. **Batch writes** para migraciones y actualizaciones masivas.
5. **Evitar leer Firestore dentro de bucles**; usar `getAll()` o consultas por lote.

### 3.7 Cachés en memoria

| Dato | TTL | Invalidación |
|---|---:|---|
| Categorías y permisos por rol | 60 s | Al crear/editar categoría o permisos |
| Nombres de índices vectoriales | 5-10 min | Al crear/eliminar categoría |
| Datos de Starlink | 60 s | Al editar un kit |
| Usuario de `verifyToken` | 30-60 s | Al cambiar rol/estado |
| Embedding de consulta | 10 min | Natural por TTL |

### 3.8 Criterio de salida de la fase 1

- Todos los índices creados.
- Cero `COLLSCAN` en consultas del chat.
- `starlink_bot` ya no se carga completa en cada pregunta.
- Pool caliente y timeouts configurados.
- `verifyToken` con caché.
- Baseline vs. después: mejora medible en p95.

---

## 4. Fase 2 — RAG unificado

**Duración:** 5-7 días.

### 4.1 Decisión

- **Conocimiento no estructurado** (manuales, PDFs, web, políticas): una sola colección `rag_documents`.
- **Datos exactos** (inventario, Starlink, códigos): consultas estructuradas + su propio índice vectorial en la base `inventarios`.
- **Colecciones antiguas:** se copiaron y verificaron antes de borrarlas el 02/11/2026. Ya no existen.

> Estado actual: el RAG unificado está activo (`RAG_BACKEND=unified`) y `rag_documents` es la única colección vectorial de conocimiento, incluyendo la web de la empresa. Ver sección 15.

### 4.2 Esquema de `rag_documents`

```js
{
  documentoId, archivoId, indiceFragmento, hashContenido, version,
  nombreManual, titulo_seccion, rutaTitulos, pagina,
  contenido_texto, embedding,
  categoriaId, categoriaNombre, tipoFuente, activo, tenantId, idioma,
  fechaIndexacion
}
```

### 4.3 Índice vectorial

```json
{
  "name": "vector_index_rag",
  "type": "vectorSearch",
  "definition": {
    "fields": [
      { "type": "vector", "path": "embedding", "numDimensions": 768, "similarity": "cosine" },
      { "type": "filter", "path": "activo" },
      { "type": "filter", "path": "categoriaId" },
      { "type": "filter", "path": "tenantId" },
      { "type": "filter", "path": "tipoFuente" },
      { "type": "filter", "path": "idioma" }
    ]
  }
}
```

### 4.4 Una sola consulta

```js
const filas = await db.collection('rag_documents').aggregate([
  {
    $vectorSearch: {
      index: 'vector_index_rag',
      path: 'embedding',
      queryVector: vector,
      numCandidates: 200,
      limit: 50,
      filter: {
        activo: true,
        categoriaId: { $in: categoriaIds },
      },
    },
  },
  {
    $project: {
      nombreManual: 1,
      titulo_seccion: 1,
      rutaTitulos: 1,
      pagina: 1,
      contenido_texto: 1,
      categoriaId: 1,
      categoriaNombre: 1,
      score: { $meta: 'vectorSearchScore' },
    },
  },
  { $match: { score: { $gte: 0.56 } } },
  { $limit: 12 },
], { maxTimeMS: 2500 }).toArray();
```

### 4.5 Qué eliminar de la ruta caliente

- `buscarPorSimilitudEnMemoria` (`server.js:3553`).
- `buscarPorTextoEnMemoria` como camino normal; dejarlo solo como emergencia con límite y timeout.
- El fan-out `fuentesListas.map(buscarEnFuente)`.
- `listSearchIndexes()` por request.

### 4.6 Híbrido para códigos

1. Detectar si la pregunta contiene un código/serial.
2. Buscar primero en la colección estructurada (`inventario`, `starlink_bot`).
3. Si no hay coincidencia exacta, usar `$vectorSearch`.
4. Fusionar con RRF o cuotas por fuente, no con scores crudos.

### 4.7 Reingesta manual desde la página

1. Crear las categorías en el panel.
2. Subir archivos en lotes de 10-20 para no saturar embeddings.
3. Revisar `estadoIndexacion` de cada archivo.
4. Corregir fallos y re-subir solo los que fallen.
5. Ejecutar verificación de conteos y dimensiones.
6. Activar `RAG_BACKEND=unified` y comparar 20-30 preguntas.
7. Mantener las colecciones antiguas durante 30 días.

### 4.8 Verificación sin escrituras

```js
// scripts/verificarRag.js (solo lectura)
const total = await db.collection('rag_documents').countDocuments({ activo: true });
const porCategoria = await db.collection('rag_documents').aggregate([
  { $match: { activo: true } },
  { $group: { _id: '$categoriaId', n: { $sum: 1 } } },
  { $sort: { n: -1 } },
]).toArray();

const dims = await db.collection('rag_documents').findOne(
  { embedding: { $exists: true } },
  { projection: { embedding: 1 } }
);
console.log({ total, porCategoria, dimensiones: dims?.embedding?.length });
```

### 4.9 Rollback

- `RAG_BACKEND=legacy` vuelve a las colecciones antiguas.
- No se borra nada.
- El índice nuevo se puede eliminar sin afectar los datos.

---

## 5. Fase 3 — OTP con reenvío cada 2 minutos y contador

**Duración:** 2-3 días.

### 5.1 Reglas de negocio

- Se puede reenviar un código cada **120 segundos** por usuario + propósito.
- El contador se muestra en el botón: `Reenviar en 01:59`.
- Al llegar a 00:00, el botón se habilita.
- El reenvío **no** borra el código que el usuario está escribiendo.
- Se invalida el código anterior (se marca como usado/reemplazado), sin borrarlo.
- El código sigue venciendo a los 10 minutos.
- Si el usuario recarga la página, el contador se recupera con `sessionStorage`.
- No se hace reenvío automático; solo manual, para evitar costos y confusión.

### 5.2 Backend: cooldown sin índices compuestos

Usar un documento de estado por usuario + propósito:

```js
const OTP_RESEND_SECONDS = Number(process.env.OTP_RESEND_SECONDS || 120);

async function reservarEnvioOtp({ uid, proposito, canal }) {
  const ref = db.collection('otpCooldowns').doc(`${uid}_${proposito}`);
  const ahora = Date.now();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const ultimo = snap.exists ? Number(snap.data().ultimoEnvioMs || 0) : 0;
    const restante = Math.ceil((ultimo + OTP_RESEND_SECONDS * 1000 - ahora) / 1000);

    if (restante > 0) {
      return { permitido: false, restante };
    }

    tx.set(ref, {
      uid,
      proposito,
      canal,
      ultimoEnvioMs: ahora,
      actualizadoEn: FieldValue.serverTimestamp(),
    }, { merge: true });

    return { permitido: true, restante: 0 };
  });
}
```

Invalidar códigos anteriores sin borrarlos:

```js
async function invalidarOtpAnteriores({ uid, proposito }) {
  const snapshot = await db.collection('otpCodes')
    .where('uid', '==', uid)
    .get();

  const pendientes = snapshot.docs.filter((doc) => {
    const data = doc.data();
    return data.proposito === proposito && data.usado === false;
  });

  if (!pendientes.length) return;

  const batch = db.batch();
  pendientes.forEach((doc) => {
    batch.update(doc.ref, {
      usado: true,
      reemplazado: true,
      reemplazadoEn: FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
}
```

Ruta:

```js
app.post('/api/otp/solicitar', verifyToken, async (req, res) => {
  try {
    const telefono = OTP_DESTINATION; // se mantiene por ahora
    const canal = req.body.canal === 'whatsapp' ? 'whatsapp' : 'sms';

    if (!/^\+\d{8,15}$/.test(telefono)) {
      return res.status(400).json({ ok: false, error: 'Número inválido.' });
    }

    const reserva = await reservarEnvioOtp({
      uid: req.user.uid,
      proposito: 'verificar-whatsapp',
      canal,
    });

    if (!reserva.permitido) {
      return res.status(429).json({
        ok: false,
        error: `Espera ${reserva.restante} segundos antes de reenviar.`,
        reintentarEn: reserva.restante,
      });
    }

    await invalidarOtpAnteriores({
      uid: req.user.uid,
      proposito: 'verificar-whatsapp',
    });

    await crearOTP({
      uid: req.user.uid,
      telefono,
      canal,
      proposito: 'verificar-whatsapp',
    });

    res.json({
      ok: true,
      reintentarEn: OTP_RESEND_SECONDS,
      expiraEn: OTP_EXPIRATION_MINUTES * 60,
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});
```

Para `/api/password/solicitar`, aplicar el mismo cooldown usando el `uid` encontrado por email, y responder siempre de forma genérica para no revelar si el correo existe.

### 5.3 Frontend: hook de contador

```jsx
// frontend/src/hooks/useCountdown.js
import { useCallback, useEffect, useRef, useState } from 'react';

export default function useCountdown() {
  const [segundos, setSegundos] = useState(0);
  const finRef = useRef(0);
  const intervaloRef = useRef(null);

  const detener = useCallback(() => {
    if (intervaloRef.current) clearInterval(intervaloRef.current);
    intervaloRef.current = null;
  }, []);

  const iniciar = useCallback((duracionSegundos) => {
    detener();
    const fin = Date.now() + Math.max(0, duracionSegundos) * 1000;
    finRef.current = fin;
    setSegundos(Math.max(0, Math.ceil((fin - Date.now()) / 1000)));

    intervaloRef.current = setInterval(() => {
      const restante = Math.max(0, Math.ceil((finRef.current - Date.now()) / 1000));
      setSegundos(restante);
      if (restante <= 0) detener();
    }, 250);
  }, [detener]);

  useEffect(() => detener, [detener]);

  return { segundos, iniciar, detener, activo: segundos > 0 };
}
```

Formateo:

```js
const formatear = (total) => {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
```

Integración en `Perfil.jsx`:

```jsx
const { segundos: segundosReenvio, iniciar: iniciarReenvio } = useCountdown();

const enviarCodigo = async () => {
  setCargando(true);
  try {
    const data = await llamada('/api/otp/solicitar', {
      method: 'POST',
      body: JSON.stringify({ telefono, canal }),
    });
    setOtpEnviado(true);
    iniciarReenvio(data.reintentarEn ?? 120);
    guardarFinContador('perfil-otp', data.reintentarEn ?? 120);
    notificarExito('Código enviado correctamente.', { titulo: 'Código enviado' });
  } catch (error) {
    if (error.reintentarEn) {
      iniciarReenvio(error.reintentarEn);
      guardarFinContador('perfil-otp', error.reintentarEn);
    }
    notificarError(error.message, { titulo: 'No se pudo enviar el código' });
  } finally {
    setCargando(false);
  }
};
```

Botón:

```jsx
<button type="button" onClick={enviarCodigo} disabled={cargando || segundosReenvio > 0}>
  {segundosReenvio > 0
    ? `Reenviar en ${formatear(segundosReenvio)}`
    : 'Enviar código'}
</button>
```

El helper `llamada` debe conservar `reintentarEn`:

```js
if (!respuesta.ok) {
  const error = new Error(data.error || 'No se pudo completar la operación.');
  error.status = respuesta.status;
  error.reintentarEn = data.reintentarEn;
  throw error;
}
```

### 5.4 Persistencia del contador al recargar

```js
function guardarFinContador(clave, segundos) {
  sessionStorage.setItem(clave, String(Date.now() + segundos * 1000));
}

function recuperarContador(clave, iniciar) {
  const fin = Number(sessionStorage.getItem(clave) || 0);
  const restante = Math.ceil((fin - Date.now()) / 1000);
  if (restante > 0) iniciar(restante);
}
```

Llamar `recuperarContador('perfil-otp', iniciarReenvio)` al montar el componente.

### 5.5 Casos de prueba

- Primer envío: botón queda deshabilitado 120 s.
- Reenvío antes de 120 s: backend responde 429 con `reintentarEn`.
- Reenvío a los 120 s: se envía y el contador vuelve a 120.
- Recarga de página: el contador continúa.
- Código anterior deja de servir después del reenvío.
- Código vence a los 10 minutos.
- Error de red: el contador no se reinicia si el envío no se concretó.

### 5.6 Nota sobre SMS

No se toca Infobip. Cuando el SMS funcione, el mismo flujo sirve; solo hay que cambiar el destino para que use el número del usuario en lugar de `OTP_DESTINATION`.

---

## 6. Fase 4 — Frontend rápido

**Duración:** 3-5 días.

| Mejora | Dónde | Impacto |
|---|---|---|
| Rutas con `React.lazy` + `Suspense` | `frontend/src/App.jsx` | Menos JS inicial |
| Analizar bundle con `rollup-plugin-visualizer` | `vite.config.js` | Detectar dependencias pesadas |
| Bufferizar el streaming y actualizar cada 50-100 ms | `Chatbot.jsx` | Menos re-renders por token |
| `React.memo` en mensajes y listas | `Chatbot.jsx`, tablas | Menos trabajo por render |
| Virtualizar historial largo | `Chatbot.jsx` | DOM más liviano |
| `AbortController` al cambiar de pregunta/desmontar | `Chatbot.jsx` | Evita respuestas viejas y trabajo inútil |
| Cargar `react-markdown` solo en chat | Chat | Menos bundle en login |
| Cachear GETs en memoria | `services/api.js` | Menos llamadas repetidas |
| Paginar tablas administrativas | Gestión de usuarios/archivos | Menos datos y renders |
| `loading="lazy"` en imágenes | Componentes | Menos red inicial |
| Debounce en buscadores | Paneles | Menos filtrados |

El contador OTP también entra en esta fase, pero se implementa en la fase 3 porque es funcionalidad nueva.

---

## 7. Fase 5 — Seguridad y operación

**Duración:** 2-3 días.

| Mejora | Detalle |
|---|---|
| Rate limiting | `express-rate-limit` global y estricto en `/api/otp`, `/api/password`, `/api/chat` |
| CORS restringido | Lista blanca desde `FRONTEND_ORIGINS` |
| `helmet` | Cabeceras de seguridad |
| Clave de Gemini en cabecera | `x-goog-api-key` en lugar de `?key=` |
| Usuario activo en `/api/chat` | Hoy no se valida `req.user.estado` |
| Validación de uploads | Extensión/MIME/magic bytes, no solo tamaño |
| Errores sin detalles internos | No devolver `error.message` crudo al cliente |
| Logs estructurados | `pino` con `requestId`, `uid`, `ms`, `tokens` |
| Alertas | p95, tasa de error, cero resultados, fallback, consumo |
| Presupuesto Gemini | Alertas en Google Cloud |
| `trust proxy` | Si está detrás de Nginx/Cloudflare |

No se cambia el destino del OTP ni se toca Infobip en esta fase.

---

## 8. Fase 6 — División de `server.js` y limpieza de comentarios

**Cuándo:** después de estabilizar las fases 1-5.

### 8.1 Estructura objetivo

```text
backend/src/
  routes/
    auth.routes.js
    chat.routes.js
    archivos.routes.js
    inventario.routes.js
    starlink.routes.js
    admin.routes.js
  services/
    embeddings.service.js
    rag.service.js
    gemini.service.js
    otp.service.js
    inventorySync.service.js
    webEmpresa.service.js
  middleware/
    auth.js
    rateLimit.js
    errors.js
  db/
    mongodb.js
```

### 8.2 Orden de extracción

1. `otp.service.js` (bajo riesgo).
2. `embeddings.service.js`.
3. `rag.service.js`.
4. `gemini.service.js`.
5. Rutas de archivos.
6. Rutas de inventario/Starlink.
7. Rutas de admin.

Cada extracción debe ser un cambio aislado, con prueba manual de la ruta afectada.

### 8.3 Política de comentarios

- Conservar comentarios que expliquen **por qué** se toma una decisión.
- Eliminar código comentado y comentarios que repiten lo que el código ya dice.
- No mezclar limpieza de comentarios con cambios funcionales.
- Hacer la limpieza en un commit separado para facilitar el diff.

---

## 9. Cronograma sugerido

| Semana | Lunes | Martes | Miércoles | Jueves | Viernes |
|---|---|---|---|---|---|
| 1 | Respaldo + baseline | Pool + timeouts | Índices | Consultas + cachés | Medir y ajustar |
| 2 | RAG: colección + índice | Ingesta idempotente | Re-subir 1 categoría | Probar unified | Comparar y ajustar |
| 3 | Re-subir resto | Verificar conteos | Cambiar tráfico | OTP backend | OTP frontend |
| 4 | Frontend lazy/bundle | Streaming/re-renders | Rate limit/CORS | Pruebas de carga | Documentar y cerrar |

---

## 10. Métricas de aceptación

| Métrica | Objetivo |
|---|---|
| `rag_search_ms` p95 | < 50 ms (Atlas, sin embedding) |
| `llm_ttfb_ms` p95 | < 1.5-2.0 s |
| `chat_total_ms` p95 | Reducción ≥ 30 % vs. baseline |
| Consultas con `COLLSCAN` en chat | 0 |
| Tasa de fallback en memoria | 0 en producción |
| Tasa de respuestas vacías | < 10 % |
| Recall@12 | ≥ baseline |
| Reenvío OTP antes de 120 s | Bloqueado con 429 |
| Contador tras recarga | Correcto |
| Datos borrados | 0 |
| Errores 5xx en chat | < 1 % |
| Bundle inicial | Reducción ≥ 20 % |

---

## 11. Riesgos y rollback

| Riesgo | Mitigación |
|---|---|
| Índice único falla por duplicados | Auditar antes; crear sin `unique` primero |
| Construcción de índices afecta escrituras | Horario de baja actividad; monitorear |
| Cambio de dimensiones obliga a reindexar | Colección nueva + feature flag + reingesta |
| La reingesta manual tarda | Lotes de 10-20 archivos; estado por archivo |
| El OTP de 120 s molesta | `OTP_RESEND_SECONDS` configurable |
| Atlas sube de costo | Medir antes/después; ajustar tier |
| Firestore index tarda en desplegar | Crear índices antes del cambio |
| Pérdida de datos | Respaldos + scripts destructivos bloqueados |
| Rollback de RAG | Restaurar snapshot de Atlas; `RAG_BACKEND=legacy` ya no tiene colecciones antiguas |

---

## 12. Checklist maestro

### Datos
- [ ] Snapshot de Atlas creado.
- [ ] Export de Firestore creado.
- [ ] `mongodump` de `north_services_db`, `mwd`, `motores`.
- [ ] Restauración probada.
- [ ] Scripts destructivos protegidos por variable de entorno.

### MongoDB
- [ ] Pool, timeouts y compresión configurados.
- [ ] Índices creados y verificados.
- [ ] Duplicados auditados antes de índices únicos.
- [ ] `starlink_bot` ya no se carga completa.
- [ ] Proyecciones aplicadas.
- [ ] `maxTimeMS` en consultas críticas.
- [ ] `explain` sin `COLLSCAN` en chat.
- [ ] Tier de Atlas revisado.

### RAG
- [x] `rag_documents` creada.
- [x] Índice vectorial `READY`.
- [x] Ingesta idempotente por hash.
- [x] Una sola consulta por pregunta.
- [x] Fallback en memoria eliminado del camino normal.
- [x] Híbrido para códigos (inventario estructurado + vectorial).
- [x] Reingesta completada (160 de categorías + 44 de la web).
- [x] Verificación de conteos y dimensiones.
- [x] Feature flag y rollback probados (`RAG_BACKEND`).
- [x] Colecciones antiguas copiadas, verificadas y retiradas.

### OTP
- [ ] Cooldown de 120 s en backend.
- [ ] Código anterior invalidado sin borrar.
- [ ] Respuesta 429 con `reintentarEn`.
- [ ] Contador en Perfil.
- [ ] Contador en recuperación de contraseña.
- [ ] Persistencia con `sessionStorage`.
- [ ] Pruebas de reenvío, recarga y expiración.

### Frontend
- [ ] Rutas con lazy loading.
- [ ] Bundle analizado.
- [ ] Streaming bufferizado.
- [ ] Mensajes memoizados/virtualizados.
- [ ] `AbortController` en chat.
- [ ] Tablas paginadas.

### Operación
- [ ] Rate limiting.
- [ ] CORS restringido.
- [ ] Helmet.
- [ ] Clave Gemini en cabecera.
- [ ] Usuario activo en chat.
- [ ] Logs estructurados.
- [ ] Alertas de p95, errores y tokens.
- [ ] Documentación actualizada.

### Limpieza posterior
- [ ] `server.js` dividido.
- [ ] Comentarios redundantes eliminados.
- [ ] Código comentado retirado.
- [ ] Commit separado solo de limpieza.

---

## 13. Decisiones pendientes

1. **Tier de Atlas:** ¿el clúster actual es M0/Flex/dedicado? Si es compartido, la mejora más grande es subir de tier.
2. **Región:** confirmar que backend y Atlas están en la misma región.
3. **Reingesta:** ¿se re-sube todo el corpus o se empieza por una categoría piloto?
4. **OTP:** ¿el contador aplica solo a verificación de WhatsApp o también a recuperación de contraseña? El plan asume ambos.
5. **Canal OTP:** el SMS se deja para después; el contador funciona igual con correo.

---

**Regla de oro:** cada fase termina con medición y rollback probado. No se avanza a la siguiente sin haber verificado que no se perdió información.

---

## 14. Estado de implementación (02/11/2026)

### 14.1 Lo que ya quedó implementado

| Fase | Estado | Detalle |
|---|---|---|
| 0 | Parcial | Scripts destructivos protegidos con `PERMITIR_LIMPIEZA`. Respaldos y baseline siguen siendo manuales. |
| 1 | Implementado | Pool caliente, timeouts, compresión, ping de verificación, cierre ordenado, caché de usuario, caché de categorías/permisos/índices, caché de Starlink, caché de embeddings, índices aditivos y `maxTimeMS`. |
| 2 | Implementado y activo | `rag_documents` + `rag.service.js`, 160 fragmentos migrados, índice vectorial `READY`, dual-write desde la ingesta, activación/desactivación no destructiva y endpoint de estado. `RAG_BACKEND=unified`. |
| 3 | Implementado | Reenvío manual cada 120 s, contador visible, límite de 5 códigos por usuario cada 24 h y bloqueo de 24 h. |
| 4 | Implementado | Lazy loading, buffer de streaming por frame, `AbortController` y errores con metadatos (`reintentarEn`, `restanteHoy`). |
| 5 | Implementado parcial | CORS por lista blanca, cabeceras de seguridad, límites de cuerpo y rate limiting propio, clave Gemini en cabecera. Faltan logs estructurados y alertas. |
| 6 | Diferido | División de `server.js` y limpieza de comentarios, tal como se acordó. |

### 14.2 Cambios por archivo

**Backend**

- `src/db/mongodb.js`: pool, timeouts, `retryWrites`/`retryReads`, `zlib`, `ping` y `cerrarConexionMongo()`.
- `src/middleware/verifyToken.js`: caché de usuario de 30 s e `invalidarCacheUsuario()`.
- `src/services/ragCategorias.service.js`: caché de categorías, permisos e índices; invalidación en cada escritura.
- `src/services/rag.service.js`: búsqueda unificada, dual-write y activación/desactivación lógica.
- `src/services/inventorySync.service.js`: `deleteMany` y `dropCollection` condicionados a `PERMITIR_LIMPIEZA`.
- `src/services/webEmpresa.service.js`: borrados de vectores antiguos condicionados a `PERMITIR_LIMPIEZA`.
- `src/server.js`: OTP con cooldown y límite diario, invalidación de códigos sin borrarlos, caché de embeddings y Starlink, seguridad, ruta unificada del chat, endpoint de estado y cierre ordenado.
- `scripts/crearIndices.js`: creación aditiva de índices sobre `north_services_db` e `inventarios`.
- `scripts/reorganizarEstructura.js`: copia, verificación, índices vectoriales de inventario y borrado controlado de lo antiguo.
- `scripts/migrarRagUnificado.js`: diagnóstico, migración idempotente, verificación, creación/liberación del índice vectorial y espera de estado.

**Frontend**

- `src/hooks/useCountdown.js`: contador persistido en `sessionStorage` (por pestaña).
- `src/services/api.js`: `apiJson()` y `ApiError` con `reintentarEn`/`restanteHoy`.
- `src/components/Perfil.jsx`: contador de reenvío y códigos restantes.
- `src/pages/Login.jsx`: contador, reenvío y códigos restantes en recuperación de contraseña.
- `src/App.jsx` y `src/components/Dashboard.jsx`: `React.lazy` + `Suspense`.
- `src/pages/Chatbot.jsx`: buffer por `requestAnimationFrame` y `AbortController`.

### 14.3 Regla del límite diario de OTP

- Ventana móvil de 24 h por usuario y propósito.
- Máximo 5 códigos enviados dentro de la ventana.
- Al intentar el sexto: respuesta `429` con `reintentarEn` en segundos y bloqueo hasta que termine la ventana.
- Los códigos anteriores se marcan `reemplazado: true; usado: true`; **no se borran**.
- Un envío fallido del proveedor libera la reserva para no consumir el cupo.

### 14.4 Variables de entorno nuevas

Todas son opcionales; los valores indicados son los predeterminados.

```env
# MongoDB
MONGO_MAX_POOL_SIZE=20
MONGO_MIN_POOL_SIZE=5
MONGO_MAX_IDLE_MS=60000
MONGO_SERVER_SELECTION_TIMEOUT_MS=5000
MONGO_CONNECT_TIMEOUT_MS=10000
MONGO_SOCKET_TIMEOUT_MS=45000

# Cachés
USER_CACHE_TTL_MS=30000
CATEGORIAS_CACHE_TTL_MS=60000
EMBEDDING_CACHE_TTL_MS=600000
EMBEDDING_CACHE_MAX=500
STARLINK_CACHE_TTL_MS=60000
STARLINK_MAX_TIME_MS=4000

# RAG unificado
# En este proyecto quedó activo: RAG_BACKEND=unified
RAG_BACKEND=legacy
RAG_VECTOR_INDEX=vector_index_rag
RAG_MEMORY_FALLBACK_LIMIT=1200
RAG_MEMORY_FALLBACK_MAX_TIME_MS=3000
RAG_MAX_TIME_MS=2500

# OTP
OTP_RESEND_SECONDS=120
OTP_DAILY_LIMIT=5
OTP_BLOCK_HOURS=24

# Seguridad
FRONTEND_ORIGINS=
JSON_BODY_LIMIT=2mb
RATE_LIMIT_OTP=20
RATE_LIMIT_PASSWORD=20
RATE_LIMIT_CHAT=30
RATE_LIMIT_API=300

# Limpieza destructiva (desactivada por defecto)
PERMITIR_LIMPIEZA=false
```

`FRONTEND_ORIGINS` acepta una lista separada por comas. Si queda vacía, se mantiene el comportamiento anterior (cualquier origen) para no romper el despliegue.

### 14.5 Pasos manuales pendientes

1. **Respaldos (fase 0):** snapshot de Atlas, export de Firestore y `mongodump` antes de producción. Sigue pendiente y es lo único realmente crítico antes de un despliegue.
2. **Índices normales:** ya ejecutado con `node backend/scripts/crearIndices.js`.
3. **Índice vectorial:** ya creado `vector_index_rag` sobre `rag_documents.embedding` con **3072 dimensiones**, similitud coseno y filtros `activo`, `categoriaId`, `tipoFuente`, `idioma`. Estado actual: `READY`.
4. **Migración:** ya ejecutada. 160 fragmentos copiados desde `brochures`, `fluidos_de_perforacion`, `perforacion_direccional` y `software_y_manuales`. No se borró ningún documento ni colección.
5. **Backend unificado:** `RAG_BACKEND=unified` ya está en `backend/.env` y el backend se reinició con la nueva estructura. El endpoint `GET /api/admin/rag/unificado/estado` responde `backend: "unified"`, `total: 204` y las cinco fuentes.
6. **Verificación:** `node backend/scripts/reorganizarEstructura.js --verificar` devuelve todo `OK`; las pruebas de chat respondieron con similitud 0.87–0.93 y el inventario usó su índice vectorial.
7. **Estado del RAG:** verificado en caliente el 02/11/2026.
8. **Baseline y métricas:** registrar tiempos antes/después y revisar el tier/región de Atlas.
9. **Fase 6:** dividir `server.js` y limpiar comentarios en un commit separado.

### 14.6 Comportamiento seguro por defecto

- `RAG_BACKEND=unified`: el chat consulta `rag_documents` con el índice vectorial.
- El dual-write es *best-effort*: si falla, la ingesta no se bloquea.
- `PERMITIR_LIMPIEZA=false`: ninguna migración borra documentos ni colecciones.
- Las colecciones antiguas ya no existen; `RAG_BACKEND=legacy` queda solo como referencia y no encuentra datos. El rollback real hoy es restaurar un respaldo de Atlas.

### 14.7 Migración ejecutada (02/11/2026)

| Categoría | Colección | Fragmentos |
|---|---|---:|
| Brochures | `brochures` | 27 |
| Fluidos de Perforación | `fluidos_de_perforacion` | 16 |
| Perforación Direccional | `perforacion_direccional` | 18 |
| Software y Manuales | `software_y_manuales` | 99 |
| **Total** | `rag_documents` | **160** |

- Los embeddings se reutilizaron tal cual: **3072 dimensiones**, sin volver a llamar a Gemini.
- El script es idempotente: una segunda ejecución dejó el total en 160, sin duplicados.
- El plan gratuito de Atlas permitía 3 índices de búsqueda. Se liberó `vector_index_perforacion_direccional` (solo el índice; sus 18 documentos siguen intactos) y se creó `vector_index_rag`.
- Si algún día se vuelve a `legacy`, esa categoría usará la búsqueda por texto de respaldo, igual que ya ocurría con `fluidos_de_perforacion`.
- La web de la empresa (`conocimientos_pagina`, 44 fragmentos) y el inventario se seguían consultando por separado en ese momento; la reorganización posterior del mismo día los integró a `rag_documents` e `inventarios` (ver sección 15).
- Comandos útiles:
  - `node backend/scripts/migrarRagUnificado.js --diagnostico`
  - `node backend/scripts/migrarRagUnificado.js --verificar`
  - `node backend/scripts/migrarRagUnificado.js --verificar-vector`
  - `node backend/scripts/migrarRagUnificado.js --indices`
  - `node backend/scripts/migrarRagUnificado.js --esperar-indice`

---

## 15. Reorganización de la estructura de datos (02/11/2026)

Esta sección reemplaza el mapa de datos anterior y documenta lo que realmente quedó en producción.

### 15.1 Estructura final

| Almacén | Contenido | Uso |
|---|---|---|
| MongoDB `north_services_db` | `rag_documents` (204), `rag_documents_trash`, `categorias_conocimiento` (4), `permisos_rag_roles` (3), `starlink_bot` (3) | Colección vectorial activa, papelera física, permisos y Starlink |
| MongoDB `inventarios` | `inventario_mwd` (75), `inventario_motores` (236), `inventario_sync_status` (2) | Inventario y estado de sincronización |
| Firestore | `estado_web_empresa/web_empresa` | Estado de la última actualización de la web |
| Atlas Search | `north_services_db.rag_documents/vector_index_rag` (3072 dims), `inventarios.inventario_mwd/vector_index_inventario_mwd` (768 dims), `inventarios.inventario_motores/vector_index_inventario_motores` (768 dims) | Los 3 índices que permite M0, todos `READY` |

Ya no existen las bases `mwd` ni `motores`, ni las colecciones `brochures`, `fluidos_de_perforacion`, `perforacion_direccional`, `software_y_manuales`, `conocimientos_pagina`, `inventario_sync_status` (en `north_services_db`) ni `web_empresa_estado`.

### 15.2 Qué se movió

| Origen | Destino | Documentos |
|---|---|---:|
| `mwd.inventario_mwd` | `inventarios.inventario_mwd` | 75 |
| `motores.inventario_motores` | `inventarios.inventario_motores` | 236 |
| `north_services_db.inventario_sync_status` | `inventarios.inventario_sync_status` | 2 |
| `conocimientos_pagina` | `rag_documents` (`tipoFuente: web_empresa`) | 44 |
| `web_empresa_estado` | Firestore `estado_web_empresa/web_empresa` | 1 |
| Colecciones de categorías | ya estaban en `rag_documents` | 160 |

Total en `rag_documents`: **204** documentos, todos con embedding de **3072 dimensiones**, sin `documentoId` duplicados.

### 15.3 Cambios de código

- `src/db/mongodb.js`: `getDatabase` solo admite `north_services_db` e `inventarios`.
- `src/services/inventorySync.service.js`: inventarios y estado leen/escriben en `inventarios`; se retiró el uso de `getDB()` para inventario.
- `src/services/rag.service.js`: única puerta de escritura/lectura de `rag_documents` (upsert por `documentoId`, activación lógica para versiones obsoletas, papelera física en `rag_documents_trash`, limpieza por archivo/recurso/categoría/origen).
- `src/services/ragCategorias.service.js`: el ciclo de vida de categorías (activar, desactivar, eliminar) usa `rag_documents` cuando `RAG_BACKEND=unified`; el renombrado físico de colecciones queda solo para `legacy`.
- `src/services/webEmpresa.service.js`: indexa la web en `rag_documents` y guarda el estado en Firestore.
- `src/server.js`: ingesta, actualización y borrado de archivos usan las rutas unificadas; la papelera copia a `rag_documents_trash` y borra de `rag_documents`, la restauración hace lo inverso y el borrado definitivo elimina de ambas colecciones.
- `scripts/crearIndices.js`: plan de índices sobre `north_services_db` e `inventarios`.
- `scripts/reorganizarEstructura.js`: herramienta de copia, verificación, creación de índices y borrado controlado.

### 15.4 Comandos

```bash
# Diagnóstico de bases y conteos
node backend/scripts/reorganizarEstructura.js --diagnostico

# Copia idempotente (inventarios, web, estado)
node backend/scripts/reorganizarEstructura.js --copiar
node backend/scripts/reorganizarEstructura.js --copiar --dry-run

# Verificación antes de borrar
node backend/scripts/reorganizarEstructura.js --verificar

# Índices vectoriales de inventario
node backend/scripts/reorganizarEstructura.js --crear-indices
node backend/scripts/reorganizarEstructura.js --esperar-indices

# Borrado de lo antiguo (solo tras verificación OK)
node backend/scripts/reorganizarEstructura.js --eliminar-legacy --confirmar

# Índices normales
node backend/scripts/crearIndices.js
```

### 15.5 Verificación realizada

```
- inventario_mwd: 75 = 75 OK
- inventario_motores: 236 = 236 OK
- inventario_sync_status: 2 = 2 OK
- rag_documents: 204 documentos, 0 sin embedding
- Web de la empresa: 44 en rag_documents OK
- Dimensiones: 3072 x 204
- documentoId: sin duplicados
- Búsqueda RAG: similitud 0.90–0.93
- Búsqueda web: similitud 0.87
- Búsqueda de inventario: 0.88 con índice vectorial
```

### 15.6 Operación

- `RAG_BACKEND=unified` en `backend/.env`; el modo `legacy` queda solo como referencia histórica.
- `LOG_LEVEL=info` por defecto: la terminal muestra arranque, avisos y errores, más una línea por consulta. Con `LOG_LEVEL=debug` aparecen tiempos, scores, fuentes y detección de intenciones.
- `PERMITIR_LIMPIEZA=false` por defecto: las limpiezas de vectores antiguos no se ejecutan salvo que se habilite explícitamente.
- La papelera de archivos es física: los fragmentos se copian a `rag_documents_trash` y se eliminan de `rag_documents`, por lo que la IA no puede encontrarlos aunque un filtro falle. Restaurar los devuelve a `rag_documents`; el borrado definitivo los elimina de ambas colecciones.
- La papelera distingue el motivo (`papeleraMotivo: 'archivo' | 'categoria'`): al reactivar una categoría solo vuelven los archivos que retiró esa desactivación, no los que el usuario había borrado a mano.
- Las versiones obsoletas de un archivo reindexado o de la web sí quedan en `rag_documents` con `activo: false`; no son papelera y no se muestran.
- Las consultas de Starlink se responden solo con `starlink_bot`: no mezclan fragmentos del RAG general ni adjuntan descargas de manuales ajenos. Si el rol no tiene el módulo habilitado, la respuesta lo indica y no consulta otras fuentes; si falla MongoDB, tampoco cae al RAG de manuales.

### 15.7 Pendientes

1. **Reiniciar el backend** para que el proceso en ejecución use la nueva estructura.
2. Probar en caliente: `/api/admin/rag/unificado/estado`, chat, subida, actualización, papelera/restauración y consultas de inventario.
3. **Respaldos:** snapshot de Atlas y export de Firestore antes de desplegar.
4. **SMS:** sigue pendiente del proveedor; no se tocó `OTP_DESTINATION` ni Infobip.
5. **Fase 6:** dividir `server.js` y limpiar comentarios en un commit separado.


