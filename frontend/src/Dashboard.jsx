import React, { useState, useEffect } from 'react';
import GestionUsuarios from './pages/GestionUsuarios';
import SubirRecursos from './SubirRecursos';

export default function Dashboard({ usuario, token, onLogout }) {
  const [chatAbierto, setChatAbierto] = useState(false);
  const [pregunta, setPregunta] = useState('');
  const [historialChat, setHistorialChat] = useState([]);
  const [cargandoChat, setCargandoChat] = useState(false);

  const [softwareList, setSoftwareList] = useState([]);
  const [manualesList, setManualesList] = useState([]);
  const [cargandoRecursos, setCargandoRecursos] = useState(true);

  const [verAdmin, setVerAdmin] = useState(false);
  const [verSubir, setVerSubir] = useState(false);

  useEffect(() => {
    if (token) {
      cargarDashboardData();
    }
  }, [token]);

  const cargarDashboardData = async () => {
    setCargandoRecursos(true);
    try {
      const [resSoftware, resManuales] = await Promise.all([
        fetch('http://localhost:8000/api/software', { headers: { Authorization: `Bearer ${token}` } }),
        fetch('http://localhost:8000/api/manuales', { headers: { Authorization: `Bearer ${token}` } })
      ]);

      const dataSoftware = await resSoftware.json();
      const dataManuales = await resManuales.json();

      if (dataSoftware.ok) setSoftwareList(dataSoftware.catalogo || []);
      if (dataManuales.ok) setManualesList(dataManuales.catalogo || []);
    } catch (error) {
      console.error('Error cargando recursos:', error);
    } finally {
      setCargandoRecursos(false);
    }
  };

  const handleDownloadSoftware = async (id, nombre, version) => {
    try {
      const res = await fetch(`http://localhost:8000/api/software/${id}/download`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const errData = await res.json();
        alert(`Error: ${errData.error || 'Acceso denegado'}`);
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${nombre}_${version}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert('No se pudo descargar el software.');
    }
  };

  const handleDownloadPDF = async (id, nombre) => {
    try {
      const res = await fetch(`http://localhost:8000/api/manuales/${id}/download`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const errData = await res.json();
        alert(`Error: ${errData.error || 'Acceso denegado'}`);
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${nombre}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert('No se pudo descargar el manual.');
    }
  };

  const manejarEnvioChat = async (e) => {
    e.preventDefault();
    if (!pregunta.trim() || cargandoChat) return;

    const consulta = pregunta;
    setPregunta('');
    setHistorialChat((prev) => [...prev, { emisor: 'usuario', texto: consulta }]);
    setCargandoChat(true);

    try {
      const res = await fetch('http://localhost:8000/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ pregunta: consulta })
      });
      const data = await res.json();
      if (data.ok) {
        setHistorialChat((prev) => [...prev, { emisor: 'bot', texto: data.respuesta }]);
      } else {
        setHistorialChat((prev) => [...prev, { emisor: 'bot', texto: `Error: ${data.error}` }]);
      }
    } catch (error) {
      setHistorialChat((prev) => [...prev, { emisor: 'bot', texto: 'Error al conectar con el servidor.' }]);
    } finally {
      setCargandoChat(false);
    }
  };

  if (!usuario) {
    return <div style={{ padding: 40, textAlign: 'center', fontFamily: 'sans-serif' }}>Cargando panel...</div>;
  }

  const esAdministrador = usuario?.rol?.toLowerCase() === 'administrador';
  const rolTexto = usuario?.rol ? usuario.rol.charAt(0).toUpperCase() + usuario.rol.slice(1).toLowerCase() : 'Técnico';
  const areaTexto = usuario?.area || usuario?.departamento || 'General';

  return (
    <div style={{ minHeight: '100vh', background: '#f1f5f9', fontFamily: 'system-ui, sans-serif', color: '#0f172a' }}>
      
      {/* HEADER */}
      <header style={{ background: '#1e293b', color: '#fff', padding: '15px 30px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20 }}>North Services AI</h2>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>Portal Técnico Integral</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 'bold', fontSize: 14 }}>{usuario?.nombre} {usuario?.apellido}</div>
            <div style={{ fontSize: 12, color: '#38bdf8' }}>
              Rol: {rolTexto} - Área: {areaTexto}
            </div>
          </div>

          {esAdministrador && (
            <div style={{ display: 'flex', gap: 10 }}>
              <button 
                type="button"
                onClick={() => { setVerSubir(!verSubir); setVerAdmin(false); }}
                style={{ background: verSubir ? '#0284c7' : '#334155', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>
                {verSubir ? 'Ocultar Carga' : 'Subir Recursos'}
              </button>

              <button 
                type="button"
                onClick={() => { setVerAdmin(!verAdmin); setVerSubir(false); }}
                style={{ background: verAdmin ? '#0284c7' : '#334155', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>
                {verAdmin ? 'Ocultar Admin' : 'Gestión Usuarios'}
              </button>
            </div>
          )}

          <button 
            type="button"
            onClick={onLogout}
            style={{ background: '#ef4444', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
            Salir
          </button>
        </div>
      </header>

      {/* MAIN CONTENT */}
      <main style={{ padding: '30px', maxWidth: 1400, margin: '0 auto', position: 'relative', zIndex: 1 }}>
        
        {/* PANEL SUBIR RECURSOS */}
        {verSubir && esAdministrador && (
          <section style={{ marginBottom: 30, position: 'relative', zIndex: 10 }}>
            <SubirRecursos token={token} alCompletar={cargarDashboardData} />
          </section>
        )}

        {/* PANEL ADMINISTRADOR MODULAR */}
        {verAdmin && esAdministrador && (
          <section style={{ marginBottom: 30, position: 'relative', zIndex: 10 }}>
            <GestionUsuarios token={token} />
          </section>
        )}

        {/* CATÁLOGOS */}
        {cargandoRecursos ? (
          <p style={{ textAlign: 'center', padding: 40 }}>Cargando catálogo unificado...</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(500px, 1fr))', gap: 30 }}>
            
            {/* SOFTWARE */}
            <div style={{ background: '#fff', padding: 25, borderRadius: 12, border: '1px solid #cbd5e1', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, borderBottom: '1px solid #f1f5f9', paddingBottom: 10 }}>
                <h3 style={{ margin: 0, fontSize: 18, color: '#0f172a' }}>Catálogo de Software Autorizado</h3>
                <span style={{ fontSize: 12, background: '#e0f2fe', color: '#0369a1', padding: '4px 10px', borderRadius: 20, fontWeight: 600 }}>{softwareList.length} disponibles</span>
              </div>

              {softwareList.length === 0 ? (
                <p style={{ color: '#64748b' }}>No hay aplicaciones registradas actualmente.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
                  {softwareList.map((item) => (
                    <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 15, border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc' }}>
                      <div>
                        <strong style={{ fontSize: 15, color: '#1e293b' }}>{item.nombre}</strong>
                        <span style={{ fontSize: 11, background: '#cbd5e1', padding: '2px 6px', borderRadius: 4, marginLeft: 8 }}>{item.version}</span>
                        <p style={{ margin: '4px 0 0 0', fontSize: 13, color: '#64748b' }}>{item.descripcion}</p>
                      </div>
                      <button 
                        type="button"
                        onClick={() => handleDownloadSoftware(item.id, item.nombre, item.version)}
                        style={{ background: '#2563eb', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>
                        Descargar ZIP
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* MANUALES */}
            <div style={{ background: '#fff', padding: 25, borderRadius: 12, border: '1px solid #cbd5e1', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, borderBottom: '1px solid #f1f5f9', paddingBottom: 10 }}>
                <h3 style={{ margin: 0, fontSize: 18, color: '#0f172a' }}>Manuales y Documentos Técnicos</h3>
                <span style={{ fontSize: 12, background: '#f0fdf4', color: '#15803d', padding: '4px 10px', borderRadius: 20, fontWeight: 600 }}>{manualesList.length} archivos</span>
              </div>

              {manualesList.length === 0 ? (
                <p style={{ color: '#64748b' }}>No hay manuales disponibles.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
                  {manualesList.map((item) => (
                    <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 15, border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc' }}>
                      <div>
                        <strong style={{ fontSize: 15, color: '#1e293b' }}>{item.nombre}</strong>
                        <span style={{ fontSize: 11, background: '#cbd5e1', padding: '2px 6px', borderRadius: 4, marginLeft: 8 }}>{item.version}</span>
                        <p style={{ margin: '4px 0 0 0', fontSize: 13, color: '#64748b' }}>{item.descripcion}</p>
                      </div>
                      <button 
                        type="button"
                        onClick={() => handleDownloadPDF(item.id, item.nombre)}
                        style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>
                        Descargar PDF
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        )}
      </main>

      {/* CHATBOT FLOTANTE */}
      <div style={{ position: 'fixed', bottom: 25, right: 25, zIndex: 1000, pointerEvents: 'none' }}>
        <div style={{
          width: 360,
          height: 480,
          background: '#fff',
          borderRadius: 16,
          boxShadow: '0 10px 25px -5px rgba(0,0,0,0.2)',
          border: '1px solid #cbd5e1',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          marginBottom: 15,
          transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          transform: chatAbierto ? 'scale(1) translateY(0)' : 'scale(0.8) translateY(20px)',
          opacity: chatAbierto ? 1 : 0,
          pointerEvents: chatAbierto ? 'auto' : 'none',
          transformOrigin: 'bottom right'
        }}>
          <div style={{ background: '#1e293b', color: '#fff', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 10, height: 10, background: '#22c55e', borderRadius: '50%' }}></span>
              <strong>Asistente IA (RAG)</strong>
            </div>
            <button type="button" onClick={() => setChatAbierto(false)} style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 18 }}>X</button>
          </div>

          <div style={{ flex: 1, padding: 15, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, background: '#f8fafc' }}>
            {historialChat.length === 0 && (
              <p style={{ color: '#94a3b8', textAlign: 'center', marginTop: 140, fontSize: 13 }}>
                ¿En qué puedo ayudarte hoy sobre los procedimientos?
              </p>
            )}
            {historialChat.map((msg, i) => (
              <div key={i} style={{
                alignSelf: msg.emisor === 'usuario' ? 'flex-end' : 'flex-start',
                background: msg.emisor === 'usuario' ? '#2563eb' : '#fff',
                color: msg.emisor === 'usuario' ? '#fff' : '#0f172a',
                padding: '8px 12px',
                borderRadius: 10,
                maxWidth: '82%',
                fontSize: 13,
                border: msg.emisor === 'bot' ? '1px solid #e2e8f0' : 'none',
                boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
              }}>
                {msg.texto}
              </div>
            ))}
            {cargandoChat && <div style={{ fontSize: 12, color: '#64748b' }}>Consultando manuales con MongoDB Vector...</div>}
          </div>

          <form onSubmit={manejarEnvioChat} style={{ padding: 10, background: '#fff', borderTop: '1px solid #e2e8f0', display: 'flex', gap: 8 }}>
            <input 
              type="text" 
              value={pregunta} 
              onChange={(e) => setPregunta(e.target.value)} 
              placeholder="Escribe tu duda..." 
              style={{ flex: 1, padding: '8px 12px', border: '1px solid #cbd5e1', borderRadius: 20, outline: 'none', fontSize: 13 }} 
            />
            <button type="submit" disabled={cargandoChat} style={{ background: '#2563eb', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 20, cursor: 'pointer', fontSize: 13 }}>
              Enviar
            </button>
          </form>
        </div>

        <button 
          type="button"
          onClick={() => setChatAbierto(!chatAbierto)}
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: '#2563eb',
            color: '#fff',
            border: 'none',
            boxShadow: '0 4px 12px rgba(37, 99, 235, 0.4)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            fontWeight: 'bold',
            float: 'right',
            pointerEvents: 'auto'
          }}>
          {chatAbierto ? 'Cerrar' : 'Chat'}
        </button>
      </div>

    </div>
  );
}