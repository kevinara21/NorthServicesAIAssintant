'use strict';

const crypto = require('node:crypto');
const { getDB } = require('../db/mongodb');

// RAG unificado (fase 2).
//
// El backend histórico consulta una colección distinta por cada categoría.
// Este servicio ofrece UNA sola búsqueda sobre `rag_documents` y se activa
// con RAG_BACKEND=unified. Por defecto sigue en `legacy` para no cambiar el
// comportamiento ni exigir la reindexación inmediata.
//
// La papelera de archivos es una colección aparte: `rag_documents_trash`.
// Así el contenido borrado no está en la colección que consulta la IA ni
// depende de que un filtro se acuerde de excluirlo.
//
// Lo que sí se queda en `rag_documents` con `activo: false` son las versiones
// obsoletas de un archivo reindexado o de la web: no son papelera, solo
// reemplazos que ya no deben competir en la búsqueda.

const COLECCION = 'rag_documents';
const COLECCION_PAPELERA = 'rag_documents_trash';
const INDICE = process.env.RAG_VECTOR_INDEX || 'vector_index_rag';
const LIMITE_POR_DEFECTO = Number(process.env.RAG_LIMIT || 5);
const CANDIDATOS = Number(process.env.RAG_NUM_CANDIDATES || 200);
const UMBRAL = Number(process.env.RAG_SCORE_THRESHOLD || 0.56);

function backendUnificadoActivo() {
  return String(process.env.RAG_BACKEND || 'legacy').toLowerCase() === 'unified';
}

function hashContenido(texto) {
  return crypto.createHash('sha256').update(String(texto || '')).digest('hex');
}

function escaparRegex(texto) {
  return String(texto || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mapearFila(fila) {
  return {
    _id: fila._id,
    documentoId: fila.documentoId,
    archivoId: fila.archivoId,
    recursoId: fila.recursoId,
    manualId: fila.manualId,
    nombreManual: fila.nombreManual,
    titulo_seccion: fila.titulo_seccion,
    rutaTitulos: fila.rutaTitulos,
    pagina: fila.pagina,
    contenido_texto: fila.contenido_texto,
    score: Number(fila.score || 0),
    categoriaId: fila.categoriaId,
    categoriaNombre: fila.categoriaNombre,
    busquedaUnificada: true,
  };
}

async function buscarPorVector({ vector, categoriaIds, limite = LIMITE_POR_DEFECTO, umbral = UMBRAL }) {
  const filtro = { activo: { $ne: false } };
  if (Array.isArray(categoriaIds) && categoriaIds.length) {
    filtro.categoriaId = { $in: categoriaIds };
  }

  const pipeline = [
    {
      $vectorSearch: {
        index: INDICE,
        path: 'embedding',
        queryVector: vector,
        numCandidates: Math.max(CANDIDATOS, limite * 10),
        limit: Math.max(limite * 4, 20),
        filter: filtro,
      },
    },
    {
      $project: {
        _id: 1,
        documentoId: 1,
        archivoId: 1,
        recursoId: 1,
        manualId: 1,
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
    { $match: { score: { $gte: umbral } } },
    { $limit: limite },
  ];

  const filas = await getDB()
    .collection(COLECCION)
    .aggregate(pipeline, { maxTimeMS: Number(process.env.RAG_MAX_TIME_MS || 2500) })
    .toArray();

  return filas.map(mapearFila);
}

async function buscarPorTexto({ pregunta, categoriaIds, limite = LIMITE_POR_DEFECTO }) {
  const terminos = [...new Set(
    String(pregunta || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]{3,}/gu) || []
  )].slice(0, 6);

  if (!terminos.length) return [];

  const filtro = { activo: { $ne: false } };
  if (Array.isArray(categoriaIds) && categoriaIds.length) {
    filtro.categoriaId = { $in: categoriaIds };
  }
  filtro.$or = terminos.map((termino) => ({
    contenido_texto: { $regex: escaparRegex(termino), $options: 'i' },
  }));

  const filas = await getDB()
    .collection(COLECCION)
    .find(filtro, {
      projection: {
        documentoId: 1,
        archivoId: 1,
        recursoId: 1,
        manualId: 1,
        nombreManual: 1,
        titulo_seccion: 1,
        rutaTitulos: 1,
        pagina: 1,
        contenido_texto: 1,
        categoriaId: 1,
        categoriaNombre: 1,
      },
    })
    .limit(300)
    .maxTimeMS(Number(process.env.RAG_MAX_TIME_MS || 2500))
    .toArray();

  const normalizado = (texto) => String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  return filas
    .map((fila) => {
      const texto = normalizado(fila.contenido_texto);
      const coincidencias = terminos.filter((termino) => texto.includes(termino)).length;
      return {
        ...fila,
        score: coincidencias / terminos.length,
        busquedaLexica: true,
      };
    })
    .filter((fila) => fila.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limite)
    .map(mapearFila);
}

async function buscarUnificado({ vectorConsulta, pregunta, categoriaIds, limite = LIMITE_POR_DEFECTO, umbral = UMBRAL }) {
  if (vectorConsulta?.length) {
    try {
      return await buscarPorVector({ vector: vectorConsulta, categoriaIds, limite, umbral });
    } catch (error) {
      console.warn(`[RAG] vectorSearch unificado falló (${error.message}); se intenta texto.`);
    }
  }
  return buscarPorTexto({ pregunta, categoriaIds, limite });
}

// Copia los vectores recién indexados a `rag_documents` reutilizando el
// embedding ya calculado: la ingesta no paga una segunda llamada a Gemini.
async function indexarVectores(vectores, { categoria } = {}) {
  if (!Array.isArray(vectores) || !vectores.length) return { escritos: 0 };

  const operaciones = vectores
    .filter((vector) => vector && Array.isArray(vector.embedding))
    .map((vector) => {
      const indiceFragmento = vector.indiceFragmento || 0;
      const documentoId = vector.documentoId
        || `${vector.archivoId || vector.recursoId || vector.manualId || 'doc'}:${indiceFragmento}`;
      const contenido = String(vector.contenido_texto || '');
      return {
        replaceOne: {
          filter: { documentoId },
          replacement: {
            documentoId,
            archivoId: vector.archivoId || null,
            recursoId: vector.recursoId || null,
            manualId: vector.manualId || null,
            indiceFragmento,
            totalFragmentos: vector.totalFragmentos || null,
            hashContenido: hashContenido(contenido),
            version: vector.versionArchivo || vector.version || null,
            nombreManual: vector.nombreManual || vector.nombreArchivo || 'Documento',
            titulo_seccion: vector.titulo_seccion || '',
            rutaTitulos: vector.rutaTitulos || '',
            pagina: vector.pagina ?? null,
            contenido_texto: contenido,
            embedding: vector.embedding,
            categoriaId: vector.categoriaId || categoria?.id || null,
            categoriaNombre: vector.categoriaNombre || categoria?.nombre || null,
            tipoFuente: vector.tipoFuente || 'categoria',
            origen: vector.origen || null,
            urlPagina: vector.urlPagina || null,
            tituloPagina: vector.tituloPagina || null,
            parte: vector.parte ?? null,
            activo: true,
            idioma: vector.idioma || 'es',
            fechaIndexacion: vector.fechaIndexacion || new Date(),
          },
          upsert: true,
        },
      };
    });

  if (!operaciones.length) return { escritos: 0 };
  await getDB().collection(COLECCION).bulkWrite(operaciones, { ordered: false });
  return { escritos: operaciones.length };
}

// Marca como obsoletos los fragmentos de un archivo sin sacarlos de la
// colección. Se usa al reindexar; la papelera real es `rag_documents_trash`.
async function desactivarPorArchivo(archivoId) {
  if (!archivoId) return { modificados: 0 };
  const resultado = await getDB()
    .collection(COLECCION)
    .updateMany({ archivoId }, { $set: { activo: false, desactivadoEn: new Date() } });
  return { modificados: resultado.modifiedCount };
}

async function activarPorArchivo(archivoId) {
  if (!archivoId) return { modificados: 0 };
  const resultado = await getDB()
    .collection(COLECCION)
    .updateMany({ archivoId }, { $set: { activo: true } });
  return { modificados: resultado.modifiedCount };
}

async function desactivarPorCategoria(categoriaId) {
  if (!categoriaId) return { modificados: 0 };
  const resultado = await getDB()
    .collection(COLECCION)
    .updateMany({ categoriaId }, { $set: { activo: false } });
  return { modificados: resultado.modifiedCount };
}

async function activarPorCategoria(categoriaId) {
  if (!categoriaId) return { modificados: 0 };
  const resultado = await getDB()
    .collection(COLECCION)
    .updateMany({ categoriaId }, { $set: { activo: true } });
  return { modificados: resultado.modifiedCount };
}

// ============================================================
// PAPELERA FÍSICA (`rag_documents_trash`)
// ============================================================
//
// Los documentos se COPIAN a la papelera y solo se borran del buscador
// después de que la copia se escribió. Si algo falla a mitad, la búsqueda
// sigue funcionando y la papelera no queda a medias.
//
// `papeleraMotivo` distingue quién mandó el documento a la papelera:
//   - 'archivo':   se borró un archivo concreto.
//   - 'categoria': se desactivó toda una categoría.
// Al reactivar la categoría solo vuelven los suyos; los archivos que ya
// estaban en la papelera a mano siguen ahí.

async function moverDocumentosAPapelera(filtro, motivo) {
  const buscador = getDB().collection(COLECCION);
  const documentos = await buscador.find(filtro).toArray();
  if (!documentos.length) return { movidos: 0 };

  const ahora = new Date();
  await getDB().collection(COLECCION_PAPELERA).bulkWrite(
    documentos.map((documento) => ({
      replaceOne: {
        filter: { _id: documento._id },
        replacement: {
          ...documento,
          activo: false,
          papeleraMotivo: motivo,
          papeleraEn: ahora,
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  await buscador.deleteMany({ _id: { $in: documentos.map((documento) => documento._id) } });
  return { movidos: documentos.length };
}

async function restaurarDocumentosDePapelera(filtro) {
  const papelera = getDB().collection(COLECCION_PAPELERA);
  const documentos = await papelera.find(filtro).toArray();
  if (!documentos.length) return { restaurados: 0 };

  await getDB().collection(COLECCION).bulkWrite(
    documentos.map((documento) => {
      const { papeleraMotivo, papeleraEn, ...resto } = documento;
      return {
        replaceOne: {
          filter: { _id: documento._id },
          replacement: { ...resto, activo: true },
          upsert: true,
        },
      };
    }),
    { ordered: false }
  );

  await papelera.deleteMany({ _id: { $in: documentos.map((documento) => documento._id) } });
  return { restaurados: documentos.length };
}

async function moverArchivoAPapelera(archivoId) {
  if (!archivoId) return { movidos: 0 };
  return moverDocumentosAPapelera({ archivoId }, 'archivo');
}

async function restaurarArchivoDesdePapelera(archivoId) {
  if (!archivoId) return { restaurados: 0 };
  const desdePapelera = await restaurarDocumentosDePapelera({
    archivoId,
    papeleraMotivo: 'archivo',
  });

  // Compatibilidad con documentos que quedaron desactivados antes de que
  // existiera la papelera física. Se reactivan solo para este archivo.
  const compatibilidad = await getDB()
    .collection(COLECCION)
    .updateMany({ archivoId, activo: false }, { $set: { activo: true } });

  return {
    restaurados: desdePapelera.restaurados + (compatibilidad.modifiedCount || 0),
  };
}

async function moverCategoriaAPapelera(categoriaId) {
  if (!categoriaId) return { movidos: 0 };
  return moverDocumentosAPapelera({ categoriaId }, 'categoria');
}

async function restaurarCategoriaDesdePapelera(categoriaId) {
  if (!categoriaId) return { restaurados: 0 };
  // Solo vuelven los que retiró la desactivación de la categoría. Un archivo
  // que el usuario mandó a la papelera por su cuenta debe seguir ahí.
  return restaurarDocumentosDePapelera({ categoriaId, papeleraMotivo: 'categoria' });
}

async function eliminarArchivoPermanente(archivoId) {
  if (!archivoId) return { eliminados: 0 };
  const [activos, papelera] = await Promise.all([
    getDB().collection(COLECCION).deleteMany({ archivoId }),
    getDB().collection(COLECCION_PAPELERA).deleteMany({ archivoId }),
  ]);
  return { eliminados: (activos.deletedCount || 0) + (papelera.deletedCount || 0) };
}

// Devuelve los fragmentos de un archivo, incluidos los inactivos. Se usa para
// poder restaurarlos si una actualización falla a mitad de camino.
async function obtenerPorArchivo(archivoId) {
  if (!archivoId) return [];
  return getDB().collection(COLECCION).find({ archivoId }).toArray();
}

async function desactivarObsoletosPorArchivo(archivoId, versionVigente) {
  if (!archivoId) return { modificados: 0 };
  const resultado = await getDB().collection(COLECCION).updateMany(
    { archivoId, version: { $ne: versionVigente } },
    { $set: { activo: false, desactivadoEn: new Date() } }
  );
  return { modificados: resultado.modifiedCount };
}

async function eliminarPorArchivoVersion(archivoId, version) {
  if (!archivoId || !version) return { eliminados: 0 };
  const resultado = await getDB().collection(COLECCION).deleteMany({ archivoId, version });
  return { eliminados: resultado.deletedCount || 0 };
}

async function restaurarVectores(documentos) {
  if (!Array.isArray(documentos) || !documentos.length) return { restaurados: 0 };
  const operaciones = documentos
    .filter((documento) => documento && documento._id)
    .map((documento) => ({
      replaceOne: {
        filter: { _id: documento._id },
        replacement: documento,
        upsert: true,
      },
    }));
  if (!operaciones.length) return { restaurados: 0 };
  await getDB().collection(COLECCION).bulkWrite(operaciones, { ordered: false });
  return { restaurados: operaciones.length };
}

async function eliminarPorArchivo(archivoId) {
  if (!archivoId) return { eliminados: 0 };
  const [activos, papelera] = await Promise.all([
    getDB().collection(COLECCION).deleteMany({ archivoId }),
    getDB().collection(COLECCION_PAPELERA).deleteMany({ archivoId }),
  ]);
  return { eliminados: (activos.deletedCount || 0) + (papelera.deletedCount || 0) };
}

async function eliminarPorManual(manualId) {
  if (!manualId) return { eliminados: 0 };
  const [activos, papelera] = await Promise.all([
    getDB().collection(COLECCION).deleteMany({ manualId }),
    getDB().collection(COLECCION_PAPELERA).deleteMany({ manualId }),
  ]);
  return { eliminados: (activos.deletedCount || 0) + (papelera.deletedCount || 0) };
}

async function eliminarPorRecurso(recursoId) {
  if (!recursoId) return { eliminados: 0 };
  const [activos, papelera] = await Promise.all([
    getDB().collection(COLECCION).deleteMany({ recursoId }),
    getDB().collection(COLECCION_PAPELERA).deleteMany({ recursoId }),
  ]);
  return { eliminados: (activos.deletedCount || 0) + (papelera.deletedCount || 0) };
}

async function eliminarPorCategoria(categoriaId) {
  if (!categoriaId) return { eliminados: 0 };
  const [activos, papelera] = await Promise.all([
    getDB().collection(COLECCION).deleteMany({ categoriaId }),
    getDB().collection(COLECCION_PAPELERA).deleteMany({ categoriaId }),
  ]);
  return { eliminados: (activos.deletedCount || 0) + (papelera.deletedCount || 0) };
}

async function desactivarPorOrigen(origen, { anterioresA = null } = {}) {
  if (!origen) return { modificados: 0 };
  const filtro = { origen };
  if (anterioresA) filtro.fechaIndexacion = { $lt: anterioresA };
  const resultado = await getDB()
    .collection(COLECCION)
    .updateMany(filtro, { $set: { activo: false, desactivadoEn: new Date() } });
  return { modificados: resultado.modifiedCount };
}

async function eliminarPorOrigen(origen, { anterioresA = null } = {}) {
  if (!origen) return { eliminados: 0 };
  const filtro = { origen };
  if (anterioresA) filtro.fechaIndexacion = { $lt: anterioresA };
  const resultado = await getDB().collection(COLECCION).deleteMany(filtro);
  return { eliminados: resultado.deletedCount || 0 };
}

let cacheIndiceDisponible = { valor: null, expira: 0 };
const TTL_CACHE_INDICE_MS = 60000;

function invalidarCacheIndice() {
  cacheIndiceDisponible = { valor: null, expira: 0 };
}

async function indiceDisponible({ usarCache = true } = {}) {
  const ahora = Date.now();
  if (usarCache && cacheIndiceDisponible.valor !== null && ahora < cacheIndiceDisponible.expira) {
    return cacheIndiceDisponible.valor;
  }

  let disponible = false;
  try {
    const indices = await getDB().collection(COLECCION).listSearchIndexes(INDICE).toArray();
    disponible = indices.some((indice) => (
      indice.name === INDICE
      && (indice.status === 'READY' || indice.queryable === true)
    ));
  } catch {
    disponible = false;
  }

  cacheIndiceDisponible = { valor: disponible, expira: ahora + TTL_CACHE_INDICE_MS };
  return disponible;
}

async function estadisticas() {
  const coleccion = getDB().collection(COLECCION);
  const [total, porCategoria, enPapelera] = await Promise.all([
    coleccion.countDocuments({ activo: { $ne: false } }),
    coleccion.aggregate([
      { $match: { activo: { $ne: false } } },
      { $group: { _id: '$categoriaId', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]).toArray(),
    getDB().collection(COLECCION_PAPELERA).countDocuments({}),
  ]);
  return { total, porCategoria, enPapelera };
}

module.exports = {
  COLECCION,
  COLECCION_PAPELERA,
  INDICE,
  backendUnificadoActivo,
  buscarUnificado,
  indexarVectores,
  desactivarPorArchivo,
  activarPorArchivo,
  desactivarPorCategoria,
  activarPorCategoria,
  desactivarObsoletosPorArchivo,
  moverArchivoAPapelera,
  restaurarArchivoDesdePapelera,
  eliminarArchivoPermanente,
  moverCategoriaAPapelera,
  restaurarCategoriaDesdePapelera,
  eliminarPorArchivo,
  eliminarPorArchivoVersion,
  eliminarPorManual,
  eliminarPorRecurso,
  eliminarPorCategoria,
  desactivarPorOrigen,
  eliminarPorOrigen,
  obtenerPorArchivo,
  restaurarVectores,
  indiceDisponible,
  invalidarCacheIndice,
  estadisticas,
  hashContenido,
};
