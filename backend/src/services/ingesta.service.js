'use strict';

// ============================================================
// INGESTA: EXTRACCIÓN Y FRAGMENTACIÓN DEL CONTENIDO
// ============================================================
//
// Única puerta de entrada de la ingesta: convierte un archivo subido en la
// lista de fragmentos que se van a embeber. Lo comparten el servidor
// (POST /api/archivos y la subida de manuales) y scripts/reindexarIngesta.js,
// así que ambos caminos indexan exactamente igual.
//
// Los PDF pasan primero por el parser estructurado
// (services/documentParser.service), que los convierte a Markdown con
// jerarquía y tablas enteras. Ese parser llama a Gemini y puede no estar
// disponible (sin clave, sin red, modelo caído, PDF demasiado grande): en
// ese caso se cae a pdf2json y el documento se indexa igual que antes.
// Nunca se descarta un archivo por culpa del parser.

const path = require('path');
const zlib = require('zlib');
const PDFParser = require('pdf2json');
const documentParser = require('./documentParser.service');

// ------------------------------------------------------------
// PDF
// ------------------------------------------------------------

function extraerTextoPDF(buffer) {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser(null, 1);

    pdfParser.on('pdfParser_dataError', (errData) => {
      reject(errData.parserError);
    });

    pdfParser.on('pdfParser_dataReady', () => {
      try {
        const textoBruto = pdfParser.getRawTextContent();

        try {
          resolve(decodeURIComponent(textoBruto));
        } catch {
          resolve(textoBruto);
        }
      } catch (error) {
        reject(error);
      }
    });

    pdfParser.parseBuffer(buffer);
  });
}

// ------------------------------------------------------------
// OFFICE (DOCX / XLSX / PPTX / VSDX)
// ------------------------------------------------------------

function decodificarEntidadesXML(texto) {
  return texto
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, codigo) => String.fromCharCode(Number(codigo)))
    .replace(/&#x([0-9a-f]+);/gi, (_, codigo) => String.fromCodePoint(parseInt(codigo, 16)));
}

function extraerTextoXml(texto) {
  return decodificarEntidadesXML(texto.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function valorElementoXml(xml, nombre) {
  const coincidencia = xml.match(new RegExp(`<${nombre}\\b[^>]*>([\\s\\S]*?)<\\/${nombre}>`));
  return coincidencia ? extraerTextoXml(coincidencia[1]) : '';
}

function extraerCadenasCompartidas(xml) {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map(([, item]) => [...item.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map(([, texto]) => decodificarEntidadesXML(texto))
      .join(''));
}

function indiceColumnaExcel(letras) {
  return [...letras].reduce((acumulado, letra) => acumulado * 26 + letra.charCodeAt(0) - 64, 0);
}

function letrasColumnaExcel(indice) {
  let letras = '';
  let restante = indice;
  while (restante > 0) {
    restante -= 1;
    letras = String.fromCharCode(65 + (restante % 26)) + letras;
    restante = Math.floor(restante / 26);
  }
  return letras;
}

function traducirFormulaCompartida(formula, origen, destino) {
  const coordenada = (referencia) => {
    const coincidencia = referencia.match(/^([A-Z]+)(\d+)$/);
    return coincidencia
      ? { columna: indiceColumnaExcel(coincidencia[1]), fila: Number(coincidencia[2]) }
      : null;
  };
  const coordenadaOrigen = coordenada(origen);
  const coordenadaDestino = coordenada(destino);
  if (!coordenadaOrigen || !coordenadaDestino) return formula;

  const diferenciaColumna = coordenadaDestino.columna - coordenadaOrigen.columna;
  const diferenciaFila = coordenadaDestino.fila - coordenadaOrigen.fila;

  return formula.replace(/(^|[^A-Za-z0-9_.])(\$?)([A-Z]{1,3})(\$?)(\d+)/g,
    (referenciaCompleta, prefijo, columnaAbsoluta, letras, filaAbsoluta, numeroFila, indice) => {
      const anterior = formula.slice(0, indice);
      const comillasAbiertas = (anterior.match(/"/g) || []).length % 2 !== 0;
      const columna = indiceColumnaExcel(letras);
      if (comillasAbiertas || columna > 16384) return referenciaCompleta;

      const nuevaColumna = columnaAbsoluta ? columna : columna + diferenciaColumna;
      const nuevaFila = filaAbsoluta ? Number(numeroFila) : Number(numeroFila) + diferenciaFila;
      if (nuevaColumna < 1 || nuevaFila < 1) return `${prefijo}#REF!`;

      return `${prefijo}${columnaAbsoluta ? '$' : ''}${letrasColumnaExcel(nuevaColumna)}${filaAbsoluta ? '$' : ''}${nuevaFila}`;
    });
}

function obtenerFormulasCompartidas(xml) {
  const formulas = new Map();
  for (const [, atributosCelda, contenido = ''] of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const referencia = atributosCelda.match(/\br="([^"]+)"/)?.[1];
    const formula = contenido.match(/<f\b([^>]*)>([\s\S]*?)<\/f>|<f\b([^>]*)\/>/);
    if (!referencia || !formula) continue;
    const atributosFormula = formula[1] ?? formula[3] ?? '';
    if (!/\bt="shared"/.test(atributosFormula)) continue;
    const indiceCompartido = atributosFormula.match(/\bsi="([^"]+)"/)?.[1];
    if (indiceCompartido !== undefined && formula[2]) {
      formulas.set(indiceCompartido, { formula: decodificarEntidadesXML(formula[2]), referencia });
    }
  }
  return formulas;
}

function decodificarCeldaExcel(xmlCelda, atributos, cadenasCompartidas, formulasCompartidas) {
  const tipo = atributos.match(/\bt="([^"]+)"/)?.[1] || '';
  const valor = valorElementoXml(xmlCelda, 'v');
  const formulaMatch = xmlCelda.match(/<f\b([^>]*)>([\s\S]*?)<\/f>|<f\b([^>]*)\/>/);
  const atributosFormula = formulaMatch ? formulaMatch[1] ?? formulaMatch[3] ?? '' : '';
  let formula = formulaMatch
    ? (formulaMatch[2] !== undefined
      ? decodificarEntidadesXML(formulaMatch[2])
      : '')
    : '';
  if (formulaMatch && !formula && /\bt="shared"/.test(atributosFormula)) {
    const indiceCompartido = atributosFormula.match(/\bsi="([^"]+)"/)?.[1];
    const referenciaOrigen = formulasCompartidas.get(indiceCompartido);
    const referenciaDestino = atributos.match(/\br="([^"]+)"/)?.[1];
    if (referenciaOrigen && referenciaDestino) {
      formula = traducirFormulaCompartida(
        referenciaOrigen.formula,
        referenciaOrigen.referencia,
        referenciaDestino
      );
    }
  }

  let valorLegible = valor;
  if (tipo === 's' && valor !== '') {
    valorLegible = cadenasCompartidas[Number(valor)] ?? `[cadena compartida ${valor} no encontrada]`;
  } else if (tipo === 'inlineStr') {
    const inline = xmlCelda.match(/<is\b[^>]*>([\s\S]*?)<\/is>/);
    valorLegible = inline
      ? [...inline[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
        .map(([, texto]) => decodificarEntidadesXML(texto))
        .join('')
      : '';
  } else if (tipo === 'b' && valor !== '') {
    valorLegible = valor === '1' ? 'VERDADERO' : 'FALSO';
  } else if (tipo === 'str' || tipo === 'e') {
    valorLegible = decodificarEntidadesXML(valor);
  }

  if (formula) {
    return valorLegible !== ''
      ? `=${formula} [resultado: ${valorLegible}]`
      : `=${formula} [sin resultado calculado guardado]`;
  }
  if (formulaMatch && valorLegible === '') return '=[fórmula compartida sin expresión en esta celda]';
  return String(valorLegible || '').trim();
}

function extraerTextoExcel(archivos) {
  const xmlCadenas = archivos.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  const cadenasCompartidas = extraerCadenasCompartidas(xmlCadenas);
  const hojas = [...archivos.keys()]
    .filter((nombre) => /^xl\/worksheets\/sheet\d+\.xml$/.test(nombre))
    .sort((a, b) => Number(a.match(/sheet(\d+)\.xml$/)[1]) - Number(b.match(/sheet(\d+)\.xml$/)[1]));

  if (!hojas.length) {
    throw new Error('El libro Excel no contiene hojas legibles.');
  }

  return hojas.map((nombreHoja, indiceHoja) => {
    const xml = archivos.get(nombreHoja).toString('utf8');
    const formulasCompartidas = obtenerFormulasCompartidas(xml);
    const filas = [...xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)]
      .map(([, atributosFila, contenidoFila], indiceFila) => {
        const numeroFila = atributosFila.match(/\br="([^"]+)"/)?.[1] || String(indiceFila + 1);
        const celdas = [...contenidoFila.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
          .map(([, atributosCelda, contenidoCelda = '']) => {
            const referencia = atributosCelda.match(/\br="([^"]+)"/)?.[1];
            if (!referencia) return '';
            const contenido = decodificarCeldaExcel(
              contenidoCelda,
              atributosCelda,
              cadenasCompartidas,
              formulasCompartidas
            );
            return contenido ? `${referencia}: ${contenido}` : '';
          })
          .filter(Boolean);
        return celdas.length ? `Fila ${numeroFila}: ${celdas.join(' | ')}` : '';
      })
      .filter(Boolean);

    return [`Hoja ${indiceHoja + 1} (${nombreHoja}):`, ...filas].join('\n');
  }).join('\n\n');
}

// Los formatos Office modernos son archivos ZIP con XML. Esta lectura evita
// depender de una aplicación instalada en el servidor y cubre DOCX, XLSX y PPTX.
function leerZipOffice(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from('PK\x05\x06'));
  if (eocd < 0) throw new Error('El documento Office no tiene un contenedor ZIP válido.');
  const totalEntradas = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const archivos = new Map();
  for (let indice = 0; indice < totalEntradas; indice += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const metodo = buffer.readUInt16LE(cursor + 10);
    const comprimido = buffer.readUInt32LE(cursor + 20);
    const nombreLongitud = buffer.readUInt16LE(cursor + 28);
    const extraLongitud = buffer.readUInt16LE(cursor + 30);
    const comentarioLongitud = buffer.readUInt16LE(cursor + 32);
    const offsetLocal = buffer.readUInt32LE(cursor + 42);
    const nombre = buffer.subarray(cursor + 46, cursor + 46 + nombreLongitud).toString('utf8');
    if (buffer.readUInt32LE(offsetLocal) === 0x04034b50) {
      const nombreLocal = buffer.readUInt16LE(offsetLocal + 26);
      const extraLocal = buffer.readUInt16LE(offsetLocal + 28);
      const inicio = offsetLocal + 30 + nombreLocal + extraLocal;
      const datos = buffer.subarray(inicio, inicio + comprimido);
      archivos.set(nombre, metodo === 8 ? zlib.inflateRawSync(datos) : datos);
    }
    cursor += 46 + nombreLongitud + extraLongitud + comentarioLongitud;
  }
  return archivos;
}

function extraerTextoOffice(buffer, extension) {
  const zip = leerZipOffice(buffer);
  let partes = [];
  if (extension === '.docx') {
    partes = ['word/document.xml', ...[...zip.keys()].filter((nombre) => /^word\/(header|footer)\d+\.xml$/.test(nombre))];
  } else if (extension === '.xlsx') {
    return extraerTextoExcel(zip);
  } else if (extension === '.vsdx') {
    partes = [...zip.keys()].filter((nombre) => /^visio\/pages\/page\d+\.xml$/.test(nombre) || nombre === 'visio/document.xml');
  } else {
    partes = [...zip.keys()].filter((nombre) => /^ppt\/slides\/slide\d+\.xml$/.test(nombre));
  }
  return partes
    .map((nombre) => zip.get(nombre)?.toString('utf8') || '')
    .map(extraerTextoXml)
    .filter(Boolean)
    .join('\n');
}

// ------------------------------------------------------------
// PREPARAR CONTENIDO INDEXABLE
// ------------------------------------------------------------

//   formato:      'markdown' | 'texto'
//   fuenteParser: 'gemini-markdown' | 'pdf2json' | 'office-xml' | 'texto-plano'
//   modeloParser: nombre del modelo de Gemini usado, o null
async function prepararContenidoIndexable({ buffer, nombreArchivo = '', extension = '' } = {}) {
  const ext = String(extension || path.extname(nombreArchivo || '')).toLowerCase();

  if (ext === '.pdf') {
    try {
      const parseado = await documentParser.parsearPdfAMarkdown({ buffer, nombreArchivo });
      if (documentParser.dividirMarkdownEnBloques(parseado.markdown).length > 0) {
        return {
          texto: parseado.markdown,
          formato: 'markdown',
          fuenteParser: parseado.fuente,
          modeloParser: parseado.modelo,
        };
      }
      throw new Error('el Markdown no produjo fragmentos utilizables');
    } catch (error) {
      // Marca puesta por documentParser cuando la cadena de modelos entera
      // (3.8-flash -> 3.1-flash-lite -> 2.5-flash) se quedó sin reintentos
      // por demanda o red. Es el único caso en que el salto a pdf2json es
      // un fallo de disponibilidad y no del documento.
      if (error?.todosLosModelosAgotados) {
        console.warn('[INGESTA] Todos los modelos de Gemini no responden. Activando fallback a pdf2json.');
        console.warn(`[INGESTA] Último error: ${error.message} (archivo: ${nombreArchivo})`);
      } else {
        console.warn(`[INGESTA] Parser estructurado descartado para "${nombreArchivo}" (${error.message}). Se usa pdf2json.`);
      }
    }

    return {
      texto: await extraerTextoPDF(buffer),
      formato: 'texto',
      fuenteParser: 'pdf2json',
      modeloParser: null,
    };
  }

  if (['.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm', '.log'].includes(ext)) {
    return { texto: buffer.toString('utf8'), formato: 'texto', fuenteParser: 'texto-plano', modeloParser: null };
  }

  if (['.docx', '.xlsx', '.pptx', '.vsdx'].includes(ext)) {
    return { texto: extraerTextoOffice(buffer, ext), formato: 'texto', fuenteParser: 'office-xml', modeloParser: null };
  }

  // El archivo queda disponible para descarga aunque su formato no permita
  // extraer texto automáticamente (por ejemplo imágenes, ZIP o ejecutables).
  return { texto: '', formato: 'texto', fuenteParser: 'sin-extraccion', modeloParser: null };
}

// ------------------------------------------------------------
// FRAGMENTACIÓN
// ------------------------------------------------------------

// Convierte el contenido preparado en la lista de fragmentos que se van a
// embeber. El camino de Markdown fragmenta por secciones sin cortar tablas;
// el camino de texto plano sigue usando el corte por longitud de siempre.
function prepararFragmentos(preparado) {
  if (preparado.formato === 'markdown') {
    const fragmentos = documentParser.dividirMarkdownEnBloques(preparado.texto);
    if (fragmentos.length) return fragmentos;
  }
  return documentParser.textoPlanoAFragmentos(dividirTextoEnBloques(preparado.texto, 800));
}

// El título de sección que se muestra en el chat. Con Markdown ya existe
// una jerarquía real; sin ella se mantiene el "Parte N" de siempre.
function tituloSeccionDelFragmento(fragmento, nombreDocumento, indice, total) {
  if (fragmento.tituloSeccion) return `${nombreDocumento} · ${fragmento.tituloSeccion}`;
  return `${nombreDocumento} (Parte ${indice + 1}${total ? ` de ${total}` : ''})`;
}

// Corta texto plano en bloques de ~800 caracteres. Solo lo usan los formatos
// sin estructura; los PDF en Markdown pasan por dividirMarkdownEnBloques.
function dividirTextoEnBloques(texto, tamanioBloque = 800) {
  const lineas = texto.replace(/\r\n/g, '\n').split('\n');

  const bloques = [];
  let bloqueActual = '';

  for (const linea of lineas) {
    const lineaLimpia = linea.trim();

    if (!lineaLimpia) continue;

    const candidato = bloqueActual ? `${bloqueActual}\n${lineaLimpia}` : lineaLimpia;

    if (candidato.length > tamanioBloque) {
      if (bloqueActual.trim()) bloques.push(bloqueActual.trim());
      bloqueActual = lineaLimpia;
    } else {
      bloqueActual = candidato;
    }
  }

  if (bloqueActual.trim()) bloques.push(bloqueActual.trim());

  return bloques.filter((bloque) => bloque.length >= 20);
}

module.exports = {
  extraerTextoPDF,
  prepararContenidoIndexable,
  prepararFragmentos,
  tituloSeccionDelFragmento,
  dividirTextoEnBloques,
};
