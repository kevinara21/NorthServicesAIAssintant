import { useEffect, useState } from 'react';
import { FiEdit2, FiPlus, FiSave } from 'react-icons/fi';
import { apiFetch } from '../services/api';

const pozoVacio = {
  nombrePozo: '', correo: '', codigoKit: '', serieAntena: '',
  diaInicioPeriodo: '', diaFinPeriodo: '', diaPago: '', estadoPago: 'no_pagado',
};

function calcularDiaPago(diaInicio) {
  const dia = Number(diaInicio);
  return dia >= 1 && dia <= 31 ? (dia === 1 ? 31 : dia - 1) : '';
}

export default function GestionFacturacion({ token }) {
  const [pozos, setPozos] = useState([]);
  const [formulario, setFormulario] = useState(pozoVacio);
  const [editando, setEditando] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState(null);

  const cargarPozos = async () => {
    try {
      const respuesta = await apiFetch('/api/admin/starlink', { headers: { Authorization: `Bearer ${token}` } });
      const texto = await respuesta.text();
      let data;
      try {
        data = JSON.parse(texto);
      } catch {
        throw new Error('El backend no respondió la API de Starlink. Reinicia el servidor backend en el puerto 8000.');
      }
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo cargar la información.');
      setPozos((data.pozos || []).sort((a, b) => {
        if (!a.diaPago) return 1;
        if (!b.diaPago) return -1;
        return Number(a.diaPago) - Number(b.diaPago);
      }));
    } catch (error) {
      setMensaje({ tipo: 'error', texto: error.message });
    } finally { setCargando(false); }
  };

  useEffect(() => { cargarPozos(); }, []);

  const cambiarCampo = (campo, valor) => {
    setFormulario((actual) => ({
      ...actual,
      [campo]: valor,
      ...(campo === 'diaInicioPeriodo' && !actual.diaPago ? { diaPago: calcularDiaPago(valor) } : {}),
    }));
  };

  const editarPozo = (pozo) => {
    setEditando(pozo.id);
    setFormulario({ ...pozoVacio, ...pozo });
    setMensaje(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelarEdicion = () => { setEditando(null); setFormulario(pozoVacio); };

  const guardarPozo = async (event) => {
    event.preventDefault();
    setGuardando(true);
    setMensaje(null);
    const ruta = editando ? `/api/admin/starlink/${editando}` : '/api/admin/starlink';
    try {
      const respuesta = await apiFetch(ruta, {
        method: editando ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(formulario),
      });
      const texto = await respuesta.text();
      let data;
      try {
        data = JSON.parse(texto);
      } catch {
        throw new Error('El backend no respondió correctamente. Reinicia el servidor backend.');
      }
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo guardar el pozo.');
      setMensaje({ tipo: 'exito', texto: editando ? 'Información actualizada en Firebase.' : 'Pozo agregado a Firebase.' });
      cancelarEdicion();
      await cargarPozos();
    } catch (error) {
      setMensaje({ tipo: 'error', texto: error.message });
    } finally { setGuardando(false); }
  };

  if (cargando) return <p className="billing-loading">Cargando pozos y facturación...</p>;

  return (
    <section className="billing-page">
      <div className="billing-heading">
        <span className="dashboard-eyebrow">Administración</span>
        <h1>Pago de Starlink</h1>
        <p>Consulta y actualiza el estado de pago. La fecha sugerida de pago es un día antes del inicio del periodo.</p>
      </div>

      {mensaje && <div className={`profile-message ${mensaje.tipo}`}>{mensaje.texto}</div>}

      <form className="billing-form" onSubmit={guardarPozo}>
        <div className="billing-form-header"><h3>{editando ? 'Editar registro Starlink' : 'Agregar Starlink'}</h3>{editando && <button className="billing-cancel" type="button" onClick={cancelarEdicion}>Cancelar</button>}</div>
        <div className="billing-form-grid">
          <label>Ubicación<input value={formulario.nombrePozo} onChange={(event) => cambiarCampo('nombrePozo', event.target.value)} required /></label>
          <label>Correo<input type="email" value={formulario.correo} onChange={(event) => cambiarCampo('correo', event.target.value)} /></label>
          <label>Código KIT<input value={formulario.codigoKit} readOnly={Boolean(editando)} onChange={(event) => cambiarCampo('codigoKit', event.target.value)} /></label>
          <label>N° Serie Antena<input value={formulario.serieAntena || formulario.codigo4Pba || ''} readOnly={Boolean(editando)} onChange={(event) => cambiarCampo('serieAntena', event.target.value)} /></label>
          {!editando && <label>Día de inicio del periodo<input type="number" min="1" max="31" placeholder="Ej. 14" value={formulario.diaInicioPeriodo} onChange={(event) => cambiarCampo('diaInicioPeriodo', event.target.value)} /></label>}
          {!editando && <label>Día de fin del periodo<input type="number" min="1" max="31" placeholder="Ej. 13" value={formulario.diaFinPeriodo} onChange={(event) => cambiarCampo('diaFinPeriodo', event.target.value)} /></label>}
          {!editando && <label>Día de pago<input type="number" min="1" max="31" value={formulario.diaPago} onChange={(event) => cambiarCampo('diaPago', event.target.value)} /></label>}
          <label>Estado de pago<select value={formulario.estadoPago} onChange={(event) => cambiarCampo('estadoPago', event.target.value)}><option value="no_pagado">No pagado</option><option value="pagado">Pagado</option></select></label>
        </div>
        {editando && <p className="billing-immutable-period">Periodo registrado: del día {formulario.diaInicioPeriodo || '-'} al {formulario.diaFinPeriodo || '-'} de cada mes · Pago día {formulario.diaPago || '-'}</p>}
        <button className="profile-primary-button" type="submit" disabled={guardando}>{editando ? <><FiSave /> Guardar cambios</> : <><FiPlus /> Agregar pozo</>}</button>
      </form>

      <div className="billing-table-wrap">
        <table className="billing-table"><thead><tr><th>Ubicación</th><th>Correo</th><th>Identificadores</th><th>Periodo</th><th>Pago</th><th>Acción</th></tr></thead><tbody>
          {pozos.length === 0 ? <tr><td colSpan="6" className="billing-empty">No hay pozos registrados.</td></tr> : pozos.map((pozo) => (
            <tr key={pozo.id}>
              <td data-label="Ubicación"><strong>{pozo.nombrePozo}</strong></td>
              <td data-label="Correo">{pozo.correo || 'Sin correo'}</td>
              <td data-label="Identificadores"><small>KIT S/N: {pozo.codigoKit || '-'}<br />Serie antena: {pozo.serieAntena || pozo.codigo4Pba || '-'}</small></td>
              <td data-label="Periodo">Día {pozo.diaInicioPeriodo || pozo.periodoInicio || '-'} de cada mes</td>
              <td data-label="Pago"><span className={`billing-status ${pozo.estadoPago}`}>{pozo.estadoPago === 'pagado' ? 'Pagado' : 'No pagado'}</span><small>Vence día {pozo.diaPago || pozo.fechaPago || '-'}</small></td>
              <td data-label="Acción"><button className="billing-edit-button" type="button" onClick={() => editarPozo(pozo)}><FiEdit2 /> Editar</button></td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </section>
  );
}
