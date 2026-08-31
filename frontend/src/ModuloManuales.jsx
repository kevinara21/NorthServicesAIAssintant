import { useState, useEffect } from 'react';

function ModuloManuales({ token }) {
  const [manuales, setManuales] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    obtenerManuales();
  }, []);

  const obtenerManuales = async () => {
    try {
      const res = await fetch('http://localhost:8000/api/manuales', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.ok) {
        setManuales(data.catalogo || []);
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError('Error al conectar con el servidor');
    } finally {
      setCargando(false);
    }
  };

  const handleDownloadPDF = async (id, nombre) => {
    try {
      const res = await fetch(`http://localhost:8000/api/manuales/${id}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const errData = await res.json();
        alert(`Error (${res.status}): ${errData.error}`);
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
      alert(`Error al descargar PDF: ${err.message}`);
    }
  };

  if (cargando) return <p>Cargando documentación...</p>;
  if (error) return <p style={{ color: 'red' }}>{error}</p>;

  return (
    <div>
      <h3>Manuales y Documentación Técnica</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 20, marginTop: 20 }}>
        {manuales.length === 0 ? (
          <p>No hay manuales disponibles en el sistema.</p>
        ) : (
          manuales.map((item) => (
            <div key={item.id} style={{ background: '#fff', padding: 20, borderRadius: 8, border: '1px solid #cbd5e1' }}>
              <h4 style={{ margin: '0 0 8px 0', color: '#0f172a' }}>{item.nombre}</h4>
              <span style={{ background: '#e2e8f0', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>
                {item.version}
              </span>
              <p style={{ fontSize: 14, color: '#475569', margin: '12px 0 20px 0' }}>{item.descripcion}</p>
              <button
                onClick={() => handleDownloadPDF(item.id, item.nombre)}
                style={{ width: '100%', padding: '8px 12px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 500 }}>
                Descargar Documento PDF
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default ModuloManuales;