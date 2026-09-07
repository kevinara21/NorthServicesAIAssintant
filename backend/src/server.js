require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const PDFParser = require('pdf2json');

const { db } = require('./firebaseAdmin');
const { connectDB, getDB } = require('./db/mongodb');
const verifyToken = require('./middleware/verifyToken');

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

async function generarEmbedding(texto) {
  if (!texto || !texto.trim()) {
    throw new Error(
      'No se puede generar un embedding de un texto vacío.'
    );
  }

  const url =
    `https://generativelanguage.googleapis.com/v1/models/` +
    `gemini-embedding-001:embedContent?key=${process.env.GEMINI_API_KEY}`;

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
    const errorTexto =
      await response.text();

    throw new Error(
      `Error generando embedding (${response.status}): ${errorTexto}`
    );
  }

  const data =
    await response.json();

  const embedding =
    data?.embedding?.values;

  if (
    !Array.isArray(embedding) ||
    embedding.length === 0
  ) {
    throw new Error(
      'Gemini no devolvió un vector de embedding válido.'
    );
  }

  return embedding;
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
// GEMINI STREAMING
// ============================================================

async function generarContenidoGemini(
  prompt,
  enviarEvento
) {
  const apiKey =
    process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY no está configurada.'
    );
  }

  const modelo =
    'gemini-3.5-flash';

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${modelo}:streamGenerateContent?alt=sse&key=${apiKey}`;

  // ==========================================================
  // CONFIGURACIÓN
  // ==========================================================

  const REQUEST_TIMEOUT = 30000;

  const generationConfig = {
    maxOutputTokens: 256,

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
    // PETICIÓN A GEMINI
    // ========================================================

    const inicioFetchGemini =
      Date.now();

    console.log(
      `[CHAT] Gemini: enviando petición...`
    );

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

    const tiempoHttpGemini =
      Date.now() -
      inicioFetchGemini;

    console.log(
      `[CHAT] Gemini HTTP: ${tiempoHttpGemini} ms`
    );

    // ========================================================
    // ERROR GEMINI
    // ========================================================

    if (!respuestaGemini.ok) {
      const errorTexto =
        await respuestaGemini.text();

      console.error(
        `[GEMINI ERROR] HTTP ${respuestaGemini.status}`
      );

      console.error(
        `[GEMINI ERROR] ${errorTexto}`
      );

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
    res.json({
      ok: true,
      usuario: req.user
    });
  }
);

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

      let idSoftware =
        null;

      let idManual =
        null;

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

        const docZip =
          await db
            .collection(
              'software'
            )
            .add({
              nombre,
              descripcion: descripcionFinal,
              version:
                version ||
                'v1.0',
              nombreArchivo:
                fileZip.filename,
              rutaLocal:
                rutaRelativa,
              activo: true,
              fechaPublicacion:
                new Date()
            });

        idSoftware =
          docZip.id;
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

        // ------------------------------------------------------
        // FIREBASE
        // ------------------------------------------------------

        const docPdf =
          await db
            .collection(
              'manuales'
            )
            .add({
              nombre:
                nombre.trim(),

              descripcion: descripcionFinal,

              ...(soloManual
                ? {}
                : {
                    version:
                      version ||
                      'v1.0'
                  }),

              nombreArchivo:
                filePdf.filename,

              rutaLocal:
                rutaRelativa,

              activo: true,

              fechaCreacion:
                new Date()
            });

        idManual =
          docPdf.id;

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
                manualId:
                  docPdf.id,

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

        idSoftware,

        idManual
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
// SOFTWARE
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
        return res.json({
          ok: true,
          catalogo: []
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
        return res.json({
          ok: true,
          catalogo: []
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
      // 4. NO HAY INFORMACIÓN
      // ========================================================

      if (
        resultadosRelevantes.length ===
        0
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

      const tiempoContexto =
        Date.now() -
        inicioContexto;

      // ========================================================
      // 6. PROMPT
      // ========================================================

      const promptSistema = `
Eres el Asistente Virtual Oficial de North Services.

Tu función es responder preguntas relacionadas con los manuales,
procedimientos y documentación técnica disponibles.

REGLAS IMPORTANTES:

1. Responde ÚNICAMENTE utilizando la información proporcionada
   en CONTEXTO RECUPERADO.

2. No inventes información.

3. No completes datos que no aparezcan en los manuales.

4. Si la información solicitada no aparece en el contexto,
   indícalo claramente.

5. Responde de manera profesional, clara y concisa.

6. Cuando sea útil, menciona el documento o sección donde
   encontraste la información.

7. No menciones que eres un modelo de lenguaje.

8. No inventes procedimientos, códigos de error, valores,
   configuraciones ni pasos técnicos.

CONTEXTO RECUPERADO:

${contextoRecuperado}

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
      // 7. GEMINI
      // ========================================================

      const inicioGemini =
        Date.now();

      const resultadoGemini =
        await generarContenidoGemini(
          promptSistema,
          enviarEvento
        );

      const tiempoGemini =
        Date.now() -
        inicioGemini;

      const firstTokenMs =
        resultadoGemini.primerTokenMs
          ? resultadoGemini
              .primerTokenMs -
            inicioGemini
          : null;

      // ========================================================
      // 8. FUENTES
      // ========================================================

      const fuentes =
        resultadosRelevantes.map(
          (f) => ({
            documento:
              f.nombreManual ||
              'Manual',

            seccion:
              f.titulo_seccion ||
              'Sin sección',

            relevancia:
              Number(
                f.score || 0
              )
          })
        );

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
// GESTIÓN DE USUARIOS
// ============================================================

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
// INICIAR SERVIDOR
// ============================================================

const PORT =
  process.env.PORT ||
  8000;

connectDB()
  .then(() => {
    app.listen(
      PORT,
      () => {
        console.log(
          `Servidor corriendo en http://localhost:${PORT}`
        );

        console.log(
          `[CONFIG] RAG_SCORE_THRESHOLD=${RAG_SCORE_THRESHOLD}`
        );

        console.log(
          `[CONFIG] RAG_LIMIT=${RAG_LIMIT}`
        );

        console.log(
          `[CONFIG] RAG_NUM_CANDIDATES=${RAG_NUM_CANDIDATES}`
        );

        console.log(
          `[CONFIG] EMBEDDING_CONCURRENCY=${EMBEDDING_CONCURRENCY}`
        );
      }
    );
  })
  .catch(
    (error) => {
      console.error(
        'Fallo al conectar con MongoDB Atlas:',
        error
      );
    }
  );