import React, { useState } from 'react';

export default function Chatbot({ token }) {
  const [pregunta, setPregunta] = useState('');
  const [historial, setHistorial] = useState([]);
  const [cargando, setCargando] = useState(false);

  const manejarEnvio = async (e) => {
    e.preventDefault();
    if (!pregunta.trim() || cargando) return;

    const consultaUsuario = pregunta;
    setPregunta('');
    setHistorial((prev) => [...prev, { emisor: 'usuario', texto: consultaUsuario }]);
    setCargando(true);

    try {
      const res = await fetch('http://localhost:8000/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ pregunta: consultaUsuario }),
      });

      const data = await res.json();
      if (data.ok) {
        setHistorial((prev) => [...prev, { emisor: 'bot', texto: data.respuesta }]);
      } else {
        setHistorial((prev) => [...prev, { emisor: 'bot', texto: `Error: ${data.error}` }]);
      }
    } catch (error) {
      setHistorial((prev) => [...prev, { emisor: 'bot', texto: 'Error al conectar con el servidor.' }]);
    } finally {
      setCargando(false);
    }
  };

  return (
    <div style={{ padding: '10px', maxWidth: '800px' }}>
      <h3>Módulo de Asistente Virtual IA / RAG</h3>
      <p style={{ color: '#64748b', marginBottom: '15px' }}>
        Consultas en tiempo real sobre manuales y procedimientos con MariaDB Vector.
      </p>

      <div style={{ height: '350px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '15px', overflowY: 'auto', background: '#fff', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {historial.length === 0 && <p style={{ color: '#94a3b8', textAlign: 'center', marginTop: '140px' }}>Haz una pregunta sobre los manuales...</p>}
        {historial.map((msg, i) => (
          <div key={i} style={{ alignSelf: msg.emisor === 'usuario' ? 'flex-end' : 'flex-start', background: msg.emisor === 'usuario' ? '#2563eb' : '#f1f5f9', color: msg.emisor === 'usuario' ? '#fff' : '#0f172a', padding: '8px 12px', borderRadius: '6px', maxWidth: '80%' }}>
            {msg.texto}
          </div>
        ))}
        {cargando && <div style={{ alignSelf: 'flex-start', color: '#64748b' }}>Buscando en manuales...</div>}
      </div>

      <form onSubmit={manejarEnvio} style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
        <input type="text" value={pregunta} onChange={(e) => setPregunta(e.target.value)} placeholder="Ej. ¿Cómo resuelvo el Error 402?" style={{ flex: 1, padding: '8px', borderRadius: '4px', border: '1px solid #cbd5e1' }} />
        <button type="submit" disabled={cargando} style={{ padding: '8px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Enviar</button>
      </form>
    </div>
  );
}