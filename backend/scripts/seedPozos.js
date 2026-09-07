const { db, FieldValue } = require('../src/firebaseAdmin');

const pozos = [
  {
    id: 'pozo-1-oficinas',
    numero: 1,
    nombrePozo: 'OFICINAS',
    correo: 'cristhian.barrantes@northservices.com.pe',
    codigoKit: 'KIT400851262',
    serieAntena: '4PBA00778844',
    diaInicioPeriodo: 14,
    diaFinPeriodo: 13,
    diaPago: 13,
  },
  {
    id: 'pozo-3-kit-01-oly-xiii',
    numero: 3,
    nombrePozo: 'KIT 01 OLY XIII',
    correo: 'kit1starlink@gmail.com',
    codigoKit: 'KIT402255653KSK',
    serieAntena: '4PBA02172477',
    diaInicioPeriodo: 11,
    diaFinPeriodo: 10,
    diaPago: 10,
  },
  {
    id: 'pozo-4-kit-03-unna-lt-iv',
    numero: 4,
    nombrePozo: 'KIT 03 UNNA LT IV',
    correo: 'starlinkmwd@gmail.com',
    codigoKit: 'KIT402262772QAZ',
    serieAntena: '4PBA02180001',
    diaInicioPeriodo: 27,
    diaFinPeriodo: 26,
    diaPago: 26,
  },
];

async function seedPozos() {
  const batch = db.batch();
  for (const pozo of pozos) {
    const { id, ...datos } = pozo;
    batch.set(db.collection('pagosStarlink').doc(id), {
      ...datos,
      estadoPago: 'no_pagado',
      observacion: FieldValue.delete(),
      periodoInicio: FieldValue.delete(),
      periodoFin: FieldValue.delete(),
      fechaPago: FieldValue.delete(),
      actualizadoEn: new Date(),
      creadoEn: new Date(),
    }, { merge: true });
  }
  await batch.commit();
  console.log(`${pozos.length} registros registrados en pagosStarlink.`);
}

seedPozos().catch((error) => {
  console.error('Error registrando pozos:', error.message);
  process.exitCode = 1;
});
