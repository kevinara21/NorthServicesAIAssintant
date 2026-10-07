// Compara la recuperación RAG del pipeline viejo (pdf2json + cortes ciegos de
// 800 caracteres) contra el nuevo (PDF -> Markdown estructurado -> fragmentos
// por sección, sin cortar tablas).
//
// Uso:  node scripts/compararIngesta.js <ruta-al-pdf> ["consulta"]
// Ej.:  node scripts/compararIngesta.js storage/manuals/.../Manual.pdf "torque"

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PDFParser = require('pdf2json');
const documentParser = require('../src/services/documentParser.service');

const TOP_K = 3;
const CONCURRENCY = 8;
const MODELO = process.env.GEMINI_MODELO || 'gemini-embedding-001';

// ---------------------------------------------------------------
// Pipeline viejo (idéntico al que estaba en server.js)
// ---------------------------------------------------------------

function extraerTextoPDF(buffer) {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser(null, 1);
    pdfParser.on('pdfParser_dataError', (errData) => reject(errData.parserError));
    pdfParser.on('pdfParser_dataReady', () => {
      const bruto = pdfParser.getRawTextContent();
      try {
        resolve(decodeURIComponent(bruto));
      } catch {
        resolve(bruto);
      }
    });
    pdfParser.parseBuffer(buffer);
  });
}

function dividirTextoLegacy(texto, tamanioBloque = 800) {
  const bloques = [];
  let bloqueActual = '';

  for (const linea of texto.replace(/\r\n/g, '\n').split('\n')) {
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

// ---------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------

async function generarEmbedding(texto) {
  const url = `https://generativelanguage.googleapis.com/v1/models/${MODELO}:embedContent?key=${process.env.GEMINI_API_KEY}`;
  const respuesta = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { parts: [{ text: texto }] } })
  });
  const datos = await respuesta.json();
  if (!respuesta.ok) throw new Error(JSON.stringify(datos));
  return datos.embedding.values;
}

async function enConcurrencia(items, trabajador) {
  const resultados = new Array(items.length);
  let siguiente = 0;

  const obreros = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (siguiente < items.length) {
      const indice = siguiente++;
      resultados[indice] = await trabajador(items[indice], indice);
    }
  });

  await Promise.all(obreros);
  return resultados;
}

function similitud(a, b) {
  let producto = 0;
  let normaA = 0;
  let normaB = 0;
  for (let i = 0; i < a.length; i += 1) {
    producto += a[i] * b[i];
    normaA += a[i] * a[i];
    normaB += b[i] * b[i];
  }
  if (!normaA || !normaB) return 0;
  return producto / (Math.sqrt(normaA) * Math.sqrt(normaB));
}

// ---------------------------------------------------------------
// Comparación
// ---------------------------------------------------------------

async function construirRuta(etiqueta, fragmentos) {
  const embebidos = await enConcurrencia(fragmentos, (fragmento) =>
    generarEmbedding(fragmento.texto)
  );
  console.log(`[OK] ${etiqueta}: ${fragmentos.length} fragmentos embebidos`);
  return fragmentos.map((fragmento, indice) => ({
    ...fragmento,
    embedding: embebidos[indice]
  }));
}

async function principal() {
  const [rutaPdf, consultaArg] = process.argv.slice(2);

  if (!rutaPdf) {
    console.error('Uso: node scripts/compararIngesta.js <ruta-al-pdf> ["consulta"]');
    process.exit(1);
  }

  const consulta =
    consultaArg ||
    '¿Cuál es el torque objetivo máximo y el torque máximo permitido según el manual?';

  const ruta = path.resolve(rutaPdf);
  const buffer = fs.readFileSync(ruta);

  console.log(`PDF: ${path.basename(ruta)}`);
  console.log(`Consulta: ${consulta}\n`);

  // --- Ruta vieja ---
  const textoViejo = await extraerTextoPDF(buffer);
  const inicioViejo = Date.now();
  const fragmentosViejos = dividirTextoLegacy(textoViejo).map((texto, indice) => ({
    texto,
    tituloSeccion: `Parte ${indice + 1}`,
    rutaTitulos: '',
    pagina: null
  }));
  const msViejo = Date.now() - inicioViejo;

  // --- Ruta nueva ---
  const inicioNuevo = Date.now();
  let markdown = null;
  try {
    markdown = await documentParser.parsearPdfAMarkdown({
      buffer,
      nombreArchivo: path.basename(ruta)
    });
  } catch (error) {
    if (error?.todosLosModelosAgotados) {
      console.warn('[INGESTA] Todos los modelos de Gemini no responden. Activando fallback a pdf2json.');
    }
    console.warn(`[AVISO] Parser estructurado no respondió: ${error.message}`);
    console.warn('[AVISO] La comparación se hará solo con el pipeline viejo.\n');
  }
  const fragmentosNuevos = markdown
    ? documentParser.dividirMarkdownEnBloques(markdown.markdown)
    : [];
  const msNuevo = Date.now() - inicioNuevo;

  console.log('--- Metadatos ---');
  console.log(
    `Viejo : ${fragmentosViejos.length} fragmentos | media ` +
      `${Math.round(fragmentosViejos.reduce((s, f) => s + f.texto.length, 0) / fragmentosViejos.length)} chars | fragmentación ${msViejo} ms`
  );
  console.log(
    `Nuevo : ${fragmentosNuevos.length} fragmentos | media ` +
      `${fragmentosNuevos.length
        ? Math.round(fragmentosNuevos.reduce((s, f) => s + f.texto.length, 0) / fragmentosNuevos.length)
        : 0} chars | parseo+fragmentación ${msNuevo} ms`
  );
  if (markdown) {
    console.log(`        parser: ${markdown.fuente} / ${markdown.modelo}`);
  }
  console.log('');

  const [viejos, nuevos, vectorConsulta] = await Promise.all([
    construirRuta('Viejo', fragmentosViejos),
    fragmentosNuevos.length ? construirRuta('Nuevo', fragmentosNuevos) : [],
    generarEmbedding(consulta)
  ]);

  const embeber = (conjunto, vectorConsulta) =>
    conjunto
      .map((fragmento) => ({
        ...fragmento,
        score: similitud(fragmento.embedding, vectorConsulta)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K);

  const topViejo = embeber(viejos, vectorConsulta);
  const topNuevo = embeber(nuevos, vectorConsulta);

  const resumir = (lista, titulo) => {
    console.log(`--- ${titulo} ---`);
    if (!lista.length) {
      console.log('(sin fragmentos)\n');
      return;
    }
    lista.forEach((fragmento, indice) => {
      const rutaTitulo = fragmento.rutaTitulos ? ` | ${fragmento.rutaTitulos}` : '';
      const pagina = fragmento.pagina ? ` | p.${fragmento.pagina}` : '';
      console.log(
        `\n#${indice + 1} score=${fragmento.score.toFixed(4)} (${fragmento.texto.length} chars${rutaTitulo}${pagina})`
      );
      console.log(fragmento.texto.slice(0, 900));
    });
    console.log('');
  };

  resumir(topViejo, 'Recuperación con pipeline VIEJO (pdf2json)');
  resumir(topNuevo, 'Recuperación con pipeline NUEVO (Markdown estructurado)');
}

principal().catch((error) => {
  console.error('[ERROR]', error.message || error);
  process.exit(1);
});
