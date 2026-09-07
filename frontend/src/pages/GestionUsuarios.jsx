import React, { useState, useEffect } from 'react';
import { apiFetch } from '../services/api';

export default function GestionUsuarios({ token }) {
  const [usuarios, setUsuarios] = useState([]);
  const [cargando, setCargando] = useState(true);

  const cargarUsuarios = async () => {
    try {
      const res = await apiFetch('/api/admin/usuarios', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.ok) {
        setUsuarios(data.usuarios);
      } else {
        alert(`Error al cargar usuarios: ${data.error}`);
      }
    } catch (err) {
      console.error('Error al cargar usuarios:', err);
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => {
    cargarUsuarios();
  }, []);

  const obtenerRolesDisponibles = () => {
    const rolesBase = ['tecnico', 'supervisor', 'administrador'];
    const rolesEnDB = usuarios.map(u => (u.rol || '').toLowerCase()).filter(Boolean);
    return Array.from(new Set([...rolesBase, ...rolesEnDB]));
  };

  const actualizarUsuario = async (userId, nuevosDatos) => {
    if (!userId) {
      alert('Error: ID de usuario inválido');
      return;
    }

    const payload = { ...nuevosDatos };
    if (payload.rol) {
      payload.rol = payload.rol.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }

    // 1. Actualización local inmediata en el estado de React (Feedback visual al instante)
    setUsuarios(prevUsuarios =>
      prevUsuarios.map(u => {
        const idActual = u.uid || u.id;
        if (idActual === userId) {
          return { ...u, ...payload };
        }
        return u;
      })
    );

    // 2. Envío de cambios al backend
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
        await cargarUsuarios(); // Revertir si hubo error
      }
    } catch (err) {
      alert('Error de conexión con el servidor. Revertiendo cambios...');
      await cargarUsuarios(); // Revertir si fallo la red
    }
  };

  if (cargando) return <p style={{ padding: '20px', textAlign: 'center' }}>Cargando gestión de usuarios...</p>;

  const rolesDisponibles = obtenerRolesDisponibles();

  return (
    <div className="admin-users-panel" style={{ padding: '20px', maxWidth: '100%', background: '#fff', borderRadius: '8px', border: '1px solid #cbd5e1' }}>
      <h2 style={{ margin: '0 0 10px 0', fontSize: '20px', color: '#0f172a' }}>Panel de Administración de Usuarios</h2>
      <p style={{ color: '#64748b', marginBottom: '20px', fontSize: '14px' }}>
        Aprobación de accesos, bajas y asignación de roles por área.
      </p>

      <div className="admin-users-table-wrap">
      <table className="admin-users-table" style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: '6px', overflow: 'hidden', border: '1px solid #e2e8f0' }}>
        <thead>
          <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
            <th style={{ padding: '12px' }}>Usuario</th>
            <th style={{ padding: '12px' }}>Email</th>
            <th style={{ padding: '12px' }}>Área</th>
            <th style={{ padding: '12px' }}>Rol</th>
            <th style={{ padding: '12px' }}>Estado</th>
            <th style={{ padding: '12px' }}>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {usuarios.map((u, index) => {
            const userId = u.uid || u.id;
            const rolActual = (u.rol || 'tecnico').toLowerCase();
            const areaActual = u.area || u.departamento || 'N/A';

            return (
              <tr key={userId || index} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td data-label="Usuario" style={{ padding: '12px' }}>{u.nombre} {u.apellido}</td>
                <td data-label="Email" style={{ padding: '12px' }}>{u.email}</td>
                <td data-label="Área" style={{ padding: '12px' }}>{areaActual}</td>
                <td data-label="Rol" style={{ padding: '12px' }}>
                  <select
                    value={rolActual}
                    onChange={(e) => actualizarUsuario(userId, { rol: e.target.value })}
                    style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #cbd5e1', textTransform: 'capitalize' }}
                  >
                    {rolesDisponibles.map((rol) => (
                      <option key={rol} value={rol} style={{ textTransform: 'capitalize' }}>
                        {rol}
                      </option>
                    ))}
                  </select>
                </td>
                <td data-label="Estado" style={{ padding: '12px' }}>
                  <span style={{
                    padding: '4px 8px',
                    borderRadius: '12px',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    background: u.estado === 'activo' ? '#dcfce7' : u.estado === 'pendiente' ? '#fef3c7' : '#fee2e2',
                    color: u.estado === 'activo' ? '#15803d' : u.estado === 'pendiente' ? '#b45309' : '#b91c1c'
                  }}>
                    {u.estado}
                  </span>
                </td>
                <td data-label="Acciones" style={{ padding: '12px' }}>
                  {u.estado === 'pendiente' && (
                    <button
                      type="button"
                      onClick={() => actualizarUsuario(userId, { estado: 'activo' })}
                      style={{ background: '#16a34a', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 500 }}
                    >
                      Aprobar
                    </button>
                  )}
                  {u.estado === 'activo' && (
                    <button
                      type="button"
                      onClick={() => actualizarUsuario(userId, { estado: 'inactivo' })}
                      style={{ background: '#dc2626', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer' }}
                    >
                      Dar de Baja
                    </button>
                  )}
                  {u.estado === 'inactivo' && (
                    <button
                      type="button"
                      onClick={() => actualizarUsuario(userId, { estado: 'activo' })}
                      style={{ background: '#2563eb', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer' }}
                    >
                      Reactivar
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}