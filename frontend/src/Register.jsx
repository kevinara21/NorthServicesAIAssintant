import React, { useState } from 'react';
import { createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';

export default function Register({ alVolverAlLogin }) {
  const [nombre, setNombre] = useState('');
  const [apellido, setApellido] = useState('');
  const [password, setPassword] = useState('');

  const [areaSeleccionada, setAreaSeleccionada] = useState('Sistemas');
  const [otraArea, setOtraArea] = useState('');

  const [rolSeleccionado, setRolSeleccionado] = useState('Técnico');
  const [otroRol, setOtroRol] = useState('');

  const [cargando, setCargando] = useState(false);
  const [mensaje, setMensaje] = useState(null);

  const areasExistentes = ['Sistemas', 'Operaciones', 'Mantenimiento', 'Administración', 'Crear nueva área...'];
  const rolesExistentes = ['Técnico', 'Supervisor', 'Administrador', 'Crear nuevo rol...'];

  const emailGenerado = (nombre && apellido) 
    ? `${nombre.trim().toLowerCase()}.${apellido.trim().toLowerCase()}@northservices.com.pe` 
    : '';

  const manejarRegistro = async (e) => {
    e.preventDefault();
    setCargando(true);
    setMensaje(null);

    const areaFinal = areaSeleccionada === 'Crear nueva área...' ? otraArea.trim() : areaSeleccionada;
    const rolFinal = rolSeleccionado === 'Crear nuevo rol...' ? otroRol.trim() : rolSeleccionado;

    if (!areaFinal || !rolFinal) {
      setMensaje({ tipo: 'error', texto: 'Por favor especifique Área y Rol.' });
      setCargando(false);
      return;
    }

    try {
      const userCredential = await createUserWithEmailAndPassword(auth, emailGenerado, password);
      const user = userCredential.user;

      await setDoc(doc(db, 'users', user.uid), {
        nombre: nombre.trim(),
        apellido: apellido.trim(),
        email: emailGenerado,
        rol: rolFinal,
        area: areaFinal,
        estado: 'pendiente',
        fechaRegistro: new Date(),
      });

      await signOut(auth);

      setMensaje({
        tipo: 'exito',
        texto: 'Solicitud enviada exitosamente. Tu cuenta se encuentra en revisión.',
      });
    } catch (error) {
      console.error('Error al registrar usuario:', error);
      let errorTexto = 'Ocurrió un error al registrar la cuenta.';
      if (error.code === 'auth/email-already-in-use') {
        errorTexto = 'El correo electrónico ya está registrado.';
      } else if (error.code === 'auth/weak-password') {
        errorTexto = 'La contraseña debe tener al menos 6 caracteres.';
      }
      setMensaje({ tipo: 'error', texto: errorTexto });
    } finally {
      setCargando(false);
    }
  };

  return (
    <div style={{ maxWidth: 380, margin: '50px auto', fontFamily: 'sans-serif' }}>
      <h2>Solicitud de Acceso</h2>
      <p style={{ fontSize: 13, color: '#64748b', marginBottom: 20 }}>
        North Services AI Assistant
      </p>

      {mensaje && (
        <div
          style={{
            padding: 10,
            borderRadius: 4,
            marginBottom: 15,
            fontSize: 13,
            backgroundColor: mensaje.tipo === 'exito' ? '#dcfce7' : '#fee2e2',
            color: mensaje.tipo === 'exito' ? '#15803d' : '#b91c1c',
          }}
        >
          {mensaje.texto}
        </div>
      )}

      <form onSubmit={manejarRegistro} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          type="text"
          placeholder="Nombre (ej. Sergio)"
          value={nombre}
          onChange={(e) => setNombre(e.target.value.replace(/\s+/g, ''))}
          required
          style={{ padding: 8, boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: 4 }}
        />
        <input
          type="text"
          placeholder="Apellido (ej. Alvarado)"
          value={apellido}
          onChange={(e) => setApellido(e.target.value.replace(/\s+/g, ''))}
          required
          style={{ padding: 8, boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: 4 }}
        />

        <div>
          <label style={{ display: 'block', fontSize: 11, color: '#64748b', marginBottom: 2 }}>Correo autogenerado</label>
          <input
            type="email"
            value={emailGenerado}
            readOnly
            placeholder="nombre.apellido@northservices.com.pe"
            style={{ width: '100%', padding: 8, boxSizing: 'border-box', background: '#f1f5f9', border: '1px solid #cbd5e1', borderRadius: 4, color: '#334155' }}
          />
        </div>

        <input
          type="password"
          placeholder="Contraseña (mínimo 6 caracteres)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={{ padding: 8, boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: 4 }}
        />

        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#475569', marginBottom: 2 }}>Área</label>
          <select
            value={areaSeleccionada}
            onChange={(e) => setAreaSeleccionada(e.target.value)}
            style={{ width: '100%', padding: 8, boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: 4 }}
          >
            {areasExistentes.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          {areaSeleccionada === 'Crear nueva área...' && (
            <input
              type="text"
              placeholder="Escriba el nombre de la nueva área"
              value={otraArea}
              onChange={(e) => setOtraArea(e.target.value)}
              required
              style={{ width: '100%', padding: 8, marginTop: 6, boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: 4 }}
            />
          )}
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#475569', marginBottom: 2 }}>Rol</label>
          <select
            value={rolSeleccionado}
            onChange={(e) => setRolSeleccionado(e.target.value)}
            style={{ width: '100%', padding: 8, boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: 4 }}
          >
            {rolesExistentes.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          {rolSeleccionado === 'Crear nuevo rol...' && (
            <input
              type="text"
              placeholder="Escriba el nombre del nuevo rol"
              value={otroRol}
              onChange={(e) => setOtroRol(e.target.value)}
              required
              style={{ width: '100%', padding: 8, marginTop: 6, boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: 4 }}
            />
          )}
        </div>

        <button type="submit" disabled={cargando} style={{ padding: 10, cursor: 'pointer', marginTop: 10, background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, fontWeight: 'bold' }}>
          {cargando ? 'Enviando...' : 'Registrar'}
        </button>
      </form>

      <div style={{ marginTop: 20, textAlign: 'center' }}>
        <button
          type="button"
          onClick={alVolverAlLogin}
          style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 13, textDecoration: 'underline' }}
        >
          ¿Ya tienes cuenta? Inicia sesión aquí
        </button>
      </div>
    </div>
  );
}