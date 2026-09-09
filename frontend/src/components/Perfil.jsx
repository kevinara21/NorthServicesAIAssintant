import { useState } from 'react';
import { FiCheck, FiCheckCircle, FiEye, FiEyeOff, FiKey, FiLock, FiSave, FiSend } from 'react-icons/fi';
import { EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth';
import { auth } from '../services/firebaseConfig';
import { apiFetch } from '../services/api';

export default function Perfil({ usuario, token, onUsuarioActualizado }) {
  const [nombre, setNombre] = useState(usuario?.nombre || '');
  const [apellido, setApellido] = useState(usuario?.apellido || '');
  const [telefono, setTelefono] = useState(usuario?.whatsapp || '');
  const [codigo, setCodigo] = useState('');
  const [canal, setCanal] = useState('sms');
  const [mensaje, setMensaje] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [otpEnviado, setOtpEnviado] = useState(false);
  const [passwordActual, setPasswordActual] = useState('');
  const [nuevaPassword, setNuevaPassword] = useState('');
  const [repetirPassword, setRepetirPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState({ actual: false, nueva: false, repetir: false });

  const llamada = async (ruta, opciones = {}) => {
    const respuesta = await apiFetch(ruta, {
      ...opciones,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...opciones.headers },
    });
    const textoRespuesta = await respuesta.text();
    let data;
    try {
      data = JSON.parse(textoRespuesta);
    } catch {
      throw new Error('El servidor no respondió correctamente. Verifica que el backend esté ejecutándose en el puerto 8000.');
    }
    if (!respuesta.ok) throw new Error(data.error || 'No se pudo completar la operación.');
    return data;
  };

  const guardarPerfil = async (event) => {
    if (event) event.preventDefault();
    setCargando(true);
    setMensaje(null);
    try {
      const data = await llamada('/api/perfil', { method: 'PUT', body: JSON.stringify({ nombre, apellido }) });
      onUsuarioActualizado(data.usuario);
      setMensaje({ tipo: 'exito', texto: 'Perfil actualizado. El correo generado también fue actualizado.' });
    } catch (error) {
      setMensaje({ tipo: 'error', texto: error.message });
    } finally { setCargando(false); }
  };

  const enviarCodigo = async () => {
    setCargando(true);
    setMensaje(null);
    try {
      await llamada('/api/otp/solicitar', { method: 'POST', body: JSON.stringify({ telefono, canal }) });
      setOtpEnviado(true);
      setMensaje({ tipo: 'exito', texto: `Código enviado por ${canal === 'whatsapp' ? 'WhatsApp' : 'SMS'}.` });
    } catch (error) {
      setMensaje({ tipo: 'error', texto: error.message });
    } finally { setCargando(false); }
  };

  const verificarCodigo = async (event) => {
    if (event) event.preventDefault();
    setCargando(true);
    setMensaje(null);
    try {
      await llamada('/api/otp/verificar', { method: 'POST', body: JSON.stringify({ telefono, codigo }) });
      onUsuarioActualizado({ ...usuario, whatsapp: telefono, whatsappVerificado: true });
      setMensaje({ tipo: 'exito', texto: `Número verificado mediante ${canal === 'whatsapp' ? 'WhatsApp' : 'SMS'}.` });
      setOtpEnviado(false);
      setCodigo('');
    } catch (error) {
      setMensaje({ tipo: 'error', texto: error.message });
    } finally { setCargando(false); }
  };

  const cambiarPassword = async () => {
    setCargando(true);
    setMensaje(null);
    try {
      if (nuevaPassword.length < 6) throw new Error('La nueva contraseña debe tener al menos 6 caracteres.');
      if (nuevaPassword !== repetirPassword) throw new Error('Las nuevas contraseñas no coinciden.');
      const usuarioActual = auth.currentUser;
      if (!usuarioActual) throw new Error('La sesión de Firebase ha expirado. Inicia sesión nuevamente.');
      const credenciales = EmailAuthProvider.credential(usuarioActual.email, passwordActual);
      await reauthenticateWithCredential(usuarioActual, credenciales);
      await llamada('/api/password/cambiar', { method: 'PUT', body: JSON.stringify({ nuevaPassword }) });
      setPasswordActual('');
      setNuevaPassword('');
      setRepetirPassword('');
      setMensaje({ tipo: 'exito', texto: 'Contraseña actualizada correctamente.' });
    } catch (error) {
      const mensajeError = error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password'
        ? 'La contraseña actual es incorrecta.'
        : error.message;
      setMensaje({ tipo: 'error', texto: mensajeError });
    } finally { setCargando(false); }
  };

  return (
    <section className="profile-layout">
      <div className="profile-heading">
        <h1>Mi perfil</h1>
        <p>Administra tus datos de acceso y verifica el número asociado a tu cuenta.</p>
      </div>
      {mensaje && <div className={`profile-message ${mensaje.tipo}`}>{mensaje.texto}</div>}
      <div className="profile-panel profile-panel-unified">
        <h3>Datos personales</h3>
        <form onSubmit={guardarPerfil}>
          <div className="profile-personal-grid">
            {/* Fila 1: Nombre, Apellido, Canal de código OTP */}
            <label>
              Nombre
              <input value={nombre} onChange={(event) => setNombre(event.target.value)} required />
            </label>
            <label>
              Apellido
              <input value={apellido} onChange={(event) => setApellido(event.target.value)} required />
            </label>
            <label>
              Canal de código OTP
              <select className="profile-channel-select" value={canal} onChange={(event) => { setCanal(event.target.value); setOtpEnviado(false); }}>
                <option value="sms">SMS</option>
                <option value="whatsapp">WhatsApp</option>
              </select>
            </label>

            {/* Fila 2: Correo corporativo, Número de teléfono, Enviar código */}
            <label>
              Correo corporativo
              <input value={`${nombre.toLowerCase()}.${apellido.toLowerCase()}@northservices.com.pe`} readOnly />
            </label>
            <label>
              Número de teléfono
              <input value={telefono} onChange={(event) => setTelefono(event.target.value)} placeholder="+51987654321" required />
            </label>
            <div className="profile-action-wrapper">
              <button className="profile-primary-button profile-btn-full" type="button" onClick={enviarCodigo} disabled={cargando}>
                <FiSend /> Enviar código
              </button>
            </div>

            {/* Fila 3: Guardar cambios (abajo de Correo, mismo ancho con icono), Estado / OTP */}
            <div className="profile-action-wrapper">
              <button className="profile-secondary-button profile-btn-full" type="submit" disabled={cargando}>
                <FiSave /> Guardar cambios
              </button>
            </div>
            <div>
              {otpEnviado ? (
                <label>
                  Código OTP
                  <input value={codigo} onChange={(event) => setCodigo(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" maxLength="6" placeholder="Ingresa 6 dígitos" required />
                </label>
              ) : (
                usuario?.whatsappVerificado && telefono === usuario.whatsapp && (
                  <div className="profile-verified-badge"><FiCheckCircle /> Número verificado</div>
                )
              )}
            </div>
            <div>
              {otpEnviado && (
                <div className="profile-action-wrapper">
                  <button className="profile-primary-button profile-btn-full" type="button" onClick={verificarCodigo} disabled={cargando}>
                    <FiCheck /> Verificar número
                  </button>
                </div>
              )}
            </div>
          </div>
        </form>

        <div className="profile-password-section">
          <h3><FiLock /> Cambiar contraseña</h3>
          <div className="profile-password-fields">
            <label>
              Contraseña actual
              <span className="password-field">
                <input type={passwordVisible.actual ? 'text' : 'password'} value={passwordActual} onChange={(event) => setPasswordActual(event.target.value)} required />
                <button type="button" className="password-toggle" onClick={() => setPasswordVisible((visible) => ({ ...visible, actual: !visible.actual }))} aria-label={passwordVisible.actual ? 'Ocultar contraseña' : 'Mostrar contraseña'}>
                  {passwordVisible.actual ? <FiEyeOff /> : <FiEye />}
                </button>
              </span>
            </label>
            <label>
              Nueva contraseña
              <span className="password-field">
                <input type={passwordVisible.nueva ? 'text' : 'password'} value={nuevaPassword} onChange={(event) => setNuevaPassword(event.target.value)} minLength="6" required />
                <button type="button" className="password-toggle" onClick={() => setPasswordVisible((visible) => ({ ...visible, nueva: !visible.nueva }))} aria-label={passwordVisible.nueva ? 'Ocultar contraseña' : 'Mostrar contraseña'}>
                  {passwordVisible.nueva ? <FiEyeOff /> : <FiEye />}
                </button>
              </span>
            </label>
            <div className="profile-password-repeat-wrap">
              <label>
                Repite la nueva contraseña
                <span className="password-field">
                  <input type={passwordVisible.repetir ? 'text' : 'password'} value={repetirPassword} onChange={(event) => setRepetirPassword(event.target.value)} minLength="6" required />
                  <button type="button" className="password-toggle" onClick={() => setPasswordVisible((visible) => ({ ...visible, repetir: !visible.repetir }))} aria-label={passwordVisible.repetir ? 'Ocultar contraseña' : 'Mostrar contraseña'}>
                    {passwordVisible.repetir ? <FiEyeOff /> : <FiEye />}
                  </button>
                </span>
              </label>
              <button
                className="profile-primary-button profile-password-icon-btn"
                type="button"
                onClick={cambiarPassword}
                disabled={cargando}
                title="Actualizar contraseña"
                aria-label="Actualizar contraseña"
              >
                <FiKey aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
