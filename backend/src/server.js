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

const requireAdmin = (req, res, next) => {
  if (req.user.rol !== 'administrador') {
    return res.status(403).json({ ok: false, error: 'Acceso restringido únicamente a administradores.' });
  }
  next();
};

function crearSlug(texto) {
  return (texto || 'recurso')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Helper para extraer texto de PDF mediante pdf2json decodificando los caracteres
function extraerTextoPDF(buffer) {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser(null, 1);

    pdfParser.on('pdfParser_dataError', (errData) => reject(errData.parserError));
    pdfParser.on('pdfParser_dataReady', () => {
      try {
        // Extraer y decodificar caracteres especiales / espacios
        const textoBruto = pdfParser.getRawTextContent();
        const textoDecodificado = decodeURIComponent(textoBruto);
        resolve(textoDecodificado);
      } catch (e) {
        // En caso de que falle la decodificación en algún fragmento, retornar el texto bruto
        resolve(pdfParser.getRawTextContent());
      }
    });

    pdfParser.parseBuffer(buffer);
  });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const { nombre, version } = req.body;
    const nombreSlug = crearSlug(nombre);
    const versionSlug = (version || 'v1.0').toLowerCase().replace(/\s+/g, '');

    const esPdf = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf');
    const tipoCarpeta = esPdf ? 'manuals' : 'software';

    const folderPath = path.join(__dirname, '../storage', tipoCarpeta, nombreSlug, versionSlug);

    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    cb(null, folderPath);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({ storage });

const uploadUnificado = upload.fields([
  { name: 'zip', maxCount: 1 },
  { name: 'pdf', maxCount: 1 }
]);

function dividirTextoEnBloques(texto, tamanioBloque = 800) {
  const lineas = texto.split('\n');
  const bloques = [];
  let bloqueActual = '';

  for (const linea of lineas) {
    if ((bloqueActual + '\n' + linea).length > tamanioBloque) {
      if (bloqueActual.trim()) bloques.push(bloqueActual.trim());
      bloqueActual = linea;
    } else {
      bloqueActual += '\n' + linea;
    }
  }
  if (bloqueActual.trim()) bloques.push(bloqueActual.trim());
  return bloques;
}

async function generarEmbedding(texto) {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-embedding-001:embedContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { parts: [{ text: texto }] } })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Error embedding: ${JSON.stringify(data)}`);
  return data.embedding.values;
}

// --- PERFIL ---
app.get('/api/perfil', verifyToken, (req, res) => {
  res.json({ ok: true, usuario: req.user });
});

// --- ENDPOINT UNIFICADO SUBIDA DE RECURSOS (ADMIN) ---
app.post('/api/admin/upload-recurso-unificado', verifyToken, requireAdmin, uploadUnificado, async (req, res) => {
  try {
    const { nombre, descripcion, version } = req.body;
    const archivos = req.files || {};

    if (!archivos.zip && !archivos.pdf) {
      return res.status(400).json({ ok: false, error: 'Debe adjuntar al menos un archivo (ZIP o PDF).' });
    }

    const nombreSlug = crearSlug(nombre);
    const versionSlug = (version || 'v1.0').toLowerCase().replace(/\s+/g, '');

    let idSoftware = null;
    let idManual = null;

    // 1. Guardar Software ZIP
    if (archivos.zip && archivos.zip[0]) {
      const fileZip = archivos.zip[0];
      const rutaRelativa = path.join('storage', 'software', nombreSlug, versionSlug, fileZip.filename);

      const docZip = await db.collection('software').add({
        nombre,
        descripcion,
        version,
        nombreArchivo: fileZip.filename,
        rutaLocal: rutaRelativa,
        activo: true,
        fechaPublicacion: new Date()
      });
      idSoftware = docZip.id;
    }

    // 2. Guardar e Indexar Manual PDF
    if (archivos.pdf && archivos.pdf[0]) {
      const filePdf = archivos.pdf[0];
      const rutaRelativa = path.join('storage', 'manuals', nombreSlug, versionSlug, filePdf.filename);

      const docPdf = await db.collection('manuales').add({
        nombre: `Manual de Usuario - ${nombre}`,
        descripcion,
        version,
        nombreArchivo: filePdf.filename,
        rutaLocal: rutaRelativa,
        activo: true,
        fechaCreacion: new Date()
      });
      idManual = docPdf.id;

      // Lectura y extracción del PDF con pdf2json
      const buffer = fs.readFileSync(filePdf.path);
      const textoExtraido = await extraerTextoPDF(buffer);

      const bloques = dividirTextoEnBloques(textoExtraido);
      const mongoDb = getDB();
      const coleccionVectores = mongoDb.collection('conocimientos_vectores');

      for (let i = 0; i < bloques.length; i++) {
        const fragmento = bloques[i];
        if (fragmento.length < 20) continue;

        const vector = await generarEmbedding(fragmento);
        await coleccionVectores.insertOne({
          manualId: docPdf.id,
          nombreManual: nombre,
          titulo_seccion: `${nombre} (Parte ${i + 1})`,
          contenido_texto: fragmento,
          embedding: vector,
          fechaIndexacion: new Date()
        });
      }
    }

    res.json({
      ok: true,
      mensaje: 'Recurso publicado e indexado correctamente en la IA.',
      idSoftware,
      idManual
    });

  } catch (error) {
    console.error('Error en carga unificada:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// --- MÓDULO SOFTWARE ---
app.get('/api/software', verifyToken, async (req, res) => {
  try {
    if (req.user.estado !== 'activo') return res.json({ ok: true, catalogo: [] });

    const snapshot = await db.collection('software').where('activo', '==', true).get();
    const catalogo = [];

    snapshot.forEach((doc) => {
      const item = doc.data();
      catalogo.push({
        id: doc.id,
        nombre: item.nombre,
        descripcion: item.descripcion,
        version: item.version,
        fechaPublicacion: item.fechaPublicacion,
      });
    });

    res.json({ ok: true, catalogo });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/software/:id/download', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user.estado !== 'activo') {
      return res.status(403).json({ ok: false, error: 'Cuenta pendiente de aprobación.' });
    }

    const doc = await db.collection('software').doc(id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: 'Software no encontrado' });

    const item = doc.data();
    const absolutePath = path.join(__dirname, '..', item.rutaLocal);
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ ok: false, error: 'El archivo no existe en el servidor' });
    }

    res.download(absolutePath, item.nombreArchivo);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// --- MÓDULO MANUALES ---
app.get('/api/manuales', verifyToken, async (req, res) => {
  try {
    if (req.user.estado !== 'activo') return res.json({ ok: true, catalogo: [] });

    const snapshot = await db.collection('manuales').where('activo', '==', true).get();
    const catalogo = [];

    snapshot.forEach((doc) => {
      const item = doc.data();
      catalogo.push({
        id: doc.id,
        nombre: item.nombre,
        descripcion: item.descripcion,
        version: item.version,
      });
    });

    res.json({ ok: true, catalogo });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/manuales/:id/download', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user.estado !== 'activo') {
      return res.status(403).json({ ok: false, error: 'Cuenta pendiente de aprobación.' });
    }

    const doc = await db.collection('manuales').doc(id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: 'Manual no encontrado' });

    const item = doc.data();
    const absolutePath = path.join(__dirname, '..', item.rutaLocal);
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ ok: false, error: 'El archivo PDF no existe en el servidor' });
    }

    res.download(absolutePath, item.nombreArchivo);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// --- CHATBOT RAG ---
app.post('/api/chat', verifyToken, async (req, res) => {
  try {
    const { pregunta } = req.body;
    if (!pregunta) return res.status(400).json({ ok: false, error: 'La pregunta es requerida' });

    const vectorConsulta = await generarEmbedding(pregunta);
    const mongoDb = getDB();

    const filasContexto = await mongoDb.collection('conocimientos_vectores').aggregate([
      {
        $vectorSearch: {
          index: 'vector_index',
          path: 'embedding',
          queryVector: vectorConsulta,
          numCandidates: 30,
          limit: 5
        }
      },
      {
        $project: {
          _id: 1,
          titulo_seccion: 1,
          contenido_texto: 1,
          score: { $meta: 'vectorSearchScore' }
        }
      }
    ]).toArray();

    let contextoRecuperado = '';
    if (filasContexto.length > 0) {
      contextoRecuperado = filasContexto
        .map((f) => `Seccion: ${f.titulo_seccion}\nContenido: ${f.contenido_texto}`)
        .join('\n\n');
    }

    const promptSistema = `
Eres el Asistente Virtual Oficial de North Services.
Responde la consulta del usuario de forma profesional, concisa y basada UNICAMENTE en la siguiente informacion tecnica de los manuales.
Si la informacion no responde la pregunta, indica amablemente que no dispones de esa informacion en los manuales.

CONTEXTO RECUPERADO:
${contextoRecuperado || 'Sin contexto disponible'}

PREGUNTA DEL USUARIO:
${pregunta}
`;

    const urlChat = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    let resChat;
    let intentos = 0;

    while (intentos < 3) {
      resChat = await fetch(urlChat, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptSistema }] }] })
      });

      if (resChat.status !== 503) break;
      intentos++;
      await new Promise(r => setTimeout(r, 1500));
    }

    const dataChat = await resChat.json();
    if (!resChat.ok) throw new Error(`Error en Gemini: ${JSON.stringify(dataChat)}`);

    const respuestaFinal = dataChat.candidates[0].content.parts[0].text;
    res.json({ ok: true, respuesta: respuestaFinal });
  } catch (error) {
    console.error('Error en /api/chat:', error);
    res.status(500).json({ ok: false, error: 'Servidor ocupado. Reintente en un momento.' });
  }
});

// --- GESTIÓN DE USUARIOS ---
app.get('/api/admin/usuarios', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'administrador') {
      return res.status(403).json({ ok: false, error: 'Acceso denegado. Solo administradores.' });
    }

    const snapshot = await db.collection('users').get();
    const usuarios = [];

    snapshot.forEach((doc) => {
      usuarios.push({ ...doc.data(), uid: doc.id });
    });

    res.json({ ok: true, usuarios });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.put('/api/admin/usuarios/:uid', verifyToken, async (req, res) => {
  try {
    if (req.user.rol !== 'administrador') {
      return res.status(403).json({ ok: false, error: 'Acceso denegado' });
    }

    const { uid } = req.params;
    const { rol, area, estado } = req.body;

    const datosActualizar = {};
    if (rol !== undefined) datosActualizar.rol = rol;
    if (area !== undefined) datosActualizar.area = area;
    if (estado !== undefined) datosActualizar.estado = estado;

    await db.collection('users').doc(uid).update(datosActualizar);

    res.json({ ok: true, mensaje: 'Usuario actualizado correctamente' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

const PORT = process.env.PORT || 8000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
  });
}).catch((error) => {
  console.error('Fallo al conectar con MongoDB Atlas:', error);
});