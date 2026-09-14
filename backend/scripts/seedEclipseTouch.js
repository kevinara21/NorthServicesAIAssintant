const { db } = require('../src/firebaseAdmin');

const EMAIL = 'kevin.nizama@northservices.com.pe';
const LINK = 'https://specialists-outside-discrimination-theology.trycloudflare.com/view/dc2a4c5f18bdd298d50e4c43c3e070b8';

async function seedEclipseTouch() {
  const snapshot = await db.collection('users').get();
  let usuario = null;
  snapshot.forEach((documento) => {
    const datos = documento.data();
    if (!usuario && String(datos.email || '').toLowerCase() === EMAIL) {
      usuario = { uid: documento.id, ...datos };
    }
  });
  if (!usuario) throw new Error(`No se encontró el usuario ${EMAIL}`);

  const existente = await db.collection('eclipseTouch').where('link', '==', LINK).get();
  if (!existente.empty) {
    console.log('El enlace ya existe en Firestore; no se duplicó.');
    return;
  }

  const referencia = db.collection('eclipseTouch').doc();
  await referencia.set({
    nombrePozo: 'Pozo de prueba',
    lote: 'Lote de prueba',
    link: LINK,
    propietarioUid: usuario.uid,
    propietarioNombre: [usuario.nombre, usuario.apellido].filter(Boolean).join(' ') || usuario.email,
    propietarioEmail: usuario.email,
    activo: true,
    fechaCreacion: new Date(),
    actualizadoEn: new Date(),
  });
  console.log(`Enlace Eclipse Touch guardado en Firestore: ${referencia.id}`);
}

seedEclipseTouch().catch((error) => {
  console.error('Error:', error.message);
  process.exitCode = 1;
});