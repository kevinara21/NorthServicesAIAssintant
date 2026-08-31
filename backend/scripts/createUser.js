const path = require('path');
const { authAdmin, db } = require(path.join(__dirname, '../src/firebaseAdmin'));

const DOMINIO = 'northservices.com.pe';

function generarCorreo(nombre, apellidoPaterno) {
  const limpiar = (texto) =>
    texto
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ñ/g, 'n')
      .replace(/[^a-z]/g, '');

  const nombreLimpio = limpiar(nombre.split(' ')[0]);
  const apellidoLimpio = limpiar(apellidoPaterno.split(' ')[0]);

  return `${nombreLimpio}.${apellidoLimpio}@${DOMINIO}`;
}

async function createOrUpdateUser({ nombre, apellidoPaterno, password, rol, area }) {
  const email = generarCorreo(nombre, apellidoPaterno);

  let uid;

  try {
    // 1. Obtener usuario si ya existe en Firebase Auth
    try {
      const existingUser = await authAdmin.getUserByEmail(email);
      uid = existingUser.uid;
      
      if (password) {
        await authAdmin.updateUser(uid, { password, displayName: `${nombre} ${apellidoPaterno}` });
      }
      console.log('Usuario existente encontrado en Auth. Credenciales actualizadas.');
    } catch (notFoundError) {
      // 2. Si no existe, crearlo
      const newUser = await authAdmin.createUser({
        email,
        password,
        displayName: `${nombre} ${apellidoPaterno}`,
      });
      uid = newUser.uid;
      console.log('Nuevo usuario registrado en Firebase Auth.');
    }

    // 3. Guardar perfil actualizado en la colección 'users' de Firestore
    await db.collection('users').doc(uid).set({
      nombre,
      apellido: apellidoPaterno,
      email,
      rol,
      area,
      estado: 'activo',
      fechaActualizacion: new Date(),
    }, { merge: true });

    console.log('--- PERFIL CREADO / ACTUALIZADO CORRECTAMENTE ---');
    console.log('UID:', uid);
    console.log('Email:', email);
    console.log('Rol:', rol);
    console.log('Área:', area);
    console.log('Estado:', 'activo');

  } catch (error) {
    console.error('Error procesando el usuario:', error.message);
  }
}

// Ejecución con tus datos
createOrUpdateUser({
  nombre: 'Kevin',
  apellidoPaterno: 'Nizama',
  password: 'Admin123!',
  rol: 'Administrador',
  area: 'Sistemas',
});