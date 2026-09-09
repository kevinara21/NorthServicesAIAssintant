const { db, FieldValue } = require('../src/firebaseAdmin');

const pozos = [
  {
    id: 'KIT400851262',
    numero: 1,
    nombrePozo: 'OFICINAS',
    correo: 'cristhian.barrantes@northservices.com.pe',
    codigoKit: 'KIT400851262',
    serieAntena: '4PBA00778844',
    diaInicioPeriodo: 14,
    diaPago: 13,
  },
  {
    id: 'KIT402255653KSK',
    numero: 3,
    nombrePozo: 'P-16603D',
    correo: 'kit1starlink@gmail.com',
    codigoKit: 'KIT402255653KSK',
    serieAntena: '4PBA02172477',
    diaInicioPeriodo: 11,
    diaPago: 10,
  },
  {
    id: 'KIT402262772QAZ',
    numero: 4,
    nombrePozo: 'GAV-1XD',
    correo: 'starlinkmwd@gmail.com',
    codigoKit: 'KIT402262772QAZ',
    serieAntena: '4PBA02180001',
    diaInicioPeriodo: 27,
    diaPago: 26,
  },
];

async function seedPozos() {
  const batch = db.batch();
  for (const pozo of pozos) {
    const { id, ...datos } = pozo;
    batch.set(db.collection('facturacionStarlink').doc(id), {
      ...datos,
      estadoPago: 'no_pagado',
      diaFinPeriodo: FieldValue.delete(),
      periodoFin: FieldValue.delete(),
      actualizadoEn: new Date(),
      creadoEn: new Date(),
    }, { merge: true });
  }
  await batch.commit();
  console.log(`${pozos.length} registros registrados en facturacionStarlink.`);
}

seedPozos().catch((error) => {
  console.error('Error registrando pozos:', error.message);
  process.exitCode = 1;
});
