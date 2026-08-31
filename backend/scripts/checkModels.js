require('dotenv').config();

async function verificarModelos() {
  const url = `https://generativelanguage.googleapis.com/v1/models?key=${process.env.GEMINI_API_KEY}`;
  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    console.error('Error al consultar modelos:', data);
    return;
  }

  const modelosEmbedding = data.models.filter((m) =>
    m.supportedGenerationMethods.includes('embedContent')
  );

  console.log('Modelos de Embedding disponibles para tu clave:');
  modelosEmbedding.forEach((m) => console.log(`- ${m.name}`));
}

verificarModelos();