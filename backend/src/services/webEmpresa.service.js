/**
 * webEmpresa.service.js
 *
 * RAG alimentado con la información pública de https://northservices.com.pe/
 *
 * A diferencia de las categorías de conocimiento (que el Administrador
 * reparte por rol), esta fuente es de la CASA y describe lo que la empresa
 * ofrece: por eso está disponible para TODOS los roles sin tocar la
 * configuración de permisos. Si algún día se quisiera cerrarla, se decide
 * aquí y no en cada punto del chat.
 *
 * El contenido vive en la colección `conocimientos_vectores` con
 * `origen: 'web_empresa'`. Es la misma colección que usaba el script suelto
 * `scripts/actualizarWebEmpresa.js`, que ahora llama a este servicio: así el
 * botón "Actualizar información de la página" y la línea de comandos
 * indexan exactamente lo mismo.
 */

const { getDB } = require('../db/mongodb');

const ORIGEN = 'web_empresa';
// La información de la página vive en su propia colección, separada de los
// vectores de las categorías de conocimiento. Antes se guardaba en
// 'conocimientos_vectores'; esa colección se limpia al actualizar para no
// dejar copias antiguas.
const COLECCION_VECTORES = 'conocimientos_pagina';
const COLECCION_LEGACY = 'conocimientos_vectores';
const COLECCION_ESTADO = 'web_empresa_estado';
const ID_ESTADO = 'web_empresa';

const BASE_URL = (process.env.WEB_EMPRESA_URL || 'https://northservices.com.pe/').replace(/\/$/, '/');
const MAX_PAGINAS = parseInt(process.env.WEB_EMPRESA_MAX_PAGINAS || '25', 10);
const MAX_FRAGMENTOS = parseInt(process.env.WEB_EMPRESA_MAX_FRAGMENTOS || '400', 10);
const CONCURRENCIA = parseInt(process.env.EMBEDDING_CONCURRENCY || '5', 10);
const TAMANO_BLOQUE = 800;

// Umbral propio, más bajo que el de los manuales: los textos de una web
// comercial son cortos y muy publicitarios, así que la coseno entre la
// pregunta y un fragmento tiende a quedar por debajo del 0.56 que se usa con
// los manuales, aunque el fragmento sea justo el que responde.
const UMBRAL_RELEVANCIA = Number(process.env.WEB_EMPRESA_UMBRAL || '0.48');
const LIMITE_RESULTADOS = 5;
const MAX_DOCUMENTOS_REVISADOS = 4000;

// Evita que dos clics seguidos en "Actualizar" lancen dos rastreos: el segundo
// se rechaza y el frontend recibe el reporte del que ya estaba corriendo.
let actualizacionEnCurso = null;

// ============================================================
// EXTRACCIÓN DE TEXTO
// ============================================================

function decodificarEntidades(texto) {
  return texto
    .replace(/&#(\d+);/g, (_, codigo) => String.fromCharCode(Number(codigo)))
    .replace(/&#x([0-9a-f]+);/gi, (_, codigo) => String.fromCharCode(parseInt(codigo, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0?39;|&rsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&hellip;/gi, '...')
    .replace(/&ndash;/gi, '-')
    .replace(/&mdash;/gi, '-')
    .replace(/&aacute;/gi, 'á')
    .replace(/&eacute;/gi, 'é')
    .replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó')
    .replace(/&uacute;/gi, 'ú')
    .replace(/&ntilde;/gi, 'ñ');
}

// Convierte el HTML en texto plano conservando los saltos de línea de los
// bloques (párrafos, listas, celdas, encabezados). Sin esto el texto sale como
// un solo bloque largo y los fragmentos de 800 caracteres cortan frases a la
// mitad, lo que ensucia los embeddings.
function htmlAPlainText(html) {
  return decodificarEntidades(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|td|th|h1|h2|h3|h4|h5|h6|section|article|header|footer|nav|ul|ol|table|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .split('\n')
    .map((linea) => linea.replace(/[ \t]+/g, ' ').trim())
    // Las líneas de dos caracteres o menos son separadores de menú, viñetas o
    // restos del maquetado; no aportan nada al modelo y sí ocupan fragmentos.
    .filter((linea) => linea.length > 2)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extraerTitulo(html, url) {
  const coincidencia = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titulo = (coincidencia ? coincidencia[1] : '')
    .replace(/<[^>]+>/g, '')
    .trim();
  if (!titulo) return url;
  // La mayoría de sitios concatenan el nombre de la empresa con "| Título".
  return titulo.replace(/\s*[|–—-]\s*North Services[^|–—-]*$/i, '').trim() || titulo;
}

// Solo se siguen enlaces del mismo sitio que apuntan a páginas de contenido.
// Se descartan los archivos binarios (los PDF y los ZIP los cubre el módulo de
// recursos) y las rutas de plugins, temas y carpetas de imágenes.
function extraerEnlaces(html, base) {
  const origen = new URL(BASE_URL).origin;
  const enlaces = new Set();
  const patron = /href=["']([^"'#]+)["']/gi;
  let coincidencia;

  while ((coincidencia = patron.exec(html)) !== null) {
    try {
      const url = new URL(coincidencia[1], base);
      if (url.origin !== origen) continue;
      if (/\.(pdf|docx?|xlsx?|pptx?|vsdx?|png|jpe?g|gif|svg|webp|zip|rar|7z|mp4|avi|css|js|json|xml|ico|woff2?)(\?|$)/i.test(url.pathname)) continue;
      if (/(wp-json|wp-content|wp-admin|wp-includes|feed|xmlrpc|api|uploads|assets|img|images|fonts|plugins|themes|cache)/i.test(url.pathname)) continue;
      url.hash = '';
      url.search = '';
      enlaces.add(url.toString());
    } catch {
      // href inválido: se ignora.
    }
  }

  return [...enlaces];
}

// Une líneas en bloques de tamaño fijo sin partir una línea por la mitad
// (partir una frase a mitad de palabra es lo que peor degrada un embedding).
function dividirTextoEnBloques(texto, tamanioBloque = TAMANO_BLOQUE) {
  const bloques = [];
  let bloqueActual = '';

  for (const lineaOriginal of texto.replace(/\r\n/g, '\n').split('\n')) {
    const linea = lineaOriginal.trim();
    if (!linea) continue;

    const candidato = bloqueActual ? `${bloqueActual}\n${linea}` : linea;

    if (candidato.length > tamanioBloque) {
      if (bloqueActual.trim()) bloques.push(bloqueActual.trim());
      bloqueActual = linea;
    } else {
      bloqueActual = candidato;
    }
  }

  if (bloqueActual.trim()) bloques.push(bloqueActual.trim());
  return bloques;
}

// ============================================================
// RASTREO
// ============================================================

async function rastrearPaginas({ onProgress = () => {} } = {}) {
  const visitadas = new Set([BASE_URL]);
  const cola = [BASE_URL];
  const paginas = [];
  // Algunos sitios publican la misma portada en `/` y en `/index.html`. Sin
  // esta firma, el contenido institucional se indexaría dos veces y el
  // asistente recibiría el mismo fragmento duplicado en el contexto.
  const contenidosVistos = new Set();

  while (cola.length && paginas.length < MAX_PAGINAS) {
    const url = cola.shift();

    try {
      const respuesta = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (North Services AI RAG)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });

      if (!respuesta.ok) {
        onProgress(`Omitida ${url} (HTTP ${respuesta.status})`);
        continue;
      }

      const html = await respuesta.text();
      const texto = htmlAPlainText(html);

      if (texto.length < 200) {
        onProgress(`Omitida ${url} (sin contenido textual)`);
        continue;
      }

      const firma = `${texto.length}|${texto.slice(0, 300)}`;
      if (contenidosVistos.has(firma)) {
        onProgress(`Omitida ${url} (contenido ya leído en otra dirección)`);
        continue;
      }
      contenidosVistos.add(firma);

      paginas.push({ url, titulo: extraerTitulo(html, url), texto });
      onProgress(`Leída ${url} (${texto.length} caracteres)`);

      for (const enlace of extraerEnlaces(html, url)) {
        if (!visitadas.has(enlace)) {
          visitadas.add(enlace);
          cola.push(enlace);
        }
      }
    } catch (error) {
      onProgress(`Error en ${url}: ${error.message}`);
    }
  }

  return paginas;
}

// ============================================================
// ACTUALIZACIÓN (INDEXACIÓN)
// ============================================================

/**
 * Vuelve a rastrear la web y reescribe los vectores de `origen: 'web_empresa'`.
 *
 * `generarEmbedding` se inyecta desde server.js para que este servicio use
 * exactamente la misma función (y la misma rotación de claves de respaldo) que
 * el resto del RAG, en vez de mantener una segunda copia.
 */
async function actualizarInformacionWeb({ generarEmbedding, onProgress = () => {} } = {}) {
  if (typeof generarEmbedding !== 'function') {
    throw new Error('No se recibió la función de embeddings.');
  }

  const db = getDB();
  const coleccion = db.collection(COLECCION_VECTORES);
  // Marca del inicio del trabajo. Todo vector con fecha anterior a esta marca
  // es de una indexación previa y se borra al final. Usar la hora de inicio y
  // no una ventana fija evita borrar por error los vectores recién creados si
  // la indexación tarda más de un minuto.
  const inicioIndexacion = new Date();

  onProgress('Revisando los datos actuales de la página...');

  const paginas = await rastrearPaginas({ onProgress });

  if (!paginas.length) {
    throw new Error('No se pudo leer ninguna página de la web de la empresa. Revisa la conexión del servidor o la dirección configurada.');
  }

  const fragmentos = [];
  for (const pagina of paginas) {
    const bloques = dividirTextoEnBloques(pagina.texto);
    bloques.forEach((contenido, indice) => {
      fragmentos.push({
        contenido_texto: contenido,
        urlPagina: pagina.url,
        tituloPagina: pagina.titulo,
        parte: indice + 1,
      });
    });
  }

  const aIndexar = fragmentos.slice(0, MAX_FRAGMENTOS);

  onProgress(`Generando vectores de ${aIndexar.length} fragmentos...`);

  const vectores = [];
  let indice = 0;
  let errores = 0;

  const trabajador = async () => {
    while (indice < aIndexar.length) {
      const fragmento = aIndexar[indice++];
      try {
        const embedding = await generarEmbedding(fragmento.contenido_texto);
        vectores.push({
          origen: ORIGEN,
          urlPagina: fragmento.urlPagina,
          tituloPagina: fragmento.tituloPagina,
          nombreManual: `Web de la Empresa: ${fragmento.tituloPagina}`,
          titulo_seccion: `${fragmento.tituloPagina} (Parte ${fragmento.parte})`,
          contenido_texto: fragmento.contenido_texto,
          embedding,
          fechaIndexacion: new Date(),
        });
      } catch (error) {
        errores += 1;
        if (errores <= 5) onProgress(`Fragmento sin vector (${fragmento.urlPagina}): ${error.message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCIA) }, () => trabajador()));

  // Los vectores nuevos se escriben primero y los antiguos se borran después:
  // si el rastreo falla a medio camino, el asistente sigue teniendo la
  // información anterior en vez de quedarse sin nada.
  if (!vectores.length) {
    throw new Error('La web se leyó correctamente, pero ningún fragmento pudo convertirse en vector. Revisa la configuración de embeddings.');
  }

  const insercion = await coleccion.insertMany(vectores, { ordered: false });
  const eliminados = await coleccion.deleteMany({ origen: ORIGEN, fechaIndexacion: { $lt: inicioIndexacion } });

  // Migración: borra las copias que quedaron en la colección antigua. Si la
  // colección no existe, Mongo no responde con error, así que no hace falta
  // comprobar nada.
  let legacyEliminados = 0;
  try {
    const legado = await db.collection(COLECCION_LEGACY).deleteMany({ origen: ORIGEN });
    legacyEliminados = legado.deletedCount || 0;
  } catch (errorLegacy) {
    console.warn(`[WEB] No se pudo limpiar la colección antigua ${COLECCION_LEGACY}: ${errorLegacy.message}`);
  }

  const resumen = {
    ok: true,
    paginas: paginas.length,
    fragmentos: insercion.insertedCount || vectores.length,
    fragmentosConError: errores,
    vectoresAnterioresEliminados: eliminados.deletedCount || 0,
    vectoresLegacyEliminados: legacyEliminados,
    coleccion: COLECCION_VECTORES,
    fechaActualizacion: new Date().toISOString(),
    mensaje: `Información de la web actualizada: ${paginas.length} página(s) y ${insercion.insertedCount || vectores.length} fragmento(s) indexados.`,
  };

  await db.collection(COLECCION_ESTADO).updateOne(
    { _id: ID_ESTADO },
    { $set: { ...resumen, actualizadoPor: 'web_empresa' } },
    { upsert: true }
  );

  onProgress(resumen.mensaje);
  return resumen;
}

// Ejecuta la actualización salvo que ya haya una en marcha, en cuyo caso se
// espera a esa y se devuelve su resultado en lugar de rastrear dos veces.
async function actualizarInformacionWebEnSerio(opciones = {}) {
  if (actualizacionEnCurso) {
    console.log('[WEB] Ya hay una actualización en curso; se espera a que termine.');
    return actualizacionEnCurso;
  }

  actualizacionEnCurso = actualizarInformacionWeb(opciones).finally(() => {
    actualizacionEnCurso = null;
  });

  return actualizacionEnCurso;
}

function estaActualizando() {
  return actualizacionEnCurso !== null;
}

// ============================================================
// BÚSQUEDA
// ============================================================

function similitudCoseno(a, b) {
  let dot = 0;
  let normaA = 0;
  let normaB = 0;
  const largo = Math.min(a.length, b.length);

  for (let i = 0; i < largo; i += 1) {
    dot += a[i] * b[i];
    normaA += a[i] * a[i];
    normaB += b[i] * b[i];
  }

  if (!normaA || !normaB) return 0;
  return dot / (Math.sqrt(normaA) * Math.sqrt(normaB));
}

// Respaldo para cuando Atlas no tiene (todavía) el índice vectorial en esta
// colección: se recorren los documentos y se compara en memoria. La colección
// es pequeña —una sola web— así que aguanta bien.
async function buscarEnMemoria(coleccion, vectorConsulta, limite) {
  const documentos = await coleccion
    .find({ origen: ORIGEN, embedding: { $exists: true } })
    .project({
      embedding: 1,
      contenido_texto: 1,
      titulo_seccion: 1,
      nombreManual: 1,
      tituloPagina: 1,
      urlPagina: 1,
      fechaIndexacion: 1,
    })
    .limit(MAX_DOCUMENTOS_REVISADOS)
    .toArray();

  return documentos
    .map((documento) => ({
      documento,
      score: similitudCoseno(vectorConsulta, documento.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limite)
    .map(({ documento, score }) => {
      const { embedding, origen, ...resto } = documento;
      return {
        ...resto,
        score,
        origenWeb: true,
        fuenteWeb: BASE_URL,
      };
    });
}

let indiceVectorialWeb = null;
let indiceVectorialWebCargadoEn = 0;
const VIGENCIA_CACHE_INDICE_MS = 5 * 60 * 1000;

async function resolverIndiceVectorial(coleccion) {
  const ahora = Date.now();
  if (indiceVectorialWeb && ahora - indiceVectorialWebCargadoEn < VIGENCIA_CACHE_INDICE_MS) {
    return indiceVectorialWeb;
  }

  try {
    const indices = await coleccion.listSearchIndexes().toArray();
    const encontrado = indices.find((indice) => indice.type === 'vectorSearch');
    indiceVectorialWeb = encontrado?.name || null;
  } catch {
    // Sin permiso de Atlas Search o sin índice: se usa la búsqueda en memoria.
    indiceVectorialWeb = null;
  }

  indiceVectorialWebCargadoEn = ahora;
  return indiceVectorialWeb;
}

/**
 * Busca fragmentos de la web de la empresa parecidos a la consulta.
 *
 * Devuelve siempre un arreglo (nunca lanza): si la web aún no está indexada o
 * falla la consulta, el chat sigue contestando con el resto de fuentes.
 */
async function buscarEnWebEmpresa(vectorConsulta, limite = LIMITE_RESULTADOS) {
  if (!Array.isArray(vectorConsulta) || !vectorConsulta.length) return [];

  try {
    const coleccion = getDB().collection(COLECCION_VECTORES);
    const indice = await resolverIndiceVectorial(coleccion);

    if (!indice) {
      const resultados = await buscarEnMemoria(coleccion, vectorConsulta, limite);
      console.log(`[WEB] Búsqueda directa en la web de la empresa: ${resultados.length} resultados`);
      return resultados;
    }

    const filas = await coleccion
      .aggregate([
        {
          $vectorSearch: {
            index: indice,
            path: 'embedding',
            queryVector: vectorConsulta,
            numCandidates: Math.max(20, limite * 4),
            limit,
            // El filtro exige que 'origen' esté declarado como campo de filtro
            // en el índice de Atlas. Si no lo está, la consulta falla y el
            // catch de abajo resuelve con la búsqueda en memoria.
            filter: { origen: { $eq: ORIGEN } },
          },
        },
        {
          $project: {
            _id: 1,
            contenido_texto: 1,
            titulo_seccion: 1,
            nombreManual: 1,
            tituloPagina: 1,
            urlPagina: 1,
            fechaIndexacion: 1,
            origen: 1,
            score: { $meta: 'vectorSearchScore' },
          },
        },
      ])
      .toArray();

    const soloWeb = filas.filter((fila) => fila.origen === ORIGEN);
    console.log(`[WEB] Búsqueda vectorial en la web de la empresa: ${soloWeb.length} resultados`);
    return soloWeb.map(({ origen, ...fila }) => ({ ...fila, origenWeb: true, fuenteWeb: BASE_URL }));
  } catch (error) {
    // El índice no existe, no tiene 'origen' como campo de filtro o la consulta
    // falló. La web es una colección pequeña: recorrerla en memoria es una
    // salida digna y no deja al asistente sin esta fuente.
    console.warn(`[WEB] Búsqueda vectorial no disponible (${error.message}); usando búsqueda directa.`);
    try {
      return await buscarEnMemoria(getDB().collection(COLECCION_VECTORES), vectorConsulta, limite);
    } catch (errorMemoria) {
      console.warn(`[WEB] Tampoco se pudo buscar en la web de la empresa: ${errorMemoria.message}`);
      return [];
    }
  }
}

// Estado que se muestra junto al botón de actualizar.
async function obtenerEstado() {
  const db = getDB();

  try {
    const [fragmentos, registro] = await Promise.all([
      db.collection(COLECCION_VECTORES).countDocuments({ origen: ORIGEN }),
      db.collection(COLECCION_ESTADO).findOne({ _id: ID_ESTADO }),
    ]);

    return {
      url: BASE_URL,
      fragmentos,
      indexada: fragmentos > 0,
      actualizando: estaActualizando(),
      ultimaActualizacion: registro?.fechaActualizacion || null,
      ultimaPaginas: registro?.paginas ?? null,
    };
  } catch (error) {
    return {
      url: BASE_URL,
      fragmentos: 0,
      indexada: false,
      actualizando: estaActualizando(),
      ultimaActualizacion: null,
      ultimaPaginas: null,
      error: error.message,
    };
  }
}

module.exports = {
  ORIGEN,
  BASE_URL,
  UMBRAL_RELEVANCIA,
  actualizarInformacionWeb,
  actualizarInformacionWebEnSerio,
  buscarEnWebEmpresa,
  obtenerEstado,
  estaActualizando,
  // Se exportan para poder probarlas sin rastrear la web entera.
  htmlAPlainText,
  dividirTextoEnBloques,
  extraerEnlaces,
  extraerTitulo,
};