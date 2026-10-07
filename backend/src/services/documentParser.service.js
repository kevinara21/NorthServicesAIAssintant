'use strict';

// ============================================================
// PARSING ESTRUCTURADO DE DOCUMENTOS (PDF -> MARKDOWN)
// ============================================================
//
// Por qué existe este módulo:
//
// pdf2json reconstruye el PDF en el ORDEN INTERNO DE DIBUJO de los
// operadores de texto, no en el orden de lectura. En un manual real
// (Manual_Sistema_Adquisicion_Torque.pdf) eso producía:
//
//   * la lista de la sección 1.1 aparecía ANTES de su propio título;
//   * las tablas salían como una sola línea con huecos de espacios,
//     y su fila de encabezado quedaba al final de la tabla;
//   * los diagramas no aportaban ni un token.
//
// Aquí el PDF se pasa completo a Gemini (visión + PDF nativo), que
// devuelve Markdown con jerarquía y tablas preservadas. El resto del
// sistema solo tiene que leer un string en Markdown.
//
// Configuración (todas opcionales):
//   PARSER_ESTRUCTURADO=off                  apaga el parser y deja pdf2json
//   GEMINI_PARSER_MODELOS=a,b,c              cadena de modelos a probar
//   GEMINI_PARSER_INTENTO_TIMEOUT_MS=60000   timeout de UNA petición HTTP
//   GEMINI_PARSER_TIMEOUT_MS=300000          presupuesto de toda la cadena
//   GEMINI_PARSER_MAX_PDF_BYTES=...          límite de PDF por el envío inline
//
// Resiliencia: la cadena de modelos se recorre en orden y, dentro de cada
// modelo, un fallo transitorio (429/503 "high demand", timeout o red) se
// reintenta hasta MAX_REINTENTOS veces con backoff exponencial + jitter
// (2 s, 4 s, 8 s). Solo cuando TODA la cadena se agota se lanza el error
// con `todosLosModelosAgotados` y el caller cae a pdf2json.
//
// Si algo falla, el servicio lanza y el caller cae a pdf2json: ninguna
// subida de archivo deja de funcionar por culpa de este módulo.

// ------------------------------------------------------------
// CONFIGURACIÓN
// ------------------------------------------------------------

// Cadena de fallback por prioridad. `gemini-3.8-flash` es el primero porque
// procesa bien los planos técnicos; `gemini-3.1-flash-lite` es el que ha
// respondido de forma más estable; `gemini-2.5-flash` entra como modelo
// estable de respaldo. Se puede sobrescribir con GEMINI_PARSER_MODELOS.
const MODELOS_POR_DEFECTO = [
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash'
];

// Reintentos POR MODELO cuando el fallo es transitorio (demanda/red/timeout).
const MAX_REINTENTOS = 3;

// Backoff exponencial: 2 s, 4 s, 8 s... + jitter para no sincronizar todos
// los clientes cuando la API se recupera.
const BACKOFF_BASE_MS = 2000;
const BACKOFF_JITTER_MS = 500;

// Timeout de UNA petición HTTP. Los planos técnicos y las figuras desordenadas
// tardan en procesarse, así que se sube a 60 s por intento.
const INTENTO_TIMEOUT_POR_DEFECTO_MS = 60000;

// Presupuesto de toda la cadena (modelos + reintentos). El peor caso teórico
// es 3 modelos x 4 intentos x 60 s, pero los 429/503 responden en segundos:
// 5 minutos cubren de sobra el caso real sin colgar una subida indefinidamente.
const CADENA_TIMEOUT_POR_DEFECTO_MS = 300000;

// El envío de un PDF va inline en base64 y la API de Gemini admite 20 MB
// por petición: 15 MB de archivo ya deja margen para el base64.
const MAX_PDF_BYTES_POR_DEFECTO = 15 * 1024 * 1024;

const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

// 2 s en el primer reintento, 4 s en el segundo, 8 s en el tercero, más un
// jitter de 0-500 ms.
function retardoBackoff(reintento) {
  const base = BACKOFF_BASE_MS * 2 ** (reintento - 1);
  return base + Math.floor(Math.random() * BACKOFF_JITTER_MS);
}

function esClaveOpenAI(clave) {
  return /^sk-/.test(String(clave || '').trim());
}

function obtenerClavesGemini() {
  return [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_FALLBACK]
    .filter(Boolean)
    .filter((clave) => !esClaveOpenAI(clave));
}

function modelosParser() {
  const propios = String(process.env.GEMINI_PARSER_MODELOS || '')
    .split(',')
    .map((modelo) => modelo.trim())
    .filter(Boolean);
  return propios.length ? propios : MODELOS_POR_DEFECTO;
}

function intentoTimeoutMs() {
  const valor = Number(process.env.GEMINI_PARSER_INTENTO_TIMEOUT_MS);
  return Number.isFinite(valor) && valor > 0 ? valor : INTENTO_TIMEOUT_POR_DEFECTO_MS;
}

function cadenaTimeoutMs() {
  const valor = Number(process.env.GEMINI_PARSER_TIMEOUT_MS);
  return Number.isFinite(valor) && valor > 0 ? valor : CADENA_TIMEOUT_POR_DEFECTO_MS;
}

function maxPdfBytes() {
  const valor = Number(process.env.GEMINI_PARSER_MAX_PDF_BYTES);
  return Number.isFinite(valor) && valor > 0 ? valor : MAX_PDF_BYTES_POR_DEFECTO;
}

function parserHabilitado() {
  return String(process.env.PARSER_ESTRUCTURADO || '').toLowerCase() !== 'off';
}

// ------------------------------------------------------------
// PROMPT
// ------------------------------------------------------------

// El prompt pide transcripción, no resumen: cualquier resumen perdería
// justamente las filas de torque y de presión que el RAG necesita responder.
function construirPrompt(nombreArchivo) {
  return [
    'Eres un parser de documentos técnicos de perforación direccional (MWD/LWD).',
    'Convierte el PDF adjunto ("' + String(nombreArchivo || 'documento.pdf') + '") en Markdown ESTRUCTURADO.',
    '',
    'REGLAS OBLIGATORIAS:',
    '1. Transcribe TODO el contenido. No resumas, no parafrasees, no inventes nada que no esté en el documento.',
    '2. Jerarquía: # para capítulos, ## para secciones, ### para subsecciones. Usa la numeración original (1, 1.1, 1.1.2).',
    '3. Tablas: usa tablas Markdown con encabezado y separador, por ejemplo:',
    '   | Componente | Función |',
    '   | --- | --- |',
    '   | Controlador PLC | Envía la lectura de presión |',
    '   Conserva TODAS las filas y TODAS las columnas, con sus unidades (Ft/Lbs, psi, etc.).',
    '   Si una fila no encaja, sigue en la misma fila; nunca la partas en dos.',
    '4. Listas: usa "- " o "1. ". Bloques de código o valores crudos entre ```.',
    '5. Órdenes de lectura: respeta el orden de arriba hacia abajo del documento.',
    '   NO pongas el pie de página ni el encabezado antes que el cuerpo de la sección.',
    '6. Figuras, diagramas y gráficos: descríbelos con detalle entre corchetes:',
    '   [Diagrama: <qué muestra, sus nodos/etapas y los valores visibles>]',
    '   Incluye los rótulos y los números que se lean en la figura.',
    '7. Números y tablas son críticos: si un valor es ilegible, escribe [ilegible] en su lugar. Nunca lo deduzcas.',
    '8. Si el documento trae el número de página explícito en el encabezado o el pie',
    '   (por ejemplo "Página 3 de 9"), inserta exactamente <!-- página N --> en ese punto del texto.',
    '   Si el número de página no está escrito en el documento, no pongas NINGÚN marcador de página.',
    '9. Empieza directamente con el Markdown. Nada de preámbulo, nada de "Aquí tienes",',
    '   nada de explicaciones fuera del Markdown ni de cercados ```markdown.'
  ].join('\n');
}

// ------------------------------------------------------------
// LLAMADA A GEMINI
// ------------------------------------------------------------

function esErrorTransitorio(error) {
  if (error?.transitorio === true) return true;
  return false;
}

async function llamarGemini({ modelo, clave, b64, prompt, tiempoLimiteMs }) {
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    modelo + ':generateContent?key=' + clave;

  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), tiempoLimiteMs);

  try {
    const respuesta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: control.signal,
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inline_data: { mime_type: 'application/pdf', data: b64 } }
          ]
        }],
        generationConfig: { temperature: 0 }
      })
    });

    const datos = await respuesta.json().catch(() => ({}));

    if (!respuesta.ok) {
      const mensaje = datos?.error?.message || `HTTP ${respuesta.status}`;
      const error = new Error(`${modelo}: ${mensaje}`);
      // 429 y 503 son picos de demanda: merece un reintento.
      error.transitorio = respuesta.status === 429 || respuesta.status === 503;
      error.http = respuesta.status;
      throw error;
    }

    const bloqueado = datos?.promptFeedback?.blockReason;
    if (bloqueado) {
      const error = new Error(`${modelo}: contenido bloqueado (${bloqueado})`);
      error.transitorio = false;
      throw error;
    }

    const markdown = (datos?.candidates?.[0]?.content?.parts || [])
      .map((parte) => parte.text || '')
      .join('')
      .trim();

    if (!markdown) {
      const error = new Error(`${modelo}: la API no devolvió texto`);
      error.transitorio = true;
      throw error;
    }

    return { markdown, usage: datos?.usageMetadata || null };
  } catch (error) {
    if (error?.name === 'AbortError') {
      const tiempo = new Error(`${modelo}: tiempo de espera agotado`);
      tiempo.transitorio = true;
      throw tiempo;
    }
    if (error instanceof TypeError) {
      // Fallo de red: también transitorio.
      const red = new Error(`${modelo}: ${error.message}`);
      red.transitorio = true;
      throw red;
    }
    throw error;
  } finally {
    clearTimeout(reloj);
  }
}

// ------------------------------------------------------------
// LIMPIEZA DEL MARKDOWN
// ------------------------------------------------------------

function limpiarMarkdown(markdown) {
  let texto = String(markdown || '').replace(/\r\n/g, '\n').trim();

  // Cercado de idioma que algunos modelos añaden aunque se les pida lo contrario.
  if (texto.startsWith('```')) {
    texto = texto.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }

  // Preámbulos habituales: se corta en la primera línea que sí es Markdown.
  const preambulos = [
    /^aqu[íi] (tienes|tienes el|est[áa])\b/i,
    /^a continuaci[óo]n\b/i,
    /^el siguiente (documento|archivo|contenido)\b/i,
    /^sure[,.]? here is\b/i,
    /^here is\b/i,
    /^#* *markdown\b/i
  ];
  const lineas = texto.split('\n');
  while (lineas.length > 1 && preambulos.some((patron) => patron.test(lineas[0].trim()))) {
    lineas.shift();
  }
  texto = lineas.join('\n').trim();

  return texto;
}

// ------------------------------------------------------------
// PUNTO DE ENTRADA
// ------------------------------------------------------------

/**
 * Convierte un PDF en Markdown estructurado.
 *
 * Recorre la cadena de modelos por prioridad. Dentro de cada modelo, los
 * fallos transitorios (429/503, timeout o red) se reintentan hasta
 * MAX_REINTENTOS veces con backoff exponencial + jitter antes de pasar al
 * siguiente modelo de la cadena.
 *
 * @param {{buffer: Buffer, nombreArchivo?: string}} opciones
 * @returns {Promise<{markdown: string, modelo: string, fuente: string, usage: object|null}>}
 * @throws {Error} si se agota la cadena. Si falló por demanda/red el error
 *         lleva `todosLosModelosAgotados = true` y el caller debe caer a
 *         pdf2json.
 */
async function parsearPdfAMarkdown({ buffer, nombreArchivo = 'documento.pdf' } = {}) {
  if (!parserHabilitado()) throw new Error('Parser estructurado deshabilitado (PARSER_ESTRUCTURADO=off).');
  if (!buffer || !buffer.length) throw new Error('El PDF está vacío.');

  const limite = maxPdfBytes();
  if (buffer.length > limite) {
    throw new Error(
      `El PDF pesa ${(buffer.length / 1048576).toFixed(1)} MB y supera el límite de ${(limite / 1048576).toFixed(0)} MB del parser multimodal.`
    );
  }

  const claves = obtenerClavesGemini();
  if (!claves.length) throw new Error('GEMINI_API_KEY no está configurada.');

  const cadena = modelosParser();
  const b64 = buffer.toString('base64');
  const prompt = construirPrompt(nombreArchivo);
  const inicio = Date.now();
  const presupuestoMs = cadenaTimeoutMs();
  const porIntentoMs = intentoTimeoutMs();

  let ultimoError = null;
  let algunFalloTransitorio = false;
  let intentoGlobal = 0;

  for (const [posicion, modelo] of cadena.entries()) {
    if (Date.now() - inicio >= presupuestoMs) break;

    console.log(`[PARSER] Modelo ${posicion + 1}/${cadena.length}: ${modelo}`);

    let reintentos = 0;

    while (true) {
      const restante = presupuestoMs - (Date.now() - inicio);
      if (restante <= 0) break;

      const clave = claves[intentoGlobal % claves.length];
      intentoGlobal += 1;

      try {
        const { markdown, usage } = await llamarGemini({
          modelo,
          clave,
          b64,
          prompt,
          tiempoLimiteMs: Math.min(porIntentoMs, restante)
        });

        const limpio = limpiarMarkdown(markdown);
        if (limpio.length < 200) {
          const corto = new Error(`${modelo}: el Markdown devuelto es demasiado corto (${limpio.length} caracteres)`);
          corto.transitorio = false;
          throw corto;
        }

        return { markdown: limpio, modelo, fuente: 'gemini-markdown', usage };
      } catch (error) {
        ultimoError = error;
        if (esErrorTransitorio(error)) algunFalloTransitorio = true;
        console.warn(`[PARSER] ${error.message}`);

        // Error permanente (404 de un modelo retirado, contenido bloqueado,
        // respuesta demasiado corta): no se gastan reintentos y se pasa al
        // siguiente modelo de la cadena.
        if (!esErrorTransitorio(error)) break;

        if (reintentos >= MAX_REINTENTOS) {
          console.warn(`[PARSER] ${modelo}: agotados ${MAX_REINTENTOS} reintentos, siguiente modelo de la cadena.`);
          break;
        }

        reintentos += 1;
        const espera = retardoBackoff(reintentos);
        console.warn(`[PARSER] ${modelo}: reintento ${reintentos}/${MAX_REINTENTOS} en ${espera} ms.`);
        await dormir(espera);
      }
    }
  }

  const fallo = ultimoError || new Error('Ningún modelo de parsing respondió.');

  // Marca para que el caller sepa que el salto a pdf2json se debe a que
  // toda la cadena se quedó sin reintentos (demanda o red), no a un
  // problema del propio PDF.
  if (algunFalloTransitorio) fallo.todosLosModelosAgotados = true;

  throw fallo;
}

// ------------------------------------------------------------
// FRAGMENTACIÓN ESTRUCTURADA
// ------------------------------------------------------------

const TITULO = /^(#{1,6})\s+\S/;
const FILA_TABLA = /^\s*\|.*\|\s*$/;
const ITEM_LISTA = /^\s*(?:[-*+]|\d+[.)])\s+\S/;
const CONTINUACION_LISTA = /^\s+\S/;
const MARCADOR_PAGINA = /^\s*<!--\s*p[áa]gina\s+(\d+)\s*-->\s*$/i;
const SEPARADOR = /^\s*(?:---|\*\*\*|___)\s*$/;

// Parte un texto largo respetando palabras y, si es posible, finales de
// oración. Nunca corta a mitad de palabra.
function partirTexto(texto, maximo) {
  if (texto.length <= maximo) return [texto];

  const partes = [];
  let resto = texto;

  while (resto.length > maximo) {
    const ventana = resto.slice(0, maximo);
    const finOracion = Math.max(
      ventana.lastIndexOf('. '),
      ventana.lastIndexOf('; '),
      ventana.lastIndexOf(': ')
    );

    let corte;
    if (finOracion > maximo * 0.35) {
      corte = finOracion + 1;
    } else {
      corte = ventana.lastIndexOf(' ');
      if (corte < maximo * 0.5) corte = maximo;
    }

    partes.push(resto.slice(0, corte).trim());
    resto = resto.slice(corte).trim();
  }

  if (resto) partes.push(resto);
  return partes;
}

// Agrupa el Markdown en unidades que no deben cortarse por la mitad:
// títulos, tablas (enteras), listas y párrafos.
function agruparUnidades(lineas) {
  const unidades = [];
  let actuales = [];
  let tipoActual = null;

  const cerrar = () => {
    if (actuales.length) unidades.push({ tipo: tipoActual, lineas: actuales });
    actuales = [];
    tipoActual = null;
  };

  for (const linea of lineas) {
    const lineaLimpia = linea.trimEnd();

    if (!lineaLimpia.trim()) {
      cerrar();
      continue;
    }

    const marcador = lineaLimpia.match(MARCADOR_PAGINA);
    if (marcador) {
      cerrar();
      unidades.push({ tipo: 'pagina', pagina: Number(marcador[1]), lineas: [] });
      continue;
    }

    let tipo;
    if (TITULO.test(lineaLimpia)) {
      tipo = 'titulo';
    } else if (FILA_TABLA.test(lineaLimpia)) {
      tipo = 'tabla';
    } else if (ITEM_LISTA.test(lineaLimpia)) {
      tipo = 'lista';
    } else if (tipoActual === 'lista' && CONTINUACION_LISTA.test(lineaLimpia)) {
      tipo = 'lista';
    } else if (SEPARADOR.test(lineaLimpia)) {
      tipo = 'separador';
    } else {
      tipo = 'parrafo';
    }

    if (tipo !== tipoActual) {
      cerrar();
      tipoActual = tipo;
    }
    actuales.push(lineaLimpia);
  }

  cerrar();
  return unidades;
}

// Cada título abre una sección nueva: así la ruta de títulos de un
// fragmento siempre describe exactamente dónde está.
function agruparSecciones(unidades) {
  const secciones = [];
  const pila = [];
  let actual = null;

  const cerrar = () => {
    if (actual && actual.unidades.length) secciones.push(actual);
    actual = null;
  };

  for (const unidad of unidades) {
    // Los marcadores de página se conservan aquí dentro: si se filtraran en
    // este punto, el bucle de fragmentación nunca los vería y todos los
    // fragmentos terminarían con pagina=null.
    if (unidad.tipo === 'pagina') {
      if (!actual) actual = { ruta: [], titulo: '', nivel: 0, unidades: [] };
      actual.unidades.push(unidad);
      continue;
    }

    if (unidad.tipo === 'titulo') {
      const coincidencia = unidad.lineas[0].match(TITULO);
      const nivel = coincidencia[1].length;
      const titulo = unidad.lineas[0]
        .slice(nivel + 1)
        .replace(/#+\s*$/, '')
        .trim();

      cerrar();

      while (pila.length && pila[pila.length - 1].nivel >= nivel) pila.pop();
      pila.push({ nivel, titulo });

      actual = {
        ruta: pila.map((entrada) => entrada.titulo),
        titulo,
        nivel,
        unidades: [unidad]
      };
      continue;
    }

    if (!actual) {
      actual = { ruta: [], titulo: '', nivel: 0, unidades: [] };
    }
    actual.unidades.push(unidad);
  }

  cerrar();
  return secciones;
}

/**
 * Fragmenta Markdown sin cortar tablas por la mitad ni romper la jerarquía.
 *
 * @param {string} markdown
 * @param {{objetivo?: number, maximo?: number}} [opciones]
 * @returns {Array<{texto: string, rutaTitulos: string, tituloSeccion: string,
 *                  nivelTitulo: number, pagina: number|null}>}
 */
function dividirMarkdownEnBloques(markdown, opciones = {}) {
  const objetivo = Number(opciones.objetivo) || 800;
  const maximo = Number(opciones.maximo) || objetivo;

  const lineas = String(markdown || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // El modelo a veces incrusta el marcador en medio de una línea; si no
    // se separa, no se reconoce y el comentario se colaría en el fragmento.
    .replace(/[ \t]*<!--\s*p[áa]gina\s+(\d+)\s*-->[ \t]*/gi, '\n<!-- página $1 -->\n')
    .split('\n');

  const secciones = agruparSecciones(agruparUnidades(lineas));
  const fragmentos = [];

  let paginaActual = null;

  const empujar = (lineasBloque, seccion) => {
    const texto = lineasBloque.join('\n').trim();
    if (texto.length < 20) return;

    fragmentos.push({
      texto,
      rutaTitulos: seccion.ruta.join(' > '),
      tituloSeccion: seccion.titulo || '',
      nivelTitulo: seccion.nivel || 0,
      pagina: paginaActual
    });
  };

  for (const seccion of secciones) {
    // El prefijo solo aparece cuando el fragmento ya no lleva su propio
    // título encima; si no, se repetiría la sección.
    const prefijo = seccion.ruta.length > 1
      ? `Sección: ${seccion.ruta.join(' > ')}\n\n`
      : '';

    let buffer = null;
    let emitida = false;

    const vaciar = () => {
      if (buffer !== null) {
        empujar(buffer.split('\n'), seccion);
        emitida = true;
        buffer = null;
      }
    };

    for (const unidad of seccion.unidades) {
      if (unidad.tipo === 'pagina') {
        paginaActual = unidad.pagina;
        continue;
      }

      let pieza = unidad.lineas.join('\n');
      if (!pieza.trim()) continue;

      // Una pieza enorme que no sea tabla ni título: se parte antes de
      // meterla en el buffer, para no romper el límite de ningún fragmento.
      if (pieza.length > maximo && unidad.tipo !== 'tabla' && unidad.tipo !== 'titulo') {
        vaciar();
        for (const parte of partirTexto(pieza, maximo)) {
          empujar([prefijo + parte], seccion);
        }
        continue;
      }

      const prefijoActual = buffer === null && emitida && unidad.tipo !== 'titulo'
        ? prefijo
        : '';
      const candidato = buffer === null
        ? prefijoActual + pieza
        : `${buffer}\n\n${pieza}`;

      if (candidato.length <= maximo) {
        buffer = candidato;
        continue;
      }

      // No cabe: se cierra el actual y se abre otro.
      vaciar();

      if (unidad.tipo === 'titulo') {
        // El título encabeza su nuevo fragmento; el prefijo sobraría.
        buffer = pieza;
      } else if (unidad.tipo === 'tabla') {
        // Una tabla no se corta nunca, aunque se pase del tamaño objetivo.
        empujar([prefijo + pieza], seccion);
        emitida = true;
      } else {
        buffer = prefijo + pieza;
      }
    }

    vaciar();
  }

  return fragmentos;
}

/**
 * Envuelve los fragmentos de un parser sin estructura (pdf2json o texto
 * plano) en el mismo formato que `dividirMarkdownEnBloques`, para que los
 * dos caminos de ingesta compartan un único contrato.
 *
 * @param {string[]} bloques
 */
function textoPlanoAFragmentos(bloques) {
  return (bloques || []).map((texto, indice) => ({
    texto,
    rutaTitulos: '',
    tituloSeccion: `Parte ${indice + 1}`,
    nivelTitulo: 0,
    pagina: null
  }));
}

module.exports = {
  parsearPdfAMarkdown,
  dividirMarkdownEnBloques,
  textoPlanoAFragmentos,
  construirPrompt,
  parserHabilitado
};
