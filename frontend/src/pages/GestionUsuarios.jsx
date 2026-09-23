import React, { useState, useEffect } from 'react';
import { FiCheckCircle, FiXCircle, FiX } from 'react-icons/fi';
import { apiFetch } from '../services/api';
import OilLoader from '../components/common/OilLoader';

export default function GestionUsuarios({ token }) {
  const [usuarios, setUsuarios] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [modalNuevo, setModalNuevo] = useState(null);
  const [valorNuevo, setValorNuevo] = useState('');

  // =========================================================
  // CARGAR USUARIOS
  // =========================================================
  const cargarUsuarios = async () => {
    try {
      setCargando(true);

      const res = await apiFetch('/api/admin/usuarios', {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      const data = await res.json();

      if (data.ok) {
        setUsuarios(data.usuarios || []);
      } else {
        alert(`Error al cargar usuarios: ${data.error}`);
      }
    } catch (err) {
      console.error('Error al cargar usuarios:', err);
      alert('Error al cargar los usuarios.');
    } finally {
      setCargando(false);
    }
  };

  // =========================================================
  // CARGAR DATOS INICIALES
  // =========================================================
  useEffect(() => {
    cargarUsuarios();
  }, [token]);

  // =========================================================
  // ROLES DISPONIBLES
  // =========================================================
  const obtenerRolesDisponibles = () => {
    // Roles base con la escritura EXACTA que queremos mostrar
    const rolesBase = [
      'Técnico',
      'Operador',
      'Administrador',
      'Ingeniero MWD'
    ];

    // Obtener los roles directamente de Firebase
    // SIN toLowerCase()
    const rolesEnDB = usuarios
      .map((u) => u.rol)
      .filter((rol) => typeof rol === 'string' && rol.trim() !== '')
      .map((rol) => rol.trim());

    // Evitar duplicados respetando las mayúsculas originales
    return Array.from(new Set([...rolesBase, ...rolesEnDB]));
  };

  // =========================================================
  // ÁREAS DISPONIBLES
  // =========================================================
  const obtenerAreasDisponibles = () => {
    const areasEnDB = usuarios
      .map((u) => u.area || u.departamento)
      .filter((area) => typeof area === 'string' && area.trim() !== '' && area.trim() !== 'N/A')
      .map((area) => area.trim());

    return Array.from(new Set(areasEnDB));
  };

  // =========================================================
  // ACTUALIZAR USUARIO
  // =========================================================
  const actualizarUsuario = async (userId, nuevosDatos) => {
    if (!userId) {
      alert('Error: ID de usuario inválido');
      return;
    }

    // Copiamos los datos
    const payload = { ...nuevosDatos };

    // IMPORTANTE:
    // NO hacemos toLowerCase() al rol.
    // Firebase conservará:
    // "Ingeniero MWD"
    // "Técnico"
    // "Administrador"
    // etc.
    if (payload.rol) {
      payload.rol = payload.rol.trim();
    }

    // =======================================================
    // ACTUALIZACIÓN LOCAL INMEDIATA
    // =======================================================
    setUsuarios((prevUsuarios) =>
      prevUsuarios.map((u) => {
        const idActual = u.uid || u.id;

        if (idActual === userId) {
          return {
            ...u,
            ...payload
          };
        }

        return u;
      })
    );

    // =======================================================
    // ENVIAR CAMBIOS AL BACKEND
    // =======================================================
    try {
      const res = await apiFetch(`/api/admin/usuarios/${userId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      if (!data.ok) {
        alert(`Error al actualizar en servidor: ${data.error}`);

        // Recargar para recuperar el valor real
        await cargarUsuarios();
      }
    } catch (err) {
      console.error('Error al actualizar usuario:', err);

      alert(
        'Error de conexión con el servidor. Revirtiendo cambios...'
      );

      // Recuperar información real desde Firebase/backend
      await cargarUsuarios();
    }
  };

  // =========================================================
  // CAMBIO EN SELECT (ROL / ÁREA) — permite crear uno nuevo
  // =========================================================
  const manejarCambioSelect = (userId, campo, valor) => {
    if (valor !== '__nuevo__') {
      actualizarUsuario(userId, { [campo]: valor });
      return;
    }
    setValorNuevo('');
    setModalNuevo({ userId, campo });
  };

  const confirmarNuevo = () => {
    if (!modalNuevo) return;
    const limpio = valorNuevo.trim();
    if (!limpio) return;
    actualizarUsuario(modalNuevo.userId, { [modalNuevo.campo]: limpio });
    setModalNuevo(null);
    setValorNuevo('');
  };

  const cerrarModalNuevo = () => {
    setModalNuevo(null);
    setValorNuevo('');
  };

  // =========================================================
  // CARGANDO
  // =========================================================
  if (cargando) {
    return <OilLoader label="Cargando gestión de usuarios" inline />;
  }

  // =========================================================
  // ROLES
  // =========================================================
  const rolesDisponibles = obtenerRolesDisponibles();
  const areasDisponibles = obtenerAreasDisponibles();

  // =========================================================
  // RENDER
  // =========================================================
  return (
    <div
      className="admin-users-panel"
      style={{
        padding: '20px',
        maxWidth: '100%',
        background: '#fff',
        borderRadius: '8px',
        border: '1px solid #cbd5e1'
      }}
    >
      <h2
        style={{
          margin: '0 0 10px 0',
          fontSize: '20px',
          color: '#0f172a'
        }}
      >
        Panel de Administración de Usuarios
      </h2>

      <p
        style={{
          color: '#64748b',
          marginBottom: '20px',
          fontSize: '14px'
        }}
      >
        Aprobación de accesos, bajas y asignación de roles por área.
      </p>

      <div className="admin-users-table-wrap">
        <table
          className="admin-users-table"
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            background: '#fff',
            borderRadius: '6px',
            overflow: 'hidden',
            border: '1px solid #e2e8f0'
          }}
        >
          <thead>
            <tr
              style={{
                background: '#f8fafc',
                borderBottom: '1px solid #e2e8f0',
                textAlign: 'left'
              }}
            >
              <th style={{ padding: '12px' }}>
                Usuario
              </th>

              <th style={{ padding: '12px' }}>
                Email
              </th>

              <th style={{ padding: '12px' }}>
                Área
              </th>

              <th style={{ padding: '12px' }}>
                Rol
              </th>

              <th style={{ padding: '12px' }}>
                Estado
              </th>
            </tr>
          </thead>

          <tbody>
            {usuarios.map((u, index) => {
              const userId = u.uid || u.id;

              // IMPORTANTE:
              // Tomamos el rol exactamente como viene de Firebase.
              //
              // NO:
              // .toLowerCase()
              //
              // NO:
              // .toUpperCase()
              //
              // NO:
              // text-transform: capitalize
              //
              const rolActual = u.rol
                ? u.rol.trim()
                : 'Tecnico';

              const areaActual =
                u.area ||
                u.departamento ||
                'N/A';

              return (
                <tr
                  key={userId || index}
                  style={{
                    borderBottom: '1px solid #f1f5f9'
                  }}
                >
                  {/* ===============================
                      USUARIO
                  ================================ */}
                  <td
                    data-label="Usuario"
                    style={{ padding: '12px' }}
                  >
                    {u.nombre} {u.apellido}
                  </td>

                  {/* ===============================
                      EMAIL
                  ================================ */}
                  <td
                    data-label="Email"
                    style={{ padding: '12px' }}
                  >
                    {u.email}
                  </td>

                  {/* ===============================
                      ÁREA (editable)
                  ================================ */}
                  <td
                    data-label="Área"
                    style={{ padding: '12px' }}
                  >
                    <select
                      value={areaActual}
                      onChange={(e) =>
                        manejarCambioSelect(
                          userId,
                          'area',
                          e.target.value
                        )
                      }
                      style={{
                        padding: '4px 8px',
                        borderRadius: '4px',
                        border: '1px solid #cbd5e1',
                        background: '#fff',
                        cursor: 'pointer'
                      }}
                    >
                      {!areasDisponibles.includes(areaActual) && (
                        <option value={areaActual}>
                          {areaActual}
                        </option>
                      )}
                      {areasDisponibles.map((area) => (
                        <option
                          key={area}
                          value={area}
                        >
                          {area}
                        </option>
                      ))}
                      <option value="__nuevo__">
                        + Nueva área…
                      </option>
                    </select>
                  </td>

                  {/* ===============================
                      ROL
                  ================================ */}
                  <td
                    data-label="Rol"
                    style={{ padding: '12px' }}
                  >
                    <select
                      value={rolActual}
                      onChange={(e) =>
                        manejarCambioSelect(
                          userId,
                          'rol',
                          e.target.value
                        )
                      }
                      style={{
                        padding: '4px 8px',
                        borderRadius: '4px',
                        border: '1px solid #cbd5e1',
                        background: '#fff',
                        cursor: 'pointer'
                      }}
                    >
                      {!rolesDisponibles.includes(rolActual) && (
                        <option value={rolActual}>
                          {rolActual}
                        </option>
                      )}
                      {rolesDisponibles.map((rol) => (
                        <option
                          key={rol}
                          value={rol}
                        >
                          {rol}
                        </option>
                      ))}
                      <option value="__nuevo__">
                        + Nuevo rol…
                      </option>
                    </select>
                  </td>

                  {/* ===============================
                      ESTADO (toggle activo / inactivo)
                  ================================ */}
                  <td
                    data-label="Estado"
                    style={{ padding: '12px' }}
                  >
                    <button
                      type="button"
                      className={`user-toggle ${u.estado === 'activo' ? 'on' : 'off'}`}
                      role="switch"
                      aria-checked={u.estado === 'activo'}
                      title={
                        u.estado === 'activo'
                          ? 'Activo — clic para dar de baja'
                          : u.estado === 'pendiente'
                          ? 'Pendiente de aprobación — clic para aprobar'
                          : 'Inactivo — clic para reactivar'
                      }
                      aria-label={
                        u.estado === 'activo'
                          ? `Desactivar a ${u.nombre} ${u.apellido}`
                          : `Activar a ${u.nombre} ${u.apellido}`
                      }
                      onClick={() =>
                        actualizarUsuario(userId, {
                          estado: u.estado === 'activo' ? 'inactivo' : 'activo'
                        })
                      }
                    >
                      <span className="user-toggle-icon" aria-hidden="true">
                        {u.estado === 'activo' ? <FiCheckCircle /> : <FiXCircle />}
                      </span>
                      <span className="user-toggle-knob" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {modalNuevo && (
        <div
          className="modal-overlay eclipse-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={modalNuevo.campo === 'rol' ? 'Nuevo rol' : 'Nueva área'}
          onClick={(event) => {
            if (event.target === event.currentTarget) cerrarModalNuevo();
          }}
        >
          <div className="eclipse-modal catalog-eclipse-modal">
            <header className="eclipse-modal-header">
              <div>
                <span className="dashboard-eyebrow">Gestión de usuarios</span>
                <h2 style={{ margin: '4px 0 0', color: '#fff', fontSize: 20 }}>
                  {modalNuevo.campo === 'rol' ? 'Nuevo rol' : 'Nueva área'}
                </h2>
              </div>
              <button
                type="button"
                className="eclipse-modal-close"
                onClick={cerrarModalNuevo}
                aria-label="Cerrar"
              >
                <FiX aria-hidden="true" />
              </button>
            </header>

            <div className="eclipse-modal-body">
              <p className="eclipse-intro">
                {modalNuevo.campo === 'rol'
                  ? 'Escribe el nombre del rol que quieres asignar. Estará disponible para todos los usuarios.'
                  : 'Escribe el nombre del área que quieres asignar. Estará disponible para todos los usuarios.'}
              </p>
              <input
                autoFocus
                type="text"
                className="catalog-eclipse-input"
                value={valorNuevo}
                onChange={(e) => setValorNuevo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmarNuevo();
                  if (e.key === 'Escape') cerrarModalNuevo();
                }}
                placeholder={
                  modalNuevo.campo === 'rol'
                    ? 'Ej. Supervisor de Campo'
                    : 'Ej. Logística'
                }
              />
              <div className="catalog-eclipse-actions">
                <button
                  type="button"
                  className="catalog-eclipse-cancel"
                  onClick={cerrarModalNuevo}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="catalog-eclipse-confirm"
                  disabled={!valorNuevo.trim()}
                  onClick={confirmarNuevo}
                >
                  Guardar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}