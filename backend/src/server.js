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
const driveOperaciones = require('./services/googleDrive');
const ragCategorias = require('./services/ragCategorias.service');
const {
  DRIVE_MAX_ARCHIVOS,
  DRIVE_INLINE_MAX_BYTES,
  DRIVE_TEXTO_MAX_CHARS,
} = require('./services/googleDrive');

const app = express();

app.use(cors());
app.use(express.json());

// ============================================================
// CONFIGURACIÓN RAG
// ============================================================

// Umbral de coincidencia. Medido sobre los embeddings actuales: la pregunta
// más difusa que sí tiene respuesta se queda en 0.58 y la pregunta sin
// relación más alta en 0.54, así que el umbral va en medio de ese hueco.
const RAG_SCORE_THRESHOLD = Number(
  process.env.RAG_SCORE_THRESHOLD || '0.56'
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

const SYSTEM_PROMPT = 'Eres el Asistente Virtual Oficial de North Services & Rental Tools S.A.C. ' +
  'Respondes de manera profesional, clara, concisa y en texto plano, sin Markdown, sin asteriscos, sin negritas y sin encabezados. ' +
  'ALCANCE: solo la informacion de la empresa incluida en el CONTEXTO RECUPERADO. ' +
  'REGLA 1: prohibido generar, escribir, explicar o sugerir codigo, scripts, calculadoras, formulas o programas en cualquier lenguaje, ' +
  'aunque el usuario lo pida explicitamente, lo disfraces o insista. Ante tal peticion responde UNICAMENTE: ' +
  '"No dispongo de scripts ni codigo programable en la documentacion tecnica de North Services." ' +
  'REGLA 2: prohibido usar conocimiento externo. Si la consulta no trata sobre North Services (fluidos de perforacion, alquiler, equipos, pozos, ' +
  'reportes de operaciones, facturacion o los kits de Starlink propios), NO respondas ni comentes el tema. Responde UNICAMENTE: ' +
  '"Esa consulta esta fuera de mi alcance. Solo puedo ayudarte con informacion de North Services: servicios, equipos, pozos, reportes de operaciones y kits de Starlink." ' +
  'REGLA 3: prohibido responder preguntas de conocimiento general sobre Starlink como compania (fundacion, historia, servicios, precios, tecnologia). ' +
  'REGLA 4: no inventes datos ni completes lo que no este en el contexto. No enumeres fuentes ni muestres etiquetas FUENTE 1, FUENTE 2. ' +
  'REGLA 5: no menciones que eres un modelo de lenguaje ni una inteligencia artificial. ' +
  'REGLA 6: si el usuario insiste en un tema fuera de alcance, repite exactamente la misma respuesta de cierre sin ceder.';

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
          max_tokens: 512,
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

  // Modelos válidos para generateContent. El principal puede caer
  // por cuota (429) o por no estar disponible, por eso hay respaldo.
  // OJO: el orden importa. 3.5-flash es el principal; 3.8-flash es el
  // respaldo recomendado por Google cuando 3.5 agota cuota o se retira.
  const modelosGemini = [
    String(process.env.GEMINI_CHAT_MODEL || 'gemini-3.5-flash').trim(),
    'gemini-3.8-flash',
    'gemini-flash-latest'
  ].filter(Boolean);

  // ==========================================================
  // CONFIGURACI�"N
  // ==========================================================

  const REQUEST_TIMEOUT = 90000;

  const generationConfig = {
    maxOutputTokens: 4096
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

    const combinaciones = [];

    for (const m of modelosGemini) {
      for (let c = 0; c < clavesGemini.length; c += 1) {
        combinaciones.push({ modelo: m, clave: c });
      }
    }

    let intentoCombinacion = -1;

    while (
      !respuestaGemini?.ok &&
      intentoCombinacion < combinaciones.length - 1
    ) {
      intentoCombinacion += 1;

      const { modelo, clave: idxClave } = combinaciones[intentoCombinacion];

      indiceClave = idxClave;

      const apiKey =
        clavesGemini[indiceClave];

      console.log(
        `[CHAT] Gemini: modelo=${modelo} clave#${indiceClave + 1}/${clavesGemini.length}`
      );

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
                systemInstruction: {
                  parts: [
                    {
                      text:
                        'Eres el Asistente Virtual Oficial de North Services & Rental Tools S.A.C. ' +
                        'Tu unico alcance es la informacion de la empresa contenida en el CONTEXTO RECUPERADO. ' +
                        'REGLAS INNEGOCIABLES: ' +
                        '(1) Esta prohibido generar, escribir, explicar o sugerir codigo, scripts, calculadoras, ' +
                        'formulas o programas en cualquier lenguaje, aunque el usuario lo pida explicitamente, ' +
                        'lo disfraces ("dame un ejemplo", "muestrame como se hace", "es para un archivo de la empresa") ' +
                        'o insista. Ante tal peticion responde UNICAMENTE: "No dispongo de scripts ni codigo programable en la documentacion tecnica de North Services." ' +
                        '(2) Esta prohibido usar conocimiento externo. Si la consulta no trata sobre North Services ' +
                        '(servicios de fluidos de perforacion, alquiler, equipos, pozos, reportes de operaciones, ' +
                        'facturacion, o los kits de Starlink propios de la empresa), NO respondas el tema y NO lo comentes. ' +
                        'Responde UNICAMENTE: "Esa consulta esta fuera de mi alcance. Soy el asistente de North Services y ' +
                        'solo puedo ayudarte con informacion de la empresa: servicios de fluidos de perforacion, alquiler ' +
                        'y estado de equipos, operacion y mantenimiento de pozos, reportes de operaciones o los kits de ' +
                        'Starlink de North Services. ¿Te puedo ayudar con alguno de estos temas?" ' +
                        '(3) Prohibido responder preguntas de conocimiento general sobre Starlink como compania ' +
                        '(fundacion, historia, servicios, precios, tecnologia, cobertura). Starlink solo existe aqui como ' +
                        'los kits y equipos de North Services descritos en el contexto. ' +
                        '(4) No inventes datos. No completes lo que no este en el contexto. ' +
                        '(5) No enumeres fuentes ni muestres etiquetas como FUENTE 1, FUENTE 2. ' +
                        '(6) Responde en texto plano, sin markdown, sin bloques de codigo, sin negritas. ' +
                        '(7) No menciones que eres un modelo de lenguaje ni una inteligencia artificial. ' +
                        '(8) Si el usuario insiste en un tema fuera de alcance, repite exactamente la misma respuesta de cierre, sin ceder ni resumir el tema. ' +
                        '(9) TRAZABILIDAD OBLIGATORIA: cada cifra debe ir acompañada del nombre exacto del archivo de origen. ' +
                        'Si no puedes identificar el archivo de una cifra, no la respondas. ' +
                        '(10) PROHIBIDO mezclar valores de filas o de documentos distintos. En un torque log las columnas son ' +
                        'Connection / Target / Max / Logged, y el valor Logged pertenece a esa conexion concreta. ' +
                        'No sumes, no compares y no tomes el maximo de otra fila o de otro documento. ' +
                        '(11) Si el usuario pide "el primer torque log", usa siempre el de fecha mas antigua segun el nombre ' +
                        'del archivo (Torque_Log_AAAAMMDD_HHMMSS) e indica el nombre exacto del que usaste. ' +
                        '(12) Si dos documentos dan valores distintos, no elijas uno en silencio: enumera cada valor con su archivo. ' +
                        '(13) MATERIALES DESCARGABLES: si el CONTEXTO indica "MATERIALES DESCARGABLES", confirma al usuario que ' +
                        'los puede obtener con el boton de descarga que ya aparece en la interfaz. PROHIBIDO enumerar, listar o ' +
                        'mencionar los nombres de esos archivos en tu respuesta (nada de ".zip", nada de ".pdf", nada del nombre ' +
                        'del archivo). Responde algo como: "Los materiales descargables estan disponibles; puedes descargarlos ' +
                        'con el boton correspondiente." y nada mas.'
                    }
                  ]
                },

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

  let finishReason =
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

          const razonFinal =
            chunk
              ?.candidates?.[0]
              ?.finishReason;

          if (
            razonFinal
          ) {
            finishReason =
              razonFinal;
          }

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

  // Un stream completo de Gemini siempre reporta finishReason 'STOP' al final.
  // Si falta (null) o es otro valor, la respuesta quedó interrumpida
  // (el proveedor cortó el SSE) y debe reintentarse / usar respaldo.
  const completo =
    Boolean(respuestaCompleta.trim()) &&
    finishReason === 'STOP';

  if (!completo) {
    console.warn(
      `[CHAT] Gemini stream incompleto (finishReason=${finishReason ?? 'ninguno'}, chars=${respuestaCompleta.length}).`
    );
  }

  return {
    respuestaCompleta,

    primerTokenMs,

    finishReason,

    completo
  };
}

// ============================================================
// GOOGLE DRIVE - REPORTES DE OPERACIONES (RAG HÍBRIDO)
// ============================================================

// Los reportes pueden ser diarios, semanales o por corrida; no se asume una
// secuencia diaria. Se detecta cualquier consulta sobre reportes de operaciones.
const PALABRAS_CLAVE_REPORTES = [
  'reporte', 'reportes', 'torque log', 'torque logs', 'torque',
  'casing', 'revestimiento', 'daily report', 'weekly report',
  'reporte semanal', 'reporte de pozo', 'reporte de campo',
  'reporte operacional', 'reportes de operación', 'reportes de operacion',
  'survey report', 'parte diario', 'informe diario', 'avance diario',
  'producción diaria', 'produccion diaria'
];

function esPreguntaReportesOperaciones(pregunta) {
  const texto = (pregunta || '').toLowerCase();
  return PALABRAS_CLAVE_REPORTES.some((palabra) => texto.includes(palabra));
}

// Números escritos con letra, porque en español casi siempre se pregunta
// "los últimos DOS torque logs" y no "los últimos 2". Sin esto la cantidad se
// perdía y el modelo acababa eligiendo archivos al azar del catálogo.
const NUMEROS_PALABRA = {
  un: 1, uno: 1, una: 1, primer: 1, primera: 1, primero: 1,
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
  ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12
};

// "el último torque log" son una sola pieza, no una serie sin número. Ojo con
// "primer": termina en "r", así que "primera" se escribe aparte.
const RE_SINGULAR = /\b(ultim[oa]|primer|primera)\b/;

// Localiza la cantidad en una pregunta donde el número puede estar lejos del
// adjetivo: en "los dos torque logs más antiguos" el "dos" no toca al
// "antiguos". Se descartan los números de más de tres cifras porque casi
// siempre son años o parte de una fecha ("reporte 2026").
function cantidadEnPregunta(texto) {
  const conCifras = texto.match(/(?:^|\D)(\d{1,3})(?:\D|$)/);
  if (conCifras) {
    const numero = Number(conCifras[1]);
    return numero >= 1 && numero <= 20 ? numero : null;
  }
  for (const palabra of texto.split(/\s+/)) {
    const limpia = palabra.replace(/[^a-z]/g, '');
    if (NUMEROS_PALABRA[limpia] !== undefined) return NUMEROS_PALABRA[limpia];
  }
  return null;
}

// Detecta cuántas piezas pide el usuario y en qué sentido.
//
// Antes solo se reconocía "el primero", así que "los últimos dos torque logs"
// caía en el orden genérico y el modelo recibía 10 PDFs sueltos más un
// catálogo de cientos de nombres para elegir: por eso respondía con fechas que
// no eran las últimas.
function interpretarPeticionDeReportes(pregunta) {
  const texto = String(pregunta || '').toLowerCase();

  // "últimos", "más recientes", "nuevos" -> del más nuevo al más viejo.
  const pideRecientes = /\b(ultim\w*|recientes?|mas\s+recientes?|nuev\w+|actual\w*)\b/.test(texto);
  // "primeros", "más antiguos", "iniciales" -> del más viejo al más nuevo.
  const pideAntiguos = /\b(primer\w*|mas\s+antigu\w+|antigu\w+|inicial\w*)\b/.test(texto);

  let cantidad = RE_SINGULAR.test(texto) ? 1 : cantidadEnPregunta(texto);

  // Un tope razonable: pedir 50 reportes a la vez no es una consulta de "los
  // últimos", es otra cosa. Si se pasa, se comporta como una consulta abierta
  // en vez de truncar la lista a un número arbitrario.
  if (cantidad && (cantidad < 1 || cantidad > 20)) cantidad = null;

  return {
    cantidad,
    // Sin señal de dirección se responde como "más recientes": es lo que
    // significa "los últimos N".
    orden: pideAntiguos && !pideRecientes ? 'nombre_fecha' : 'nombre_fecha_desc',
    pideRecientes,
    pideAntiguos
  };
}

// Llamada no-streaming a Gemini que admite PDFs en modo buffer (inline_data).
// Reintenta con backoff ante 429/503 (alta demanda / rate limit).
// El respaldo en texto plano de los PDFs es local y tarda milisegundos, así
// que no compensa insistir con Gemini cuando responde 503 por alta demanda:
// solo añade decenas de segundos de espera antes de caer al mismo contenido.
// Se puede subir con GEMINI_DRIVE_REINTENTOS si el servicio se estabiliza.
async function geminiExtraerDePdf(
  partes,
  { reintentos = Number(process.env.GEMINI_DRIVE_REINTENTOS || '1') } = {}
) {
  const claves = obtenerClavesGemini();
  if (!claves.length) throw new Error('GEMINI_API_KEY no está configurada.');

  const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));
  let ultimoError = null;

  for (let intento = 0; intento < reintentos; intento++) {
    for (const clave of claves) {
      // La indexacion desde Drive usa un modelo propio para no
      // agotar la cuota del modelo del chat (y viceversa).
      const modeloDrive = String(
        process.env.GEMINI_DRIVE_MODEL || 'gemini-3.8-flash'
      ).trim();

      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${modeloDrive}:generateContent?key=${clave}`;
      try {
        const respuesta = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: partes }],
            generationConfig: {
              maxOutputTokens: 2048
            }
          })
        });
        if (!respuesta.ok) {
          const cuerpo = await respuesta.text();
          ultimoError = new Error(`Gemini respondió ${respuesta.status}: ${cuerpo}`);
          // Reintentable: alta demanda o límite de tasa.
          if (respuesta.status === 429 || respuesta.status === 503) break;
          continue;
        }
        const data = await respuesta.json();
        const texto = data?.candidates?.[0]?.content?.parts
          ?.map((parte) => parte.text)
          .filter(Boolean)
          .join('\n');
        if (texto && texto.trim()) return texto.trim();
        ultimoError = new Error('Gemini no devolvió texto en la extracción del PDF.');
      } catch (error) {
        ultimoError = error;
      }
    }
    if (intento < reintentos - 1) {
      const espera = 2000 * (intento + 1);
      console.warn(`[DRIVE] Gemini extracción falló (intento ${intento + 1}); reintentando en ${espera} ms...`);
      await dormir(espera);
    }
  }
  throw ultimoError || new Error('No se pudo extraer información del PDF con Gemini.');
}

/**
 * Lee los reportes de operaciones (PDF) de la carpeta compartida de Operaciones
 * vía Drive API en modo buffer/media y los pasa a Gemini para extracción de
 * tablas y resumen. Devuelve un bloque de contexto de texto (o '' si no aplica).
 */
// ¿El nombre del archivo pertenece al tipo de reporte que pidió el usuario?
//
// Sin este filtro, "los últimos dos torque logs" podía devolver los dos
// archivos más recientes de la carpeta aunque fueran daily reports: el nombre
// se comparaba palabra por palabra y "torque" no aparecía en ellos.
function coincideConLaPregunta(nombreArchivo, pregunta) {
  const texto = String(pregunta || '').toLowerCase();
  const nombre = String(nombreArchivo || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // Tipos de reporte que el usuario puede pedir por nombre. Solo se exige
  // coincidencia cuando el usuario menciona explícitamente ese tipo.
  const TIPOS = [
    { patron: /torque/, enNombre: /torque/ },
    { patron: /casing/, enNombre: /casing/ },
    { patron: /revestimiento/, enNombre: /revestim|casing/ },
    { patron: /daily\s*report/, enNombre: /daily|diar/ },
    { patron: /daily/, enNombre: /daily|diar/ },
    { patron: /survey/, enNombre: /survey/ },
    { patron: /reporte\s*semanal|weekly/, enNombre: /semanal|weekly/ }
  ];

  const pedido = TIPOS.find((tipo) => tipo.patron.test(texto));
  if (!pedido) return true;
  return pedido.enNombre.test(nombre);
}

async function obtenerContextoReportesOperaciones(pregunta, enviarEvento) {
  try {
    // Se interpreta la petición antes de listar: define el orden y cuántos
    // archivos van al prompt. "Los últimos dos" y "el primero" son la misma
    // operación con distinto destino.
    const peticion = interpretarPeticionDeReportes(pregunta);
    const { orden, cantidad } = peticion;

    console.log(
      `[CHAT] Drive: orden="${orden}"` +
      (cantidad ? ` cantidad=${cantidad}` : '') +
      (peticion.pideAntiguos ? ' (más antiguos)' : '')
    );

    if (cantidad) {
      if (typeof enviarEvento === 'function') {
        enviarEvento({
          tipo: 'estado',
          mensaje: `Buscando ${cantidad === 1 ? 'el reporte' : `los ${cantidad} reportes`} ${peticion.pideAntiguos ? 'más antiguo(s)' : 'más reciente(s)'}...`
        });
      }
    }

    const archivos = await driveOperaciones.listarReportesPdf({
      maxResultados: 500,
      pregunta,
      orden
    });
    if (!archivos.length) {
      console.log('[DRIVE] No hay PDFs en la carpeta de Operaciones.');
      return '';
    }

    // Resumen por carpeta: responde preguntas de conteo/disponibilidad
    // (p. ej. "¿cuántos torque log hay?") incluso si Gemini no está disponible.
    const porCarpeta = new Map();
    for (const archivo of archivos) {
      const clave = archivo.carpeta || '(raíz)';
      porCarpeta.set(clave, (porCarpeta.get(clave) || 0) + 1);
    }
    const resumenCarpetas = Array.from(porCarpeta.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([carpeta, total]) => `- ${carpeta}: ${total} archivo(s)`)
      .join('\n');

    // El listado se arma DESPUÉS de elegir los archivos. Cuando el usuario
    // pidió una cantidad concreta solo se listan esos: poner los 500 nombres
    // delante era lo que invitaba al modelo a elegir otros y a inventar fechas.
    const listar = (lista) =>
      lista
        .map((archivo, indice) => {
          const fecha = archivo.modifiedTime
            ? new Date(archivo.modifiedTime).toLocaleDateString('es-PE')
            : 'sin fecha';
          return `${indice + 1}. ${archivo.name} [${archivo.carpeta || '(raíz)'}] (modificado: ${fecha})`;
        })
        .join('\n');

    const catalogoCompleto = listar(archivos);

    // Priorizar PDFs cuyo nombre coincida con términos de la pregunta.
    // Se normaliza (sin separadores, minúsculas) y se singulariza para que
    // "torques" coincida con "Torque_Log", "reportes" con "Reporte", etc.
    const normalizarToken = (texto) =>
      texto
        .toLowerCase()
        .replace(/[^a-z0-9ñ]/g, '')
        .replace(/es$|s$/, '');

    const tokensPregunta = (pregunta || '')
      .toLowerCase()
      .split(/[^a-z0-9áéíóúñ]+/i)
      .filter((token) => token.length >= 4)
      .map(normalizarToken)
      .filter((token) => token.length >= 3);

    const puntaje = (nombre) => {
      const nombreNorm = normalizarToken(nombre || '');
      return tokensPregunta.reduce(
        (acc, token) => (nombreNorm.includes(token) ? acc + 1 : acc),
        0
      );
    };

    const seleccionados = (() => {
      // Cuando el usuario pide un número concreto ("los últimos dos"), la
      // lista YA viene en el orden correcto y filtrada. Reordenar por
      // coincidencias de nombre tiraría ese orden a la basura, que es
      // exactamente lo que pasaba antes: el modelo recibía 10 archivos
      // desordenados y además un catálogo de cientos de nombres entre los que
      //elegir al azar, y respondía con fechas que no eran las últimas.
      if (cantidad) {
        const coherentes = archivos.filter((archivo) => coincideConLaPregunta(archivo.name, pregunta));
        const candidatos = coherentes.length ? coherentes : archivos;
        console.log(
          `[DRIVE] Selección directa: ${candidatos.length} archivo(s) coinciden con la pregunta, se toman ${cantidad}`
        );
        return candidatos.slice(0, cantidad);
      }

      // Sin cantidad ("¿qué torque logs hay?") el puntaje sigue sirviendo para
      // traer los que mejor encajan con lo que se preguntó.
      return archivos
        .map((archivo) => ({ archivo, score: puntaje(archivo.name) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, DRIVE_MAX_ARCHIVOS)
        .map((item) => item.archivo);
    })();

    // Con cantidad concreta el catálogo se reduce a lo pedido. Sin ella se
    // mantiene el listado completo, que es lo que permite preguntas del tipo
    // "¿qué reportes hay?".
    const bloqueCatalogo = cantidad
      ? `ARCHIVOS SELECCIONADOS PARA ESTA CONSULTA (Google Drive)
Se pidió${cantidad === 1 ? '' : 'n'} ${cantidad === 1 ? 'reporte' : `${cantidad} reportes`} ${peticion.pideAntiguos ? 'más antiguo(s)' : 'más reciente(s)'}.
Total de documentos PDF en la carpeta compartida de Operaciones: ${archivos.length}

ESTOS SON LOS ARCHIVOS QUE DEBES USAR, EN ESTE ORDEN:
${listar(seleccionados)}

Usa únicamente estos ${cantidad === 1 ? 'reporte' : `${cantidad} reportes`}. No menciones ni
comentes otros nombres de archivo aunque aparezcan en otro contexto.`
      : `CATÁLOGO DE ARCHIVOS EN LA CARPETA COMPARTIDA DE OPERACIONES (Google Drive)
Total de documentos PDF: ${archivos.length}

RESUMEN POR CARPETA:
${resumenCarpetas}

LISTADO COMPLETO:
${catalogoCompleto}`;

    const partes = [];
    const nombresUsados = [];
    const textosRespaldo = [];

    for (const archivo of seleccionados) {
      try {
        const buffer = await driveOperaciones.descargarArchivoBuffer(archivo.id);
        nombresUsados.push(archivo.name);

        // El texto se lee una sola vez: sirve de contenido para Gemini cuando
        // el PDF no cabe en línea y también de respaldo si la extracción con
        // Gemini falla por saturación.
        let textoPlano = '';
        try {
          textoPlano = await driveOperaciones.extraerTextoPdf(buffer);
        } catch (errorTexto) {
          console.warn(
            `[DRIVE] No se pudo leer el texto de ${archivo.name}: ${errorTexto.message}`
          );
        }
        if (textoPlano && textoPlano.trim()) {
          textosRespaldo.push(
            `DOCUMENTO: ${archivo.name}\n${textoPlano.slice(0, DRIVE_TEXTO_MAX_CHARS)}`
          );
        }

        if (buffer.length <= DRIVE_INLINE_MAX_BYTES) {
          partes.push({
            inlineData: { mimeType: 'application/pdf', data: buffer.toString('base64') }
          });
        } else {
          partes.push({ text: `DOCUMENTO: ${archivo.name}\n${textoPlano.slice(0, DRIVE_TEXTO_MAX_CHARS)}` });
        }
      } catch (errorArchivo) {
        console.error(`[DRIVE] Error leyendo ${archivo.name}:`, errorArchivo.message);
      }
    }

    if (!nombresUsados.length) {
      // Aun sin poder leer contenidos, el catálogo responde preguntas de conteo.
      return `
INFORMACIÓN DE REPORTES DE OPERACIONES (Google Drive)
=============================================================
${bloqueCatalogo}

(No se pudo descargar el contenido de los PDFs en esta consulta.)
`;
    }

    partes.push({
      text:
        `A partir de los reportes de operaciones adjuntos (archivos: ${nombresUsados.join(', ')}), ` +
        `extrae las tablas de datos relevantes y elabora un resumen estructurado que responda a la ` +
        `siguiente consulta. Incluye cifras, fechas, pozos, casing/torque y cualquier valor numérico ` +
        `exactamente como aparece en los documentos. No inventes datos. ` +
        `Usa texto plano, sin Markdown.\n\nCONSULTA: ${pregunta}`
    });

    let contenido;
    try {
      contenido = await geminiExtraerDePdf(partes);
    } catch (errorExtraccion) {
      // Respaldo: si Gemini está saturado (503), aportar el texto plano extraído
      // de los PDFs para que el modelo principal (u Ollama) pueda responder.
      console.warn('[DRIVE] Extracción con Gemini falló, usando texto plano de respaldo:', errorExtraccion.message);
      contenido = textosRespaldo.length
        ? `EXTRACCIÓN AUTOMÁTICA NO DISPONIBLE. CONTENIDO EN TEXTO PLANO DE LOS PDFs:\n\n${textosRespaldo.join('\n\n')}`
        : 'No se pudo extraer el contenido de los PDFs en esta consulta.';
    }

    return `
INFORMACIÓN DE REPORTES DE OPERACIONES (Google Drive)
=============================================================
${bloqueCatalogo}

Documentos revisados en detalle: ${nombresUsados.join(', ')}

${contenido}
`;
  } catch (error) {
    console.error('[DRIVE] Error obteniendo reportes de operaciones:', error.message);
    return '';
  }
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

app.get('/api/perfil', verifyToken, async (req, res) => {
  try {
    const permisos = await ragCategorias.obtenerPermisosRol(req.user.rol);
    const fuentes = await ragCategorias.obtenerFuentesPermitidas(req.user.rol);
    res.json({
      ok: true,
      usuario: {
        ...req.user,
        // El rol se devuelve con la capitalización original del registro,
        // para que la interfaz muestre exactamente el rol solicitado.
        rol: req.user.rolOriginal || req.user.rol,
        fuentesRag: fuentes.map((fuente) => ({ id: fuente.id, nombre: fuente.nombre })),
        puedeUsarStarlink: await ragCategorias.puedeAccederModulo(req.user.rol, 'starlink'),
        permisosConfigurados: permisos.configurado,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
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
    // El rol NO se toca aquí: solo el Administrador puede asignarlo.
    res.json({ ok: true, usuario: { ...req.user, nombre, apellido, email, rol: req.user.rolOriginal || req.user.rol } });
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

// El manual del recurso se indexa SIEMPRE en la categoría de software y
// manuales. El administrador puede configurar qué roles tienen acceso a esta
// categoría desde el panel de permisos. Antes esta línea usaba una variable
// `categoriaId` que no existía en ningún sitio: al subir un recurso con manual
// PDF reventaba con ReferenceError y ningún manual llegaba a indexarse.
//
// La categoría se crea sola la primera vez, así que no hay que preparar nada
// antes de publicar el primer software.
const categoriaIngesta = await ragCategorias.obtenerOCrearCategoriaRecursos(
  req.user?.uid
);

// Se guarda en el documento del recurso para que al borrarlo se sepa dónde
// están sus vectores, igual que se hace con los archivos de Archivos.
await recursoRef.update({
  categoriaId: categoriaIngesta.id,
  categoriaNombre: categoriaIngesta.nombre,
  categoriaColeccion: categoriaIngesta.coleccion,
});

const coleccionVectores = mongoDb.collection(categoriaIngesta.coleccion);

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

    // Verificar si el usuario tiene acceso al módulo software_y_manuales
    const tieneAccesoRecursos = await ragCategorias.puedeAccederModulo(req.user.rol, 'software_y_manuales');

    if (!tieneAccesoRecursos) {
      // Si no tiene acceso, devolver lista vacía en lugar de error
      return res.json({ ok: true, recursos: [] });
    }

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

    // Verificar si el usuario tiene acceso al módulo software_y_manuales
    const tieneAccesoRecursos = await ragCategorias.puedeAccederModulo(req.user.rol, 'software_y_manuales');
    if (!tieneAccesoRecursos) {
      return res.status(403).json({ ok: false, error: 'No tienes permiso para descargar recursos de software y manuales.' });
    }

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
    // Los recursos se indexan en la categoría de software y manuales. Se lee
    // del documento, no del código, para que el borrado siga funcionando
    // aunque esa categoría se renombre.
    const { categoria: categoriaRecurso } = await coleccionesDeCategoria(recurso);
    const coleccionRecurso = categoriaRecurso
      ? categoriaRecurso.coleccion
      : (await ragCategorias.obtenerCategoria('software_y_manuales'))?.coleccion;
    if (coleccionRecurso) {
      await getDB().collection(coleccionRecurso).deleteMany({ recursoId: req.params.id });
    }
    const raiz = path.resolve(__dirname, '../storage');
    for (const archivo of [recurso.software, recurso.manual]) {
      if (!archivo?.rutaLocal) continue;
      const rutaArchivo = path.resolve(__dirname, '..', archivo.rutaLocal);
      await eliminarArchivoYCarpetasVacias(rutaArchivo, raiz);
    }
    await referencia.delete();
    res.json({ ok: true, mensaje: 'Recurso eliminado correctamente.' });
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
  // El recurso guarda en qué colección quedó indexado; si no lo guardó
  // (recursos antiguos) se usa la categoría general.
  const coleccionVectoresRecurso =
    item?.categoriaColeccion ||
    (await ragCategorias.obtenerCategoria(item?.categoriaId || ragCategorias.CATEGORIA_POR_DEFECTO))?.coleccion;
  if (eliminarVectores && coleccionVectoresRecurso) {
    await getDB().collection(coleccionVectoresRecurso).deleteMany({ manualId: id });
  }
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
    res.json({ ok: true, mensaje: 'Manual eliminado correctamente.' });
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

    // El tipo de conocimiento se resuelve contra las categorías dinámicas
    // de MongoDB. Si no se envía, se usa la categoría general.
    const categoria = await ragCategorias.resolverCategoriaParaIngesta(req.body.categoriaId, {
      creadoPor: req.user?.uid,
    });

    const rutaLocal = path.relative(path.join(__dirname, '..'), req.file.path);
    referencia = await db.collection('archivos').add({
      nombre: String(req.body.nombre || path.parse(req.file.originalname).name).trim(),
      descripcion: String(req.body.descripcion || '').trim(),
      nombreArchivo: req.file.originalname,
      rutaLocal,
      tipoMime: req.file.mimetype || 'application/octet-stream',
      tamano: req.file.size,
      extension: path.extname(req.file.originalname || '').toLowerCase(),
      // La categoría queda registrada en el documento para poder mover sus
      // vectores a la papelera correcta más adelante.
      categoriaId: categoria.id,
      categoriaNombre: categoria.nombre,
      categoriaColeccion: categoria.coleccion,
      categoriaColeccionPapelera: categoria.coleccionPapelera,
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
      // La categoría se graba en cada vector para poder auditar y aislar
      // el origen del embedding.
      categoriaId: categoria.id,
      categoriaNombre: categoria.nombre,
      fechaIndexacion: new Date(),
    }));
    const vectores = resultados.filter((resultado) => resultado && !resultado.error && Array.isArray(resultado.embedding));
    if (!vectores.length) throw new Error('No se pudo generar embeddings para el contenido del archivo.');
    // Los embeddings van a la colección vectorial de la categoría elegida.
    await getDB().collection(categoria.coleccion).insertMany(vectores, { ordered: false });
    await referencia.update({ estadoIndexacion: 'completada', fragmentosIndexados: vectores.length, actualizadoEn: new Date() });
    res.status(201).json({
      ok: true,
      archivo: { id: referencia.id, categoriaId: categoria.id, categoriaNombre: categoria.nombre },
      mensaje: `Archivo guardado e indexado correctamente en "${categoria.nombre}" para el asistente IA.`,
    });
  } catch (error) {
    console.error('Error al cargar archivo colaborativo:', error);
    if (referencia) await referencia.update({ estadoIndexacion: 'error', errorIndexacion: error.message, actualizadoEn: new Date() }).catch(() => {});
    res.status(error.status || 500).json({ ok: false, error: error.message || 'No se pudo procesar el archivo.' });
  }
});

// Un archivo solo se lista y se descarga si su categoría está entre las
// fuentes permitidas para el rol. Así, quitarle una categoría a un rol en
// Conocimiento y permisos por rol le oculta también los archivos.
//
// Los archivos antiguos sin categoría registrada se muestran a todos, para
// no dejarlos inaccesibles.
function puedeVerArchivoEnCategoria(archivo, categoriasPermitidas) {
  const id = archivo?.categoriaId;
  if (!id) return true;
  return categoriasPermitidas.has(id);
}

app.get('/api/archivos', verifyToken, async (req, res) => {
  try {
    if (!usuarioActivo(req, res)) return;
    const permitidas = await ragCategorias.obtenerFuentesPermitidas(req.user.rol);
    const permitidasIds = new Set(permitidas.map((categoria) => categoria.id));

    const snapshot = await db.collection('archivos').where('activo', '==', true).get();
    const archivos = snapshot.docs
      .map((documento) => ({ id: documento.id, ...documento.data() }))
      .filter((archivo) => archivo.eliminado !== true)
      .filter((archivo) => puedeVerArchivoEnCategoria(archivo, permitidasIds));

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

    // Misma regla que el listado: la categoría del archivo tiene que estar
    // permitida para el rol, o el archivo no existe para ese usuario.
    const permitidas = await ragCategorias.obtenerFuentesPermitidas(req.user.rol);
    const permitidasIds = new Set(permitidas.map((categoria) => categoria.id));
    if (!puedeVerArchivoEnCategoria(item, permitidasIds)) {
      return res.status(403).json({
        ok: false,
        error: 'No tienes acceso a esta categoría de información.',
      });
    }

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

// Devuelve el par de colecciones (activa + papelera) de una categoría.
// Si el documento no tiene categoría registrada se usa la general,
// que es la que usa el sistema desde su inicio. El nombre de la colección
// se lee siempre de la categoría guardada en MongoDB; nunca se escribe
// aquí para no tener que modificar el código al agregar una fuente.
async function coleccionesDeCategoria(item) {
  const id = item?.categoriaId || ragCategorias.CATEGORIA_POR_DEFECTO;
  const categoria = await ragCategorias.obtenerCategoria(id);
  if (!categoria) {
    return {
      categoria: null,
      activa: null,
      papelera: null,
      error: `La categoría "${id}" no existe o ya no está disponible.`,
    };
  }
  return {
    categoria,
    activa: categoria.coleccion,
    papelera: categoria.coleccionPapelera,
  };
}

async function moverArchivoAPapelera(id, user) {
  const referencia = db.collection('archivos').doc(id);
  const documento = await referencia.get();
  if (!documento.exists) return { id, ok: false, error: 'Archivo no encontrado.' };
  const item = documento.data();
  if (item.eliminado === true) return { id, ok: false, error: 'El archivo ya está en la papelera.' };
  if (!puedeGestionarArchivo(user, item)) return { id, ok: false, error: 'Solo puedes eliminar archivos que tú subiste.' };

  // Migrar los vectores de RAG a la papelera DE SU CATEGORÍA, para no
  // mezclar documentos eliminados de fuentes distintas.
  const { activa, papelera, error } = await coleccionesDeCategoria(item);
  if (error) return { id, ok: false, error };

  try {
    const mongoDb = getDB();
    const vectores = await mongoDb.collection(activa).find({ archivoId: id }).toArray();

    if (vectores.length > 0) {
      // Insertar en la papelera de esa categoría
      await mongoDb.collection(papelera).insertMany(vectores, { ordered: false });
      // Eliminar de la colección activa
      await mongoDb.collection(activa).deleteMany({ archivoId: id });
      console.log(`[PAPELERA] Migrados ${vectores.length} vectores del archivo ${id} de "${activa}" a "${papelera}"`);
    }
  } catch (falloMigracion) {
    // Si los vectores no salen de la colección activa, el contenido seguiría
    // respondiendo en el chat. No se marca el archivo como eliminado para no
    // romper la promesa de que la papelera saca el conocimiento de circulation.
    console.error(`[PAPELERA] Error al migrar vectores del archivo ${id}:`, falloMigracion.message);
    return {
      id,
      ok: false,
      error:
        'No se pudo retirar el contenido del buscador, por lo que el archivo no se movió a la papelera. Inténtalo de nuevo.',
    };
  }

  await referencia.update({
    eliminado: true,
    eliminadoPor: user.uid,
    eliminadoPorNombre: nombreUsuarioActual(user),
    eliminadoEn: new Date(),
  });
  return { id, ok: true };
}

async function restaurarArchivoDePapelera(id) {
  const documento = await db.collection('archivos').doc(id).get();
  if (!documento.exists) return { id, ok: false, error: 'Elemento no encontrado.' };

  const item = documento.data();

  // Un archivo puede estar en la papelera por dos motivos muy distintos:
  // porque alguien lo borró, o porque se desactivó toda su categoría. En el
  // segundo caso la operación era de colección, así que no se deshace archivo
  // por archivo: se reactiva la categoría completa desde Conocimiento y
  // permisos por rol. Permitirlo aquí dejaría la categoría a medias, con
  // algunos archivos dentro y otros fuera.
  if (item.eliminadoPorCategoria === true) {
    return {
      id,
      ok: false,
      error:
        'Este archivo se mandó a la papelera al desactivar toda su categoría. Reactívala desde Conocimiento y permisos por rol.',
    };
  }

  const { activa, papelera, error } = await coleccionesDeCategoria(item);
  if (error) return { id, ok: false, error };

  try {
    const mongoDb = getDB();
    const vectoresPapelera = await mongoDb.collection(papelera).find({ archivoId: id }).toArray();

    if (vectoresPapelera.length > 0) {
      // Insertar de vuelta en la colección activa de su categoría
      await mongoDb.collection(activa).insertMany(vectoresPapelera, { ordered: false });
      // Eliminar de la papelera de esa categoría
      await mongoDb.collection(papelera).deleteMany({ archivoId: id });
      console.log(`[PAPELERA] Restaurados ${vectoresPapelera.length} vectores del archivo ${id} de "${papelera}" a "${activa}"`);
    }
  } catch (falloRestauracion) {
    console.error(`[PAPELERA] Error al restaurar vectores del archivo ${id}:`, falloRestauracion.message);
    return {
      id,
      ok: false,
      error:
        'No se pudo devolver el contenido al buscador, por lo que el archivo sigue en la papelera. Inténtalo de nuevo.',
    };
  }

  await db.collection('archivos').doc(id).update({
    eliminado: false,
    eliminadoPor: null,
    eliminadoPorNombre: null,
    eliminadoEn: null,
  });
  return { id, ok: true };
}

async function eliminarArchivoPermanentemente(id, data) {
  // Se purga en la colección activa y en la de papelera de la categoría,
  // porque el documento pudo estar en cualquiera de las dos.
  const { activa, papelera, error } = await coleccionesDeCategoria(data);
  if (error) return { id, ok: false, error };
  const mongoDb = getDB();
  for (const coleccion of new Set([activa, papelera])) {
    try {
      await mongoDb.collection(coleccion).deleteMany({ archivoId: id });
    } catch (error) {
      console.error(`[PAPELERA] No se pudieron eliminar vectores de ${id} en ${coleccion}:`, error.message);
    }
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
    // Los archivos que están en la papelera porque su categoría está
    // desactivada NO se purgan: si al reactivarla el Administrador espera
    // encontrarlos, no deben desaparecer por estar un mes desactivada.
    if (data.eliminadoPorCategoria === true) continue;
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

// Coseno entre dos vectores. Los embeddings llegan normalizados, así que el
// producto escalar basta; se divide igualmente para no depender de eso.
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

// Respaldo para categorías sin índice vectorial en Atlas: recorre los
// documentos de la colección y devuelve los más parecidos al vector de la
// consulta. Solo es adecuado mientras la colección sea pequeña, por eso la
// consola avisa para crear el índice en Atlas cuando el volumen crezca.
const MAX_DOCUMENTOS_REVISADOS = 4000;

async function buscarPorSimilitudEnMemoria(coleccion, vectorConsulta, fuente, limite) {
  const documentos = await coleccion
    .find(
      { embedding: { $exists: true } },
      {
        projection: {
          manualId: 1,
          recursoId: 1,
          archivoId: 1,
          nombreManual: 1,
          titulo_seccion: 1,
          contenido_texto: 1,
          embedding: 1,
        },
      }
    )
    .limit(MAX_DOCUMENTOS_REVISADOS)
    .toArray();

  if (!documentos.length) return [];

  const puntuados = documentos.map((documento) => ({
    documento,
    score: similitudCoseno(vectorConsulta, documento.embedding),
  }));

  puntuados.sort((a, b) => b.score - a.score);

  return puntuados
    .slice(0, limite)
    .map(({ documento, score }) => {
      const { embedding, ...resto } = documento;
      return {
        ...resto,
        score,
        categoriaId: fuente.id,
        categoriaNombre: fuente.nombre,
        busquedaEnMemoria: true,
      };
    });
}

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

      // --------------------------------------------------------
      // FILTRO DETERMINISTA DE ALCANCE (antes de llamar al modelo)
      // --------------------------------------------------------

      const CIERRE_FUERA_DE_ALCANCE =
        'Esa consulta está fuera de mi alcance. Soy el asistente de North Services y solo puedo ayudarte con información de la empresa. ¿Te puedo ayudar con alguno de estos temas?';

      const CIERRE_SIN_CODIGO =
        'No dispongo de scripts ni código programable en la documentación técnica de North Services.';

      const normalizar = t => t
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

      const pNorm = normalizar(preguntaLimpia);

      const pideCodigo = [
        'script', 'scripts', 'codigo', 'programa', 'programar',
        'python', 'javascript', 'java ', 'javascript', 'sql',
        'bash', 'powershell', 'html', 'css', 'json', 'algoritmo',
        'algoritmos', 'funcion', 'clase', 'base de datos', 'pandas',
        'numpy', 'react', 'node', 'api ', 'backend', 'frontend',
        'calculadora', 'formula', 'diagrama de flujo', 'pseudocodigo',
        'hazme un programa', 'escribe un programa'
      ].some(t => pNorm.includes(t));

      // Starlink como compañía (fundación/historia/etc.) y otros
      // temas generales de conocimiento externo.
      const fueraDeAlcance = [
        'cuando se fundo', 'cuando fue fundad', 'fecha de fundacion',
        'quien fundo', 'historia de starlink', 'fundada en', 'fundado en',
        'starlink fue', 'starlink es una empresa', 'satelite', 'cobertura',
        'orbital', 'musks', 'elon musk', 'spacex',
        'presidente de', 'ceo de', 'quien es el', 'biografia',
        'fibonacci', 'ecuacion', 'integral', 'derivada', 'teorema',
        'paises', 'capital de', 'presidente de mexico', 'loteria',
        'horoscopo', 'receta de', 'futbol', 'clima de', 'dolar',
        'bitcoin', 'acciones', 'personas famosos'
      ].some(t => pNorm.includes(t));

      if (pideCodigo || fueraDeAlcance) {
        const mensajeFuera = pideCodigo && !fueraDeAlcance
          ? CIERRE_SIN_CODIGO
          : CIERRE_FUERA_DE_ALCANCE;

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders && res.flushHeaders();

        res.write(
          `data: ${JSON.stringify({
            tipo: 'texto',
            texto: mensajeFuera
          })}\n\n`
        );

        console.log(
          `[CHAT] Consulta fuera de alcance bloqueada: "${preguntaLimpia}"`
        );

        return res.end();
      }

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

      // --------------------------------------------------------
      // FUENTES AUTORIZADAS PARA EL ROL DE ESTE USUARIO
      // --------------------------------------------------------
      // La lista se resuelve en el backend a partir de la categoría
      // seleccionada en cada documento. El cliente NO puede pedir
      // fuentes: cambiarla a mano en la petición HTTP no sirve.
      //
      // El Administrador recibe todas las categorías activas, así que
      // una categoría nueva queda disponible para él automáticamente.
      const fuentesAutorizadas =
        await ragCategorias.obtenerFuentesPermitidas(
          req.user.rol
        );

      console.log(
        `[RAG] Rol "${req.user.rol || 'sin rol'}" → fuentes: ${
          fuentesAutorizadas.length
            ? fuentesAutorizadas
                .map((fuente) => fuente.coleccion)
                .join(', ')
            : 'ninguna'
        }`
      );

      // Se averigua qué categorías tienen búsqueda vectorial disponible.
      // Atlas no lanza error al consultar un índice inexistente: devuelve
      // cero filas, así que sin esta comprobación una categoría recién
      // creada parecería vacía.
      const indicesDisponibles = await ragCategorias
        .descubrirIndicesVectoriales()
        .catch(() => new Map());
      const fuentesListas = fuentesAutorizadas.map((fuente) => ({
        ...fuente,
        tieneIndice: indicesDisponibles.has(fuente.coleccion),
      }));

      const buscarEnFuente = async (fuente) => {
        // Las colecciones de papelera nunca participan en la búsqueda.
        if (ragCategorias.esColeccionPapelera(fuente.coleccion)) return [];

        // Una categoría recién creada todavía no tiene índice vectorial, y
        // Atlas NO avisa cuando se consulta un índice inexistente: devuelve
        // cero resultados sin error. Por eso la ruta se decide mirando si el
        // índice existe, y no confiando en capturar una excepción.
        if (!fuente.tieneIndice) {
          const porSimilitud = await buscarPorSimilitudEnMemoria(
            mongoDb.collection(fuente.coleccion),
            vectorConsulta,
            fuente,
            RAG_LIMIT
          );
          console.log(
            `[CHAT] "${fuente.coleccion}": ${porSimilitud.length} coincidencias por búsqueda directa`
          );
          return porSimilitud;
        }

        try {
          const filas = await mongoDb
            .collection(fuente.coleccion)
            .aggregate([
              {
                $vectorSearch: {
                  index: fuente.indiceVectorial,

                  path: 'embedding',

                  queryVector:
                    vectorConsulta,

                  numCandidates:
                    RAG_NUM_CANDIDATES,

                  limit: RAG_LIMIT
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

          return filas.map((fila) => ({ ...fila, categoriaId: fuente.id, categoriaNombre: fuente.nombre }));
        } catch (error) {
          // El índice existía pero la consulta falló. Se recorre la colección
          // y se calcula la similitud en memoria para no dejar la categoría
          // muda.
          const porSimilitud = await buscarPorSimilitudEnMemoria(
            mongoDb.collection(fuente.coleccion),
            vectorConsulta,
            fuente,
            RAG_LIMIT
          );
          if (porSimilitud.length > 0) {
            console.warn(
              `[CHAT] "${fuente.coleccion}" se consultó por búsqueda directa (${error.message}).`
            );
            return porSimilitud;
          }
          console.error(`[CHAT] No se pudo buscar en "${fuente.coleccion}": ${error.message}`);
          return [];
        }
      };

      // Si la pregunta es sobre reportes de operaciones, la respuesta sale de Drive
// y los folletos no aportan nada. Antes se buscaban igual: costaban segundos y
// además contaminaban la respuesta, porque el modelo terminaba contestando
// sobre el catálogo de productos en lugar de sobre los torque logs.
const esPreguntaDeReportes = esPreguntaReportesOperaciones(preguntaLimpia);

const resultadosPorFuente = esPreguntaDeReportes
        ? []
        : await Promise.all(
          fuentesListas.map(buscarEnFuente)
        );

      const filasContexto = resultadosPorFuente.flat();

      // ========================================================
      // ORDEN GLOBAL POR PUNTUACIÓN
      // ========================================================

      filasContexto.sort(
        (a, b) => (b.score || 0) - (a.score || 0)
      );

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

      // --------------------------------------------------------
      // ORDEN POR FECHA REAL DE ARCHIVO (para torque logs)
      // El score de similitud NO implica orden temporal: dos
      // torque logs distintos tienen scores casi idénticos. Si el
      // usuario pide "el primer torque log", se ordena por la fecha
      // del nombre de archivo (AAAAMMDD_HHMMSS) y no por score.
      // --------------------------------------------------------

      const fechaDesdeNombre = nombre => {
        const m = String(
          nombre || ''
        ).match(/(\d{4})(\d{2})(\d{2})[_-]?(\d{2})?(\d{2})?(\d{2})?/);

        if (m) {
          return `${m[1]}-${m[2]}-${m[3]}T${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}`;
        }

        const m2 = String(
          nombre || ''
        ).match(/(\d{4})[-_](\d{2})[-_](\d{2})/);

        if (m2) {
          return `${m2[1]}-${m2[2]}-${m2[3]}T00:00:00`;
        }

        return null;
      };

      const esTorqueLog = nombre => /torque[\s_-]?log/i.test(
        String(nombre || '')
      );

      const pidePrimerLog =
        /primer|primero|primer torque|mas antiguo|más antiguo|inicial/i.test(
          preguntaLimpia
        ) &&
        /torque/i.test(
          preguntaLimpia
        );

      if (pidePrimerLog) {
        // -------------------------------------------------------------
        // "el primer torque log SUBIDO" = el que se subió primero.
        // Se resuelve contra la colección 'archivos' usando creadoEn
        // (orden real de subida), no por el nombre ni por el score.
        // -------------------------------------------------------------
        let nombreMasAntiguoSubido = null;

        try {
          const torqueDocs = await getDB()
            .collection('archivos')
            .find({
              nombre: {
                $regex: 'torque[\\s_-]?log',
                $options: 'i'
              }
            })
            .sort({ creadoEn: 1 })
            .limit(1)
            .toArray();

          if (
            torqueDocs.length > 0 &&
            torqueDocs[0].nombre
          ) {
            nombreMasAntiguoSubido = torqueDocs[0].nombre;
            console.log(
              `[CHAT] Primer torque log SUBIDO (por creadoEn): ${nombreMasAntiguoSubido}`
            );
          }
        } catch (errorSubida) {
          console.error(
            `[CHAT] No se pudo resolver orden de subida: ${errorSubida.message}`
          );
        }

        if (nombreMasAntiguoSubido) {
          resultadosRelevantes.sort((a, b) => {
            if (a.nombreManual === nombreMasAntiguoSubido) return -1;
            if (b.nombreManual === nombreMasAntiguoSubido) return 1;

            const fa = fechaDesdeNombre(a.nombreManual);
            const fb = fechaDesdeNombre(b.nombreManual);

            if (fa && fb) return fa.localeCompare(fb);
            if (fa) return -1;
            if (fb) return 1;

            return (
              (b.score || 0) - (a.score || 0)
            );
          });
        } else {
        const conFecha = resultadosRelevantes
          .map(fila => ({
            fila,
            fecha: fechaDesdeNombre(fila.nombreManual)
          }))
          .filter(x => x.fecha);

        if (conFecha.length > 0) {
          conFecha.sort(
            (a, b) => a.fecha.localeCompare(b.fecha)
          );

          const primero = conFecha[0].fila;
          const nombrePrimero = primero.nombreManual;

          const tienePrimeraFecha = esTorqueLog(nombrePrimero);

          if (tienePrimeraFecha) {
            console.log(
              `[CHAT] "Primer torque log" resuelto por fecha: ${nombrePrimero} (${conFecha[0].fecha})`
            );

            resultadosRelevantes.sort((a, b) => {
              if (a.nombreManual === nombrePrimero) return -1;
              if (b.nombreManual === nombrePrimero) return 1;
              const fa = fechaDesdeNombre(a.nombreManual);
              const fb = fechaDesdeNombre(b.nombreManual);

              if (fa && fb) return fa.localeCompare(fb);
              if (fa) return -1;
              if (fb) return 1;

              return (
                (b.score || 0) - (a.score || 0)
              );
            });
          }
        }
        }
      } else {
        // Sin pedido explícito de "el primero": aun así, ordena por
        // fecha cuando el nombre la tiene, para que el orden del
        // contexto sea cronológico y no aleatorio por score.
        resultadosRelevantes.sort((a, b) => {
          const fa = fechaDesdeNombre(a.nombreManual);
          const fb = fechaDesdeNombre(b.nombreManual);

          if (fa && fb) return fa.localeCompare(fb);
          if (fa) return -1;
          if (fb) return 1;

          return (
            (b.score || 0) - (a.score || 0)
          );
        });
      }

      console.log(
        `[CHAT] Resultados relevantes: ${resultadosRelevantes.length}`
      );

      // ========================================================
      // 4. CONSULTA STARLINK BOT
      // ========================================================

      const inicioStarlink = Date.now();
      let contextoStarlink = '';

      // Detectar si la pregunta está relacionada con Starlink.
      //
      // NOTA: la lista incluye términos que normalmente NO irían con
      // "Starlink" pero que el usuario usa para referirse a un equipo
      // específico (ej: "fluidos", "perforación", "oficinas", "lote vii",
      // nombre de ubicación/comentario). Esto es intencional: después
      // de consultar la BD, si ningún equipo coincide por esos términos,
      // el contextoStarlink se genera igual pero con un preámbulo que
      // le dice al LLM "esta información corresponde a kits Starlink",
      // y si la pregunta no era de Starlink, simplemente no la usa.
      const palabrasClaveStarlink = [
        'starlink', 'internet satelital', 'vencer', 'pago starlink',
        'facturación starlink', 'kit starlink', 'antena starlink',
        'conexión satelital', 'equipo starlink', 'kit', 'antena',
        'codigo kit', 'código kit', 'serie antena', 'equipo',
        'pago', 'pagado', 'no pagado', 'vencido', 'factura', 'facturación',
        'fluido', 'fluidos', 'linea de fluidos', 'línea de fluidos',
        'perforacion', 'perforación', 'direccional', 'pozo', 'pozos',
        'ubicacion', 'ubicación', 'oficinas', 'lote', 'campo', 'yacimiento',
        'fecha ultimo pago', 'fecha último pago', 'inicio periodo',
      ];
      const preguntaMinuscula = preguntaLimpia.toLowerCase();
      const esPreguntaStarlink = palabrasClaveStarlink.some(palabra => preguntaMinuscula.includes(palabra));

      console.log(`[CHAT] Pregunta: "${preguntaLimpia}"`);
      console.log(`[CHAT] ¿Es pregunta Starlink?: ${esPreguntaStarlink}`);

      if (esPreguntaStarlink) {
        // Starlink no es una categoría de conocimiento: es un módulo
        // independiente. Su acceso se decide con la configuración por
        // rol que guarda el Administrador, sin condiciones escritas en
        // el código. El Administrador siempre tiene acceso.
        const puedeUsarStarlink =
          await ragCategorias.puedeAccederModulo(req.user.rol, 'starlink');

        if (!puedeUsarStarlink) {
          console.log(`[CHAT] Acceso a Starlink denegado para el rol "${req.user.rol || 'sin rol'}"`);
          enviarEvento({
            tipo: 'estado',
            mensaje: 'Verificando disponibilidad de información...'
          });
        } else {
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

            // ============================================================
            // MATCHING INTELIGENTE
            // Filtra los equipos que tienen alguna coincidencia real con
            // la pregunta (comentario, ubicación, código, serie, correo,
            // estadoPago) para destacar al LLM los kits relevantes.
            // ============================================================
            const tokensPregunta = preguntaMinuscula
              .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
              .split(/[^a-z0-9]+/i)
              .filter(t => t.length >= 3);

            const coincideEquipo = (pozo) => {
              const campos = [
                pozo.ubicacion, pozo.codigoKit, pozo.serieAntena,
                pozo.comentario, pozo.correo, pozo.estadoPago,
              ].filter(Boolean).join(' ')
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .toLowerCase();

              return tokensPregunta.some(tok => campos.includes(tok));
            };

            const equiposRelevantes = datosStarlink.filter(coincideEquipo);

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

            const estadoTxt = (p) => (
              p.estadoPago === 'pagado' ? 'Pagado' : 'No pagado'
            );
            const servicioTxt = (p) => (
              p.estadoActivo ? 'Activo' : 'Inactivo'
            );

            const renderFichaEquipo = (p, idx) => `
FICHA EQUIPO ${idx + 1}:
  - Nombre/Ubicación: ${p.ubicacion}
  - Código KIT: ${p.codigoKit}
  - Serie Antena: ${p.serieAntena}
  - Correo: ${p.correo}
  - Día de pago: ${p.diaPago}
  - Estado Pago: ${estadoTxt(p)} (valor BD: ${p.estadoPago})
  - Servicio: ${servicioTxt(p)}
  - Monto: S/ ${p.monto}
  - Fecha inicio periodo: ${p.fechaInicioPeriodo || '-'}
  - Fecha último pago: ${p.fechaUltimoPago || '-'}
  - Comentario: ${p.comentario ? p.comentario : '(sin comentario)'}
`;

            contextoStarlink = `
INFORMACIÓN DE STARLINK (KITS / EQUIPOS SATELITALES)
====================================================
Total de equipos registrados: ${datosStarlink.length}

CÓMO RESPONDER A PREGUNTAS DE ESTA SECCIÓN:
- Primero identifica en PREGUNTA DEL USUARIO qué equipo se consulta.
- Compara con COMENTARIO, UBICACIÓN, CÓDIGO KIT y SERIE ANTENA.
- Cuando encuentres el equipo correcto, responde directamente
  usando ESTADO PAGO, UBICACIÓN y COMENTARIO del mismo, NO inventes
  datos ni reutilices cifras de otros kits.
- Si la pregunta es SOBRE PAGO de un kit específico, indica
  explícitamente el valor de estadoPago de ese equipo, su
  ubicación, su código KIT y si corresponde comentario.

ESTADO DE PAGOS GENERAL:
- Equipos pagados: ${datosStarlink.filter(p => p.estadoPago === 'pagado').length}
- Equipos no pagados: ${datosStarlink.filter(p => p.estadoPago === 'no_pagado').length}

ESTADO DE SERVICIO:
- Equipos activos: ${datosStarlink.filter(p => p.estadoActivo).length}
- Equipos inactivos: ${datosStarlink.filter(p => !p.estadoActivo).length}

${pozosPorVencer.length > 0 ? `
EQUIPOS POR VENCER (próximos 7 días):
${pozosPorVencer.map(p => `- ${p.ubicacion} (KIT: ${p.codigoKit}): Vence el día ${p.diaPago}, Monto: S/ ${p.monto}${!p.estadoActivo ? ' [INACTIVO]' : ''}`).join('\n')}
` : ''}

${pozosVencidos.length > 0 ? `
EQUIPOS VENCIDOS:
${pozosVencidos.map(p => `- ${p.ubicacion} (KIT: ${p.codigoKit}): Venció el día ${p.diaPago}, Monto: S/ ${p.monto}${!p.estadoActivo ? ' [INACTIVO]' : ''}`).join('\n')}
` : ''}

${equiposRelevantes.length > 0 ? `
EQUIPOS QUE COINCIDEN CON LA PREGUNTA "${preguntaLimpia}":
${equiposRelevantes.map(renderFichaEquipo).join('\n')}
` : ''}

${datosStarlink.filter(p => p.comentario && p.comentario.trim()).length > 0 ? `
   COMENTARIOS DE EQUIPOS (tómalos como identificador principal
   cuando la pregunta mencione "fluido", "fluidos", "perforación",
   "lote", "oficinas", etc.):
${datosStarlink.filter(p => p.comentario && p.comentario.trim()).map(p => `- ${p.ubicacion} (KIT: ${p.codigoKit}) | COMENTARIO: ${p.comentario}`).join('\n')}
` : ''}

DETALLE COMPLETO DE EQUIPOS:
${datosStarlink.map(renderFichaEquipo).join('\n')}
`;
          }
        } catch (error) {
          console.error('[CHAT] Error al consultar Starlink:', error.message);
          console.error('[CHAT] Stack:', error.stack);
        }
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
      // 4B. REPORTES DE OPERACIONES (GOOGLE DRIVE)
      // ========================================================

      const inicioDrive = Date.now();
      let contextoDrive = '';
      console.log(`[CHAT] ¿Es pregunta de reportes?: ${esPreguntaDeReportes}`);

      if (esPreguntaDeReportes) {
        contextoDrive = await obtenerContextoReportesOperaciones(preguntaLimpia, enviarEvento);
        console.log(`[CHAT] Drive: ${Date.now() - inicioDrive} ms`);
        console.log(`[CHAT] Contexto Drive generado: ${contextoDrive ? 'SÍ' : 'NO'}`);
      }

      // Cuando la respuesta se apoya en el contexto de Google Drive se va
      // directo al servidor local. Gemini devuelve 503 con mucha frecuencia
      // y, tras reintentar tres modelos, el usuario llegaba a esperar casi
      // dos minutos para obtener la misma respuesta.
      //
      // Además, en ese caso los fragmentos de los manuales se dejan fuera
      // del prompt: el modelo local terminaba respondiendo sobre los
      // folletos y concluía que no había torque logs, cuando el listado de
      // Drive sí los tenía.
      const usarServidorLocalDirecto = Boolean(contextoDrive);

      // ========================================================
      // 5. NO HAY INFORMACIÓN
      // ========================================================

      if (
        resultadosRelevantes.length ===
        0 &&
        !contextoStarlink &&
        !contextoDrive
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
      // 4C. DESCARGAS LIGADAS A LOS DOCUMENTOS RECUPERADOS
      // ========================================================
      // Cada documento recuperado de MongoDB puede tener un archivo o software
      // ligado. Se resuelve ANTES de armar el contexto para que el modelo sepa
      // que esos materiales SÍ están disponibles y no responda "no se menciona".

      const solicitaDescarga = /\b(descarga|descargar|download|software|instalador|archivo|archivos|manual|manuales|brochure|brochures|folleto|folletos|cat[áa]logo|cat[áa]logos|ficha|documento|documentos)\b/i.test(preguntaLimpia);
      const descargasPorFuente = new Map();
      if (solicitaDescarga) {
        const recursosIds = [...new Set(resultadosRelevantes.map((f) => f.recursoId).filter(Boolean))];
        const archivosIds = [...new Set(resultadosRelevantes.map((f) => f.archivoId).filter(Boolean))];
        const manualesIds = [...new Set(resultadosRelevantes.map((f) => f.manualId).filter(Boolean))];
        const recursos = await Promise.all(recursosIds.map(async (id) => ({ id, documento: await db.collection('recursos').doc(id).get() })));
        const archivos = await Promise.all(archivosIds.map(async (id) => ({ id, documento: await db.collection('archivos').doc(id).get() })));
        const manuales = await Promise.all(manualesIds.map(async (id) => ({ id, documento: await db.collection('manuales').doc(id).get() })));

        // Verificar si el usuario tiene acceso al módulo software_y_manuales
        const tieneAccesoRecursos = await ragCategorias.puedeAccederModulo(req.user.rol, 'software_y_manuales');

        recursos.forEach(({ id, documento }) => {
          if (!documento.exists || documento.data().activo !== true) return;
          const recurso = documento.data();
          const botones = [];
          // Solo agregar botones de descarga si el usuario tiene acceso al módulo software_y_manuales
          if (tieneAccesoRecursos) {
            if (recurso.software?.rutaLocal) botones.push({ etiqueta: recurso.software?.nombreArchivo || 'software', ruta: `/api/recursos/${id}/software/download` });
            if (recurso.manual?.rutaLocal) botones.push({ etiqueta: recurso.manual?.nombreArchivo || 'manual', ruta: `/api/recursos/${id}/manual/download` });
          }
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

      const obtenerDescargasFuente = (f) =>
        f.recursoId
          ? (descargasPorFuente.get(`recurso:${f.recursoId}`) || [])
          : (f.archivoId
            ? (descargasPorFuente.get(`archivo:${f.archivoId}`) || [])
            : (descargasPorFuente.get(`manual:${f.manualId}`) || []));

      // ========================================================
      // 5. CONTEXTO
      // ========================================================

      const inicioContexto =
        Date.now();

      const contextoRecuperado =
        resultadosRelevantes
          .map(
            (f, index) => {
              const descargasFuente = obtenerDescargasFuente(f);
              const bloqueDescargas = descargasFuente.length
                ? `\nMATERIALES DESCARGABLES LIGADOS A ESTE DOCUMENTO (el sistema ya muestra los botones de descarga en la interfaz): ${descargasFuente.map((d) => d.etiqueta).join(', ')}. REGLAS: (a) confirma al usuario que puede obtenerlos con el botón de descarga; (b) PROHIBIDO enumerar, listar o mencionar en tu respuesta los nombres de estos archivos (no digas ".zip", no digas ".pdf", no menciones los nombres de archivo); (c) no digas que no están disponibles ni que no se mencionan.\n`
                : '';
              return `
FUENTE ${index + 1}${index === 0 ? ' (PRIMERA Y PRIORITARIA: si el usuario pregunta por "el primer torque log", esta es la fuente que debes usar)' : ''}
Documento: ${
                f.nombreManual ||
                'Manual'
              }
Sección: ${
                f.titulo_seccion ||
                'Sin sección'
              }
Fecha del archivo: ${
                fechaDesdeNombre(f.nombreManual) ||
                'no disponible'
              }
Relevancia: ${Number(
                f.score
              ).toFixed(4)}
${bloqueDescargas}
Contenido:
${
                f.contenido_texto
              }
`;
            }
          )
          .join(
            '\n\n'
          );

      // Agregar contexto de Starlink y de reportes de operaciones (Drive) si están disponibles
      //
      // Si hay contexto de Drive, la respuesta se arma solo con ese material:
      // mezclarlo con los fragmentos de los manuales hacía que el modelo
      // respondiera sobre el catálogo equivocado.
      const contextoCompleto = [
        contextoStarlink,
        contextoDrive,
        usarServidorLocalDirecto ? '' : contextoRecuperado
      ]
        .filter(Boolean)
        .join('\n\n');

      const tiempoContexto =
        Date.now() -
        inicioContexto;

      // ========================================================
      // 6. PROMPT
      // ========================================================

      // Los reportes de operaciones llegan como texto plano de los PDFs,
      // así que el modelo local puede confundirse y acabar respondiendo
      // sobre otra fuente o inventando que no hay datos. Se le encuadra
      // exactamente qué tiene que responder.
      const instruccionDrive = `
INSTRUCCIÓN ESPECÍFICA PARA ESTA CONSULTA:

El CONTEXTO RECUPERADO contiene unicamente el catálogo y el contenido de los
reportes de operaciones alojados en Google Drive. Tu respuesta debe salir
exclusivamente de ese material.

1. Los reportes vienen identificados por su número y nombre, y su contenido
   aparece más abajo como texto plano. Si el usuario pidió una cantidad
   concreta ("los últimos dos"), el CONTENIDO ya corresponde exactamente a
   esos reportes y en ese orden: responde de esos y de ninguno más. No
   menciones ni deduzcas nombres de archivo que no estén ahí.
2. Redacta la respuesta como si hablaras con el usuario: nada de "fuente 1",
   "fuente 2", "las fuentes proporcionadas", "el contexto", "el documento" ni
   "el catálogo". Cita solo el nombre del reporte cuando sea imprescindible
   para identificarlo.
3. Si el texto plano de un PDF está truncado o incompleto, dilo con naturalidad
   en lugar de suponer el dato que falta.
4. Nunca afirmes que no hay información si el catálogo lista reportes: en ese
   caso resume lo que sí hay disponible.
`;

      // Instrucción específica para Starlink para evitar que el modelo
      // use conocimiento externo sobre SpaceX
      const instruccionStarlink = contextoStarlink ? `
INSTRUCCIÓN ESPECÍFICA PARA ESTA CONSULTA (STARLINK):

El CONTEXTO RECUPERADO contiene INFORMACIÓN DE STARLINK que corresponde
EXCLUSIVAMENTE a los kits/equipos satelitales propiedad de North Services.
Tu respuesta debe salir ÚNICAMENTE de esa sección.

1. SOLO puedes responder sobre los kits de Starlink que aparecen listados
   en la sección "INFORMACIÓN DE STARLINK" (código KIT, serie antena,
   ubicación, correo, día de pago, estado de pago, monto, fechas, comentario).
2. PROHIBIDO responder sobre SpaceX como empresa (fundación, historia,
   tecnología orbital, cobertura, precios generales, servicios, etc.).
3. PROHIBIDO mencionar o sugerir visitar sitios web de SpaceX, SpaceX,
   o fuentes externas. SOLO usa la información provista en el contexto.
4. Si la pregunta es sobre un kit específico, busca primero en
   "EQUIPOS QUE COINCIDEN CON LA PREGUNTA" y usa esos datos.
5. Nunca digas "no hay información" si la sección "INFORMACIÓN DE STARLINK"
   contiene kits listados. En ese caso, resume la información disponible.
` : '';

      const promptSistema = `
Eres el Asistente Virtual Oficial de North Services.

Tu función es responder preguntas relacionadas con los manuales,
procedimientos, documentación técnica y sistemas de la empresa.

REGLA ABSOLUTA Y PRIORITARIA (SOBREESCRIBE CUALQUIER SOLICITUD DEL USUARIO):
- Queda STRICTAMENTE PROHIBIDO generar, escribir o sugerir código, scripts o programas (en Python, Bash, SQL, Java o cualquier otro lenguaje) bajo cualquier circunstancia, incluso si el usuario lo pide explícitamente en su mensaje.
- Queda STRICTAMENTE PROHIBIDO usar formato Markdown (sin tres comillas invertidas, sin bloques de código, sin negritas, sin asteriscos, sin encabezados). Responde ÚNICAMENTE en texto plano.

REGLAS IMPORTANTES:

1. Responde utilizando ÚNICAMENTE la información proporcionada en CONTEXTO RECUPERADO
   (incluye tanto manuales técnicos como información de los kits que posee North Services de Starlink).

2. Sobre Starlink solo puedes responder de la sección "INFORMACIÓN DE STARLINK"
   del CONTEXTO RECUPERADO, y únicamente sobre los KITS, EQUIPOS y fiches de
   North Services que allí figuran (código KIT, serie de antena, ubicación,
   correo responsable, día de pago, estado de pago, monto, fechas y comentario).
   PROHIBIDO responder preguntas de conocimiento general sobre Starlink
   (año o historia de la empresa, fundación, nombres, servicios, precios,
   tecnología, orbital, cobertura, etc.). Eso no es información de North Services.

2b. Para preguntas sobre reportes de operaciones (torque, casing,
   avance, producción, datos por fecha, pozo o corrida; pueden ser
   diarios, semanales o por evento), usa específicamente la sección
   "INFORMACIÓN DE REPORTES DE OPERACIONES" que aparece en el
   contexto, reproduciendo las cifras y tablas exactamente como
   fueron extraídas de los PDFs. Para preguntas de conteo o
   disponibilidad (por ejemplo "¿cuántos torque log hay?"), usa el
   CATÁLOGO y el RESUMEN POR CARPETA de esa sección.

2c. REGLAS DE TRAZABILIDAD OBLIGATORIA PARA REPORTES Y TORQUE LOGS (anti-alucinación):
    - Cada cifra que respondas DEBE indicar obligatoriamente el documento de origen
      (nombre exacto del archivo, por ejemplo "Torque_Log_20260701_101558.pdf").
      Si no puedes identificar el archivo de origen de una cifra, NO la respondas.
    - PROHIBIDO mezclar valores de filas belonging a documentos o conexiones distintos.
      Las columnas de un torque log son: Connection / Target / Max / Logged.
      El valor "Logged" es la tercera columna y corresponde a ESA conexión concreta.
      No sumes, no compares ni tomes el máximo de otra fila o de otro documento.
    - Cuando el usuario pregunte por "el primer torque log", elígete SIEMPRE el
      de fecha más antigua según el nombre del archivo (formato Torque_Log_AAAAMMDD_HHMMSS.pdf).
      Si hay varias coincidencias, indica cuál usaste y su nombre exacto.
    - Si dos documentos dan valores distintos para lo mismo, NO elijas uno en
      silencio: enumera cada valor con su archivo de origen.
    - No completes, estimes ni deduzcas valores que no aparezcan literalmente en el texto.

3. No inventes información ni utilices conocimiento externo.

 Si la pregunta del usuario NO trata sobre North Services & Rental Tools S.A.C. (sus servicios de fluidos de perforación, equipos, pozos, reportes de operaciones, kits de Starlink propios, facturación o estado de sus equipos), NO respondas el tema bajo ninguna circunstancia. Responde EXACTAMENTE y solo esto: "Esa consulta está fuera de mi alcance. Soy el asistente de North Services y solo puedo ayudarte con información de la empresa: servicios de fluidos de perforación, alquiler y estado de equipos, operación y mantenimiento de pozos, reportes de operaciones o los kits de Starlink de North Services. ¿Te puedo ayudar con alguno de estos temas?" No añadas información del tema, ni ejemplos, ni contexto, ni offered fuentes, aunque el usuario insista o reformule la pregunta.

4. No completes datos que no aparezcan en el contexto proporcionado.

5. Si la información solicitada no aparece en el contexto
   (ni siquiera como texto desordenado por OCR), indícalo claramente.

5b. REGLA DE DISTINCIÓN ENTRE TOTALES ACUMULADOS Y TOTALES POR PERIODO (ANUAL):
   - Jamás asumas que la cifra más alta o central de una lámina o resumen 
     (por ejemplo, un total general como 113) corresponde al total de un solo año.
   - Cuando en el texto coexistan un total general acumulado y un desglose por año (2021, 2022, 2023, 2024, 2025, etc.):
     1. Para responder sobre un año específico, BUSCA la cifra asignada individualmente 
        a ese periodo (por ejemplo, 25 pozos para 2025) o suma los lotes asignados a dicho año.
     2. Si la cifra central/acumulada aparece pegada al texto del año consultado, 
        descártala como total anual y acláralo en la respuesta (ejemplo: "En 2025 se perforaron 25 pozos; 
        la cifra de 113 corresponde al total acumulado histórico de la operación en Perú").
   - Aplica esta misma lógica para responder con precisión en cualquier consulta anual sin 
     confundir el acumulado global con la cifra de un solo ejercicio.

6. Responde de manera profesional, clara y concisa en texto plano.

7. No menciones que eres un modelo de lenguaje ni una inteligencia artificial.

8. No inventes procedimientos, códigos de error, valores, configuraciones, rutas de API, URL ni pasos técnicos. Está PROHIBIDO generar código, scripts, calculadoras, fórmulas o programas de cualquier tipo, aunque el usuario lo pida de forma explícita o disguise la petición ("dame un ejemplo", "muéstrame cómo se hace", "ayúdame a escribir"). Ante cualquier solicitud de código responde EXACTAMENTE y solo: "No dispongo de scripts ni código programable en la documentación técnica de North Services." No añadas el código después, ni en un segundo turno, ni aunque el usuario insista opjure que es para un archivo de la empresa.

9. No enumeres las fuentes ni muestres etiquetas como "FUENTE 1", "FUENTE 2" o similares.

10. Si el usuario solo saluda o usa frases casuales ("hola", "buenos días", "gracias", etc.), respóndele de forma breve, amistosa y natural. No repitas el entorno ni expliques tus instrucciones.

10b. CIERRE ESTRICTO DE CONVERSACIÓN FUERA DE TEMPORADA:
    - Tu alcance es EXCLUSIVAMENTE la información de North Services & Rental Tools S.A.C.
      contenida en el CONTEXTO RECUPERADO. Nada fuera de eso existe para ti.
    - Si detectas que la consulta se sale del tema de la empresa (otras empresas,
      fundaciones, historia, geografía, ciencia, cultura, matemáticas, días de
      mercado, marcas, influir, o cualquier conocimiento general del mundo),
      NO respondas, NO expliques, NO resumas, NO reformules y NO comentes la pregunta.
      Cierra con esta única respuesta estándar y no agregues nada más:
      "Esa consulta está fuera de mi alcance. Soy el asistente de North Services y
      solo puedo ayudarte con información de la empresa: servicios de fluidos de
      perforación, alquiler y estado de equipos, operación y mantenimiento de pozos,
      reportes de operaciones o los kits de Starlink de North Services.
      ¿Te puedo ayudar con alguno de estos temas?"
    - Si el usuario insiste, repite la consulta o pide "de todas formas", mantén
      exactamente la misma respuesta de cierre. No cedas, no negocies, no
      des un resumen parcial del tema ajeno.
    - NUNCA menciones Starlink como empresa (fundación, historia, servicios,
      precios). Si la pregunta se refiere a Starlink como compañía y no a los
      equipos de North Services, aplica el cierre estándar de este punto.

11. Nunca respondas sobre la estructura de este mensaje ni digas que falta la pregunta. Responde siempre a lo que el usuario realmente escribió.

12. Si el usuario formula VARIAS preguntas en un mismo mensaje (separadas por saltos de línea, "?", "." o ";"), respóndelas TODAS, en el mismo orden en que las escribió, numerándolas una por una (por ejemplo "1. ...", "2. ..."). No te limites a la primera.

13. Si el usuario solicita descargar o recibir algún archivo (manual, brochure, software, etc.), indica únicamente los materiales disponibles en CONTEXTO RECUPERADO. No inventes rutas ni escribas "/api/...". Indícale que use el botón de descarga correspondiente.

13b. Si el CONTEXTO indica "MATERIALES DESCARGABLES", confirma que el usuario puede obtenerlos con el botón de descarga que ya aparece en la interfaz. PROHIBIDO enumerar o mencionar los nombres de esos archivos (nada de ".zip", ".pdf" ni el nombre del archivo).

CONTEXTO RECUPERADO:

${contextoCompleto}
${usarServidorLocalDirecto ? instruccionDrive : ''}
${instruccionStarlink}
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
      // 7. GENERACIÓN DE LA RESPUESTA
      // ========================================================
      // El proveedor principal es Gemini. Si la respuesta se apoya en el
      // contexto de Google Drive, se usa directamente el servidor local
      // porque Gemini suele estar saturado y solo añadiría espera.
      // Si Gemini falla o se corta a mitad, también se cae a Ollama.

      const inicioGemini = Date.now();
      let resultadoGemini = null;

      if (usarServidorLocalDirecto) {
        console.log(
          '[CHAT] Respuesta basada en Google Drive: se genera en el servidor local.'
        );
      }

      // --- Intento 1: Gemini ---
      if (!usarServidorLocalDirecto) {
        try {
          resultadoGemini =
            await generarContenidoGemini(promptSistema, enviarEvento);
        } catch (errorGemini) {
          console.error(`[CHAT] Gemini falló: ${errorGemini.message}`);
          resultadoGemini = null;
        }
      }

      // --- Si Gemini cortó la respuesta a mitad (stream incompleto), reintentar
      //     una vez. Se emite texto_reset para que el frontend descarte el texto
      //     parcial ya mostrado en lugar de concatenarlo. ---
      if (resultadoGemini && !resultadoGemini.completo) {
        console.warn(
          `[CHAT] Respuesta de Gemini interrumpida (finishReason=${resultadoGemini.finishReason ?? 'ninguno'}), reintentando...`
        );

        enviarEvento({ tipo: 'texto_reset' });

        try {
          const reintento =
            await generarContenidoGemini(promptSistema, enviarEvento);

          if (reintento.completo) {
            resultadoGemini = reintento;
          } else {
            console.warn('[CHAT] El reintento de Gemini también quedó incompleto.');
          }
        } catch (errorReintento) {
          console.error(`[CHAT] Reintento de Gemini falló: ${errorReintento.message}`);
        }
      }

      // --- Si no hay una respuesta completa de Gemini, caer al servidor local. ---
      if (!resultadoGemini || !resultadoGemini.completo) {
        enviarEvento({ tipo: 'texto_reset' });

        // Con contexto de Drive el servidor local ya es el proveedor
        // principal, así que no se avisa de una caída que no ha ocurrido.
        if (!usarServidorLocalDirecto) {
          enviarEvento({
            tipo: 'estado',
            mensaje: 'El proveedor principal está ocupado, intentando servidor local...'
          });
        }

        try {
          resultadoGemini =
            await generarContenidoOllama(promptSistema, enviarEvento);
        } catch (errorOllama) {
          console.error(`[CHAT] Ollama falló: ${errorOllama.message}`);
          throw new Error('No fue posible completar la consulta.');
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
      // solicitaDescarga, descargasPorFuente y obtenerDescargasFuente ya se
      // calcularon en la sección 4C (antes del contexto) para que el modelo
      // conozca los materiales ligados. Aquí solo se emiten al frontend.

      const fuentes = resultadosRelevantes.map((f) => ({
        documento: f.nombreManual || 'Manual',
        seccion: f.titulo_seccion || 'Sin sección',
        relevancia: Number(f.score || 0),
        descargas: obtenerDescargasFuente(f),
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
// CATEGORÍAS DE CONOCIMIENTO Y PERMISOS RAG
// ============================================================
//
// Los endpoints de abajo son la superficie que usa el Administrador:
//   - listar y crear categorías de conocimiento,
//   - ver y guardar qué categorías puede consultar cada rol,
//   - consultar las categorías activas para la pantalla de subida.
//
// La matriz se guarda en MongoDB, por lo que agregar una categoría o un
// rol nuevo NO requiere modificar el código del RAG.
// ============================================================

// Estado real de las colecciones de conocimiento: cuáles existen en Atlas,
// con qué índice vectorial y a qué categoría pertenecen. Se lee de la base
// de datos, así que una fuente creada por cualquier medio queda visible.
app.get('/api/admin/rag/colecciones', verifyToken, requireAdmin, async (req, res) => {
  try {
    const colecciones = await ragCategorias.listarColeccionesVectoriales();
    res.json({ ok: true, colecciones });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Categorías activas disponibles para la pantalla de subida de archivos.
// No filtra por rol a propósito: elegir la categoría de un archivo nuevo
// no es lo mismo que poder consultar el contenido ya publicado.
app.get('/api/rag/categorias', verifyToken, async (req, res) => {
  try {
    if (!usuarioActivo(req, res)) return;
    const categorias = await ragCategorias.listarCategorias({ incluirInactivas: true });
    res.json({ ok: true, categorias });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/admin/rag/categorias', verifyToken, requireAdmin, async (req, res) => {
  try {
    const categorias = await ragCategorias.listarCategorias({ incluirInactivas: true });
    res.json({ ok: true, categorias });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Cualquier usuario autenticado puede crear una categoría al subir un archivo.
// No es una operación reservada al Administrador: si solo él pudiera crearlas,
// quien sube un documento no podría elegir dónde guardarlo.
//
// El rol del creador recibe el acceso en el mismo acto (ver
// `crearCategoria`), así que ve de inmediato lo que acaba de subir sin que
// nadie tenga que marcar permisos a mano.
app.post('/api/rag/categorias', verifyToken, async (req, res) => {
  try {
    if (!usuarioActivo(req, res)) return;
    const categoria = await ragCategorias.crearCategoria({
      nombre: req.body?.nombre,
      descripcion: req.body?.descripcion,
      creadoPor: req.user.uid,
      rolCreador: req.user.rol,
    });
    res.status(201).json({ ok: true, categoria, mensaje: `Categoría "${categoria.nombre}" creada correctamente. Ya tienes acceso a ella.` });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message });
  }
});

app.post('/api/admin/rag/categorias', verifyToken, requireAdmin, async (req, res) => {
  try {
    const categoria = await ragCategorias.crearCategoria({
      nombre: req.body?.nombre,
      descripcion: req.body?.descripcion,
      creadoPor: req.user.uid,
      rolCreador: req.user.rol,
    });
    res.status(201).json({ ok: true, categoria, mensaje: `Categoría "${categoria.nombre}" creada correctamente. Ya tienes acceso a ella.` });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message });
  }
});

app.put('/api/admin/rag/categorias/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    // El usuario se pasa al servicio para que la papelera atribuya el cambio a
    // una persona y no a un texto técnico sobre la categoría.
    const usuario = { uid: req.user.uid, nombre: nombreUsuarioActual(req.user) };
    const categoria = await ragCategorias.actualizarCategoria(req.params.id, req.body || {}, usuario);
    const avisos = categoria.avisos || [];
    res.json({
      ok: true,
      categoria,
      avisos,
      mensaje: `Categoría "${categoria.nombre}" actualizada.`,
    });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message });
  }
});

// Elimina la categoría. Por defecto borra también todos sus documentos; si
// el frontend envía ?papelera=true, la categoría se retira pero sus archivos
// quedan guardados en la papelera por si hay que recuperarlos.
app.delete('/api/admin/rag/categorias/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const aPapelera = String(req.query?.papelera || '') === 'true';
    const resultado = await ragCategorias.eliminarCategoria(req.params.id, {
      eliminarDocumentos: !aPapelera,
    });
    res.json({ ok: true, ...resultado });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message });
  }
});

// Matriz completa: categorías × roles + acceso a Starlink por rol.
app.get('/api/admin/rag/permisos', verifyToken, requireAdmin, async (req, res) => {
  try {
    const matriz = await ragCategorias.obtenerMatrizPermisos();
    res.json({ ok: true, ...matriz });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.put('/api/admin/rag/permisos/:rol', verifyToken, requireAdmin, async (req, res) => {
  try {
    const rol = req.params.rol;
    if (ragCategorias.esAdministrador(rol)) {
      // El Administrador tiene acceso total: no se le aplica una matriz
      // restrictiva ni hace falta marcarle cada categoría.
      const guardadoAdmin = await ragCategorias.guardarPermisosRol(rol, {
        categorias: (await ragCategorias.listarCategorias({ incluirInactivas: true })).map((categoria) => categoria.id),
        modulos: { starlink: true, software_y_manuales: true },
      });
      return res.json({
        ok: true,
        rol: guardadoAdmin.rol,
        permisos: guardadoAdmin,
        mensaje: 'El Administrador tiene acceso total a todas las categorías, Starlink y Software y Manuales.',
      });
    }

    const guardado = await ragCategorias.guardarPermisosRol(rol, {
      categorias: Array.isArray(req.body?.categorias) ? req.body.categorias : [],
      modulos: {
        starlink: req.body?.modulos?.starlink === true,
        software_y_manuales: req.body?.modulos?.software_y_manuales === true,
      },
    });
    res.json({
      ok: true,
      rol: guardado.rol,
      // Se devuelve lo que quedó realmente guardado: el backend descarta
      // categorías inexistentes. Así el panel se sincroniza sin volver a
      // cargar toda la matriz.
      permisos: guardado,
      mensaje: `Permisos de "${req.params.rol}" actualizados.`,
    });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message });
  }
});

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

      // El rol se guarda con la capitalización elegida por el
      // Administrador: "Contabilidad", "Técnico", "Ingeniero MWD", etc.
      // Solo se recorta el espacio sobrante; no se fuerza ningún valor.
      if (
        rol !== undefined
      ) {
        const rolLimpio =
          String(rol).trim();

        if (!rolLimpio) {
          return res.status(400).json({
            ok: false,
            error:
              'El rol no puede quedar vacío.'
          });
        }

        datosActualizar.rol =
          rolLimpio;
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
        // Permite al frontend bloquear "Restaurar": si el archivo está en la
        // papelera por una categoría desactivada, el cambio se revierte desde
        // el panel de conocimiento y no archivo por archivo.
        bloqueadoPorCategoria: data.eliminadoPorCategoria === true,
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
      const doc = await db.collection('archivos').doc(id).get();
      if (!doc.exists) { fallidos.push({ id, error: 'Elemento no encontrado.' }); continue; }
      const data = doc.data();
      if (!puedeGestionarArchivo(req.user, data)) { fallidos.push({ id, error: 'Sin permiso.' }); continue; }

      await restaurarArchivoDePapelera(id);
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

    await restaurarArchivoDePapelera(req.params.id);
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
  .then(async () => {
    // El sistema arranca sin categorías: las crea el Administrador desde el
    // panel. Aquí solo se registra el estado inicial en el log.
    await ragCategorias.inicializarRag().catch((error) =>
      console.error('[RAG] No se pudo inicializar el RAG:', error.message)
    );

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
