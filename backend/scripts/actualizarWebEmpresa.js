require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { connectDB, getDB } = require('../src/db/mongodb');

const ORIGEN = 'web_empresa';
const BASE_URL = process.env.WEB_EMPRESA_URL || 'https://northservices.com.pe/';
const MAX_PAGINAS = parseInt(process.env.WEB_EMPRESA_MAX_PAGINAS || '20', 10);
const MAX_FRAGMENTOS = parseInt(process.env.WEB_EMPRESA_MAX_FRAGMENTOS || '300', 10);
const CONCURRENCIA = parseInt(process.env.EMBEDDING_CONCURRENCY || '5', 10);
const TAMANO_BLOQUE = 800;

function esClaveOpenAI(clave) {
  return /^sk-/.test(String(clave || '').trim());
}

function obtenerClavesGemini() {
  return [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_FALLBACK]
    .filter(Boolean)
    .filter((clave) => !esClaveOpenAI(clave));
}

async function generarEmbedding(texto) {
  if (!texto || !texto.trim()) throw new Error('Texto vacío.');
  const claves = obtenerClavesGemini();
  if (!claves.length) throw new Error('GEMINI_API_KEY no está configurada.');
  let ultimoError = null;
  for (const clave of claves) {
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-embedding-001:embedContent?key=${clave}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { parts: [{ text: texto }] } }),
      });
      if (!response.ok) {
        const textoError = await response.text();
        ultimoError = new Error(`HTTP ${response.status}: ${textoError}`);
        console.error(`[EMBED] Clave falló con HTTP ${response.status}; probando respaldo.`);
        continue;
      }
      const data = await response.json();
      const embedding = data?.embedding?.values;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error('Gemini no devolvió un vector de embedding válido.');
      }
      return embedding;
    } catch (error) {
      if (error.message === 'Gemini no devolvió un vector de embedding válido.') throw error;
      ultimoError = error;
    }
  }
  throw ultimoError || new Error('No fue posible generar embeddings.');
}

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

function limpiarHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}

function extraerEnlaces(html, base) {
  const enlaces = new Set();
  const origen = new URL(BASE_URL).origin;
  const re = /href=["']([^"'#]+)["']/gi;
  let coincidencia;
  while ((coincidencia = re.exec(html)) !== null) {
    try {
      const url = new URL(coincidencia[1], base);
      if (url.origin !== origen) continue;
      if (/\.(pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|svg|webp|zip|rar|7z|mp4|avi|css|js|json|xml|ico|woff2?)(\?|$)/i.test(url.pathname)) continue;
      if (/(wp-json|wp-content|wp-admin|wp-includes|feed|xmlrpc|api|uploads|assets|img|images|fonts)/i.test(url.pathname)) continue;
      url.hash = '';
      url.search = '';
      enlaces.add(url.toString());
    } catch {
      // enlace inválido
    }
  }
  return [...enlaces];
}

(async () => {
  let hecho = false;
  try {
    await connectDB();
    const db = getDB();
    const coleccion = db.collection('conocimientos_vectores');

    const eliminados = await coleccion.deleteMany({ origen: ORIGEN });
    console.log(`Vectores web anteriores eliminados: ${eliminados.deletedCount || 0}`);

    const visitadas = new Set([BASE_URL]);
    const cola = [BASE_URL];
    const paginas = [];

    while (cola.length && paginas.length < MAX_PAGINAS) {
      const url = cola.shift();
      try {
        const respuesta = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (North Services AI RAG)' },
          redirect: 'follow',
          signal: AbortSignal.timeout(20000),
        });
        if (!respuesta.ok) continue;
        const html = await respuesta.text();
        const texto = limpiarHtml(html);
        if (texto.trim().length < 200) continue;

        const tituloMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const titulo = (tituloMatch ? tituloMatch[1] : '').replace(/<[^>]+>/g, '').trim() || url;

        paginas.push({ url, titulo, texto });
        console.log(`[WEB] Visitada: ${url} (${texto.length} caracteres)`);

        for (const enlace of extraerEnlaces(html, url)) {
          if (!visitadas.has(enlace)) {
            visitadas.add(enlace);
            cola.push(enlace);
          }
        }
      } catch (error) {
        console.log(`[WEB] Error en ${url}: ${error.message}`);
      }
    }

    console.log(`Páginas con contenido: ${paginas.length}`);

    const fragmentos = [];
    for (const pagina of paginas) {
      const bloques = dividirTextoEnBloques(pagina.texto);
      bloques.forEach((contenido, indice) => {
        fragmentos.push({ contenido_texto: contenido, url: pagina.url, titulo: pagina.titulo, parte: indice + 1 });
      });
    }

    const clientes = [
      'Nuestros Clientes: North Services & Rental Tools trabaja con empresas líderes del sector hidrocarburos en Perú, Ecuador y Colombia. Entre sus clientes y aliados se encuentran: Pluspetrol, Petrotal, Olympic, Petroecuador, Aguaytía Energy, Savia, Unna, Vigo Energy, Unni Energía y GTG. Para estas empresas brinda servicios de perforación direccional, slickline, fluidos de perforación y control de sólidos, cementación, fractura y acidificación.',
      'Los clientes principales de North Services en la industria petrolera, presente en Perú, Ecuador y Colombia, incluyen a empresas como Aguaytía Energy, GTG, Olympic, Petroecuador, Petrotal, Pluspetrol, Savia, Unna, Vigo Energy y Unni Energía. Estas compañías confían en North Services como socio estratégico para sus operaciones de pozos.',
    ];
    clientes.forEach((contenido, indice) => {
      fragmentos.push({ contenido_texto: contenido, url: BASE_URL, titulo: 'Nuestros Clientes', parte: indice + 1 });
    });

    console.log(`Fragmentos a indexar: ${fragmentos.length}`);

    const aIndexar = fragmentos.slice(0, MAX_FRAGMENTOS);
    const vectores = [];
    let indiceFragmento = 0;

    const trabajador = async () => {
      while (indiceFragmento < aIndexar.length) {
        const fragmento = aIndexar[indiceFragmento++];
        try {
          const embedding = await generarEmbedding(fragmento.contenido_texto);
          vectores.push({
            origen: ORIGEN,
            urlPagina: fragmento.url,
            tituloPagina: fragmento.titulo,
            nombreManual: `Web de la Empresa: ${fragmento.titulo}`,
            titulo_seccion: `${fragmento.titulo} (Parte ${fragmento.parte})`,
            contenido_texto: fragmento.contenido_texto,
            embedding,
            fechaIndexacion: new Date(),
          });
        } catch (error) {
          console.log(`[EMBED] Error en ${fragmento.url}: ${error.message}`);
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCIA }, () => trabajador()));
    console.log(`Vectores con embedding generados: ${vectores.length}`);

    if (vectores.length) {
      const insercion = await coleccion.insertMany(vectores, { ordered: false });
      console.log(`Fragmentos de la web indexados en conocimientos_vectores: ${insercion.insertedCount}`);
    } else {
      console.log('No se indexó ningún fragmento de la web.');
    }
    hecho = true;
  } catch (error) {
    console.error('Error ejecutando el script:', error);
  } finally {
    if (hecho) process.exit(0);
    else process.exit(1);
  }
})();