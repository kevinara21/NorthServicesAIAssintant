import React, { useState } from 'react';

export default function SubirRecursos({ token, alCompletar }) {
  const [nombre, setNombre] = useState('');
  const [version, setVersion] = useState('v1.0');
  const [descripcion, setDescripcion] = useState('');

  const [archivoZip, setArchivoZip] = useState(null);
  const [archivoPdf, setArchivoPdf] = useState(null);

  const [cargando, setCargando] = useState(false);
  const [progreso, setProgreso] = useState(0);
  const [mensaje, setMensaje] = useState(null);

  const handleSubmit = (e) => {
    e.preventDefault();

    if (!archivoZip && !archivoPdf) {
      setMensaje({ tipo: 'error', texto: 'Debes adjuntar al menos un archivo (ZIP o PDF).' });
      return;
    }

    setCargando(true);
    setProgreso(0);
    setMensaje(null);

    const formData = new FormData();
    formData.append('nombre', nombre);
    formData.append('version', version);
    formData.append('descripcion', descripcion);

    if (archivoZip) formData.append('zip', archivoZip);
    if (archivoPdf) formData.append('pdf', archivoPdf);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'http://localhost:8000/api/admin/upload-recurso-unificado');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    // Seguimiento del progreso de subida
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const porcentaje = Math.round((event.loaded / event.total) * 100);
        setProgreso(porcentaje);
      }
    };

    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status === 200 && data.ok) {
          setMensaje({ tipo: 'exito', texto: data.mensaje });
          setNombre('');
          setVersion('v1.0');
          setDescripcion('');
          setArchivoZip(null);
          setArchivoPdf(null);
          if (alCompletar) alCompletar();
        } else {
          setMensaje({ tipo: 'error', texto: data.error || 'Error al procesar el archivo' });
        }
      } catch (err) {
        setMensaje({ tipo: 'error', texto: 'Respuesta inválida del servidor.' });
      } finally {
        setCargando(false);
      }
    };

    xhr.onerror = () => {
      setMensaje({ tipo: 'error', texto: 'Error de conexión con el servidor.' });
      setCargando(false);
    };

    xhr.send(formData);
  };

  return (
    <div style={{ background: '#FFFFFF', padding: 20, borderRadius: 8, border: '1px solid #E5E7EB', marginBottom: 20 }}>
      <h3 style={{ margin: '0 0 15px 0', color: '#000000', fontWeight: 700 }}>Publicación Unificada de Recursos</h3>

      {mensaje && (
        <div style={{
          padding: 10,
          borderRadius: 4,
          marginBottom: 15,
          fontSize: 13,
          background: mensaje.tipo === 'exito' ? '#dcfce7' : '#fee2e2',
          color: mensaje.tipo === 'exito' ? '#15803d' : '#b91c1c'
        }}>
          {mensaje.texto}
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
          <input
            type="text"
            placeholder="Nombre del Recurso (ej. Drilling Merger)"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            required
            style={{ padding: 8, border: '1px solid #E5E7EB', borderRadius: 4 }}
          />

          <input
            type="text"
            placeholder="Versión (ej. v1.0)"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            required
            style={{ padding: 8, border: '1px solid #E5E7EB', borderRadius: 4 }}
          />
        </div>

        <textarea
          placeholder="Descripción técnica del recurso..."
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
          required
          rows={3}
          style={{ padding: 8, border: '1px solid #E5E7EB', borderRadius: 4, fontFamily: 'inherit' }}
        />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15, background: '#F8F9FA', padding: 12, borderRadius: 6, border: '1px solid #E5E7EB' }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 'bold', color: '#000000', marginBottom: 4 }}>
              Instalador Software (.ZIP / .RAR)
            </label>
            <input
              type="file"
              accept=".zip,.rar,.exe"
              onChange={(e) => setArchivoZip(e.target.files[0] || null)}
              style={{ fontSize: 12 }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 'bold', color: '#000000', marginBottom: 4 }}>
              Manual Técnico (.PDF)
            </label>
            <input
              type="file"
              accept=".pdf"
              onChange={(e) => setArchivoPdf(e.target.files[0] || null)}
              style={{ fontSize: 12 }}
            />
          </div>
        </div>

        {cargando && (
          <div style={{ marginTop: 5 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#6B7280', marginBottom: 4 }}>
              <span>Subiendo e Indexando...</span>
              <span>{progreso}%</span>
            </div>
            <div style={{ width: '100%', background: '#E5E7EB', height: 8, borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${progreso}%`, background: '#DD2226', height: '100%', transition: 'width 0.2s' }}></div>
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={cargando}
          style={{
            padding: 10,
            background: '#DD2226',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: cargando ? 'not-allowed' : 'pointer',
            fontWeight: 'bold',
            marginTop: 5
          }}
        >
          {cargando ? 'Procesando Recurso...' : 'Publicar Recurso Unificado'}
        </button>
      </form>
    </div>
  );
}