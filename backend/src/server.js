require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const PDFParser = require('pdf2json');
const crypto = require('crypto');
const zlib = require('zlib');

const { db, authAdmin, FieldValue } = require('./firebaseAdmin');
const { connectDB, getDB } = require('./db/mongodb');
const verifyToken = require('./middleware/verifyToken');
const { enviarOtpCorporativo } = require('./services/corporateEmail.service');

const app = express();

app.use(cors());
app.use(express.json());

// ============================================================
// CONFIGURACIÓN RAG
// ============================================================

const RAG_SCORE_THRESHOLD = Number(
  process.env.RAG_SCORE_THRESHOLD || '0.40'
);

const RAG_LIMIT = Number(
  process.env.RAG_LIMIT || '5'
);

const RAG_NUM_CANDIDATES = Number(
  process.env.RAG_NUM_CANDIDATES || '20'
);

const EMBEDDING_CONCURRENCY = Number(
  process.env.EMBEDDING_CONCURRENCY || '5'
);

const OTP_EXPIRATION_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_DESTINATION = normalizarTelefono(process.env.OTP_DESTINATION || '+51981384927');
const INFOBIP_BASE_URL = (process.env.INFOBIP_BASE_URL || '').replace(/\/$/, '');
const INFOBIP_SMS_SENDER = process.env.INFOBIP_SMS_SENDER || '447491163443';
const INFOBIP_WHATSAPP_SENDER = process.env.INFOBIP_WHATSAPP_SENDER || '';
const INFOBIP_WHATSAPP_TEMPLATE_NAME = process.env.INFOBIP_WHATSAPP_TEMPLATE_NAME || 'test_whatsapp_template_en';
const INFOBIP_WHATSAPP_LANGUAGE = process.env.INFOBIP_WHATSAPP_LANGUAGE || 'en';

function normalizarTelefono(telefono) {
  return String(telefono || '').replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
}

function generarCodigoOTP() {
  return String(crypto.randomInt(100000, 1000000));
}

function hashOTP(codigo) {
  return crypto.createHash('sha256').update(codigo).digest('hex');
}

async function enviarOTPSMS(telefono, codigo) {
  if (!process.env.INFOBIP_API_KEY || !INFOBIP_BASE_URL || !INFOBIP_SMS_SENDER) {
    throw new Error('Infobip SMS no está configurado. Define INFOBIP_API_KEY, INFOBIP_BASE_URL e INFOBIP_SMS_SENDER.');
  }

  const response = await fetch(`${INFOBIP_BASE_URL}/sms/3/messages`, {
    method: 'POST',
    headers: {
      Authorization: `App ${process.env.INFOBIP_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      messages: [{
        destinations: [{ to: telefono.replace('+', '') }],
        sender: INFOBIP_SMS_SENDER,
        content: { text: `North Services: tu código de verificación es ${codigo}. Vence en ${OTP_EXPIRATION_MINUTES} minutos.` },
      }],
    }),
  });

  const respuestaInfobip = await response.json().catch(() => ({}));
  const resultado = respuestaInfobip?.messages?.[0];

  if (!response.ok || resultado?.status?.groupName === 'REJECTED') {
    const detalle = resultado?.status?.description || respuestaInfobip?.requestError?.serviceException?.text;
    if (detalle === 'Destination not registered') throw new Error('El número de destino no está habilitado para recibir SMS de este remitente de Infobip.');
    throw new Error(`Infobip rechazó el envío (${response.status})${detalle ? `: ${detalle}` : '.'}`);
  }

  return {
    messageId: resultado?.messageId || null,
    estado: resultado?.status?.groupName || 'ACCEPTED',
    descripcion: resultado?.status?.description || null,
  };
}

async function enviarOTPWhatsApp(telefono, codigo) {
  if (!process.env.INFOBIP_API_KEY || !INFOBIP_BASE_URL || !INFOBIP_WHATSAPP_SENDER) {
    throw new Error('Infobip WhatsApp no está configurado.');
  }

  const response = await fetch(`${INFOBIP_BASE_URL}/whatsapp/1/message/template`, {
    method: 'POST',
    headers: {
      Authorization: `App ${process.env.INFOBIP_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      messages: [{
        from: INFOBIP_WHATSAPP_SENDER,
        to: telefono.replace('+', ''),
        content: {
          templateName: INFOBIP_WHATSAPP_TEMPLATE_NAME,
          templateData: { body: { placeholders: [codigo] } },
          language: INFOBIP_WHATSAPP_LANGUAGE,
        },
      }],
    }),
  });
  const data = await response.json().catch(() => ({}));
  const resultado = data?.messages?.[0];
  const detalle = resultado?.status?.description || data?.requestError?.serviceException?.text;
  if (!response.ok || resultado?.status?.groupName === 'REJECTED') {
    throw new Error(`Infobip rechazó WhatsApp${detalle ? `: ${detalle}` : '.'}`);
  }
  return { messageId: resultado?.messageId || null, estado: resultado?.status?.groupName || 'ACCEPTED', descripcion: detalle || null };
}

async function crearOTP({ uid = null, telefono, email = null, proposito, canal = 'sms' }) {
  const codigo = generarCodigoOTP();
  const referencia = db.collection('otpCodes').doc();
  await referencia.set({
    uid, email, telefono, proposito, canal, codigoHash: hashOTP(codigo), intentos: 0, usado: false,
    creadoEn: FieldValue.serverTimestamp(),
    expiraEn: new Date(Date.now() + OTP_EXPIRATION_MINUTES * 60 * 1000),
  });
  try {
    if (canal === 'correo') {
      const envio = await enviarOtpCorporativo({ para: email, otp: codigo, minutosExpiracion: OTP_EXPIRATION_MINUTES });
      if (!envio.ok) {
        await referencia.delete();
        throw new Error(envio.error || 'No se pudo enviar el código por correo corporativo.');
      }
      await referencia.update({ canal: 'correo', correoMessageId: envio.messageId });
      return envio;
    }
    const envio = canal === 'whatsapp'
      ? await enviarOTPWhatsApp(telefono, codigo)
      : await enviarOTPSMS(telefono, codigo);
    await referencia.update({
      infobipMessageId: envio.messageId,
      infobipEstado: envio.estado,
      infobipDescripcion: envio.descripcion,
    });
    return envio;
  } catch (error) {
    await referencia.delete();
    throw error;
  }
}

async function validarOTP({ codigo, telefono, uid = null, proposito }) {
  const snapshot = await db.collection('otpCodes')
    .where('telefono', '==', telefono).get();
  const documentos = snapshot.docs
    .filter((documento) => {
      const data = documento.data();
      return data.proposito === proposito && data.usado === false;
    })
    .sort((a, b) => (b.data().creadoEn?.toMillis?.() || 0) - (a.data().creadoEn?.toMillis?.() || 0));
  if (!documentos.length) throw new Error('Código inválido o expirado.');
  const referencia = documentos[0];
  const otp = referencia.data();
  const expiraEn = otp.expiraEn?.toDate ? otp.expiraEn.toDate() : new Date(otp.expiraEn);
  if ((uid && otp.uid !== uid) || otp.intentos >= OTP_MAX_ATTEMPTS || expiraEn < new Date()) throw new Error('Código inválido o expirado.');
    if (hashOTP(codigo) !== otp.codigoHash) {
    await referencia.ref.update({ intentos: FieldValue.increment(1) });
    throw new Error('Código inválido o expirado.');
  }
  await referencia.ref.update({ usado: true, verificadoEn: FieldValue.serverTimestamp() });
}

// ============================================================
// ADMIN
// ============================================================

const requireAdmin = (req, res, next) => {
  if (req.user.rol !== 'administrador') {
    return res.status(403).json({
      ok: false,
      error:
        'Acceso restringido únicamente a administradores.'
    });
  }

  if (req.user.estado !== 'activo') {
    return res.status(403).json({
      ok: false,
      error:
        'El administrador aún no ha habilitado su cuenta para el sistema.'
    });
  }

  next();
};

// ============================================================
// SLUG
// ============================================================

function crearSlug(texto) {
  return (texto || 'recurso')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ============================================================
// EXTRAER TEXTO PDF
// ============================================================

function extraerTextoPDF(buffer) {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser(null, 1);

    pdfParser.on(
      'pdfParser_dataError',
      (errData) => {
        reject(errData.parserError);
      }
    );

    pdfParser.on(
      'pdfParser_dataReady',
      () => {
        try {
          const textoBruto =
            pdfParser.getRawTextContent();

          try {
            const textoDecodificado =
              decodeURIComponent(textoBruto);

            resolve(textoDecodificado);
          } catch {
            resolve(textoBruto);
          }
        } catch (error) {
          reject(error);
        }
      }
    );

    pdfParser.parseBuffer(buffer);
  });
}

function decodificarEntidadesXML(texto) {
  return texto
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, codigo) => String.fromCharCode(Number(codigo)))
    .replace(/\s+/g, ' ').trim();
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

async function extraerTextoArchivo(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const buffer = await fs.promises.readFile(file.path);
  if (extension === '.pdf') return extraerTextoPDF(buffer);
  if (['.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm', '.log'].includes(extension)) {
    return buffer.toString('utf8');
  }
  if (['.docx', '.xlsx', '.pptx', '.vsdx'].includes(extension)) {
    const zip = leerZipOffice(buffer);
    let partes = [];
    if (extension === '.docx') {
      partes = ['word/document.xml', ...[...zip.keys()].filter((nombre) => /^word\/(header|footer)\d+\.xml$/.test(nombre))];
    } else if (extension === '.xlsx') {
      partes = [...zip.keys()].filter((nombre) => nombre === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(nombre));
    } else if (extension === '.vsdx') {
      partes = [...zip.keys()].filter((nombre) => /^visio\/pages\/page\d+\.xml$/.test(nombre) || nombre === 'visio/document.xml');
    } else {
      partes = [...zip.keys()].filter((nombre) => /^ppt\/slides\/slide\d+\.xml$/.test(nombre));
    }
    return partes
      .map((nombre) => zip.get(nombre)?.toString('utf8') || '')
      .map(decodificarEntidadesXML)
      .filter(Boolean)
      .join('\n');
  }
  // El archivo queda disponible para descarga aunque su formato no permita
  // extraer texto automáticamente (por ejemplo imágenes, ZIP o ejecutables).
  return '';
}

// ============================================================
// MULTER
// ============================================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const { nombre, version } = req.body;

    const nombreSlug =
      crearSlug(nombre);

    const esPdf =
      file.mimetype === 'application/pdf' ||
      file.originalname
        .toLowerCase()
        .endsWith('.pdf');

    const versionSlug =
      (esPdf && !version ? 'manual' : version || 'v1.0')
        .toLowerCase()
        .replace(/\s+/g, '');

    const tipoCarpeta =
      esPdf
        ? 'manuals'
        : 'software';

    const folderPath =
      esPdf && !version
        ? path.join(
            __dirname,
            '../storage',
            tipoCarpeta,
            nombreSlug
          )
        : path.join(
            __dirname,
            '../storage',
            tipoCarpeta,
            nombreSlug,
            versionSlug
          );

    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(
        folderPath,
        {
          recursive: true
        }
      );
    }

    cb(null, folderPath);
  },

  filename: (req, file, cb) => {
    cb(
      null,
      file.originalname
    );
  }
});

const upload =
  multer({
    storage
  });

const uploadUnificado =
  upload.fields([
    {
      name: 'zip',
      maxCount: 1
    },
    {
      name: 'pdf',
      maxCount: 1
    }
  ]);

// Los archivos colaborativos se guardan con un nombre generado por el servidor.
// Así evitamos sobrescribir archivos de otros usuarios y no dependemos de la
// extensión para aceptar el archivo.
const storageArchivos = multer.diskStorage({
  destination: (req, file, cb) => {
    const folderPath = path.join(__dirname, '../storage', 'archivos', req.user.uid);
    fs.mkdirSync(folderPath, { recursive: true });
    cb(null, folderPath);
  },
  filename: (req, file, cb) => {
    const nombreSeguro = path.basename(file.originalname || 'archivo')
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${crypto.randomUUID()}-${nombreSeguro || 'archivo'}`);
  },
});

const uploadArchivo = multer({
  storage: storageArchivos,
  limits: { fileSize: 50 * 1024 * 1024 },
});

async function eliminarArchivoYCarpetasVacias(rutaArchivo, raizPermitida) {
  const raiz = path.resolve(raizPermitida);
  const ruta = path.resolve(rutaArchivo);
  if (!ruta.startsWith(`${raiz}${path.sep}`)) return;
  if (fs.existsSync(ruta)) await fs.promises.unlink(ruta);

  // Solo subimos hasta la raíz específica del tipo de archivo; nunca se borra
  // la carpeta raíz de almacenamiento, y rmdir solo elimina directorios vacíos.
  let carpeta = path.dirname(ruta);
  while (carpeta.startsWith(`${raiz}${path.sep}`) && carpeta !== raiz) {
    try {
      await fs.promises.rmdir(carpeta);
    } catch (error) {
      if (error.code === 'ENOTEMPTY' || error.code === 'ENOENT') break;
      throw error;
    }
    carpeta = path.dirname(carpeta);
  }
}

// ============================================================
// DIVIDIR TEXTO
// ============================================================

function dividirTextoEnBloques(
  texto,
  tamanioBloque = 800
) {
  const lineas =
    texto
      .replace(/\r\n/g, '\n')
      .split('\n');

  const bloques = [];

  let bloqueActual = '';

  for (const linea of lineas) {
    const lineaLimpia =
      linea.trim();

    if (!lineaLimpia) {
      continue;
    }

    const candidato =
      bloqueActual
        ? `${bloqueActual}\n${lineaLimpia}`
        : lineaLimpia;

    if (
      candidato.length >
      tamanioBloque
    ) {
      if (
        bloqueActual.trim()
      ) {
        bloques.push(
          bloqueActual.trim()
        );
      }

      bloqueActual =
        lineaLimpia;
    } else {
      bloqueActual =
        candidato;
    }
  }

  if (
    bloqueActual.trim()
  ) {
    bloques.push(
      bloqueActual.trim()
    );
  }

  return bloques.filter(
    (bloque) =>
      bloque.length >= 20
  );
}

// ============================================================
// GEMINI EMBEDDING
// ============================================================

function esClaveOpenAI(clave) {
  return /^sk-/.test(String(clave || '').trim());
}

function obtenerClavesGemini() {
  return [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_FALLBACK]
    .filter(Boolean)
    .filter((clave) => !esClaveOpenAI(clave));
}

async function generarEmbedding(texto) {
  if (!texto || !texto.trim()) {
    throw new Error(
      'No se puede generar un embedding de un texto vacío.'
    );
  }

  const claves = obtenerClavesGemini();
  if (!claves.length) throw new Error('GEMINI_API_KEY no está configurada.');

  let ultimoError = null;

  for (const clave of claves) {
    const url =
      `https://generativelanguage.googleapis.com/v1/models/` +
      `gemini-embedding-001:embedContent?key=${clave}`;

    try {
      const response = await fetch(url, {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
        },

        body: JSON.stringify({
          content: {
            parts: [
              {
                text: texto,
              },
            ],
          },
        }),
      });

      if (!response.ok) {
        const errorTexto = await response.text();
        ultimoError = new Error(`Error generando embedding (${response.status}): ${errorTexto}`);
        console.error(`[GEMINI] Clave de embedding falló con HTTP ${response.status}; probando respaldo.`);
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

  throw ultimoError || new Error('No fue posible generar embeddings con las claves configuradas.');
}

// ============================================================
// CONCURRENCIA CONTROLADA
// ============================================================

async function procesarConcurrencia(
  elementos,
  limite,
  funcion
) {
  const resultados =
    new Array(
      elementos.length
    );

  let indice = 0;

  async function trabajador() {
    while (true) {
      const posicion =
        indice++;

      if (
        posicion >=
        elementos.length
      ) {
        return;
      }

      try {
        resultados[posicion] =
          await funcion(
            elementos[posicion],
            posicion
          );
      } catch (error) {
        resultados[posicion] = {
          error:
            error.message
        };
      }
    }
  }

  const trabajadores =
    Math.min(
      Math.max(
        1,
        limite
      ),
      elementos.length
    );

  await Promise.all(
    Array.from(
      {
        length:
          trabajadores
      },
      () =>
        trabajador()
    )
  );

  return resultados;
}

// ============================================================
// DORMIR
// ============================================================

function dormir(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}

// ============================================================
// STREAMING COMPATIBLE CON OPENAI (BASE GENÉRICA)
// ============================================================

const SYSTEM_PROMPT = 'Eres el Asistente Virtual Oficial de North Services. ' +
  'Respondes de manera profesional, clara, concisa y ' +
  'en texto plano, sin Markdown, sin asteriscos, sin negritas y sin encabezados.';

async function generarContenidoCompat(
  prompt,
  enviarEvento,
  { nombre, baseUrl, apiKey, modelo }
) {
  if (!baseUrl) {
    throw new Error(`${nombre}: URL base no configurada.`);
  }

  const REQUEST_TIMEOUT = 30000;

  const controller =
    new AbortController();

  const timeout =
    setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  const headers = {
    'Content-Type': 'application/json'
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let respuesta;
  const inicio = Date.now();

  try {
    respuesta = await fetch(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: modelo,
          stream: true,
          max_tokens: 256,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt }
          ]
        })
      }
    );

    console.log(`[CHAT] ${nombre} HTTP: ${Date.now() - inicio} ms`);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`${nombre} tardó demasiado en responder.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!respuesta.ok) {
    const texto = await respuesta.text().catch(() => '');
    throw new Error(`${nombre} respondió HTTP ${respuesta.status}: ${texto}`);
  }

  if (!respuesta.body) {
    throw new Error(`${nombre} no devolvió un stream de respuesta.`);
  }

  const reader = respuesta.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let respuestaCompleta = '';
  let primerTokenMs = null;

  const procesarEvento = (evento) => {
    for (const linea of evento.split(/\r?\n/)) {
      if (!linea.startsWith('data:')) continue;
      const contenido = linea.substring(5).trim();
      if (!contenido || contenido === '[DONE]') continue;
      try {
        const delta = JSON.parse(contenido)?.choices?.[0]?.delta?.content;
        if (typeof delta !== 'string' || !delta) continue;
        if (primerTokenMs === null) primerTokenMs = Date.now();
        respuestaCompleta += delta;
        enviarEvento({ tipo: 'texto', texto: delta });
      } catch {
        // fragmento inválido
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const eventos = buffer.split(/\r?\n\r?\n/);
    buffer = eventos.pop() || '';
    for (const ev of eventos) if (ev.trim()) procesarEvento(ev);
  }

  buffer += decoder.decode();
  if (buffer.trim()) procesarEvento(buffer);

  return { respuestaCompleta, primerTokenMs };
}

// ============================================================
// OLLAMA LOCAL (RESPALDO GRATUITO)
// ============================================================

async function generarContenidoOllama(prompt, enviarEvento) {
  return generarContenidoCompat(prompt, enviarEvento, {
    nombre: 'Ollama',
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
    apiKey: process.env.OLLAMA_API_KEY || '',
    modelo: process.env.OLLAMA_MODEL || 'llama3.1'
  });
}

// ============================================================
// GEMINI STREAMING
// ============================================================

async function generarContenidoGemini(
  prompt,
  enviarEvento
) {
  const clavesGemini =
    obtenerClavesGemini();

  if (!clavesGemini.length) {
    throw new Error(
      'GEMINI_API_KEY no está configurada.'
    );
  }

  const modelo =
    'gemini-3.5-flash';

  // ==========================================================
  // CONFIGURACI�"N
  // ==========================================================

  const REQUEST_TIMEOUT = 90000;

  const generationConfig = {
    maxOutputTokens: 2048,

    thinkingConfig: {
      thinkingLevel: 'minimal'
    }
  };

  // ==========================================================
  // ABORT CONTROLLER
  // ==========================================================

  const controller =
    new AbortController();

  const timeout =
    setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT);

  let respuestaGemini;

  try {
    // ========================================================
    // PETICIÓN A GEMINI (con respaldo de clave)
    // ========================================================

    console.log(
      `[CHAT] Gemini: enviando petición...`
    );

    let indiceClave = -1;

    while (
      !respuestaGemini?.ok &&
      indiceClave < clavesGemini.length - 1
    ) {
      indiceClave += 1;

      const apiKey =
        clavesGemini[indiceClave];

      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${modelo}:streamGenerateContent?alt=sse&key=${apiKey}`;

      const inicioFetchGemini =
        Date.now();

      try {
        respuestaGemini =
          await fetch(
            url,
            {
              method: 'POST',

              headers: {
                'Content-Type':
                  'application/json',

                Accept:
                  'text/event-stream'
              },

              signal:
                controller.signal,

              body: JSON.stringify({
                contents: [
                  {
                    role: 'user',

                    parts: [
                      {
                        text: prompt
                      }
                    ]
                  }
                ],

                generationConfig
              })
            }
          );
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        respuestaGemini = null;
        console.error(
          `[GEMINI] Intento ${indiceClave + 1} falló en la red: ${error.message}`
        );
        continue;
      }

      const tiempoHttpGemini =
        Date.now() -
        inicioFetchGemini;

      console.log(
        `[CHAT] Gemini HTTP: ${tiempoHttpGemini} ms`
      );

      // ======================================================
      // ERROR GEMINI
      // ======================================================

      if (!respuestaGemini.ok) {
        const errorTexto =
          await respuestaGemini.text();

        console.error(
          `[GEMINI ERROR] HTTP ${respuestaGemini.status} con intento ${indiceClave + 1}`
        );

        console.error(
          `[GEMINI ERROR] ${errorTexto}`
        );
      }
    }

    if (!respuestaGemini.ok) {
      const errorTexto =
        await respuestaGemini.text().catch(() => '');

      throw new Error(
        `Gemini respondió HTTP ${respuestaGemini.status}: ${errorTexto}`
      );
    }

  } catch (error) {

    if (
      error.name ===
      'AbortError'
    ) {
      console.error(
        `[GEMINI] Timeout después de ${REQUEST_TIMEOUT} ms`
      );

      throw new Error(
        'Gemini tardó demasiado en responder.'
      );
    }

    throw error;

  } finally {
    clearTimeout(timeout);
  }

  // ==========================================================
  // VALIDAR STREAM
  // ==========================================================

  if (
    !respuestaGemini.body
  ) {
    throw new Error(
      'Gemini no devolvió un stream de respuesta.'
    );
  }

  // ==========================================================
  // LEER STREAM
  // ==========================================================

  const reader =
    respuestaGemini.body
      .getReader();

  const decoder =
    new TextDecoder(
      'utf-8'
    );

  let buffer = '';

  let respuestaCompleta =
    '';

  let primerTokenMs =
    null;

  const inicioLectura =
    Date.now();

  // ==========================================================
  // PROCESAR EVENTO SSE
  // ==========================================================

  const procesarEvento =
    (evento) => {

      const lineas =
        evento.split(
          /\r?\n/
        );

      for (
        const linea of lineas
      ) {

        if (
          !linea.startsWith(
            'data:'
          )
        ) {
          continue;
        }

        const jsonTexto =
          linea
            .substring(5)
            .trim();

        if (
          !jsonTexto
        ) {
          continue;
        }

        try {

          const chunk =
            JSON.parse(
              jsonTexto
            );

          const partes =
            chunk
              ?.candidates?.[0]
              ?.content?.parts;

          if (
            !Array.isArray(
              partes
            )
          ) {
            continue;
          }

          for (
            const parte of partes
          ) {

            // ==================================================
            // IMPORTANTE:
            // Gemini puede devolver partes que no sean texto.
            // ==================================================

            if (
              !parte ||
              typeof parte.text !==
                'string'
            ) {
              continue;
            }

            const texto =
              parte.text;

            if (
              !texto
            ) {
              continue;
            }

            // ==================================================
            // PRIMER TOKEN
            // ==================================================

            if (
              primerTokenMs ===
              null
            ) {

              primerTokenMs =
                Date.now();

              console.log(
                `[CHAT] Primer token recibido en ` +
                `${primerTokenMs - inicioLectura} ms`
              );
            }

            respuestaCompleta +=
              texto;

            enviarEvento({
              tipo:
                'texto',

              texto
            });
          }

        } catch (error) {

          console.warn(
            '[CHAT] Chunk Gemini inválido:',
            error.message
          );
        }
      }
    };

  // ==========================================================
  // CONSUMIR STREAM
  // ==========================================================

  while (true) {

    const {
      value,
      done
    } =
      await reader.read();

    if (
      done
    ) {
      break;
    }

    buffer +=
      decoder.decode(
        value,
        {
          stream: true
        }
      );

    const eventos =
      buffer.split(
        /\r?\n\r?\n/
      );

    buffer =
      eventos.pop() || '';

    for (
      const evento of eventos
    ) {

      procesarEvento(
        evento
      );
    }
  }

  // ==========================================================
  // PROCESAR ÚLTIMO BLOQUE
  // ==========================================================

  buffer +=
    decoder.decode();

  if (
    buffer.trim()
  ) {
    procesarEvento(
      buffer
    );
  }

  // ==========================================================
  // VALIDAR RESPUESTA
  // ==========================================================

  if (
    !respuestaCompleta.trim()
  ) {
    console.warn(
      '[CHAT] Gemini terminó sin devolver texto.'
    );
  }

  return {
    respuestaCompleta,

    primerTokenMs
  };
}

// ============================================================
// PERFIL
// ============================================================

app.get(
  '/api/perfil',
  verifyToken,
  (req, res) => {
    if (req.user.estado !== 'activo') {
      return res.status(403).json({
        ok: false,
        error: req.user.estado === 'pendiente'
          ? 'El administrador aún no ha habilitado su cuenta para el sistema.'
          : 'Su cuenta no se encuentra activa en el sistema. Contacte al administrador.',
        estado: req.user.estado
      });
    }

    res.json({
      ok: true,
      usuario: req.user
    });
  }
);

// ============================================================
// OTP, PERFIL Y RECUPERACIÓN DE CONTRASEÑA
// ============================================================

app.post('/api/otp/solicitar', verifyToken, async (req, res) => {
  try {
    const telefono = OTP_DESTINATION;
    const canal = req.body.canal === 'whatsapp' ? 'whatsapp' : 'sms';
    if (!/^\+\d{8,15}$/.test(telefono)) return res.status(400).json({ ok: false, error: 'Ingresa un número con código de país, por ejemplo +51987654321.' });
    await crearOTP({ uid: req.user.uid, telefono, canal, proposito: 'verificar-whatsapp' });
    res.json({ ok: true, mensaje: `Código enviado por ${canal === 'whatsapp' ? 'WhatsApp' : 'SMS'}.` });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/otp/verificar', verifyToken, async (req, res) => {
  try {
    const telefonoUsuario = normalizarTelefono(req.body.telefono);
    if (!/^\+\d{8,15}$/.test(telefonoUsuario)) return res.status(400).json({ ok: false, error: 'Ingresa un número válido con código de país.' });
    await validarOTP({ uid: req.user.uid, telefono: OTP_DESTINATION, codigo: String(req.body.codigo || ''), proposito: 'verificar-whatsapp' });
    await db.collection('users').doc(req.user.uid).update({ whatsapp: telefonoUsuario, whatsappVerificado: true, whatsappVerificadoEn: FieldValue.serverTimestamp() });
    res.json({ ok: true, mensaje: 'Número verificado para SMS.' });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.put('/api/perfil', verifyToken, async (req, res) => {
  try {
    const nombre = String(req.body.nombre || '').trim();
    const apellido = String(req.body.apellido || '').trim();
    if (!nombre || !apellido) return res.status(400).json({ ok: false, error: 'Nombre y apellido son obligatorios.' });
    const email = `${nombre.toLowerCase()}.${apellido.toLowerCase()}@northservices.com.pe`;
    await authAdmin.updateUser(req.user.uid, { displayName: `${nombre} ${apellido}`, email });
    await db.collection('users').doc(req.user.uid).update({ nombre, apellido, email });
    res.json({ ok: true, usuario: { ...req.user, nombre, apellido, email } });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.code === 'auth/email-already-exists' ? 'El correo generado ya está registrado.' : error.message });
  }
});

app.post('/api/password/solicitar', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const canal = String(req.body.canal || 'sms').trim().toLowerCase();
    const snapshot = await db.collection('users').where('email', '==', email).limit(1).get();
    if (snapshot.empty) return res.status(400).json({ ok: false, error: 'No existe una cuenta con ese correo.' });
    await crearOTP({ uid: snapshot.docs[0].id, telefono: OTP_DESTINATION, email, proposito: 'restablecer-password', canal });
    res.json({ ok: true, mensaje: canal === 'correo' ? 'Código enviado a tu correo corporativo.' : 'Código enviado por SMS.' });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/password/restablecer', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const snapshot = await db.collection('users').where('email', '==', email).limit(1).get();
    if (snapshot.empty) throw new Error('Cuenta no encontrada.');
    const nuevaPassword = String(req.body.nuevaPassword || '');
    if (nuevaPassword.length < 6) return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 6 caracteres.' });
    const usuario = snapshot.docs[0].data();
    await validarOTP({ uid: snapshot.docs[0].id, telefono: OTP_DESTINATION, codigo: String(req.body.codigo || ''), proposito: 'restablecer-password' });
    await authAdmin.updateUser(snapshot.docs[0].id, { password: nuevaPassword });
    res.json({ ok: true, mensaje: 'Contraseña actualizada correctamente.' });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.put('/api/password/cambiar', verifyToken, async (req, res) => {
  try {
    const nuevaPassword = String(req.body.nuevaPassword || '');
    if (nuevaPassword.length < 6) return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 6 caracteres.' });
    await authAdmin.updateUser(req.user.uid, { password: nuevaPassword });
    res.json({ ok: true, mensaje: 'Contraseña actualizada correctamente.' });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

// ============================================================
// SUBIDA UNIFICADA
// ============================================================

app.post(
  '/api/admin/upload-recurso-unificado',
  verifyToken,
  requireAdmin,
  uploadUnificado,
  async (req, res) => {
    try {
      const {
        nombre,
        descripcion,
        version
      } = req.body;

      const archivos =
        req.files || {};

      // --------------------------------------------------------
      // VALIDACIONES
      // --------------------------------------------------------

      if (
        !nombre ||
        !nombre.trim()
      ) {
        return res.status(400).json({
          ok: false,
          error:
            'El nombre del recurso es requerido.'
        });
      }

      if (
        !archivos.zip &&
        !archivos.pdf
      ) {
        return res.status(400).json({
          ok: false,
          error:
            'Debe adjuntar un archivo PDF o un instalador de software.'
        });
      }

      const nombreSlug =
        crearSlug(
          nombre
        );

      const soloManual =
        Boolean(
          archivos.pdf &&
          archivos.pdf[0] &&
          !archivos.zip
        );

      const versionSlug =
        (
          soloManual
            ? 'manual'
            : version || 'v1.0'
        )
          .toLowerCase()
          .replace(
            /\s+/g,
            ''
          );

      const descripcionFinal =
        descripcion && descripcion.trim()
          ? descripcion.trim()
          : `Manual técnico de ${nombre.trim()}`;

      // Un solo documento de Firestore representa el recurso completo, aunque
      // tenga instalador y manual. Así se muestran y descargan juntos.
      const recursoRef = await db.collection('recursos').add({
        nombre: nombre.trim(),
        descripcion: descripcionFinal,
        version: version || 'v1.0',
        activo: true,
        software: null,
        manual: null,
        fechaPublicacion: new Date(),
      });

      // ========================================================
      // SOFTWARE
      // ========================================================

      if (
        archivos.zip &&
        archivos.zip[0]
      ) {
        const fileZip =
          archivos.zip[0];

        const rutaRelativa =
          path.join(
            'storage',
            'software',
            nombreSlug,
            versionSlug,
            fileZip.filename
          );

        await recursoRef.update({
          software: {
            nombreArchivo: fileZip.filename,
            rutaLocal: rutaRelativa,
          },
        });
      }

      // ========================================================
      // MANUAL PDF
      // ========================================================

      if (
        archivos.pdf &&
        archivos.pdf[0]
      ) {
        const filePdf =
          archivos.pdf[0];

        const rutaRelativa =
          soloManual
            ? path.join(
                'storage',
                'manuals',
                nombreSlug,
                filePdf.filename
              )
            : path.join(
                'storage',
                'manuals',
                nombreSlug,
                versionSlug,
                filePdf.filename
              );

        await recursoRef.update({
          manual: {
            nombreArchivo: filePdf.filename,
            rutaLocal: rutaRelativa,
          },
        });

        // ------------------------------------------------------
        // EXTRAER PDF
        // ------------------------------------------------------

        console.log(
          `[RAG] Extrayendo PDF: ${filePdf.filename}`
        );

        const buffer =
          await fs.promises.readFile(
            filePdf.path
          );

        const textoExtraido =
          await extraerTextoPDF(
            buffer
          );

        if (
          !textoExtraido ||
          !textoExtraido.trim()
        ) {
          throw new Error(
            'No se pudo extraer texto del PDF.'
          );
        }

        // ------------------------------------------------------
        // CHUNKS
        // ------------------------------------------------------

        const bloques =
          dividirTextoEnBloques(
            textoExtraido,
            800
          );

        console.log(
          `[RAG] Bloques encontrados: ${bloques.length}`
        );

        if (
          bloques.length === 0
        ) {
          throw new Error(
            'El PDF no contiene suficiente texto para indexarlo.'
          );
        }

        // ------------------------------------------------------
        // MONGODB
        // ------------------------------------------------------

        const mongoDb =
          getDB();

        const coleccionVectores =
          mongoDb.collection(
            'conocimientos_vectores'
          );

        const inicioIndexacion =
          Date.now();

        // ------------------------------------------------------
        // EMBEDDINGS EN PARALELO
        // ------------------------------------------------------

        const resultados =
          await procesarConcurrencia(
            bloques,
            EMBEDDING_CONCURRENCY,
            async (
              fragmento,
              indice
            ) => {
              console.log(
                `[RAG] Embedding ${indice + 1}/${bloques.length}`
              );

              const vector =
                await generarEmbedding(
                  fragmento
                );

              return {
                recursoId:
                  recursoRef.id,

                nombreManual:
                  nombre,

                titulo_seccion:
                  `${nombre} (Parte ${indice + 1})`,

                contenido_texto:
                  fragmento,

                embedding:
                  vector,

                fechaIndexacion:
                  new Date()
              };
            }
          );

        // ------------------------------------------------------
        // SEPARAR RESULTADOS
        // ------------------------------------------------------

        const documentosValidos =
          resultados.filter(
            (resultado) =>
              resultado &&
              !resultado.error &&
              Array.isArray(
                resultado.embedding
              )
          );

        const errores =
          resultados.filter(
            (resultado) =>
              resultado &&
              resultado.error
          );

        console.log(
          `[RAG] Embeddings correctos: ${documentosValidos.length}`
        );

        console.log(
          `[RAG] Embeddings con error: ${errores.length}`
        );

        // ------------------------------------------------------
        // INSERTAR TODOS LOS VECTORES
        // ------------------------------------------------------

        if (
          documentosValidos.length >
          0
        ) {
          await coleccionVectores.insertMany(
            documentosValidos,
            {
              ordered: false
            }
          );
        }

        const tiempoIndexacion =
          Date.now() -
          inicioIndexacion;

        console.log(
          `[RAG] Indexación completada en ${tiempoIndexacion} ms`
        );

        if (
          documentosValidos.length ===
          0
        ) {
          throw new Error(
            'No se pudo generar ningún embedding para el PDF.'
          );
        }
      }

      // ========================================================
      // RESPUESTA
      // ========================================================

      res.json({
        ok: true,

        mensaje:
          'Recurso publicado e indexado correctamente en la IA.',

        idRecurso: recursoRef.id
      });
    } catch (error) {
      console.error(
        'Error en carga unificada:',
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// RECURSOS UNIFICADOS
// ============================================================

app.get('/api/recursos', verifyToken, async (req, res) => {
  try {
    if (req.user.estado !== 'activo') return res.status(403).json({ ok: false, error: 'Cuenta pendiente de aprobación.' });
    const snapshot = await db.collection('recursos').where('activo', '==', true).get();
    res.json({ ok: true, recursos: snapshot.docs.map((documento) => ({ id: documento.id, ...documento.data() })) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

async function descargarRecursoUnificado(req, res) {
  try {
    if (req.user.estado !== 'activo') return res.status(403).json({ ok: false, error: 'Cuenta pendiente de aprobación.' });
    const documento = await db.collection('recursos').doc(req.params.id).get();
    if (!documento.exists || documento.data().activo !== true) return res.status(404).json({ ok: false, error: 'Recurso no encontrado.' });
    const archivo = req.params.tipo === 'manual' ? documento.data().manual : documento.data().software;
    if (!archivo?.rutaLocal) return res.status(404).json({ ok: false, error: 'Esta descarga no está disponible para el recurso.' });
    const rutaArchivo = path.resolve(__dirname, '..', archivo.rutaLocal);
    const raiz = path.resolve(__dirname, '../storage');
    if (!rutaArchivo.startsWith(`${raiz}${path.sep}`) || !fs.existsSync(rutaArchivo)) return res.status(404).json({ ok: false, error: 'El archivo no existe en el servidor.' });
    res.download(rutaArchivo, archivo.nombreArchivo);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}

app.get('/api/recursos/:id/software/download', verifyToken, (req, res) => {
  req.params.tipo = 'software';
  return descargarRecursoUnificado(req, res);
});
app.get('/api/recursos/:id/manual/download', verifyToken, (req, res) => {
  req.params.tipo = 'manual';
  return descargarRecursoUnificado(req, res);
});

app.delete('/api/admin/recursos/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const referencia = db.collection('recursos').doc(req.params.id);
    const documento = await referencia.get();
    if (!documento.exists) return res.status(404).json({ ok: false, error: 'Recurso no encontrado.' });
    const recurso = documento.data();
    await getDB().collection('conocimientos_vectores').deleteMany({ recursoId: req.params.id });
    const raiz = path.resolve(__dirname, '../storage');
    for (const archivo of [recurso.software, recurso.manual]) {
      if (!archivo?.rutaLocal) continue;
      const rutaArchivo = path.resolve(__dirname, '..', archivo.rutaLocal);
      await eliminarArchivoYCarpetasVacias(rutaArchivo, raiz);
    }
    await referencia.delete();
    res.json({ ok: true, mensaje: 'Recurso, descargas y vectores de MongoDB eliminados.' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================
// SOFTWARE LEGADO
// ============================================================

app.get(
  '/api/software',
  verifyToken,
  async (req, res) => {
    try {
      if (
        req.user.estado !==
        'activo'
      ) {
        return res.status(403).json({
          ok: false,
          error:
            'El administrador aún no ha habilitado su cuenta para el sistema.'
        });
      }

      const snapshot =
        await db
          .collection(
            'software'
          )
          .where(
            'activo',
            '==',
            true
          )
          .get();

      const catalogo =
        [];

      snapshot.forEach(
        (doc) => {
          const item =
            doc.data();

          catalogo.push({
            id:
              doc.id,

            nombre:
              item.nombre,

            descripcion:
              item.descripcion,

            version:
              item.version,

            fechaPublicacion:
              item.fechaPublicacion
          });
        }
      );

      res.json({
        ok: true,
        catalogo
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// DESCARGAR SOFTWARE
// ============================================================

app.get(
  '/api/software/:id/download',
  verifyToken,
  async (req, res) => {
    try {
      const {
        id
      } = req.params;

      if (
        req.user.estado !==
        'activo'
      ) {
        return res.status(403).json({
          ok: false,
          error:
            'Cuenta pendiente de aprobación.'
        });
      }

      const doc =
        await db
          .collection(
            'software'
          )
          .doc(id)
          .get();

      if (
        !doc.exists
      ) {
        return res.status(404).json({
          ok: false,
          error:
            'Software no encontrado'
        });
      }

      const item =
        doc.data();

      const absolutePath =
        path.join(
          __dirname,
          '..',
          item.rutaLocal
        );

      if (
        !fs.existsSync(
          absolutePath
        )
      ) {
        return res.status(404).json({
          ok: false,
          error:
            'El archivo no existe en el servidor'
        });
      }

      res.download(
        absolutePath,
        item.nombreArchivo
      );
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// MANUALES
// ============================================================

app.get(
  '/api/manuales',
  verifyToken,
  async (req, res) => {
    try {
      if (
        req.user.estado !==
        'activo'
      ) {
        return res.status(403).json({
          ok: false,
          error:
            'El administrador aún no ha habilitado su cuenta para el sistema.'
        });
      }

      const snapshot =
        await db
          .collection(
            'manuales'
          )
          .where(
            'activo',
            '==',
            true
          )
          .get();

      const catalogo =
        [];

      snapshot.forEach(
        (doc) => {
          const item =
            doc.data();

          catalogo.push({
            id:
              doc.id,

            nombre:
              item.nombre,

            descripcion:
              item.descripcion,

            version:
              item.version
          });
        }
      );

      res.json({
        ok: true,
        catalogo
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// DESCARGAR MANUAL
// ============================================================

app.get(
  '/api/manuales/:id/download',
  verifyToken,
  async (req, res) => {
    try {
      const {
        id
      } = req.params;

      if (
        req.user.estado !==
        'activo'
      ) {
        return res.status(403).json({
          ok: false,
          error:
            'Cuenta pendiente de aprobación.'
        });
      }

      const doc =
        await db
          .collection(
            'manuales'
          )
          .doc(id)
          .get();

      if (
        !doc.exists
      ) {
        return res.status(404).json({
          ok: false,
          error:
            'Manual no encontrado'
        });
      }

      const item =
        doc.data();

      const absolutePath =
        path.join(
          __dirname,
          '..',
          item.rutaLocal
        );

      if (
        !fs.existsSync(
          absolutePath
        )
      ) {
        return res.status(404).json({
          ok: false,
          error:
            'El archivo PDF no existe en el servidor'
        });
      }

      res.download(
        absolutePath,
        item.nombreArchivo
      );
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// ELIMINACIÓN DE RECURSOS ADMINISTRATIVOS
// ============================================================

async function eliminarRecursoAdministrativo(coleccion, id, { eliminarVectores = false } = {}) {
  const referencia = db.collection(coleccion).doc(id);
  const documento = await referencia.get();
  if (!documento.exists) {
    const error = new Error('Recurso no encontrado.');
    error.status = 404;
    throw error;
  }
  const item = documento.data();
  if (eliminarVectores) await getDB().collection('conocimientos_vectores').deleteMany({ manualId: id });
  const raiz = path.resolve(__dirname, '../storage');
  const rutaArchivo = path.resolve(__dirname, '..', item.rutaLocal || '');
  await eliminarArchivoYCarpetasVacias(rutaArchivo, raiz);
  await referencia.delete();
}

app.delete('/api/admin/software/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await eliminarRecursoAdministrativo('software', req.params.id);
    res.json({ ok: true, mensaje: 'Software eliminado correctamente.' });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message });
  }
});

app.delete('/api/admin/manuales/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await eliminarRecursoAdministrativo('manuales', req.params.id, { eliminarVectores: true });
    res.json({ ok: true, mensaje: 'Manual y sus vectores de MongoDB fueron eliminados.' });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message });
  }
});

// ============================================================
// ARCHIVOS COLABORATIVOS E INDEXACIÓN RAG
// ============================================================

function usuarioActivo(req, res) {
  if (req.user.estado !== 'activo') {
    res.status(403).json({ ok: false, error: 'Cuenta pendiente de aprobación.' });
    return false;
  }
  return true;
}

app.post('/api/archivos', verifyToken, (req, res, next) => {
  if (!usuarioActivo(req, res)) return;
  next();
}, uploadArchivo.single('archivo'), async (req, res) => {
  let referencia = null;
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Debes seleccionar un archivo.' });

    const rutaLocal = path.relative(path.join(__dirname, '..'), req.file.path);
    referencia = await db.collection('archivos').add({
      nombre: String(req.body.nombre || path.parse(req.file.originalname).name).trim(),
      descripcion: String(req.body.descripcion || '').trim(),
      nombreArchivo: req.file.originalname,
      rutaLocal,
      tipoMime: req.file.mimetype || 'application/octet-stream',
      tamano: req.file.size,
      extension: path.extname(req.file.originalname || '').toLowerCase(),
      propietarioUid: req.user.uid,
      propietarioNombre: [req.user.nombre, req.user.apellido].filter(Boolean).join(' ') || req.user.email,
      propietarioEmail: req.user.email,
      activo: true,
      estadoIndexacion: 'pendiente',
      fechaCreacion: new Date(),
    });

    const texto = await extraerTextoArchivo(req.file);
    const bloques = dividirTextoEnBloques(texto, 800);
    if (!bloques.length) {
      await referencia.update({ estadoIndexacion: 'sin_texto', actualizadoEn: new Date() });
      return res.status(201).json({ ok: true, archivo: { id: referencia.id }, mensaje: 'Archivo guardado. Este formato no contiene texto que pueda indexarse automáticamente.' });
    }

    const resultados = await procesarConcurrencia(bloques, EMBEDDING_CONCURRENCY, async (fragmento, indice) => ({
      archivoId: referencia.id,
      nombreArchivo: req.file.originalname,
      nombreManual: String(req.body.nombre || path.parse(req.file.originalname).name).trim(),
      titulo_seccion: `${req.file.originalname} (Parte ${indice + 1})`,
      contenido_texto: fragmento,
      embedding: await generarEmbedding(fragmento),
      fechaIndexacion: new Date(),
    }));
    const vectores = resultados.filter((resultado) => resultado && !resultado.error && Array.isArray(resultado.embedding));
    if (!vectores.length) throw new Error('No se pudo generar embeddings para el contenido del archivo.');
    await getDB().collection('conocimientos_vectores').insertMany(vectores, { ordered: false });
    await referencia.update({ estadoIndexacion: 'completada', fragmentosIndexados: vectores.length, actualizadoEn: new Date() });
    res.status(201).json({ ok: true, archivo: { id: referencia.id }, mensaje: 'Archivo guardado e indexado correctamente para el asistente IA.' });
  } catch (error) {
    console.error('Error al cargar archivo colaborativo:', error);
    if (referencia) await referencia.update({ estadoIndexacion: 'error', errorIndexacion: error.message, actualizadoEn: new Date() }).catch(() => {});
    res.status(500).json({ ok: false, error: error.message || 'No se pudo procesar el archivo.' });
  }
});

app.get('/api/archivos', verifyToken, async (req, res) => {
  try {
    if (!usuarioActivo(req, res)) return;
    const snapshot = await db.collection('archivos').where('activo', '==', true).get();
    const archivos = snapshot.docs
      .map((documento) => ({ id: documento.id, ...documento.data() }))
      .filter((archivo) => archivo.eliminado !== true);
    res.json({ ok: true, archivos });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/archivos/:id/download', verifyToken, async (req, res) => {
  try {
    if (!usuarioActivo(req, res)) return;
    const documento = await db.collection('archivos').doc(req.params.id).get();
    if (!documento.exists || documento.data().activo !== true || documento.data().eliminado === true) return res.status(404).json({ ok: false, error: 'Archivo no encontrado.' });
    const item = documento.data();
    const raizArchivos = path.resolve(__dirname, '../storage/archivos');
    const rutaArchivo = path.resolve(__dirname, '..', item.rutaLocal);
    if (!rutaArchivo.startsWith(`${raizArchivos}${path.sep}`) || !fs.existsSync(rutaArchivo)) return res.status(404).json({ ok: false, error: 'El archivo ya no está disponible en el servidor.' });
    res.download(rutaArchivo, item.nombreArchivo);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

const DIAS_RETENCION_PAPELERA = 30;
const MS_RETENCION_PAPELERA = DIAS_RETENCION_PAPELERA * 24 * 60 * 60 * 1000;

function parseFechaFirestore(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor;
  if (typeof valor.toDate === 'function') {
    const fecha = valor.toDate();
    return Number.isNaN(fecha.getTime()) ? null : fecha;
  }
  if (typeof valor === 'object') {
    const segundos = valor._seconds ?? valor.seconds;
    if (typeof segundos === 'number') return new Date(segundos * 1000);
  }
  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function fechaAISO(valor) {
  const fecha = parseFechaFirestore(valor);
  return fecha ? fecha.toISOString() : null;
}

function nombreUsuarioActual(user) {
  return [user?.nombre, user?.apellido].filter(Boolean).join(' ') || user?.email || 'Usuario';
}

function puedeGestionarArchivo(user, item) {
  return user.rol === 'administrador' || item.propietarioUid === user.uid;
}

async function moverArchivoAPapelera(id, user) {
  const referencia = db.collection('archivos').doc(id);
  const documento = await referencia.get();
  if (!documento.exists) return { id, ok: false, error: 'Archivo no encontrado.' };
  const item = documento.data();
  if (item.eliminado === true) return { id, ok: false, error: 'El archivo ya está en la papelera.' };
  if (!puedeGestionarArchivo(user, item)) return { id, ok: false, error: 'Solo puedes eliminar archivos que tú subiste.' };
  
  // Migrar vectores de RAG a la colección de papelera
  try {
    const mongoDb = getDB();
    const vectores = await mongoDb.collection('conocimientos_vectores').find({ archivoId: id }).toArray();
    
    if (vectores.length > 0) {
      // Insertar en colección de papelera
      await mongoDb.collection('conocimientos_vectores_papelera').insertMany(vectores, { ordered: false });
      // Eliminar de colección activa
      await mongoDb.collection('conocimientos_vectores').deleteMany({ archivoId: id });
      console.log(`[PAPELERA] Migrados ${vectores.length} vectores del archivo ${id} a la colección de papelera`);
    }
  } catch (error) {
    console.error(`[PAPELERA] Error al migrar vectores del archivo ${id}:`, error.message);
    // Continuamos con el proceso aunque falle la migración
  }
  
  await referencia.update({
    eliminado: true,
    eliminadoPor: user.uid,
    eliminadoPorNombre: nombreUsuarioActual(user),
    eliminadoEn: new Date(),
  });
  return { id, ok: true };
}

async function eliminarArchivoPermanentemente(id, data) {
  try {
    await getDB().collection('conocimientos_vectores').deleteMany({ archivoId: id });
  } catch (error) {
    console.error(`[PAPELERA] No se pudieron eliminar vectores de ${id}:`, error.message);
  }
  if (data?.rutaLocal) {
    const raizArchivos = path.resolve(__dirname, '../storage/archivos');
    const rutaArchivo = path.resolve(__dirname, '..', data.rutaLocal);
    await eliminarArchivoYCarpetasVacias(rutaArchivo, raizArchivos);
  }
  await db.collection('archivos').doc(id).delete();
}

async function purgarPapeleraExpirada() {
  const snapshot = await db.collection('archivos').where('eliminado', '==', true).get();
  const ahora = Date.now();
  let purgados = 0;
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const fecha = parseFechaFirestore(data.eliminadoEn);
    if (!fecha || ahora - fecha.getTime() < MS_RETENCION_PAPELERA) continue;
    try {
      await eliminarArchivoPermanentemente(doc.id, data);
      purgados += 1;
    } catch (error) {
      console.error(`[PAPELERA] No se pudo purgar ${doc.id}:`, error.message);
    }
  }
  if (purgados) console.log(`[PAPELERA] Se eliminaron ${purgados} archivo(s) con más de ${DIAS_RETENCION_PAPELERA} días.`);
  return purgados;
}

app.delete('/api/archivos/:id', verifyToken, async (req, res) => {
  try {
    if (!usuarioActivo(req, res)) return;
    const resultado = await moverArchivoAPapelera(req.params.id, req.user);
    if (!resultado.ok) return res.status(resultado.error === 'Archivo no encontrado.' ? 404 : 403).json({ ok: false, error: resultado.error });
    res.json({ ok: true, mensaje: 'Archivo movido a la papelera. El contenido se mantiene disponible para la IA durante 30 días.' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/archivos/lote/eliminar', verifyToken, async (req, res) => {
  try {
    if (!usuarioActivo(req, res)) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ ok: false, error: 'Selecciona al menos un archivo.' });
    const resultados = [];
    for (const id of ids) resultados.push(await moverArchivoAPapelera(id, req.user));
    const procesados = resultados.filter((item) => item.ok).length;
    const fallidos = resultados.filter((item) => !item.ok);
    res.json({
      ok: true,
      procesados,
      fallidos,
      mensaje: procesados
        ? `${procesados} archivo${procesados === 1 ? '' : 's'} enviado${procesados === 1 ? '' : 's'} a la papelera. El contenido no estará disponible para la IA.`
        : 'No se pudo enviar ningún archivo a la papelera.',
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================
// ECLIPSE TOUCH - ENLACES COMPARTIDOS
// Cualquier usuario activo publica un enlace indicando el pozo,
// el lote y la URL. Puede haber varios enlaces y cada usuario
// edita o elimina el suyo; los administradores pueden con todos.
// ============================================================

function validarUrl(texto) {
  const valor = String(texto || '').replace(/[\u0000-\u0020\u007F-\u00A0\u2000-\u200F\u2028\u2029\u202F\u205F\u3000\uFEFF]+/g, '').trim();
  try {
    const url = new URL(valor);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch (error) {
    console.log(`[validarUrl] rechazada: ${JSON.stringify(valor)} (original: ${JSON.stringify(String(texto || ''))})`);
    return '';
  }
}

app.get('/api/monitoreo', verifyToken, async (req, res) => {
  try {
    if (!usuarioActivo(req, res)) return;
    const snapshot = await db.collection('monitoreoPozos').orderBy('fechaCreacion', 'desc').get();
    const enlaces = snapshot.docs.map((documento) => ({ id: documento.id, ...documento.data() }));
    res.json({ ok: true, enlaces });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/monitoreo', verifyToken, async (req, res) => {
  try {
    if (!usuarioActivo(req, res)) return;
    const nombrePozo = String(req.body.nombrePozo || '').trim();
    const lote = String(req.body.lote || '').trim();
    const descripcion = String(req.body.descripcion || '').trim();
    const link = validarUrl(req.body.link);
    if (!nombrePozo) return res.status(400).json({ ok: false, error: 'El nombre del pozo es obligatorio.' });
    if (!lote) return res.status(400).json({ ok: false, error: 'El lote es obligatorio.' });
    if (!link) return res.status(400).json({ ok: false, error: 'Ingresa un enlace válido que empiece con http:// o https://.' });
    const referencia = await db.collection('monitoreoPozos').add({
      nombrePozo,
      lote,
      descripcion,
      link,
      propietarioUid: req.user.uid,
      propietarioNombre: [req.user.nombre, req.user.apellido].filter(Boolean).join(' ') || req.user.email,
      propietarioEmail: req.user.email,
      activo: true,
      fechaCreacion: new Date(),
      actualizadoEn: new Date(),
    });
    res.status(201).json({ ok: true, enlace: { id: referencia.id, nombrePozo, lote, descripcion, link } });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.put('/api/monitoreo/:id', verifyToken, async (req, res) => {
  try {
    if (!usuarioActivo(req, res)) return;
    const referencia = db.collection('monitoreoPozos').doc(req.params.id);
    const documento = await referencia.get();
    if (!documento.exists) return res.status(404).json({ ok: false, error: 'Enlace no encontrado.' });
    const item = documento.data();
    const esAdministrador = req.user.rol === 'administrador';
    if (!esAdministrador && item.propietarioUid !== req.user.uid) return res.status(403).json({ ok: false, error: 'Solo puedes editar enlaces que tú publicaste.' });
    const datos = {
      nombrePozo: String(req.body.nombrePozo ?? item.nombrePozo ?? '').trim(),
      lote: String(req.body.lote ?? item.lote ?? '').trim(),
      descripcion: String(req.body.descripcion ?? item.descripcion ?? '').trim(),
      link: validarUrl(req.body.link ?? item.link),
    };
    if (!datos.nombrePozo) return res.status(400).json({ ok: false, error: 'El nombre del pozo es obligatorio.' });
    if (!datos.lote) return res.status(400).json({ ok: false, error: 'El lote es obligatorio.' });
    if (!datos.link) return res.status(400).json({ ok: false, error: 'Ingresa un enlace válido.' });
    await referencia.update({ ...datos, actualizadoEn: new Date() });
    res.json({ ok: true, enlace: { id: req.params.id, ...datos } });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.delete('/api/monitoreo/:id', verifyToken, async (req, res) => {
  try {
    if (!usuarioActivo(req, res)) return;
    const referencia = db.collection('monitoreoPozos').doc(req.params.id);
    const documento = await referencia.get();
    if (!documento.exists) return res.status(404).json({ ok: false, error: 'Enlace no encontrado.' });
    const item = documento.data();
    const esAdministrador = req.user.rol === 'administrador';
    if (!esAdministrador && item.propietarioUid !== req.user.uid) return res.status(403).json({ ok: false, error: 'Solo puedes eliminar enlaces que tú publicaste.' });
    await referencia.delete();
    res.json({ ok: true, mensaje: 'Enlace eliminado correctamente.' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================
// CHATBOT RAG - STREAMING
// ============================================================

app.post(
  '/api/chat',
  verifyToken,
  async (req, res) => {
    const inicioTotal =
      Date.now();

    let streamIniciado =
      false;

    try {
      const {
        pregunta
      } = req.body;

      // --------------------------------------------------------
      // VALIDACIÓN
      // --------------------------------------------------------

      if (
        !pregunta ||
        !pregunta.trim()
      ) {
        return res.status(400).json({
          ok: false,
          error:
            'La pregunta es requerida'
        });
      }

      const preguntaLimpia =
        pregunta.trim();

      if (
        req.user.estado !==
        'activo'
      ) {
        return res.status(403).json({
          ok: false,
          error:
            'El administrador aún no ha habilitado su cuenta para el sistema.'
        });
      }

      // --------------------------------------------------------
      // SSE
      // --------------------------------------------------------

      res.setHeader(
        'Content-Type',
        'text/event-stream; charset=utf-8'
      );

      res.setHeader(
        'Cache-Control',
        'no-cache, no-transform'
      );

      res.setHeader(
        'Connection',
        'keep-alive'
      );

      res.setHeader(
        'X-Accel-Buffering',
        'no'
      );

      if (
        res.flushHeaders
      ) {
        res.flushHeaders();
      }

      streamIniciado =
        true;

      const enviarEvento =
        (datos) => {
          if (
            !res.writableEnded
          ) {
            res.write(
              `data: ${JSON.stringify(datos)}\n\n`
            );
          }
        };

      enviarEvento({
        tipo:
          'estado',

        mensaje:
          'Analizando consulta...'
      });

      // ========================================================
      // 1. EMBEDDING
      // ========================================================

      const inicioEmbedding =
        Date.now();

      const vectorConsulta =
        await generarEmbedding(
          preguntaLimpia
        );

      const tiempoEmbedding =
        Date.now() -
        inicioEmbedding;

      console.log(
        `[CHAT] Embedding: ${tiempoEmbedding} ms`
      );

      enviarEvento({
        tipo:
          'estado',

        mensaje:
          'Buscando información relevante...'
      });

      // ========================================================
      // 2. MONGODB VECTOR SEARCH
      // ========================================================

      const inicioMongo =
        Date.now();

      const mongoDb =
        getDB();

      const filasContexto =
        await mongoDb
          .collection(
            'conocimientos_vectores'
          )
          .aggregate([
            {
              $vectorSearch: {
                index:
                  'vector_index',

                path:
                  'embedding',

                queryVector:
                  vectorConsulta,

                numCandidates:
                  RAG_NUM_CANDIDATES,

                limit:
                  RAG_LIMIT
              }
            },

            {
              $project: {
                _id: 1,

                manualId: 1,

                recursoId: 1,

                archivoId: 1,

                nombreManual: 1,

                titulo_seccion: 1,

                contenido_texto: 1,

                score: {
                  $meta:
                    'vectorSearchScore'
                }
              }
            }
          ])
          .toArray();

      const tiempoMongo =
        Date.now() -
        inicioMongo;

      console.log(
        `[CHAT] MongoDB: ${tiempoMongo} ms`
      );

      console.log(
        `[CHAT] Resultados encontrados: ${filasContexto.length}`
      );

      console.log(
        '[CHAT] Scores:',
        filasContexto.map(
          (fila) =>
            Number(
              fila.score || 0
            ).toFixed(4)
        )
      );

      // ========================================================
      // 3. FILTRO
      // ========================================================

      const resultadosRelevantes =
        filasContexto.filter(
          (fila) =>
            typeof fila.score ===
              'number' &&
            fila.score >=
              RAG_SCORE_THRESHOLD
        );

      console.log(
        `[CHAT] Resultados relevantes: ${resultadosRelevantes.length}`
      );

      // ========================================================
      // 4. CONSULTA STARLINK BOT
      // ========================================================

      const inicioStarlink = Date.now();
      let contextoStarlink = '';

      // Detectar si la pregunta está relacionada con Starlink
      // Palabras clave más específicas para evitar falsos positivos
      const palabrasClaveStarlink = ['starlink', 'internet satelital', 'vencer', 'pago starlink', 'facturación starlink', 'kit starlink', 'antena starlink', 'conexión satelital', 'equipo starlink'];
      const preguntaMinuscula = preguntaLimpia.toLowerCase();
      const esPreguntaStarlink = palabrasClaveStarlink.some(palabra => preguntaMinuscula.includes(palabra));

      console.log(`[CHAT] Pregunta: "${preguntaLimpia}"`);
      console.log(`[CHAT] ¿Es pregunta Starlink?: ${esPreguntaStarlink}`);

      if (esPreguntaStarlink) {
        try {
          console.log('[CHAT] Consultando colección starlink_bot...');
          const mongoDb = getDB();
          const datosStarlink = await mongoDb.collection('starlink_bot').find({}).toArray();
          console.log(`[CHAT] Se encontraron ${datosStarlink.length} registros de Starlink`);
          
          if (datosStarlink.length > 0) {
            const hoy = new Date();
            const diaActual = hoy.getDate();
            const mesActual = hoy.getMonth() + 1;
            const añoActual = hoy.getFullYear();

            // Calcular pozos que vencen pronto (próximos 7 días)
            const pozosPorVencer = datosStarlink.filter(pozo => {
              if (!pozo.diaPago || pozo.estadoPago === 'pagado') return false;
              const diaPago = Number(pozo.diaPago);
              const diasHastaPago = diaPago - diaActual;
              return diasHastaPago >= 0 && diasHastaPago <= 7;
            });

            // Calcular pozos vencidos
            const pozosVencidos = datosStarlink.filter(pozo => {
              if (!pozo.diaPago || pozo.estadoPago === 'pagado') return false;
              const diaPago = Number(pozo.diaPago);
              return diaPago < diaActual;
            });

            contextoStarlink = `
INFORMACIÓN DE STARLINK
========================
Total de equipos: ${datosStarlink.length}

ESTADO DE PAGOS:
- Equipos pagados: ${datosStarlink.filter(p => p.estadoPago === 'pagado').length}
- Equipos no pagados: ${datosStarlink.filter(p => p.estadoPago === 'no_pagado').length}

ESTADO DE SERVICIO:
- Equipos activos: ${datosStarlink.filter(p => p.estadoActivo).length}
- Equipos inactivos: ${datosStarlink.filter(p => !p.estadoActivo).length}

${pozosPorVencer.length > 0 ? `
⚠️ EQUIPOS POR VENCER (próximos 7 días):
${pozosPorVencer.map(p => `- ${p.ubicacion} (KIT: ${p.codigoKit}): Vence el día ${p.diaPago}, Monto: S/ ${p.monto}${!p.estadoActivo ? ' [INACTIVO]' : ''}`).join('\n')}
` : ''}

${pozosVencidos.length > 0 ? `
🚨 EQUIPOS VENCIDOS:
${pozosVencidos.map(p => `- ${p.ubicacion} (KIT: ${p.codigoKit}): Venció el día ${p.diaPago}, Monto: S/ ${p.monto}${!p.estadoActivo ? ' [INACTIVO]' : ''}`).join('\n')}
` : ''}

${datosStarlink.filter(p => p.comentario && p.comentario.trim()).length > 0 ? `
📝 COMENTARIOS DE EQUIPOS:
${datosStarlink.filter(p => p.comentario && p.comentario.trim()).map(p => `- ${p.ubicacion} (KIT: ${p.codigoKit}): ${p.comentario}`).join('\n')}
` : ''}

DETALLE DE EQUIPOS:
${datosStarlink.map(p => `
• ${p.ubicacion}
  - Código KIT: ${p.codigoKit}
  - Serie Antena: ${p.serieAntena}
  - Correo: ${p.correo}
  - Día de pago: ${p.diaPago}
  - Estado: ${p.estadoPago === 'pagado' ? '✅ Pagado' : '❌ No pagado'}
  - Servicio: ${p.estadoActivo ? '✅ Activo' : '❌ Inactivo'}
  - Monto: S/ ${p.monto}
  - Inicio periodo: ${p.fechaInicioPeriodo}
  ${p.comentario ? `- Comentario: ${p.comentario}` : ''}
`).join('\n')}
`;
          }
        } catch (error) {
          console.error('[CHAT] Error al consultar Starlink:', error.message);
          console.error('[CHAT] Stack:', error.stack);
        }
      } else {
        console.log('[CHAT] No se detectó pregunta de Starlink, usando solo RAG de manuales');
      }

      const tiempoStarlink = Date.now() - inicioStarlink;
      console.log(`[CHAT] Starlink: ${tiempoStarlink} ms`);
      console.log(`[CHAT] Contexto Starlink generado: ${contextoStarlink ? 'SÍ' : 'NO'}`);
      if (contextoStarlink) {
        console.log(`[CHAT] Longitud contexto Starlink: ${contextoStarlink.length} caracteres`);
      }

      // ========================================================
      // 5. NO HAY INFORMACIÓN
      // ========================================================

      if (
        resultadosRelevantes.length ===
        0 &&
        !contextoStarlink
      ) {
        const tiempoTotal =
          Date.now() -
          inicioTotal;

        enviarEvento({
          tipo:
            'texto',

          texto:
            'No encontré información suficientemente relevante para responder esta consulta en los manuales disponibles.'
        });

        enviarEvento({
          tipo:
            'metricas',

          metricas: {
            embeddingMs:
              tiempoEmbedding,

            mongoMs:
              tiempoMongo,

            contextoMs:
              0,

            geminiMs:
              0,

            firstTokenMs:
              null,

            totalMs:
              tiempoTotal
          }
        });

        enviarEvento({
          tipo:
            'fin'
        });

        return res.end();
      }

      // ========================================================
      // 5. CONTEXTO
      // ========================================================

      const inicioContexto =
        Date.now();

      const contextoRecuperado =
        resultadosRelevantes
          .map(
            (f, index) =>
              `
FUENTE ${index + 1}
Documento: ${
                f.nombreManual ||
                'Manual'
              }
Sección: ${
                f.titulo_seccion ||
                'Sin sección'
              }
Relevancia: ${Number(
                f.score
              ).toFixed(4)}

Contenido:
${
                f.contenido_texto
              }
`
          )
          .join(
            '\n\n'
          );

      // Agregar contexto de Starlink si está disponible
      const contextoCompleto = contextoStarlink 
        ? `${contextoStarlink}\n\n${contextoRecuperado}`
        : contextoRecuperado;

      const tiempoContexto =
        Date.now() -
        inicioContexto;

      // ========================================================
      // 6. PROMPT
      // ========================================================

      const promptSistema = `
Eres el Asistente Virtual Oficial de North Services.

Tu función es responder preguntas relacionadas con los manuales,
procedimientos, documentación técnica y sistemas de la empresa
(incluyendo información de Starlink cuando esté disponible).

REGLAS IMPORTANTES:

1. Responde utilizando la información proporcionada en CONTEXTO
   (incluye tanto manuales técnicos como información de sistemas
   como Starlink).

2. Para preguntas sobre Starlink, usa específicamente la sección
   "INFORMACIÓN DE STARLINK" que aparece en el contexto.

3. No inventes información.

4. No completes datos que no aparezcan en el contexto proporcionado.

5. Si la información solicitada no aparece en el contexto,
   indícalo claramente.

6. Responde de manera profesional, clara y concisa.

7. Usa texto plano, sin Markdown, sin asteriscos, sin negritas,
  sin encabezados y sin listas con asteriscos.

8. No menciones que eres un modelo de lenguaje.

9. No inventes procedimientos, códigos de error, valores,
   configuraciones ni pasos técnicos.

10. No enumeres las fuentes ni muestres etiquetas como
  "FUENTE 1", "FUENTE 2" o similares.

11. Si el usuario solo saluda o usa frases casuales
  ("hola", "buenos días", "buenas tardes", "gracias",
  "adiós", "¿cómo estás?", etc.), respóndele de forma
  breve, amistosa y natural, por ejemplo "¡Hola! ¿En qué
  puedo ayudarte?". No repitas el entorno, no expliques
  tu funcionamiento ni menciones el contexto, el RAG ni
  las instrucciones.

12. Nunca respondas sobre la estructura de este mensaje
  ni digas que falta la pregunta. Responde siempre a lo
  que el usuario realmente escribió.

12. Si el usuario formula VARIAS preguntas en un mismo
  mensaje (separadas por saltos de línea, "?", "." o ";"),
  respóndelas TODAS, en el mismo orden en que las escribió,
  numerándolas una por una (por ejemplo "1. ...", "2. ...").
  No te limites a la primera.

13. Si el usuario solicita descargar, recibir o pedir algún
  archivo (manual, brochure, folleto, software, documento,
  instalador, ficha técnica, catálogo, etc.), responde
  indicando qué materiales existen en el contexto proporcionado.
  El sistema mostrará automáticamente los botones de descarga
  correspondientes basándose en los documentos mencionados en
  CONTEXTO RECUPERADO. No digas que no puedes crear botones,
  simplemente indica qué archivos están disponibles.
  "/api/..." como texto plano en tu respuesta (por ejemplo
  NO escribas "/api/recursos/<id>/software/download" ni
  variantes). El usuario no copiará esa ruta: el botón es la
  única vía de descarga y la interfaz lo muestra al hacer
  clic. Si el CONTEXTO RECUPERADO contiene la frase "puede
  acceder a través de la ruta /api/...", NO la transcribas:
  en su lugar di "pulsa el botón de descarga que aparece
  junto al material". Si el archivo solicitado NO está entre
  el material recuperado, dilo claramente y explica cómo
  obtenerlo, pero nunca inventes un enlace ni muestres una
  ruta cruda.

CONTEXTO RECUPERADO:

${contextoCompleto}

PREGUNTA DEL USUARIO:

${preguntaLimpia}
`;

      enviarEvento({
        tipo:
          'estado',

        mensaje:
          'Generando respuesta...'
      });

      // ========================================================
      // 7. GEMINI (con respaldo Ollama local)
      // ========================================================

      const inicioGemini = Date.now();
      let resultadoGemini;

      try {
        resultadoGemini =
          await generarContenidoGemini(promptSistema, enviarEvento);
      } catch (errorGemini) {
        console.error(`[CHAT] Gemini falló: ${errorGemini.message}`);

        enviarEvento({
          tipo: 'estado',
          mensaje: 'El proveedor principal está ocupado, intentando servidor local...'
        });

        try {
          resultadoGemini =
            await generarContenidoOllama(promptSistema, enviarEvento);
        } catch (errorOllama) {
          console.error(`[CHAT] Ollama falló: ${errorOllama.message}`);
          throw errorGemini;
        }
      }

      const tiempoGemini = Date.now() - inicioGemini;

      const firstTokenMs =
        resultadoGemini.primerTokenMs
          ? resultadoGemini.primerTokenMs - inicioGemini
          : null;

      // ========================================================
      // 8. FUENTES
      // ========================================================

      const solicitaDescarga = /\b(descarga|descargar|download|software|instalador|archivo|archivos|manual|manuales|brochure|brochures|folleto|folletos|cat[áa]logo|cat[áa]logos|ficha|documento|documentos)\b/i.test(preguntaLimpia);
      const descargasPorFuente = new Map();
      if (solicitaDescarga) {
        const recursosIds = [...new Set(resultadosRelevantes.map((f) => f.recursoId).filter(Boolean))];
        const archivosIds = [...new Set(resultadosRelevantes.map((f) => f.archivoId).filter(Boolean))];
        const manualesIds = [...new Set(resultadosRelevantes.map((f) => f.manualId).filter(Boolean))];
        const recursos = await Promise.all(recursosIds.map(async (id) => ({ id, documento: await db.collection('recursos').doc(id).get() })));
        const archivos = await Promise.all(archivosIds.map(async (id) => ({ id, documento: await db.collection('archivos').doc(id).get() })));
        const manuales = await Promise.all(manualesIds.map(async (id) => ({ id, documento: await db.collection('manuales').doc(id).get() })));
        recursos.forEach(({ id, documento }) => {
          if (!documento.exists || documento.data().activo !== true) return;
          const recurso = documento.data();
          const botones = [];
          if (recurso.software?.rutaLocal) botones.push({ etiqueta: recurso.software?.nombreArchivo || 'software', ruta: `/api/recursos/${id}/software/download` });
          if (recurso.manual?.rutaLocal) botones.push({ etiqueta: recurso.manual?.nombreArchivo || 'manual', ruta: `/api/recursos/${id}/manual/download` });
          descargasPorFuente.set(`recurso:${id}`, botones);
        });
        archivos.forEach(({ id, documento }) => {
          if (!documento.exists || documento.data().activo !== true || documento.data().eliminado === true) return;
          descargasPorFuente.set(`archivo:${id}`, [{ etiqueta: documento.data().nombreArchivo || 'archivo', ruta: `/api/archivos/${id}/download` }]);
        });
        manuales.forEach(({ id, documento }) => {
          if (documento.exists && documento.data().activo === true) descargasPorFuente.set(`manual:${id}`, [{ etiqueta: documento.data().nombreArchivo || 'manual', ruta: `/api/manuales/${id}/download` }]);
        });
      }

      const fuentes = resultadosRelevantes.map((f) => ({
        documento: f.nombreManual || 'Manual',
        seccion: f.titulo_seccion || 'Sin sección',
        relevancia: Number(f.score || 0),
        descargas: f.recursoId
          ? (descargasPorFuente.get(`recurso:${f.recursoId}`) || [])
          : (f.archivoId
            ? (descargasPorFuente.get(`archivo:${f.archivoId}`) || [])
            : (descargasPorFuente.get(`manual:${f.manualId}`) || [])),
      }));

      enviarEvento({
        tipo:
          'fuentes',

        fuentes
      });

      // ========================================================
      // 9. MÉTRICAS
      // ========================================================

      const tiempoTotal =
        Date.now() -
        inicioTotal;

      enviarEvento({
        tipo:
          'metricas',

        metricas: {
          embeddingMs:
            tiempoEmbedding,

          mongoMs:
            tiempoMongo,

          contextoMs:
            tiempoContexto,

          geminiMs:
            tiempoGemini,

          firstTokenMs,

          totalMs:
            tiempoTotal
        }
      });

      enviarEvento({
        tipo:
          'fin'
      });

      // ========================================================
      // LOGS
      // ========================================================

      console.log(
        '===================================='
      );

      console.log(
        '[CHAT] CONSULTA FINALIZADA'
      );

      console.log(
        `[CHAT] Embedding: ${tiempoEmbedding} ms`
      );

      console.log(
        `[CHAT] MongoDB: ${tiempoMongo} ms`
      );

      console.log(
        `[CHAT] Contexto: ${tiempoContexto} ms`
      );

      console.log(
        `[CHAT] Gemini: ${tiempoGemini} ms`
      );

      console.log(
        `[CHAT] Primer token: ${
          firstTokenMs ??
          'N/A'
        } ms`
      );

      console.log(
        `[CHAT] TOTAL: ${tiempoTotal} ms`
      );

      console.log(
        '===================================='
      );

      res.end();

    } catch (error) {
      console.error(
        '[CHAT] Error:',
        error
      );

      if (
        streamIniciado ||
        res.headersSent
      ) {
        if (
          !res.writableEnded
        ) {
          res.write(
            `data: ${JSON.stringify({
              tipo: 'error',
              error:
                'No fue posible completar la consulta.'
            })}\n\n`
          );

          res.end();
        }
      } else {
        res.status(500).json({
          ok: false,

          error:
            'Servidor ocupado. Reintente en un momento.'
        });
      }
    }
  }
);

// ============================================================
// ROLES Y ÁREAS PÚBLICOS (para formulario de registro)
// ============================================================

app.get('/api/roles', async (req, res) => {
  try {
    const snapshot = await db.collection('users').get();
    const roles = new Set();
    snapshot.forEach((doc) => {
      const rol = (doc.data().rol || '').trim();
      if (rol) roles.add(rol);
    });
    res.json({ ok: true, roles: [...roles].sort() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/areas', async (req, res) => {
  try {
    const snapshot = await db.collection('users').get();
    const areas = new Set();
    snapshot.forEach((doc) => {
      const area = (doc.data().area || '').trim();
      if (area) areas.add(area);
    });
    res.json({ ok: true, areas: [...areas].sort() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================
// GESTIÓN DE USUARIOS
// ============================================================

// ============================================================
// POZOS Y FACTURACIÓN
// ============================================================

app.get('/api/admin/starlink', verifyToken, requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('facturacionStarlink').orderBy('diaPago', 'asc').get();
    const pozos = snapshot.docs.map((documento) => {
      const datos = documento.data();
      return {
        id: documento.id,
        ...datos,
        estadoPago: calcularEstadoPago(datos),
      };
    });
    res.json({ ok: true, pozos });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================
// SINCRONIZACIÓN DE STARLINK CON MONGODB PARA EL BOT
// ============================================================

async function sincronizarStarlinkConMongoDB(datosPozo, operacion = 'crear') {
  try {
    const mongoDb = getDB();
    const coleccionStarlink = mongoDb.collection('starlink_bot');
    
    const datosMongo = {
      id: datosPozo.codigoKit || datosPozo.id,
      ubicacion: datosPozo.nombrePozo,
      correo: datosPozo.correo,
      codigoKit: datosPozo.codigoKit,
      serieAntena: datosPozo.serieAntena || datosPozo.codigo4Pba || '',
      fechaInicioPeriodo: datosPozo.fechaInicioPeriodo,
      diaInicioPeriodo: datosPozo.diaInicioPeriodo || datosPozo.periodoInicio,
      diaPago: datosPozo.diaPago || datosPazo.fechaPago,
      estadoPago: datosPozo.estadoPago,
      monto: datosPozo.monto || 0,
      fechaUltimoPago: datosPozo.fechaUltimoPago || null,
      contrasena: datosPozo.contrasena || '',
      estadoActivo: datosPozo.estadoActivo !== false, // Por defecto true
      comentario: datosPozo.comentario || '',
      actualizadoEn: new Date(),
    };

    if (operacion === 'crear' || operacion === 'actualizar') {
      await coleccionStarlink.updateOne(
        { id: datosMongo.id },
        { $set: datosMongo },
        { upsert: true }
      );
      console.log(`[MONGODB] Starlink ${operacion}orrectamente: ${datosMongo.id}`);
    } else if (operacion === 'eliminar') {
      await coleccionStarlink.deleteOne({ id: datosMongo.id });
      console.log(`[MONGODB] Starlink eliminado: ${datosMongo.id}`);
    }
  } catch (error) {
    console.error(`[MONGODB] Error al sincronizar Starlink:`, error.message);
    // No fallamos la operación principal si falla la sincronización con MongoDB
  }
}

app.post('/api/admin/starlink', verifyToken, requireAdmin, async (req, res) => {
  try {
    const datos = normalizarDatosPozo(req.body);
    if (!datos.nombrePozo) return res.status(400).json({ ok: false, error: 'El nombre del pozo es obligatorio.' });
    if (!datos.codigoKit) return res.status(400).json({ ok: false, error: 'El código KIT es obligatorio.' });
    const datosConPago = datos.estadoPago === 'pagado'
      ? { ...datos, fechaUltimoPago: obtenerFechaHoy() }
      : datos;
    const referencia = db.collection('facturacionStarlink').doc(datos.codigoKit);
    await referencia.set({ ...datosConPago, creadoEn: FieldValue.serverTimestamp(), actualizadoEn: FieldValue.serverTimestamp() });
    
    // Sincronizar con MongoDB para el bot
    await sincronizarStarlinkConMongoDB({ ...datosConPago, id: datos.codigoKit }, 'crear');
    
    res.status(201).json({ ok: true, pozo: { id: datos.codigoKit, ...datosConPago } });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.put('/api/admin/starlink/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const referencia = db.collection('facturacionStarlink').doc(req.params.id);
    const existente = await referencia.get();
    if (!existente.exists) return res.status(404).json({ ok: false, error: 'Pozo no encontrado.' });
    const datosSolicitados = normalizarDatosPozo(req.body);
    const datosOriginales = existente.data();
    const datos = {
      ...datosSolicitados,
      numero: datosOriginales.numero || 0,
      codigoKit: datosOriginales.codigoKit || '',
      serieAntena: datosOriginales.serieAntena || datosOriginales.codigo4Pba || '',
      fechaInicioPeriodo: datosSolicitados.fechaInicioPeriodo || datosOriginales.fechaInicioPeriodo || '',
      diaInicioPeriodo: datosOriginales.diaInicioPeriodo || datosOriginales.periodoInicio || '',
      diaPago: datosOriginales.diaPago || datosOriginales.fechaPago || '',
    };
    if (!datos.nombrePozo) return res.status(400).json({ ok: false, error: 'El nombre del pozo es obligatorio.' });
    const pagoVigente = calcularEstadoPago(datosOriginales) === 'pagado';
    const fechaUltimoPago = datos.estadoPago === 'pagado'
      ? (pagoVigente ? datosOriginales.fechaUltimoPago : obtenerFechaHoy())
      : null;
    const cambiosPago = datos.estadoPago === 'pagado'
      ? { fechaUltimoPago }
      : { fechaUltimoPago: FieldValue.delete() };
    await referencia.update({
      ...datos,
      diaFinPeriodo: FieldValue.delete(),
      periodoFin: FieldValue.delete(),
      ...cambiosPago,
      actualizadoEn: FieldValue.serverTimestamp(),
    });
    
    // Sincronizar con MongoDB para el bot
    await sincronizarStarlinkConMongoDB({ ...datos, id: req.params.id, fechaUltimoPago }, 'actualizar');
    
    res.json({ ok: true, pozo: { id: req.params.id, ...datos, fechaUltimoPago } });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

// Endpoint para eliminar un pozo de Starlink
app.delete('/api/admin/starlink/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const referencia = db.collection('facturacionStarlink').doc(req.params.id);
    const documento = await referencia.get();
    if (!documento.exists) return res.status(404).json({ ok: false, error: 'Pozo no encontrado.' });
    
    const datos = documento.data();
    
    // Sincronizar eliminación con MongoDB
    await sincronizarStarlinkConMongoDB({ ...datos, id: req.params.id }, 'eliminar');
    
    await referencia.delete();
    res.json({ ok: true, mensaje: 'Pozo eliminado correctamente.' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Endpoint para sincronización manual de todos los datos con MongoDB
app.post('/api/admin/starlink/sync-mongodb', verifyToken, requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('facturacionStarlink').get();
    const pozos = snapshot.docs.map((documento) => {
      const datos = documento.data();
      return {
        id: documento.id,
        ...datos,
        estadoPago: calcularEstadoPago(datos),
      };
    });
    
    // Actualizar registros existentes con los nuevos campos si no los tienen
    for (const pozo of pozos) {
      const actualizaciones = {};
      if (pozo.estadoActivo === undefined) {
        actualizaciones.estadoActivo = true; // Por defecto activo
      }
      if (pozo.comentario === undefined) {
        actualizaciones.comentario = ''; // Por defecto vacío
      }
      
      if (Object.keys(actualizaciones).length > 0) {
        await db.collection('facturacionStarlink').doc(pozo.id).update(actualizaciones);
        console.log(`[STARLINK] Actualizado registro ${pozo.id} con nuevos campos`);
      }
    }
    
    let sincronizados = 0;
    let errores = 0;
    
    for (const pozo of pozos) {
      try {
        // Asegurar que los datos tengan los nuevos campos antes de sincronizar
        const datosCompletos = {
          ...pozo,
          estadoActivo: pozo.estadoActivo !== false,
          comentario: pozo.comentario || '',
        };
        await sincronizarStarlinkConMongoDB(datosCompletos, 'actualizar');
        sincronizados++;
      } catch (error) {
        console.error(`Error sincronizando ${pozo.id}:`, error.message);
        errores++;
      }
    }
    
    res.json({ 
      ok: true, 
      mensaje: `Sincronización completada: ${sincronizados} pozos sincronizados, ${errores} errores. Registros actualizados con nuevos campos.`,
      sincronizados,
      errores,
      total: pozos.length
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

function normalizarDatosPozo(datos = {}) {
  const fechaInicioPeriodo = normalizarFechaInicio(datos.fechaInicioPeriodo);
  const diaInicioPeriodo = normalizarDia(fechaInicioPeriodo ? fechaInicioPeriodo.slice(-2) : (datos.diaInicioPeriodo || datos.periodoInicio));
  const diaPago = calcularDiaPago(diaInicioPeriodo);
  return {
    numero: Number(datos.numero) || 0,
    nombrePozo: String(datos.nombrePozo || '').trim(),
    correo: String(datos.correo || '').trim(),
    codigoKit: String(datos.codigoKit || '').trim(),
    serieAntena: String(datos.serieAntena || datos.codigo4Pba || '').trim(),
    fechaInicioPeriodo,
    diaInicioPeriodo,
    diaPago,
    estadoPago: datos.estadoPago === 'pagado' ? 'pagado' : 'no_pagado',
    monto: Number(datos.monto) || 0,
    contrasena: String(datos.contrasena || '').trim(),
    estadoActivo: datos.estadoActivo !== false, // Por defecto true
    comentario: String(datos.comentario || '').trim(),
  };
}

function normalizarDia(valor) {
  const dia = Number.parseInt(valor, 10);
  return dia >= 1 && dia <= 31 ? dia : '';
}

function normalizarFechaInicio(valor) {
  const fecha = String(valor || '').trim();
  return /^\d{4}-\d{2}-(0[1-9]|[12]\d|3[01])$/.test(fecha) ? fecha : '';
}

function calcularDiaPago(diaInicio) {
  const dia = normalizarDia(diaInicio);
  if (dia >= 29 && dia <= 31) return 28;
  return dia ? (dia === 1 ? 31 : dia - 1) : '';
}

function obtenerFechaHoy() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const valores = Object.fromEntries(partes.map(({ type, value }) => [type, value]));
  return `${valores.year}-${valores.month}-${valores.day}`;
}

function convertirFechaPago(valor) {
  if (!valor) return null;
  if (typeof valor === 'string') {
    const coincidencia = valor.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return coincidencia ? {
      anio: Number(coincidencia[1]),
      mes: Number(coincidencia[2]) - 1,
      dia: Number(coincidencia[3]),
    } : null;
  }
  if (typeof valor.toDate === 'function') {
    const fecha = valor.toDate();
    const partes = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(fecha);
    const valores = Object.fromEntries(partes.map(({ type, value }) => [type, value]));
    return { anio: Number(valores.year), mes: Number(valores.month) - 1, dia: Number(valores.day) };
  }
  return null;
}

function calcularEstadoPago(datos) {
  if (datos.estadoPago !== 'pagado') return 'no_pagado';

  const diaPago = normalizarDia(datos.diaPago || datos.fechaPago);
  const fechaUltimoPago = convertirFechaPago(datos.fechaUltimoPago);
  if (!diaPago || !fechaUltimoPago) return 'no_pagado';

  const fechaHoy = convertirFechaPago(obtenerFechaHoy());
  if (!fechaHoy) return 'no_pagado';

  const diffMeses = (fechaHoy.anio - fechaUltimoPago.anio) * 12 + (fechaHoy.mes - fechaUltimoPago.mes);
  const diaPagado = fechaUltimoPago.dia;
  const diaHoy = fechaHoy.dia;

  if (diaPagado <= diaPago) {
    if (diffMeses === 0) return diaHoy <= diaPago ? 'pagado' : 'no_pagado';
    if (diffMeses === 1) return diaHoy <= diaPago ? 'pagado' : 'no_pagado';
    return 'no_pagado';
  }

  if (diffMeses === 0) return diaHoy > diaPago ? 'pagado' : 'no_pagado';
  if (diffMeses === 1) return diaHoy <= diaPago ? 'pagado' : 'no_pagado';
  return 'no_pagado';
}

app.get(
  '/api/admin/usuarios',
  verifyToken,
  async (req, res) => {
    try {
      if (
        req.user.rol !==
        'administrador'
      ) {
        return res.status(403).json({
          ok: false,

          error:
            'Acceso denegado. Solo administradores.'
        });
      }

      const snapshot =
        await db
          .collection(
            'users'
          )
          .get();

      const usuarios =
        [];

      snapshot.forEach(
        (doc) => {
          usuarios.push({
            ...doc.data(),
            uid:
              doc.id
          });
        }
      );

      res.json({
        ok: true,
        usuarios
      });

    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// ACTUALIZAR USUARIO
// ============================================================

app.put(
  '/api/admin/usuarios/:uid',
  verifyToken,
  async (req, res) => {
    try {
      if (
        req.user.rol !==
        'administrador'
      ) {
        return res.status(403).json({
          ok: false,
          error:
            'Acceso denegado'
        });
      }

      const {
        uid
      } = req.params;

      const {
        rol,
        area,
        estado
      } = req.body;

      const datosActualizar =
        {};

      if (
        rol !== undefined
      ) {
        datosActualizar.rol =
          rol;
      }

      if (
        area !== undefined
      ) {
        datosActualizar.area =
          area;
      }

      if (
        estado !== undefined
      ) {
        datosActualizar.estado =
          estado;
      }

      await db
        .collection(
          'users'
        )
        .doc(uid)
        .update(
          datosActualizar
        );

      res.json({
        ok: true,

        mensaje:
          'Usuario actualizado correctamente'
      });

    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// PAPELERA - ELEMENTOS ELIMINADOS RECIENTEMENTE
// ============================================================

app.get('/api/papelera', verifyToken, async (req, res) => {
  try {
    if (!usuarioActivo(req, res)) return;
    await purgarPapeleraExpirada().catch((error) => console.error('[PAPELERA] Error al purgar:', error.message));
    const esAdmin = req.user.rol === 'administrador';
    const snapshot = await db.collection('archivos').where('eliminado', '==', true).get();
    const items = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (!esAdmin && data.propietarioUid !== req.user.uid) return;
      const eliminadoEn = fechaAISO(data.eliminadoEn);
      const fecha = parseFechaFirestore(data.eliminadoEn);
      const diasRestantes = fecha
        ? Math.max(0, Math.ceil((fecha.getTime() + MS_RETENCION_PAPELERA - Date.now()) / (24 * 60 * 60 * 1000)))
        : DIAS_RETENCION_PAPELERA;
      items.push({
        id: doc.id,
        tipo: 'archivo',
        nombre: data.nombre || data.nombreArchivo,
        nombreArchivo: data.nombreArchivo || data.nombre || '',
        descripcion: data.descripcion || '',
        propietarioNombre: data.propietarioNombre || data.propietarioEmail || 'Usuario',
        propietarioUid: data.propietarioUid,
        eliminadoPor: data.eliminadoPor || '',
        eliminadoPorNombre: data.eliminadoPorNombre || data.propietarioNombre || data.propietarioEmail || 'Usuario',
        eliminadoEn,
        diasRestantes,
        estadoIndexacion: data.estadoIndexacion || '',
      });
    });
    items.sort((a, b) => new Date(b.eliminadoEn || 0) - new Date(a.eliminadoEn || 0));
    res.json({ ok: true, items, diasRetencion: DIAS_RETENCION_PAPELERA });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/papelera/lote/restaurar', verifyToken, async (req, res) => {
  try {
    if (!usuarioActivo(req, res)) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ ok: false, error: 'Selecciona al menos un elemento.' });
    let procesados = 0;
    const fallidos = [];
    for (const id of ids) {
      const referencia = db.collection('archivos').doc(id);
      const doc = await referencia.get();
      if (!doc.exists) { fallidos.push({ id, error: 'Elemento no encontrado.' }); continue; }
      const data = doc.data();
      if (!puedeGestionarArchivo(req.user, data)) { fallidos.push({ id, error: 'Sin permiso.' }); continue; }
      
      // Restaurar vectores de RAG desde la colección de papelera
      try {
        const mongoDb = getDB();
        const vectoresPapelera = await mongoDb.collection('conocimientos_vectores_papelera').find({ archivoId: id }).toArray();
        
        if (vectoresPapelera.length > 0) {
          // Insertar en colección activa
          await mongoDb.collection('conocimientos_vectores').insertMany(vectoresPapelera, { ordered: false });
          // Eliminar de colección de papelera
          await mongoDb.collection('conocimientos_vectores_papelera').deleteMany({ archivoId: id });
          console.log(`[PAPELERA] Restaurados ${vectoresPapelera.length} vectores del archivo ${id} a la colección activa`);
        }
      } catch (error) {
        console.error(`[PAPELERA] Error al restaurar vectores del archivo ${id}:`, error.message);
        // Continuamos con el proceso aunque falle la restauración
      }
      
      await referencia.update({
        eliminado: false,
        eliminadoPor: null,
        eliminadoPorNombre: null,
        eliminadoEn: null,
      });
      procesados += 1;
    }
    res.json({
      ok: true,
      procesados,
      fallidos,
      mensaje: procesados ? `${procesados} elemento${procesados === 1 ? '' : 's'} restaurado${procesados === 1 ? '' : 's'}.` : 'No se restauró ningún elemento.',
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/papelera/lote/definitivo', verifyToken, async (req, res) => {
  try {
    if (!usuarioActivo(req, res)) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ ok: false, error: 'Selecciona al menos un elemento.' });
    let procesados = 0;
    const fallidos = [];
    for (const id of ids) {
      const referencia = db.collection('archivos').doc(id);
      const doc = await referencia.get();
      if (!doc.exists) { fallidos.push({ id, error: 'Elemento no encontrado.' }); continue; }
      const data = doc.data();
      if (!puedeGestionarArchivo(req.user, data)) { fallidos.push({ id, error: 'Sin permiso.' }); continue; }
      await eliminarArchivoPermanentemente(id, data);
      procesados += 1;
    }
    res.json({
      ok: true,
      procesados,
      fallidos,
      mensaje: procesados ? `${procesados} elemento${procesados === 1 ? '' : 's'} eliminado${procesados === 1 ? '' : 's'} permanentemente.` : 'No se eliminó ningún elemento.',
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/papelera/:id/restaurar', verifyToken, async (req, res) => {
  try {
    if (!usuarioActivo(req, res)) return;
    const referencia = db.collection('archivos').doc(req.params.id);
    const doc = await referencia.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: 'Elemento no encontrado.' });
    const data = doc.data();
    const esAdmin = req.user.rol === 'administrador';
    if (!esAdmin && data.propietarioUid !== req.user.uid) return res.status(403).json({ ok: false, error: 'No tienes permiso para restaurar este elemento.' });

    // Restaurar vectores de RAG desde la colección de papelera
    try {
      const mongoDb = getDB();
      const vectoresPapelera = await mongoDb.collection('conocimientos_vectores_papelera').find({ archivoId: req.params.id }).toArray();
      
      if (vectoresPapelera.length > 0) {
        // Insertar en colección activa
        await mongoDb.collection('conocimientos_vectores').insertMany(vectoresPapelera, { ordered: false });
        // Eliminar de colección de papelera
        await mongoDb.collection('conocimientos_vectores_papelera').deleteMany({ archivoId: req.params.id });
        console.log(`[PAPELERA] Restaurados ${vectoresPapelera.length} vectores del archivo ${req.params.id} a la colección activa`);
      }
    } catch (error) {
      console.error(`[PAPELERA] Error al restaurar vectores del archivo ${req.params.id}:`, error.message);
      // Continuamos con el proceso aunque falle la restauración
    }

    await referencia.update({
      eliminado: false,
      eliminadoPor: null,
      eliminadoPorNombre: null,
      eliminadoEn: null,
    });
    res.json({ ok: true, mensaje: 'Elemento restaurado correctamente.' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.delete('/api/papelera/:id/definitivo', verifyToken, async (req, res) => {
  try {
    if (!usuarioActivo(req, res)) return;
    const referencia = db.collection('archivos').doc(req.params.id);
    const doc = await referencia.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: 'Elemento no encontrado.' });
    const data = doc.data();
    const esAdmin = req.user.rol === 'administrador';
    if (!esAdmin && data.propietarioUid !== req.user.uid) return res.status(403).json({ ok: false, error: 'No tienes permiso para eliminar permanentemente este elemento.' });

    await eliminarArchivoPermanentemente(req.params.id, data);
    res.json({ ok: true, mensaje: 'Elemento eliminado permanentemente.' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================

const PORT = process.env.PORT || 8000;
const HOST = process.env.HOST || "0.0.0.0";

connectDB()
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`Servidor corriendo en http://${HOST}:${PORT}`);
      console.log(`[CONFIG] RAG_SCORE_THRESHOLD=${RAG_SCORE_THRESHOLD}`);
      console.log(`[CONFIG] RAG_LIMIT=${RAG_LIMIT}`);
      console.log(`[CONFIG] RAG_NUM_CANDIDATES=${RAG_NUM_CANDIDATES}`);
      console.log(`[CONFIG] EMBEDDING_CONCURRENCY=${EMBEDDING_CONCURRENCY}`);
    });
    purgarPapeleraExpirada().catch((error) => console.error('[PAPELERA] Error al purgar al iniciar:', error.message));
    setInterval(() => {
      purgarPapeleraExpirada().catch((error) => console.error('[PAPELERA] Error al purgar:', error.message));
    }, 60 * 60 * 1000);
  })
  .catch((error) => {
    console.error("Fallo al conectar con MongoDB Atlas:", error);
  });
