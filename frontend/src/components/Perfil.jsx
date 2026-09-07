import { useState } from 'react';
import { FiCheckCircle, FiEye, FiEyeOff, FiSend } from 'react-icons/fi';
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
    event.preventDefault();
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
    event.preventDefault();
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
      <form className="profile-panel profile-panel-unified" onSubmit={otpEnviado ? verificarCodigo : guardarPerfil}>
        <h3>Datos personales</h3>
        <div className="profile-data-layout">
          <div className="profile-fields">
            <div className="profile-fields-row">
              <label>Nombre<input value={nombre} onChange={(event) => setNombre(event.target.value)} required /></label>
              <label>Apellido<input value={apellido} onChange={(event) => setApellido(event.target.value)} required /></label>
            </div>
            <div className="profile-fields-row">
              <label>Correo corporativo<input value={`${nombre.toLowerCase()}.${apellido.toLowerCase()}@northservices.com.pe`} readOnly /></label>
              <label>Número de teléfono<input value={telefono} onChange={(event) => setTelefono(event.target.value)} placeholder="+51987654321" required />
                <span className="profile-channel-inline">
                  <span>Canal de código OTP</span>
                  <select className="profile-channel-select" value={canal} onChange={(event) => { setCanal(event.target.value); setOtpEnviado(false); }}>
                    <option value="sms">SMS</option>
                    <option value="whatsapp">WhatsApp</option>
                  </select>
                </span>
                {otpEnviado && <span className="profile-otp-inline"><span>Código OTP</span><input value={codigo} onChange={(event) => setCodigo(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" maxLength="6" required /></span>}
              </label>
            </div>
          </div>
        </div>
        {usuario?.whatsappVerificado && telefono === usuario.whatsapp && !otpEnviado && (
          <div className="profile-verified"><FiCheckCircle /> Número verificado</div>
        )}
        <div className="profile-actions">
          <button className="profile-primary-button" type={otpEnviado ? 'submit' : 'button'} onClick={otpEnviado ? undefined : enviarCodigo} disabled={cargando}>
            {otpEnviado ? 'Verificar número' : <><FiSend /> Enviar código</>}
          </button>
          {!otpEnviado && <button className="profile-secondary-button" type="submit" disabled={cargando}>Guardar cambios</button>}
        </div>
        <div className="profile-password-section">
          <h3>Cambiar contraseña</h3>
          <div className="profile-password-fields">
            <label>Contraseña actual<span className="password-field"><input type={passwordVisible.actual ? 'text' : 'password'} value={passwordActual} onChange={(event) => setPasswordActual(event.target.value)} required /><button type="button" className="password-toggle" onClick={() => setPasswordVisible((visible) => ({ ...visible, actual: !visible.actual }))} aria-label={passwordVisible.actual ? 'Ocultar contraseña' : 'Mostrar contraseña'}>{passwordVisible.actual ? <FiEyeOff /> : <FiEye />}</button></span></label>
            <label>Nueva contraseña<span className="password-field"><input type={passwordVisible.nueva ? 'text' : 'password'} value={nuevaPassword} onChange={(event) => setNuevaPassword(event.target.value)} minLength="6" required /><button type="button" className="password-toggle" onClick={() => setPasswordVisible((visible) => ({ ...visible, nueva: !visible.nueva }))} aria-label={passwordVisible.nueva ? 'Ocultar contraseña' : 'Mostrar contraseña'}>{passwordVisible.nueva ? <FiEyeOff /> : <FiEye />}</button></span></label>
            <label>Repite la nueva contraseña<span className="password-field"><input type={passwordVisible.repetir ? 'text' : 'password'} value={repetirPassword} onChange={(event) => setRepetirPassword(event.target.value)} minLength="6" required /><button type="button" className="password-toggle" onClick={() => setPasswordVisible((visible) => ({ ...visible, repetir: !visible.repetir }))} aria-label={passwordVisible.repetir ? 'Ocultar contraseña' : 'Mostrar contraseña'}>{passwordVisible.repetir ? <FiEyeOff /> : <FiEye />}</button></span></label>
          </div>
          <button className="profile-primary-button" type="button" onClick={cambiarPassword} disabled={cargando}>Actualizar contraseña</button>
        </div>
      </form>
    </section>
  );
}
