/**
 * actualizarWebEmpresa.js
 *
 * Rastrea la web de la empresa desde la línea de comandos.
 *
 * El trabajo real lo hace `src/services/webEmpresa.service.js`, que es el mismo
 * código que ejecuta el botón "Actualizar información de la página" del
 * asistente. Este script se conserva para poder reindexar sin abrir la
 * aplicación (por ejemplo, desde una tarea programada o por SSH).
 *
 *   node scripts/actualizarWebEmpresa.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { connectDB } = require('../src/db/mongodb');
const webEmpresa = require('../src/services/webEmpresa.service');

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
        ultimoError = new Error(`HTTP ${response.status}: ${await response.text()}`);
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
      ultimoError = error;
    }
  }

  throw ultimoError || new Error('No fue posible generar embeddings.');
}

(async () => {
  try {
    await connectDB();
    const resumen = await webEmpresa.actualizarInformacionWeb({
      generarEmbedding,
      onProgress: (mensaje) => console.log(`[WEB] ${mensaje}`),
    });
    console.log(`[WEB] Listo: ${JSON.stringify(resumen, null, 2)}`);
    process.exit(0);
  } catch (error) {
    console.error('[WEB] Error ejecutando la actualización:', error.message);
    process.exit(1);
  }
})();