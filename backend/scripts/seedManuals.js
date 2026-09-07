const { db } = require('../src/firebaseAdmin');

async function registrarManual() {
  try {
    const manualRef = db.collection('manuales').doc('manual-drilling-merger');
    
    await manualRef.set({
      nombre: 'Manual de Usuario - Drilling Merger',
      descripcion: 'Guía técnica y de procedimiento para la consolidación de datos de pozo.',
      nombreArchivo: 'Manual_Drilling_Merger_v1.pdf',
      rutaLocal: 'storage/manuals/drilling-merger/v1.0/Manual_Drilling_Merger_v1.pdf',
      rolesPermitidos: ['administrador', 'supervisor', 'usuario'],
      departamentoPermitido: '',
      activo: true,
      fechaPublicacion: new Date(),
    });

    console.log('Manual registrado exitosamente en Firestore');
  } catch (error) {
    console.error('Error registrando manual:', error.message);
  }
}

registrarManual();