/**
 * Integración con Google Drive API para el RAG híbrido.
 *
 * Autenticación: estricta y únicamente mediante el archivo de credenciales
 * de Service Account `mantenimiento-476814-5b28adda0b55.json`
 * (cuenta: mantenimiento-drive-app-696@mantenimiento-476814.iam.gserviceaccount.com).
 *
 * Uso: leer los reportes diarios (PDF) de la carpeta compartida de Operaciones
 * en modo buffer/media para pasarlos a Gemini (extracción de tablas y resumen).
 */

const path = require('path');
const fs = require('fs');
const { GoogleAuth } = require('google-auth-library');
const PDFParser = require('pdf2json');

const RUTA_CREDENCIALES = path.join(
  __dirname,
  '..',
  '..',
  'mantenimiento-476814-5b28adda0b55.json'
);

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const MIME_CARPETA = 'application/vnd.google-apps.folder';
const MIME_PDF = 'application/pdf';

// Carpeta compartida de Operaciones. Configurable por entorno; por defecto se
// usa la carpeta compartida expuesta en el dashboard.
const FOLDER_OPERACIONES =
  process.env.DRIVE_FOLDER_OPERACIONES ||
  '1Bdm_qnQ_ccSnL2MRTFfJHoPnwHju5DYd';

// Cantidad máxima de PDFs que se seleccionan para enviar al modelo.
// Fallback por defecto: 10 (conforme a la especificación de búsqueda híbrida).
const DRIVE_MAX_ARCHIVOS = Number(process.env.DRIVE_MAX_ARCHIVOS || '10');

// Tamaño máximo en bytes para enviar un PDF como inlineData en Gemini.
// Límite recomendado 6 MB (6291456 bytes).
const DRIVE_INLINE_MAX_BYTES = Number(
  process.env.DRIVE_INLINE_MAX_BYTES || '6291456'
);

// Cantidad máxima de caracteres a extraer de un PDF cuando no cabe inline.
const DRIVE_TEXTO_MAX_CHARS = Number(
  process.env.DRIVE_TEXTO_MAX_CHARS || '24000'
);

// Tope de espera para no dejar el chat colgado si Drive o el lector de PDF
// se quedan sin responder.
const DRIVE_TIMEOUT_MS = Number(process.env.DRIVE_TIMEOUT_MS || '30000');
const DRIVE_TIMEOUT_PDF_MS = Number(process.env.DRIVE_TIMEOUT_PDF_MS || '30000');

let clienteAuthCache = null;

function obtenerCredenciales() {
  if (!fs.existsSync(RUTA_CREDENCIALES)) {
    throw new Error(
      `No se encontró el archivo de credenciales del Service Account en ${RUTA_CREDENCIALES}`
    );
  }
  return RUTA_CREDENCIALES;
}

async function obtenerCliente() {
  if (clienteAuthCache) return clienteAuthCache;
  const auth = new GoogleAuth({
    keyFile: obtenerCredenciales(),
    scopes: [SCOPE],
  });
  clienteAuthCache = await auth.getClient();
  return clienteAuthCache;
}

async function obtenerAccessToken() {
  const cliente = await obtenerCliente();
  const token = await cliente.getAccessToken();
  // google-auth-library v10 puede devolver { token } o el string directamente.
  return typeof token === 'string' ? token : token?.token;
}

async function driveFetch(url, options = {}) {
  const accessToken = await obtenerAccessToken();

  // Sin esto, una petición que Drive no responde deja la consulta del chat
  // esperando indefinidamente.
  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(), DRIVE_TIMEOUT_MS);

  try {
    const respuesta = await fetch(url, {
      ...options,
      signal: control.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options.headers || {}),
      },
    });
    if (!respuesta.ok) {
      const detalle = await respuesta.text().catch(() => '');
      throw new Error(`Drive API respondió ${respuesta.status}: ${detalle}`);
    }
    return respuesta;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Drive no respondió en ${DRIVE_TIMEOUT_MS / 1000} segundos.`);
    }
    throw error;
  } finally {
    clearTimeout(temporizador);
  }
}

/**
 * Lista los hijos directos de una carpeta (con paginación).
 */
async function listarHijos(folderId) {
  const hijos = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,createdTime,size)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const respuesta = await driveFetch(`${DRIVE_API}/files?${params.toString()}`);
    const data = await respuesta.json();
    hijos.push(...(data.files || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return hijos;
}

/**
 * Extrae la fecha/hora del NOMBRE del archivo.
 * Ejemplos: Torque_Log_20260701_101558.pdf -> "20260701-101558"
 *           TorqueLog20260701_134151.pdf  -> "20260701-134151"
 *           2026-07-01.pdf                -> "20260701-000000"
 * El timestamp del nombre es la referencia real de "cual se subio primero",
 * porque createdTime de Drive cambia si el archivo se toca o se re-sube.
 */
function fechaDesdeNombreArchivo(nombre) {
  const n = String(nombre || '');

  const m = n.match(/(\d{4})(\d{2})(\d{2})[_\-\s]?(\d{2})?(\d{2})?(\d{2})?/);

  if (m) {
    return `${m[1]}${m[2]}${m[3]}-${m[4] || '00'}${m[5] || '00'}${m[6] || '00'}`;
  }

  return '99999999-999999';
}

/**
 * Obtiene PDFs directamente desde una consulta API (sin recursión)
 * bajo un folder padre opcional.
 *
 * orden: 'modificados'   -> modifiedTime desc (más reciente primero, por defecto)
 *        'creados'       -> createdTime asc (orden real de subida en Drive)
 *        'nombre'        -> name asc
 *        'nombre_fecha'  -> por la fecha/hora del NOMBRE (el primero real)
 *        'nombre_fecha_desc' -> por la fecha del NOMBRE, del más nuevo al más viejo
 */
async function listarPdfsDirectos({ folderId, limit, fieldsExtra = '', orden = 'modificados' }) {
  const condiciones = [
    folderId ? `'${folderId}' in parents` : null,
    `mimeType = '${MIME_PDF}'`,
    'trashed = false',
  ].filter(Boolean).join(' and ');

  const orderBy =
    orden === 'creados'
      ? 'createdTime asc'
      : orden === 'nombre' || orden === 'nombre_fecha'
        ? 'name asc'
        : 'modifiedTime desc';

  const params = new URLSearchParams({
    q: condiciones,
    fields: `files(id,name,mimeType,modifiedTime,createdTime,size${fieldsExtra ? ',' + fieldsExtra : ''})`,
    pageSize: String(limit),
    orderBy,
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });

  const respuesta = await driveFetch(`${DRIVE_API}/files?${params.toString()}`);
  const data = await respuesta.json();

  const files = data.files || [];

  if (orden === 'nombre_fecha') {
    files.sort(
      (a, b) =>
        fechaDesdeNombreArchivo(a.name).localeCompare(
          fechaDesdeNombreArchivo(b.name)
        )
    );
  }

  return files;
}

/**
 * Caché corta del árbol de PDFs de Drive.
 *
 * Recorrer todas las subcarpetas cuesta decenas de llamadas a la API y el
 * contenido cambia muy rara vez, así que se guarda unos minutos. Sin esto,
 * cada consulta de reportes repetía el mismo recorrido completo.
 */
const CACHE_TTL_MS = Number(process.env.DRIVE_CACHE_TTL_MS || '120000');
const cacheArbol = new Map(); // clave -> { expira, pdfs }

function leerCacheArbol(clave) {
  const entrada = cacheArbol.get(clave);
  if (!entrada) return null;
  if (entrada.expira <= Date.now()) {
    cacheArbol.delete(clave);
    return null;
  }
  return entrada.pdfs;
}

function guardarCacheArbol(clave, pdfs) {
  cacheArbol.set(clave, { expira: Date.now() + CACHE_TTL_MS, pdfs });
  if (cacheArbol.size > 20) {
    const masAntigua = cacheArbol.keys().next().value;
    cacheArbol.delete(masAntigua);
  }
}

function limpiarCacheArbol() {
  cacheArbol.clear();
}

/**
 * Lista recursivamente todos los PDFs bajo la carpeta de Operaciones,
 * incluyendo subcarpetas (p. ej. "Torque Logs Reports", "Plots", reportes por
 * pozo/lote). Cada resultado incluye la ruta relativa dentro de la carpeta.
 * Respaldo global cuando la búsqueda inteligente por subcarpeta no aplica.
 */
async function listarReportesPdfRecursivo({ maxResultados, maxProfundidad = 5, orden = 'modificados' }) {
  // El recorrido NO se corta por maxResultados. El árbol se visita carpeta
  // por carpeta, así que detenerse antes de terminar devolvería solo los
  // archivos de las primeras carpetas visitadas y, al ordenarlos después,
  // el resultado no serían realmente "los más recientes". Se junta todo el
  // árbol (con un tope de seguridad) y recién ahí se ordena y se recorta.
  const limiteColeccion = 2000;

  const claveCache = `${FOLDER_OPERACIONES}:${maxProfundidad}:${limiteColeccion}`;
  let pdfs = leerCacheArbol(claveCache);

  if (!pdfs) {
    pdfs = [];

    async function recorrer(folderId, profundidad, ruta) {
      if (profundidad > maxProfundidad || pdfs.length >= limiteColeccion) return;

      let hijos;
      try {
        hijos = await listarHijos(folderId);
      } catch (error) {
        // Una subcarpeta inaccesible no debe tumbar todo el reporte: se avisa
        // en consola y se sigue con el resto del árbol.
        console.warn(
          `[DRIVE] No se pudo listar "${ruta || '(raíz)'}": ${error.message}`
        );
        return;
      }

      await Promise.all(
        hijos.map(async (hijo) => {
          if (pdfs.length >= limiteColeccion) return;
          try {
            if (hijo.mimeType === MIME_CARPETA) {
              await recorrer(hijo.id, profundidad + 1, `${ruta}/${hijo.name}`);
            } else if (hijo.mimeType === MIME_PDF) {
              pdfs.push({
                id: hijo.id,
                name: hijo.name,
                modifiedTime: hijo.modifiedTime,
                createdTime: hijo.createdTime,
                size: hijo.size,
                carpeta: ruta.replace(/^\//, '') || '(raíz)',
              });
            }
          } catch (errorHijo) {
            console.warn(`[DRIVE] Omitiendo "${hijo.name}": ${errorHijo.message}`);
          }
        })
      );
    }

    await recorrer(FOLDER_OPERACIONES, 0, '');
    guardarCacheArbol(claveCache, pdfs);
  }

  // Se copia antes de ordenar para no mutar lo que está en caché.
  const ordenados = [...pdfs];

  if (orden === 'creados') {
    // El PRIMERO subido a Drive: createdTime asc.
    ordenados.sort((a, b) => new Date(a.createdTime || 0) - new Date(b.createdTime || 0));
  } else if (orden === 'nombre' || orden === 'nombre_fecha') {
    // Por la fecha/hora del NOMBRE del archivo (el primero real).
    ordenados.sort((a, b) =>
      fechaDesdeNombreArchivo(a.name).localeCompare(fechaDesdeNombreArchivo(b.name))
    );
  } else if (orden === 'nombre_fecha_desc') {
    // Por la fecha/hora del NOMBRE, del más nuevo al más viejo.
    //
    // Es el orden que se usa para "los últimos N reportes": el timestamp del
    // nombre es cuando se generó el reporte en campo. `modifiedTime` de Drive
    // no sirve para eso, porque cambia en cuanto alguien vuelve a subir o a
    // tocar el archivo, y eso desordena la cronología real de las operaciones.
    ordenados.sort((a, b) =>
      fechaDesdeNombreArchivo(b.name).localeCompare(fechaDesdeNombreArchivo(a.name))
    );
  } else {
    ordenados.sort((a, b) => new Date(b.modifiedTime || 0) - new Date(a.modifiedTime || 0));
  }

  return ordenados.slice(0, maxResultados);
}

/**
 * Búsqueda híbrida de archivos PDF.
 *
 * Estrategia:
 *  1. Si la pregunta contiene una palabra clave conocida (operadora, año,
 *     proyecto, etc.), intenta localizar una subcarpeta dentro de Operaciones
 *     cuyo nombre coincida y obtiene los PDFs directamente desde ella.
 *  2. De no haber coincidencia, no existir la subcarpeta, o no arrojar
 *     resultados, cae de forma transparente al listado recursivo global
 *     sobre la carpeta de Operaciones (comportamiento histórico).
 *
 * El límite máximo de resultados se toma del entorno DRIVE_MAX_ARCHIVOS
 * (por defecto 10), salvo que se indique explícitamente.
 */
async function listarReportesPdf({
  maxResultados,
  maxProfundidad = 5,
  pregunta = '',
  orden = 'modificados',
} = {}) {
  const limit = maxResultados || DRIVE_MAX_ARCHIVOS;

  const palabrasClave = ['unna', 'olympic', 'gtg', 'savia', '2025', '2026'];
  const preguntaLower = (pregunta || '').toLowerCase();
  const terminoCarpeta = palabrasClave.find(p => preguntaLower.includes(p));

  let archivos = [];

  if (terminoCarpeta) {
    try {
      const paramsCarpeta = new URLSearchParams({
        q: `'${FOLDER_OPERACIONES}' in parents and mimeType = '${MIME_CARPETA}' and name contains '${terminoCarpeta}' and trashed = false`,
        fields: 'files(id, name)',
        pageSize: '10',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });

      const resCarpeta = await driveFetch(`${DRIVE_API}/files?${paramsCarpeta.toString()}`);
      const dataCarpeta = await resCarpeta.json();
      const carpetas = dataCarpeta.files || [];

      if (carpetas.length > 0) {
        const folderId = carpetas[0].id;
        const nombreCarpeta = carpetas[0].name;
        const pdfsDirectos = await listarPdfsDirectos({ folderId, limit, orden });
        archivos = pdfsDirectos.map(pdf => ({
          id: pdf.id,
          name: pdf.name,
          modifiedTime: pdf.modifiedTime,
          createdTime: pdf.createdTime,
          size: pdf.size,
          carpeta: nombreCarpeta,
        }));
      }
    } catch (err) {
      console.warn(
        '[DRIVE] Error buscando en subcarpeta por palabra clave "' +
          terminoCarpeta +
          '", aplicando respaldo global:',
        err.message
      );
    }
  }

  if (!archivos.length) {
    archivos = await listarReportesPdfRecursivo({
      maxResultados: limit,
      maxProfundidad,
      orden,
    });
  }

  return archivos;
}

/**
 * Descarga un archivo de Drive en modo buffer/media.
 */
async function descargarArchivoBuffer(fileId) {
  const params = new URLSearchParams({
    alt: 'media',
    supportsAllDrives: 'true',
  });
  const respuesta = await driveFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`
  );
  const arrayBuffer = await respuesta.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Decodifica el texto que entrega pdf2json (viene codificado en la URL).
 */
function decodificarTexto(fragmento) {
  const bruto =
    fragmento?.T ??
    (Array.isArray(fragmento?.R) ? fragmento.R[0]?.T : undefined) ??
    '';
  if (!bruto) return '';
  try {
    return decodeURIComponent(bruto);
  } catch {
    return String(bruto);
  }
}

/**
 * Reconstruye las filas de una tabla a partir de la posición de cada texto.
 *
 * Los torque logs son tablas: los números están en columnas separadas por
 * encabezados. Al volcar el texto plano se mezclan los encabezados con los
 * valores y el resultado es ilegible. Agrupando por coordenada vertical y
 * ordenando por la horizontal, cada fila vuelve a su sitio.
 *
 * Dos textos contiguos que almost no se separan pertenecen a la misma celda y
 * se unen con un espacio; cuando hay un hueco claro se trata de celdas
 * distintas y se separan con " | ".
 * se separan con " | ".
 */
function reconstruirFilas(textos, separacionColumnas = 6) {
  const filas = new Map();

  for (const fragmento of textos || []) {
    const texto = decodificarTexto(fragmento).replace(/\s+/g, ' ').trim();
    if (!texto) continue;

    const y = Number(fragmento.y ?? 0);
    const x = Number(fragmento.x ?? 0);
    const ancho = Number(fragmento.w ?? 0);

    // Se busca una fila ya abierta lo bastante cerca en vertical.
    let filaY = null;
    let mejorDiferencia = Infinity;
    for (const clave of filas.keys()) {
      const diferencia = Math.abs(clave - y);
      if (diferencia <= 3 && diferencia < mejorDiferencia) {
        filaY = clave;
        mejorDiferencia = diferencia;
      }
    }
    if (filaY === null) {
      filaY = y;
      filas.set(filaY, []);
    }

    filas.get(filaY).push({ x, ancho, texto });
  }

  return [...filas.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, celdas]) => {
      celdas.sort((a, b) => a.x - b.x);

      const partes = [];
      let previo = null;
      for (const celda of celdas) {
        if (previo) {
          const hueco = celda.x - (previo.x + previo.ancho);
          partes.push(hueco > separacionColumnas ? ' | ' : ' ');
        }
        partes.push(celda.texto);
        previo = celda;
      }
      return partes.join('').replace(/\s+\|\s+/g, ' | ').trim();
    })
    .filter(Boolean);
}

/**
 * Extrae el texto de un PDF a partir de su buffer.
 *
 * Se reconstruyen las filas usando la posición de cada fragmento para que las
 * tablas mantengan su estructura. Si el PDF no permite recuperar esa
 * información, se devuelve el volcado plano para no perder el contenido.
 */
function extraerTextoPdf(buffer) {
  return new Promise((resolve, reject) => {
    let resuelto = false;
    const finalizar = (fn) => (valor) => {
      if (resuelto) return;
      resuelto = true;
      clearTimeout(temporizador);
      fn(valor);
    };
    const aceptar = finalizar(resolve);
    const fallar = finalizar(reject);

    // pdf2json no siempre emite error si el PDF está corrupto; sin este
    // filtro la consulta se quedaría esperando indefinidamente.
    const temporizador = setTimeout(
      () => fallar(new Error('Se agotó el tiempo al leer el PDF.')),
      DRIVE_TIMEOUT_PDF_MS
    );

    let parser;
    try {
      parser = new PDFParser(null, true);
    } catch (error) {
      fallar(new Error(`No se pudo iniciar el lector de PDF: ${error.message}`));
      return;
    }

    parser.on('pdfParser_dataError', (error) =>
      fallar(
        new Error(
          error?.parserError?.message ||
            'El PDF está dañado o no se pudo interpretar.'
        )
      )
    );

    parser.on('pdfParser_dataReady', () => {
      try {
        const bloques = parser.getMergedTextBlocksIfNeeded?.();
        const paginas = bloques?.Pages || [];

        const secciones = paginas.map((pagina, indice) => {
          const filas = reconstruirFilas(pagina?.Texts);
          if (filas.length) {
            return `--- Página ${indice + 1} ---\n${filas.join('\n')}`;
          }
          return '';
        });

        const texto = secciones.filter(Boolean).join('\n\n').trim();
        aceptar(texto || parser.getRawTextContent());
      } catch (error) {
        try {
          aceptar(parser.getRawTextContent());
        } catch {
          fallar(error);
        }
      }
    });

    parser.parseBuffer(buffer);
  });
}

module.exports = {
  FOLDER_OPERACIONES,
  DRIVE_MAX_ARCHIVOS,
  DRIVE_INLINE_MAX_BYTES,
  DRIVE_TEXTO_MAX_CHARS,
  listarReportesPdf,
  descargarArchivoBuffer,
  extraerTextoPdf,
  limpiarCacheArbol,
};
