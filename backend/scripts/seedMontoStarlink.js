require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db } = require('../src/firebaseAdmin');

const MONTO_MUESTRA = 50;

(async () => {
  const snapshot = await db.collection('facturacionStarlink').get();
  let actualizados = 0;
  const actualizaciones = [];
  snapshot.forEach((doc) => {
    const datos = doc.data();
    if (!datos.monto && datos.monto !== 0) {
      actualizaciones.push(doc.ref.update({ monto: MONTO_MUESTRA, actualizadoEn: new Date() }));
      actualizados++;
    }
  });
  await Promise.all(actualizaciones);
  console.log(`Pozos actualizados con monto de muestra ($${MONTO_MUESTRA} USD): ${actualizados}`);
  process.exit(0);
})().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});