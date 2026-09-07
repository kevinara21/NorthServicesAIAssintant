import React, { useState } from 'react';
import { FiEye, FiEyeOff } from 'react-icons/fi';
import { createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { auth, db } from '../services/firebaseConfig';

export default function Register({ alVolverAlLogin }) {
  const [nombre, setNombre] = useState('');
  const [apellido, setApellido] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [whatsapp, setWhatsapp] = useState('');

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
        ...(whatsapp.trim() ? { whatsapp: whatsapp.trim(), whatsappVerificado: false } : {}),
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
    <div className="login-page register-page" style={{ maxWidth: 380, margin: '50px auto', fontFamily: 'sans-serif' }}>
      <img className="login-logo" src="/NorthServices.svg" alt="North Services" />
      <h2 className="login-heading" style={{ color: '#000000', marginBottom: '0.5rem' }}>Solicitud de Acceso</h2>
      <p className="login-subtitle" style={{ fontSize: 13, color: '#666666', marginBottom: 20 }}>
        North Services AI Assistant
      </p>

      {mensaje && (
        <div
          style={{
            padding: 10,
            borderRadius: 4,
            marginBottom: 15,
            fontSize: 13,
            backgroundColor: mensaje.tipo === 'exito' ? '#D1FAE5' : '#FEE2E2',
            color: mensaje.tipo === 'exito' ? '#065F46' : '#B91C1C',
            borderLeft: `4px solid ${mensaje.tipo === 'exito' ? '#10B981' : '#DD2226'}`,
          }}
        >
          {mensaje.texto}
        </div>
      )}

      <form onSubmit={manejarRegistro} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#000000', marginBottom: 4, fontWeight: 600 }}>Nombre</label>
          <input
            type="text"
            placeholder="Nombre (ej. Sergio)"
            value={nombre}
            onChange={(e) => setNombre(e.target.value.replace(/\s+/g, ''))}
            required
            style={{ width: '100%', padding: 8, boxSizing: 'border-box', border: '1px solid #E5E7EB', borderRadius: 4 }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#000000', marginBottom: 4, fontWeight: 600 }}>Apellido</label>
          <input
            type="text"
            placeholder="Apellido (ej. Alvarado)"
            value={apellido}
            onChange={(e) => setApellido(e.target.value.replace(/\s+/g, ''))}
            required
            style={{ width: '100%', padding: 8, boxSizing: 'border-box', border: '1px solid #E5E7EB', borderRadius: 4 }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, color: '#000000', marginBottom: 4, fontWeight: 600 }}>Correo autogenerado</label>
          <input
            type="email"
            value={emailGenerado}
            readOnly
            placeholder="nombre.apellido@northservices.com.pe"
            style={{ width: '100%', padding: 8, boxSizing: 'border-box', background: '#F8F9FA', border: '1px solid #E5E7EB', borderRadius: 4, color: '#666666' }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#000000', marginBottom: 4, fontWeight: 600 }}>Contraseña</label>
          <span className="password-field"><input type={passwordVisible ? 'text' : 'password'} placeholder="Contraseña (mínimo 6 caracteres)" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ width: '100%', padding: 8, boxSizing: 'border-box', border: '1px solid #E5E7EB', borderRadius: 4 }} /><button type="button" className="password-toggle" onClick={() => setPasswordVisible((visible) => !visible)} aria-label={passwordVisible ? 'Ocultar contraseña' : 'Mostrar contraseña'}>{passwordVisible ? <FiEyeOff /> : <FiEye />}</button></span>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#000000', marginBottom: 4, fontWeight: 600 }}>Área</label>
          <select
            value={areaSeleccionada}
            onChange={(e) => setAreaSeleccionada(e.target.value)}
            style={{ width: '100%', padding: 8, boxSizing: 'border-box', border: '1px solid #E5E7EB', borderRadius: 4 }}
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
              style={{ width: '100%', padding: 8, marginTop: 6, boxSizing: 'border-box', border: '1px solid #E5E7EB', borderRadius: 4 }}
            />
          )}
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#000000', marginBottom: 4, fontWeight: 600 }}>WhatsApp (opcional)</label>
          <input type="tel" placeholder="+51987654321" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} style={{ width: '100%', padding: 8, boxSizing: 'border-box', border: '1px solid #E5E7EB', borderRadius: 4 }} />
          <small style={{ color: '#666666' }}>Podrás verificarlo desde tu perfil.</small>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#000000', marginBottom: 4, fontWeight: 600 }}>Rol</label>
          <select
            value={rolSeleccionado}
            onChange={(e) => setRolSeleccionado(e.target.value)}
            style={{ width: '100%', padding: 8, boxSizing: 'border-box', border: '1px solid #E5E7EB', borderRadius: 4 }}
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
              style={{ width: '100%', padding: 8, marginTop: 6, boxSizing: 'border-box', border: '1px solid #E5E7EB', borderRadius: 4 }}
            />
          )}
        </div>

        <button className="register-submit-button" type="submit" disabled={cargando} style={{ padding: 10, cursor: 'pointer', marginTop: 10, background: '#DD2226', color: '#FFFFFF', border: 'none', borderRadius: 4, fontWeight: 'bold', transition: 'all 0.3s' }}>
          {cargando ? 'Enviando...' : 'Registrar'}
        </button>
      </form>

      <div style={{ marginTop: 20, textAlign: 'center' }}>
        <button
          type="button"
          onClick={alVolverAlLogin}
          className="login-secondary-link"
        >
          ¿Ya tienes cuenta? Inicia sesión aquí
        </button>
      </div>
    </div>
  );
}