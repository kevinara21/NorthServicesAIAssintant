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
  const respuesta = await fetch(url, {
    ...options,
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
 * Lista recursivamente todos los PDFs bajo la carpeta de Operaciones,
 * incluyendo subcarpetas (p. ej. "Torque Logs Reports", "Plots", reportes por
 * pozo/lote). Cada resultado incluye la ruta relativa dentro de la carpeta.
 * Respaldo global cuando la búsqueda inteligente por subcarpeta no aplica.
 */
async function listarReportesPdfRecursivo({ maxResultados, maxProfundidad = 5, orden = 'modificados' }) {
  const pdfs = [];

  // Para ordenar por fecha/subida se necesitan TODOS los archivos del
  // arbol; solo se limita la coleccion cuando el orden es por modificacion.
  const limiteColeccion = orden === 'modificados' ? maxResultados : 2000;

  async function recorrer(folderId, profundidad, ruta) {
    if (profundidad > maxProfundidad || pdfs.length >= limiteColeccion) return;
    const hijos = await listarHijos(folderId);
    for (const hijo of hijos) {
      if (pdfs.length >= limiteColeccion) break;
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
    }
  }

  await recorrer(FOLDER_OPERACIONES, 0, '');

  if (orden === 'creados') {
    // El PRIMERO subido a Drive: createdTime asc.
    pdfs.sort((a, b) => new Date(a.createdTime || 0) - new Date(b.createdTime || 0));
  } else if (orden === 'nombre' || orden === 'nombre_fecha') {
    // Por la fecha/hora del NOMBRE del archivo (el primero real).
    pdfs.sort(
      (a, b) =>
        fechaDesdeNombreArchivo(a.name).localeCompare(
          fechaDesdeNombreArchivo(b.name)
        )
    );
  } else {
    pdfs.sort((a, b) => new Date(b.modifiedTime || 0) - new Date(a.modifiedTime || 0));
  }

  return pdfs.slice(0, maxResultados);
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
 * Extrae el texto plano de un PDF a partir de su buffer.
 */
function extraerTextoPdf(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, true);
    parser.on('pdfParser_dataError', (error) =>
      reject(new Error(error?.parserError?.message || 'Error al parsear el PDF'))
    );
    parser.on('pdfParser_dataReady', () => {
      try {
        resolve(parser.getRawTextContent());
      } catch (error) {
        reject(error);
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
};
