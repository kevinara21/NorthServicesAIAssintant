const { db } = require('../src/firebaseAdmin');

async function registrarSoftware() {
  try {
    const softwareRef = db.collection('software').doc('drilling-merger');
    
    await softwareRef.set({
      nombre: 'Drilling Temperature',
      descripcion: 'Herramienta para combinar data de gamma y temperatura de pozo.',
      version: 'v1.0',
      nombreArchivo: 'Drilling Merger.zip',
      rutaLocal: 'storage/software/drilling-merger/v1.0/Drilling Merger.zip',
      rolesPermitidos: ['administrador', 'supervisor', 'usuario'], // Quiénes pueden verlo
      departamentoPermitido: '', // Vacío = todos los departamentos
      activo: true,
      fechaPublicacion: new Date(),
    });

    console.log('Software registrado exitosamente en Firestore');
  } catch (error) {
    console.error('Error registrando software:', error.message);
  }
}

registrarSoftware();