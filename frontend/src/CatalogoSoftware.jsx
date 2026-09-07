import { useState, useEffect } from 'react';
import { FiDownload } from 'react-icons/fi';

function CatalogoSoftware({ token }) {
  const [softwareList, setSoftwareList] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    obtenerCatalogo();
  }, []);

  const obtenerCatalogo = async () => {
    try {
      const res = await fetch('http://localhost:8000/api/software', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.ok) {
        setSoftwareList(data.catalogo || []);
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError('Error al conectar con el servidor');
    } finally {
      setCargando(false);
    }
  };

  const handleDownload = async (id, nombre, version) => {
    try {
      const res = await fetch(`http://localhost:8000/api/software/${id}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const errData = await res.json();
        alert(`Error: ${errData.error}`);
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
      alert('Error en la descarga del software');
    }
  };

  if (cargando) return <p>Cargando catálogo de software...</p>;
  if (error) return <p style={{ color: 'red' }}>{error}</p>;

  return (
    <div>
      <h3>Catálogo de Software Autorizado</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 20, marginTop: 20 }}>
        {softwareList.length === 0 ? (
          <p>No hay aplicaciones disponibles actualmente.</p>
        ) : (
          softwareList.map((item) => (
            <div key={item.id} style={{ background: '#FFFFFF', padding: 20, borderRadius: 8, border: '1px solid #E5E7EB' }}>
              <h4 style={{ margin: '0 0 8px 0', color: '#000000' }}>{item.nombre}</h4>
              <span style={{ background: '#F8F9FA', padding: '2px 8px', borderRadius: 4, fontSize: 12, color: '#6B7280' }}>
                {item.version}
              </span>
              <p style={{ fontSize: 14, color: '#475569', margin: '12px 0 20px 0' }}>{item.descripcion}</p>
              <button
                type="button"
                onClick={() => handleDownload(item.id, item.nombre, item.version)}
                aria-label={`Descargar instalador de ${item.nombre}`}
                title="Descargar instalador ZIP"
                style={{ width: '100%', padding: '8px 12px', background: '#DD2226', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}>
                <FiDownload aria-hidden="true" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default CatalogoSoftware;