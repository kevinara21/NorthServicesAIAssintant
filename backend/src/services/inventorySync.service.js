'use strict';

const crypto = require('node:crypto');
const { getDB, getDatabase } = require('../db/mongodb');

const COLLECTION_LEGACY_VECTORS = 'inventario_vectores';
const COLLECTION_STATUS = 'inventario_sync_status';
const EMBEDDING_MODEL = process.env.INVENTARIO_EMBEDDING_MODEL || 'gemini-embedding-001';
const VECTOR_INDEXES = {
  mwd: process.env.INVENTARIO_MWD_VECTOR_INDEX || 'vector_index_inventario_mwd',
  motores: process.env.INVENTARIO_MOTORES_VECTOR_INDEX || 'vector_index_inventario_motores',
};
const VECTOR_LIMIT = 5;
const BATCH_SIZE = 5;
const EMBEDDING_MIN_INTERVAL_MS = Number(process.env.INVENTARIO_EMBEDDING_MIN_INTERVAL_MS || 1000);
const EMBEDDING_MAX_RETRIES = Number(process.env.INVENTARIO_EMBEDDING_MAX_RETRIES || 3);
const MAX_AUTOMATIC_RETRY_WAIT_MS = 2 * 60 * 1000;
const SYNC_STALE_AFTER_MS = 2 * 60 * 1000;
const FIELDS = [
  'codigo',
  'nombre',
  'descripcion',
  'estado',
  'ubicacion',
  'lote',
  'ultimo_mantenimiento',
  'responsable',
  'observaciones',
];

const INVENTORIES = {
  mwd: { tipo: 'mwd', label: 'Inventario MWD', database: 'mwd', collection: 'inventario_mwd' },
  motores: { tipo: 'motor', label: 'Inventario Motores', database: 'motores', collection: 'inventario_motores' },
};

const running = new Map();
let legacyMigrationPromise = null;
let destinationTypesMigrationPromise = null;
let ultimoInicioEmbedding = 0;

function obtenerColeccionVectores(tipo) {
  const inventario = INVENTORIES[tipo];
  if (!inventario) throw new Error('Tipo de inventario no válido.');
  return getDatabase(inventario.database).collection(inventario.collection);
}

async function migrarVectoresLegados() {
  if (legacyMigrationPromise) return legacyMigrationPromise;
  legacyMigrationPromise = (async () => {
    const dbPrincipal = getDB();
    const nombresLegacy = [
      { collection: COLLECTION_LEGACY_VECTORS, tipo: null },
      { collection: 'inventario_mwd', tipo: 'mwd' },
      { collection: 'inventario_motores', tipo: 'motor' },
    ];

    for (const legacy of nombresLegacy) {
      const colecciones = await dbPrincipal.listCollections(
        { name: legacy.collection },
        { nameOnly: true }
      ).toArray();
      if (!colecciones.length) continue;

      const origen = dbPrincipal.collection(legacy.collection);
      for (const key of ['mwd', 'motores']) {
        const inventario = INVENTORIES[key];
        const tiposOrigen = key === 'mwd' ? ['mwd'] : ['motor', 'motores'];
        if (legacy.tipo && !tiposOrigen.includes(legacy.tipo)) continue;
        const filtroOrigen = legacy.tipo ? {} : { tipo: { $in: tiposOrigen } };
        const cantidadOrigen = await origen.countDocuments(filtroOrigen);
        if (!cantidadOrigen) continue;

        const destino = obtenerColeccionVectores(key);
        const cursor = origen.find(filtroOrigen);
        let lote = [];
        while (await cursor.hasNext()) {
          const doc = await cursor.next();
          const { _id, ...campos } = doc;
          lote.push({
            replaceOne: {
              filter: { _id },
              replacement: { _id, ...campos, tipo: inventario.tipo },
              upsert: true,
            },
          });
          if (lote.length === 200) {
            await destino.bulkWrite(lote, { ordered: false });
            lote = [];
          }
        }
        if (lote.length) await destino.bulkWrite(lote, { ordered: false });

        const cantidadDestino = await destino.countDocuments({ tipo: inventario.tipo });
        if (cantidadDestino < cantidadOrigen) {
          throw new Error(`La migración antigua de ${key} quedó incompleta: ${cantidadDestino} de ${cantidadOrigen} registros copiados. Se conservó ${legacy.collection}.`);
        }
        await origen.deleteMany(filtroOrigen);
        console.log(`[INVENTARIO] Migrados ${cantidadOrigen} vectores de north_services_db.${legacy.collection} a ${inventario.database}.${inventario.collection}.`);
      }

      if (await origen.countDocuments() === 0) {
        await dbPrincipal.dropCollection(legacy.collection);
        console.log(`[INVENTARIO] Colección anterior north_services_db.${legacy.collection} retirada.`);
      } else if (legacy.tipo) {
        throw new Error(`La colección antigua ${legacy.collection} contiene documentos sin migrar; se conservó para proteger los datos.`);
      }
    }
  })().catch((error) => {
    legacyMigrationPromise = null;
    throw error;
  });
  return legacyMigrationPromise;
}

async function prepararColeccionesInventario() {
  await migrarVectoresLegados();
  const statusDB = getDB();
  const statusCollections = await statusDB.listCollections({}, { nameOnly: true }).toArray();
  if (!statusCollections.some((collection) => collection.name === COLLECTION_STATUS)) {
    try {
      await statusDB.createCollection(COLLECTION_STATUS);
    } catch (error) {
      if (error.code !== 48) throw error;
    }
  }
  for (const inventario of Object.values(INVENTORIES)) {
    const db = getDatabase(inventario.database);
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    if (collections.some((collection) => collection.name === inventario.collection)) continue;
    try {
      await db.createCollection(inventario.collection);
    } catch (error) {
      if (error.code !== 48) throw error;
    }
  }
  if (!destinationTypesMigrationPromise) {
    destinationTypesMigrationPromise = Promise.all(Object.entries(INVENTORIES).map(([key, inventario]) => {
      const legacyTypes = key === 'motores' ? ['motores'] : [];
      if (!legacyTypes.length) return Promise.resolve();
      return obtenerColeccionVectores(key).updateMany(
        { tipo: { $in: legacyTypes } },
        { $set: { tipo: inventario.tipo } }
      );
    })).catch((error) => {
      destinationTypesMigrationPromise = null;
      throw error;
    });
  }
  await destinationTypesMigrationPromise;
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function esperarIntervaloEmbedding() {
  const ahora = Date.now();
  const siguienteInicio = Math.max(ahora, ultimoInicioEmbedding + EMBEDDING_MIN_INTERVAL_MS);
  ultimoInicioEmbedding = siguienteInicio;
  const espera = siguienteInicio - ahora;
  if (espera) await esperar(espera);
}

function obtenerEsperaDeReintento(response, cuerpo) {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter * 1000);

  const retryInfo = cuerpo?.error?.details?.find((detalle) => detalle['@type']?.endsWith('.RetryInfo'));
  const retryDelay = String(retryInfo?.retryDelay || '').match(/^(\d+(?:\.\d+)?)s$/);
  if (retryDelay) return Math.ceil(Number(retryDelay[1]) * 1000);
  return 60000;
}

function resumirErrorGemini(status, cuerpo) {
  const mensaje = String(cuerpo?.error?.message || '').replace(/\s+/g, ' ').trim();
  if (status === 429) {
    return `Gemini alcanzó el límite temporal de solicitudes. La sincronización guardó los lotes anteriores; espera el reinicio de cuota y vuelve a sincronizar.`;
  }
  return `Gemini embeddings respondió HTTP ${status}${mensaje ? `: ${mensaje}` : '.'}`;
}

function hashContenido(texto) {
  return crypto.createHash('sha256').update(texto).digest('hex');
}

function obtenerConfiguracionPuente(tipo) {
  const inventario = INVENTORIES[tipo];
  if (!inventario) throw new Error('Tipo de inventario no válido.');

  const bridgeUrl = process.env.INVENTORY_BRIDGE_URL;
  const bridgeToken = process.env.INVENTORY_BRIDGE_TOKEN;
  if (!bridgeUrl || !bridgeToken) {
    throw new Error('Configura INVENTORY_BRIDGE_URL e INVENTORY_BRIDGE_TOKEN para conectar con el puente seguro del hosting.');
  }
  let url;
  try {
    url = new URL(bridgeUrl);
  } catch {
    throw new Error('INVENTORY_BRIDGE_URL no contiene una URL válida.');
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('INVENTORY_BRIDGE_URL debe usar HTTPS fuera del entorno local.');
  }
  return { ...inventario, bridgeUrl: url, bridgeToken };
}

function normalizarValor(valor) {
  if (valor === null || valor === undefined) return '';
  if (valor instanceof Date) return valor.toISOString();
  if (Buffer.isBuffer(valor)) return valor.toString('utf8');
  return String(valor).trim();
}

function obtenerCodigoVisible(tipo, row, codigoInterno) {
  const especificado = normalizarValor(row.codigo_visible);
  if (especificado) return especificado;
  if (tipo !== 'mwd') return codigoInterno;

  const identificadorExterno = normalizarValor(row.descripcion)
    .match(/(?:^|;\s*)identificador externo\s+([^;]+)/i)?.[1]
    ?.trim();
  if (!identificadorExterno) return codigoInterno;
  return /^\d+$/.test(identificadorExterno)
    ? (identificadorExterno.replace(/^0+/, '') || '0')
    : identificadorExterno;
}

function construirTextoPlano(tipo, metadata) {
  const etiquetas = {
    nombre: 'nombre',
    descripcion: 'descripción',
    estado: 'estado',
    ubicacion: 'ubicación',
    lote: 'lote',
    ultimo_mantenimiento: 'último mantenimiento',
    responsable: 'responsable',
    observaciones: 'observaciones',
  };
  const detalles = FIELDS
    .filter((field) => field !== 'codigo' && metadata[field])
    .map((field) => `${etiquetas[field]} ${metadata[field]}`);
  const nombre = tipo === 'mwd' ? 'Inventario MWD' : 'Inventario de motores';
  const codigoVisible = metadata.codigo_visible || metadata.codigo;
  return `${nombre}, código ${codigoVisible}${detalles.length ? `; ${detalles.join('; ')}` : ''}.`;
}

function obtenerClaveGemini() {
  const clave = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_FALLBACK]
    .find((valor) => valor && !/^sk-/.test(String(valor).trim()));
  if (!clave) throw new Error('No está configurada una clave de Google Gemini para generar embeddings de inventario.');
  return clave;
}

async function generarEmbeddingInventario(texto) {
  for (let intento = 0; intento <= EMBEDDING_MAX_RETRIES; intento += 1) {
    await esperarIntervaloEmbedding();
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(EMBEDDING_MODEL)}:embedContent?key=${encodeURIComponent(obtenerClaveGemini())}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text: texto }] },
          outputDimensionality: 768,
        }),
        signal: AbortSignal.timeout(30000),
      }
    );
    if (response.ok) {
      const data = await response.json();
      const embedding = data?.embedding?.values;
      if (!Array.isArray(embedding) || embedding.length !== 768) {
        throw new Error(`Gemini no devolvió un vector válido de 768 dimensiones para ${EMBEDDING_MODEL}.`);
      }
      return embedding;
    }

    const body = await response.text();
    let errorBody;
    try {
      errorBody = JSON.parse(body);
    } catch {
      errorBody = null;
    }
    if (response.status !== 429 || intento === EMBEDDING_MAX_RETRIES) {
      throw new Error(resumirErrorGemini(response.status, errorBody));
    }

    const delay = obtenerEsperaDeReintento(response, errorBody);
    if (delay > MAX_AUTOMATIC_RETRY_WAIT_MS) {
      const minutos = Math.ceil(delay / 60000);
      throw new Error(`Gemini indicó que la cuota no se restablecerá durante aproximadamente ${minutos} minutos. Se conservaron los lotes completados; espera ese plazo y vuelve a sincronizar.`);
    }
    console.warn(`[INVENTARIO] Gemini aplicó un límite temporal; reintento ${intento + 1}/${EMBEDDING_MAX_RETRIES} en ${Math.ceil(delay / 1000)} segundos.`);
    await esperar(delay);
  }
}

async function guardarEstado(tipo, actualizacion) {
  await getDB().collection(COLLECTION_STATUS).updateOne(
    { _id: tipo },
    { $set: { tipo, actualizadoEn: new Date(), ...actualizacion } },
    { upsert: true }
  );
}

async function leerFilasDesdePuente(tipo, config) {
  const url = new URL(config.bridgeUrl);
  url.searchParams.set('tipo', tipo);
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${config.bridgeToken}`,
      'X-Inventory-Token': config.bridgeToken,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(120000),
  });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(`El puente de inventarios devolvió una respuesta no JSON (HTTP ${response.status}). Verifica que el archivo PHP esté instalado y que la URL sea correcta.`);
  }
  const payload = await response.json();
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.error || `El puente de inventarios respondió HTTP ${response.status}.`);
  }
  if (payload.tipo !== tipo || !Array.isArray(payload.registros)) {
    throw new Error('El puente de inventarios devolvió un formato de datos no válido.');
  }
  if (payload.registros.length > 10000) {
    throw new Error('El puente devolvió más de 10.000 registros; se detuvo la sincronización para evitar una carga incompleta.');
  }
  return payload.registros;
}

async function ejecutarSincronizacion(tipo, config, job) {
  try {
    await prepararColeccionesInventario();
    await guardarEstado(tipo, {
      estado: job.estado,
      progreso: job.progreso,
      procesados: job.procesados,
      total: job.total,
      iniciadoEn: job.iniciadoEn,
      error: null,
    });
    const rows = await leerFilasDesdePuente(tipo, config);
    const tipoDocumento = INVENTORIES[tipo].tipo;

    const codigosActuales = rows.map((row) => normalizarValor(row.codigo));
    if (codigosActuales.some((codigo) => !codigo)) {
      throw new Error('Se encontró un registro sin código; la sincronización se detuvo para evitar datos ambiguos.');
    }
    if (new Set(codigosActuales).size !== codigosActuales.length) {
      throw new Error('El inventario contiene códigos duplicados; la sincronización se detuvo sin borrar los registros previos.');
    }

    job.total = rows.length;
    await guardarEstado(tipo, {
      estado: job.estado,
      progreso: rows.length ? 0 : 100,
      procesados: 0,
      total: rows.length,
      iniciadoEn: job.iniciadoEn,
      error: null,
    });

    const collection = obtenerColeccionVectores(tipo);
    const existentes = await collection.find(
      { tipo: tipoDocumento },
      { projection: { codigo: 1, contenido_hash: 1, embedding_modelo: 1, embedding: 1 } }
    ).toArray();
    const existentesPorCodigo = new Map(existentes.map((documento) => [documento.codigo, documento]));

    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const lote = rows.slice(offset, offset + BATCH_SIZE);
      const operaciones = [];
      for (const row of lote) {
        const metadata = Object.fromEntries(FIELDS.map((field) => [field, normalizarValor(row[field])]));
        metadata.codigo_visible = obtenerCodigoVisible(tipo, row, metadata.codigo);
        const textoPlano = construirTextoPlano(tipo, metadata);
        const contenidoHash = hashContenido(textoPlano);
        const existente = existentesPorCodigo.get(metadata.codigo);
        const embeddingValido = Array.isArray(existente?.embedding) && existente.embedding.length === 768;
        const embeddingSinCambio = embeddingValido
          && existente.contenido_hash === contenidoHash
          && existente.embedding_modelo === EMBEDDING_MODEL;
        const embedding = embeddingSinCambio
          ? existente.embedding
          : await generarEmbeddingInventario(textoPlano);
        operaciones.push({
          updateOne: {
            filter: { tipo: tipoDocumento, codigo: metadata.codigo },
            update: {
              $set: {
                tipo: tipoDocumento,
                codigo: metadata.codigo,
                texto_plano: textoPlano,
                embedding,
                contenido_hash: contenidoHash,
                embedding_modelo: EMBEDDING_MODEL,
                metadata_original: metadata,
                fecha_sync: new Date(),
              },
            },
            upsert: true,
          },
        });
      }
      if (operaciones.length) {
        await collection.bulkWrite(operaciones, { ordered: true });
      }
      job.procesados = offset + lote.length;
      job.progreso = job.total ? Math.floor((job.procesados / job.total) * 100) : 100;
      await guardarEstado(tipo, {
        estado: job.estado,
        progreso: job.progreso,
        procesados: job.procesados,
        total: job.total,
        iniciadoEn: job.iniciadoEn,
        error: null,
      });
    }

    if (rows.length) {
      await collection.deleteMany({ tipo: tipoDocumento, codigo: { $nin: codigosActuales } });
    } else {
      await collection.deleteMany({ tipo: tipoDocumento });
    }

    job.estado = 'completado';
    job.progreso = 100;
    job.completadoEn = new Date();
    await guardarEstado(tipo, {
      estado: job.estado,
      progreso: 100,
      procesados: job.procesados,
      total: job.total,
      ultimaSync: job.completadoEn,
      completadoEn: job.completadoEn,
      error: null,
    });
    console.log(`[INVENTARIO] Sincronización ${tipo} completada: ${job.procesados} registros.`);
  } catch (error) {
    job.estado = 'error';
    job.error = error.message;
    await guardarEstado(tipo, {
      estado: job.estado,
      progreso: job.progreso,
      procesados: job.procesados,
      total: job.total,
      error: error.message,
    }).catch((errorEstado) => {
      console.error(`[INVENTARIO] No se pudo guardar el estado de error de ${tipo}:`, errorEstado.message);
    });
    console.error(`[INVENTARIO] Error al sincronizar ${tipo}:`, error.message);
  } finally {
    running.delete(tipo);
  }
}

function iniciarSincronizacion(tipo) {
  if (!INVENTORIES[tipo]) throw new Error('Tipo de inventario no válido.');
  if (running.has(tipo)) return { iniciada: false, estado: running.get(tipo) };

  const config = obtenerConfiguracionPuente(tipo);
  const job = {
    tipo,
    estado: 'sincronizando',
    progreso: 0,
    procesados: 0,
    total: 0,
    iniciadoEn: new Date(),
  };
  running.set(tipo, job);
  ejecutarSincronizacion(tipo, config, job);
  return { iniciada: true, estado: job };
}

async function obtenerEstados() {
  const mongoDb = getDB();
  await prepararColeccionesInventario();
  const estados = await mongoDb.collection(COLLECTION_STATUS).find({}).toArray();
  const porTipo = new Map(estados.map((estado) => [estado.tipo, estado]));
  const resultado = {};

  for (const [key, inventario] of Object.entries(INVENTORIES)) {
    const guardado = porTipo.get(key) || {};
    const job = running.get(key);
    const estadoActualizadoEn = guardado.actualizadoEn
      ? new Date(guardado.actualizadoEn).getTime()
      : 0;
    const sincronizacionCaducada = Date.now() - estadoActualizadoEn > SYNC_STALE_AFTER_MS;
    if (guardado.estado === 'sincronizando' && !job && sincronizacionCaducada) {
      guardado.estado = 'error';
      guardado.error = 'La sincronización se interrumpió al reiniciar el servicio. Iníciala nuevamente.';
      await guardarEstado(key, {
        estado: guardado.estado,
        error: guardado.error,
      });
    }
    const totalRegistros = await obtenerColeccionVectores(key)
      .countDocuments({ tipo: inventario.tipo });
    resultado[key] = {
      tipo: inventario.tipo,
      nombre: inventario.label,
      estado: job?.estado || guardado.estado || 'pendiente',
      progreso: job?.progreso ?? guardado.progreso ?? 0,
      procesados: job?.procesados ?? guardado.procesados ?? 0,
      total: job?.total ?? guardado.total ?? totalRegistros,
      totalRegistros,
      ultimaSync: guardado.ultimaSync || null,
      error: job?.error || (guardado.estado === 'error' ? guardado.error : null),
    };
  }
  return resultado;
}

function similitudCoseno(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let producto = 0;
  let normaA = 0;
  let normaB = 0;
  for (let i = 0; i < a.length; i += 1) {
    producto += a[i] * b[i];
    normaA += a[i] ** 2;
    normaB += b[i] ** 2;
  }
  if (!normaA || !normaB) return 0;
  return producto / (Math.sqrt(normaA) * Math.sqrt(normaB));
}

async function buscarInventario(pregunta) {
  const mongoDb = getDB();
  await prepararColeccionesInventario();
  const disponibles = await Promise.all(Object.entries(INVENTORIES).map(async ([key, inventario]) => {
    const collection = obtenerColeccionVectores(key);
    const total = await collection.countDocuments({ tipo: inventario.tipo });
    return { key, inventario, collection, total };
  }));
  if (disponibles.every(({ total }) => total === 0)) return [];

  const queryVector = await generarEmbeddingInventario(pregunta);
  const resultados = await Promise.all(disponibles.map(async ({ key, inventario, collection, total }) => {
    if (!total) return [];
    let indiceDisponible = false;
    try {
      const indices = await collection.listSearchIndexes().toArray();
      indiceDisponible = indices.some((indice) => indice.name === VECTOR_INDEXES[key]);
    } catch (error) {
      console.warn(`[INVENTARIO] No se pudo consultar el índice de ${key}; se utilizará búsqueda en memoria: ${error.message}`);
    }

    if (indiceDisponible) {
      try {
        return await collection.aggregate([
          {
            $vectorSearch: {
              index: VECTOR_INDEXES[key],
              path: 'embedding',
              queryVector,
              numCandidates: Math.max(50, VECTOR_LIMIT * 10),
              limit: VECTOR_LIMIT,
            },
          },
          {
            $project: {
              tipo: 1,
              codigo: 1,
              texto_plano: 1,
              metadata_original: 1,
              score: { $meta: 'vectorSearchScore' },
            },
          },
        ]).toArray();
      } catch (error) {
        console.warn(`[INVENTARIO] Falló Atlas Vector Search para ${key}; se utilizará búsqueda en memoria: ${error.message}`);
      }
    }

    if (total > 4000) {
      console.warn(`[INVENTARIO] No hay índice Atlas para ${key}; búsqueda en memoria limitada a 4000 de ${total} registros.`);
    }
    const documentos = await collection.find({ tipo: inventario.tipo, embedding: { $exists: true } })
      .limit(4000)
      .toArray();
    return documentos
      .map((documento) => ({ ...documento, score: similitudCoseno(queryVector, documento.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, VECTOR_LIMIT);
  }));

  return resultados.flat().sort((a, b) => b.score - a.score).slice(0, VECTOR_LIMIT);
}

module.exports = {
  iniciarSincronizacion,
  obtenerEstados,
  buscarInventario,
  prepararColeccionesInventario,
};
