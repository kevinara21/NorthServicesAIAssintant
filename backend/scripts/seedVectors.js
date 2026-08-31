const pool = require('../src/db');
require('dotenv').config();

const fragmentosManual = [
  {
    manual_id: 'manual-drilling-merger',
    titulo_seccion: 'Procedimiento de Fusion de Archivos',
    contenido_texto: 'Para combinar archivos de datos de temperatura y gamma ray en Drilling Merger v1.0, cargue los archivos CSV en la pestana Principal. Asegurese de que las marcas de profundidad coincidan en intervalos de 0.5 metros antes de presionar el boton Procesar.',
  },
  {
    manual_id: 'manual-drilling-merger',
    titulo_seccion: 'Resolucion de Errores de Lectura',
    contenido_texto: 'Si la aplicacion muestra el Error 402 en la consola, verifique que la codificacion del archivo CSV sea UTF-8 y que los valores nulos esten representados por -999.25.',
  },
];

async function obtenerEmbedding(texto) {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-embedding-001:embedContent?key=${process.env.GEMINI_API_KEY}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: { parts: [{ text: texto }] }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }
  return data.embedding.values;
}

async function guardarVectoresReales() {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query('TRUNCATE TABLE conocimientos_vectores');

    for (const chunk of fragmentosManual) {
      const vectorValores = await obtenerEmbedding(chunk.contenido_texto);
      
      // Convertir el arreglo de JavaScript a cadena formateada "[val1,val2,...]"
      const vectorCadena = `[${vectorValores.join(',')}]`;

      await conn.query(
        'INSERT INTO conocimientos_vectores (manual_id, titulo_seccion, contenido_texto, embedding) VALUES (?, ?, ?, Vec_FromText(?))',
        [chunk.manual_id, chunk.titulo_seccion, chunk.contenido_texto, vectorCadena]
      );

      console.log(`Vector generado para: ${chunk.titulo_seccion} (${vectorValores.length} dimensiones)`);
    }

    console.log('Proceso completado: Embeddings guardados en MariaDB 12.3');
  } catch (error) {
    console.error('Error al generar o insertar embeddings:', error.message || error);
  } finally {
    if (conn) conn.release();
  }
}

guardarVectoresReales();