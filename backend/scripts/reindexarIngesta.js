// Reindexa los vectores del RAG con el pipeline actual.
//
// Borra los vectores de cada documento (por archivoId o recursoId) y vuelve
// a generarlos: parseo estructurado (PDF -> Markdown) + fragmentación por
// secciones + embeddings. Los archivos que ya estén indexados con el pipeline
// viejo (pdf2json + cortes ciegos) quedan iguales hasta que pasen por aquí.
//
// Uso:
//   node scripts/reindexarIngesta.js                     # todo
//   node scripts/reindexarIngesta.js --dry-run           # sin escribir en Mongo
//   node scripts/reindexarIngesta.js --solo=<id>         # un archivo o recurso
//   node scripts/reindexarIngesta.js --coleccion=<nombre>
//
// Un fallo de parseo NO borra nada: se deja el documento como estaba.

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { connectDB, getDB } = require('../src/db/mongodb');
const { db: firestore } = require('../src/firebaseAdmin');
const ingesta = require('../src/services/ingesta.service');

const RAIZ = path.resolve(__dirname, '..');
const COLECCION_CATEGORIAS = 'categorias_conocimiento';
const CONCURRENCY = Number(process.env.EMBEDDING_CONCURRENCY || '5');
const MODELO = process.env.GEMINI_MODELO || 'gemini-embedding-001';

// ------------------------------------------------------------
// UTILIDADES
// ------------------------------------------------------------

function argumento(prefijo) {
  const encontrado = process.argv.find((valor) => valor.startsWith(prefijo));
  return encontrado ? encontrado.slice(prefijo.length) : null;
}

const DRY_RUN = process.argv.includes('--dry-run');
const SOLO = argumento('--solo=');
const COLECCION = argumento('--coleccion=');

function rutaAbsoluta(rutaLocal) {
  return path.resolve(RAIZ, rutaLocal || '');
}

async function generarEmbedding(texto) {
  const url = `https://generativelanguage.googleapis.com/v1/models/${MODELO}:embedContent?key=${process.env.GEMINI_API_KEY}`;
  const respuesta = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { parts: [{ text: texto }] } })
  });
  const datos = await respuesta.json();
  if (!respuesta.ok) throw new Error(`embedding: HTTP ${respuesta.status} ${JSON.stringify(datos).slice(0, 200)}`);
  if (!Array.isArray(datos?.embedding?.values)) throw new Error('embedding: respuesta sin vector');
  return datos.embedding.values;
}

async function enConcurrencia(items, trabajador) {
  const resultados = new Array(items.length);
  let siguiente = 0;
  const obreros = Array.from({ length: Math.max(1, Math.min(CONCURRENCY, items.length)) }, async () => {
    while (siguiente < items.length) {
      const indice = siguiente++;
      try {
        resultados[indice] = await trabajador(items[indice], indice);
      } catch (error) {
        resultados[indice] = { error: error.message, indice };
      }
    }
  });
  await Promise.all(obreros);
  return resultados;
}

// ------------------------------------------------------------
// FUENTES
// ------------------------------------------------------------

async function coleccionesPorId() {
  const snapshot = await getDB().collection(COLECCION_CATEGORIAS).find({}).toArray();
  return new Map(snapshot.map((categoria) => [categoria.id, categoria]));
}

async function unidadesArchivos(categorias) {
  const snapshot = await firestore.collection('archivos').get();
  return snapshot.docs
    .map((documento) => ({ id: documento.id, ...documento.data() }))
    .filter((item) => item.activo === true && item.eliminado !== true && item.rutaLocal)
    .map((item) => ({
      tipo: 'archivo',
      clave: 'archivoId',
      id: item.id,
      nombre: item.nombre || item.nombreArchivo || item.id,
      nombreArchivo: item.nombreArchivo || item.nombre || item.id,
      ruta: rutaAbsoluta(item.rutaLocal),
      coleccion: item.categoriaColeccion || categorias.get(item.categoriaId)?.coleccion,
      camposExtra: {
        nombreManual: item.nombre || item.nombreArchivo || item.id,
        categoriaId: item.categoriaId,
        categoriaNombre: item.categoriaNombre,
        nombreArchivo: item.nombreArchivo,
      },
    }));
}

async function unidadesRecursos(categorias) {
  const unidades = [];
  for (const nombreColeccion of ['recursos', 'manuales']) {
    const snapshot = await firestore.collection(nombreColeccion).get();
    for (const documento of snapshot.docs) {
      const item = { id: documento.id, ...documento.data() };
      const rutaLocal = item?.manual?.rutaLocal || item.rutaLocal;
      if (!rutaLocal) continue;
      if (item.activo === false) continue;
      unidades.push({
        tipo: 'recurso',
        clave: 'recursoId',
        id: item.id,
        nombre: item.nombre || item.nombreManual || item.id,
        nombreArchivo: item?.manual?.nombreArchivo || item.nombre || item.id,
        ruta: rutaAbsoluta(rutaLocal),
        coleccion: item.categoriaColeccion || categorias.get(item.categoriaId)?.coleccion,
        camposExtra: {
          nombreManual: item.nombre || item.nombreManual || item.id,
        },
      });
    }
  }
  return unidades;
}

// ------------------------------------------------------------
// REINDEX
// ------------------------------------------------------------

async function reindexar(unidad) {
  if (!fs.existsSync(unidad.ruta)) {
    console.log(`  [SKIP] Archivo físico no encontrado: ${unidad.ruta}`);
    return { estado: 'sin_archivo' };
  }
  if (!unidad.coleccion) {
    console.log(`  [SKIP] Sin colección de destino.`);
    return { estado: 'sin_coleccion' };
  }

  const buffer = fs.readFileSync(unidad.ruta);
  const extension = path.extname(unidad.nombreArchivo || '').toLowerCase();
  const preparado = await ingesta.prepararContenidoIndexable({
    buffer,
    nombreArchivo: unidad.nombreArchivo,
    extension,
  });
  const fragmentos = ingesta.prepararFragmentos(preparado);

  if (!fragmentos.length) {
    console.log(`  [SKIP] Sin texto indexable (fuente=${preparado.fuenteParser}).`);
    return { estado: 'sin_texto' };
  }

  console.log(
    `  ${fragmentos.length} fragmentos | ${preparado.formato} | ${preparado.fuenteParser}` +
      `${preparado.modeloParser ? ` / ${preparado.modeloParser}` : ''}`
  );

  if (DRY_RUN) {
    for (const fragmento of fragmentos.slice(0, 2)) {
      console.log(
        `    · ${ingesta.tituloSeccionDelFragmento(fragmento, unidad.nombreArchivo, 0, fragmentos.length)}`
      );
    }
    return { estado: 'dry-run', fragmentos: fragmentos.length };
  }

  const embebidos = await enConcurrencia(fragmentos, (fragmento) => generarEmbedding(fragmento.texto));
  const fallos = embebidos.filter((resultado) => resultado && resultado.error);
  const vectores = embebidos
    .map((embedding, indice) => (embedding.error ? null : { embedding, indice }))
    .filter(Boolean);

  if (fallos.length) console.log(`  [AVISO] ${fallos.length} embeddings fallaron.`);
  if (!vectores.length) {
    console.log('  [ERROR] Ningún embedding salió bien; NO se borra nada.');
    return { estado: 'error' };
  }

  const documentos = vectores.map(({ embedding, indice }) => ({
    [unidad.clave]: unidad.id,
    ...unidad.camposExtra,
    titulo_seccion: ingesta.tituloSeccionDelFragmento(fragmentos[indice], unidad.nombreArchivo, indice, fragmentos.length),
    rutaTitulos: fragmentos[indice].rutaTitulos || '',
    pagina: fragmentos[indice].pagina ?? null,
    indiceFragmento: indice + 1,
    totalFragmentos: fragmentos.length,
    formatoContenido: preparado.formato,
    fuenteParser: preparado.fuenteParser,
    modeloParser: preparado.modeloParser || null,
    contenido_texto: fragmentos[indice].texto,
    embedding,
    fechaIndexacion: new Date(),
  }));

  // Guarda contra insertar vectores sin embedding: sin él la búsqueda RAG
  // no puede puntuar nada y el documento queda inútil.
  if (documentos.some((documento) => !Array.isArray(documento.embedding) || !documento.embedding.length)) {
    console.log('  [ERROR] Algún vector quedó sin embedding; NO se escribe nada.');
    return { estado: 'error' };
  }

  // Borra e inserta en el mismo momento: si la inserción falla a mitad, el
  // documento queda con menos fragmentos pero nunca con los dos pipelines a la vez.
  const borrados = await getDB().collection(unidad.coleccion).deleteMany({ [unidad.clave]: unidad.id });
  await getDB().collection(unidad.coleccion).insertMany(documentos, { ordered: false });

  console.log(`  [OK] ${unidad.coleccion}: -${borrados.deletedCount} +${documentos.length}`);
  return { estado: 'ok', fragmentos: documentos.length };
}

// ------------------------------------------------------------
// PRINCIPAL
// ------------------------------------------------------------

async function principal() {
  await connectDB();
  const categorias = await coleccionesPorId();

  let unidades = [...(await unidadesArchivos(categorias)), ...(await unidadesRecursos(categorias))];

  if (SOLO) unidades = unidades.filter((unidad) => unidad.id === SOLO);
  if (COLECCION) unidades = unidades.filter((unidad) => unidad.coleccion === COLECCION);

  // Las unidades que apuntan a la misma colección se procesan una a una.
  unidades.sort((a, b) => String(a.coleccion).localeCompare(String(b.coleccion)));

  console.log(`${DRY_RUN ? '[DRY-RUN] ' : ''}Unidades a reindexar: ${unidades.length}\n`);

  const resumen = { ok: 0, 'dry-run': 0, sin_archivo: 0, sin_coleccion: 0, sin_texto: 0, error: 0 };

  for (const unidad of unidades) {
    console.log(`- ${unidad.tipo} ${unidad.id} (${unidad.nombre}) -> ${unidad.coleccion || '?'}`);
    try {
      const resultado = await reindexar(unidad);
      resumen[resultado.estado] = (resumen[resultado.estado] || 0) + 1;
    } catch (error) {
      console.log(`  [ERROR] ${error.message}`);
      resumen.error += 1;
    }
    console.log('');
  }

  console.log('Resumen:', JSON.stringify(resumen));
  process.exit(0);
}

principal().catch((error) => {
  console.error('[FATAL]', error);
  process.exit(1);
});
