import React, { useState } from 'react';
import { FiCheckCircle, FiEdit3, FiFileText, FiPackage, FiPlus, FiTrash2, FiUploadCloud } from 'react-icons/fi';
import { API_URL } from '../services/api';

export default function SubirRecursos({ token, alCompletar }) {
  const [nombre, setNombre] = useState('');
  const [version, setVersion] = useState('v1.0');
  const [descripcion, setDescripcion] = useState('');

  const [archivoZip, setArchivoZip] = useState(null);
  const [archivoPdf, setArchivoPdf] = useState(null);
  const [arrastrandoZip, setArrastrandoZip] = useState(false);
  const [arrastrandoPdf, setArrastrandoPdf] = useState(false);

  const formatearTamano = (bytes) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const dm = 1;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  };

  const limpiarZip = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setArchivoZip(null);
    const input = document.getElementById('archivo-zip');
    if (input) input.value = '';
  };

  const limpiarPdf = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setArchivoPdf(null);
    const input = document.getElementById('archivo-pdf');
    if (input) input.value = '';
  };

  const [cargando, setCargando] = useState(false);
  const [progreso, setProgreso] = useState(0);
  const [fase, setFase] = useState('');
  const [mensaje, setMensaje] = useState(null);
  const soloManual = Boolean(archivoPdf && !archivoZip);

  const handleSubmit = (e) => {
    e.preventDefault();

    if (!archivoZip && !archivoPdf) {
      setMensaje({
        tipo: 'error',
        texto: 'Debes adjuntar un archivo PDF o un instalador de software.',
      });
      return;
    }

    if (!nombre.trim()) {
      setMensaje({
        tipo: 'error',
        texto: 'Debes ingresar el nombre del recurso.',
      });
      return;
    }

    setCargando(true);
    setProgreso(0);
    setFase('Subiendo archivos...');
    setMensaje(null);

    const formData = new FormData();

    formData.append('nombre', nombre.trim());
    if (!soloManual) {
      formData.append('version', version.trim());
      formData.append('descripcion', descripcion.trim());
    }

    if (archivoZip) {
      formData.append('zip', archivoZip);
    }

    if (archivoPdf) {
      formData.append('pdf', archivoPdf);
    }

    const xhr = new XMLHttpRequest();

    xhr.open(
      'POST',
      `${API_URL}/api/admin/upload-recurso-unificado`
    );

    xhr.setRequestHeader(
      'Authorization',
      `Bearer ${token}`
    );

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;

      const porcentaje = Math.round(
        (event.loaded / event.total) * 100
      );

      setProgreso(porcentaje);

      if (porcentaje >= 100) {
        setFase(
          archivoPdf
            ? 'Archivo recibido. Indexando manual en MongoDB...'
            : 'Archivo recibido. Finalizando publicación...'
        );
      } else {
        setFase('Subiendo archivos...');
      }
    };

    xhr.onload = () => {
      try {
        let data = null;

        try {
          data = JSON.parse(xhr.responseText);
        } catch (_) {
          data = null;
        }

        if (xhr.status >= 200 && xhr.status < 300 && data?.ok) {
          setProgreso(100);
          setFase('Proceso completado.');

          setMensaje({
            tipo: 'exito',
            texto:
              data.mensaje ||
              'El recurso fue publicado correctamente.',
          });

          setNombre('');
          setVersion('v1.0');
          setDescripcion('');
          setArchivoZip(null);
          setArchivoPdf(null);

          // Reiniciamos los inputs file visualmente.
          const inputZip = document.getElementById(
            'archivo-zip'
          );

          const inputPdf = document.getElementById(
            'archivo-pdf'
          );

          if (inputZip) inputZip.value = '';
          if (inputPdf) inputPdf.value = '';

          if (alCompletar) {
            alCompletar();
          }
        } else {
          setMensaje({
            tipo: 'error',
            texto:
              data?.error ||
              `Error al procesar el recurso. Código HTTP: ${xhr.status}`,
          });

          setFase('El proceso terminó con errores.');
        }
      } catch (error) {
        console.error(
          'Error procesando respuesta:',
          error
        );

        setMensaje({
          tipo: 'error',
          texto: 'Respuesta inválida del servidor.',
        });

        setFase('El proceso terminó con errores.');
      } finally {
        setCargando(false);
      }
    };

    xhr.onerror = () => {
      console.error('Error de conexión con el servidor.');

      setMensaje({
        tipo: 'error',
        texto:
          'No se pudo conectar con el servidor. Verifica que el backend esté ejecutándose.',
      });

      setFase('Error de conexión.');
      setCargando(false);
    };

    xhr.onabort = () => {
      setMensaje({
        tipo: 'error',
        texto: 'La carga fue cancelada.',
      });

      setFase('Carga cancelada.');
      setCargando(false);
    };

    xhr.ontimeout = () => {
      setMensaje({
        tipo: 'error',
        texto:
          'La solicitud tardó demasiado tiempo y fue cancelada.',
      });

      setFase('Tiempo de espera agotado.');
      setCargando(false);
    };

    xhr.send(formData);
  };

  return (
    <div
      className="resource-upload-panel"
      style={{
        background: '#FFFFFF',
        padding: 20,
        borderRadius: 8,
        border: '1px solid #E5E7EB',
        marginBottom: 20,
      }}
    >
      <h3
        className="resource-upload-form"
        style={{
          margin: '0 0 6px 0',
          color: '#000000',
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <FiUploadCloud aria-hidden="true" style={{ color: '#DD2226', fontSize: 20 }} />
        Publicación de Recursos
      </h3>

      <p
        style={{
          margin: '0 0 15px',
          color: '#6B7280',
          fontSize: 13,
        }}
      >
        Publica un manual PDF para el asistente IA. El instalador de software es opcional.
      </p>

      {mensaje && (
        <div
          className="resource-main-fields"
          style={{
            padding: 10,
            borderRadius: 5,
            marginBottom: 15,
            fontSize: 13,
            background:
              mensaje.tipo === 'exito'
                ? '#dcfce7'
                : '#fee2e2',
            color:
              mensaje.tipo === 'exito'
                ? '#15803d'
                : '#b91c1c',
            border:
              mensaje.tipo === 'exito'
                ? '1px solid #bbf7d0'
                : '1px solid #fecaca',
          }}
        >
          {mensaje.texto}
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div
          className="resource-file-fields"
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr',
            gap: 10,
          }}
        >
          <input
            className="resource-field"
            type="text"
            placeholder="Nombre del Recurso (ej. Drilling Merger)"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            required
            disabled={cargando}
            style={{
              padding: 9,
              border: '1px solid #E5E7EB',
              borderRadius: 4,
              outline: 'none',
              background: '#FFFFFF',
              color: '#111827',
            }}
          />

          <input
            className="resource-field"
            type="text"
            placeholder="Versión (ej. v1.0)"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            required={!soloManual}
            disabled={cargando || soloManual}
            style={{
              padding: 9,
              border: '1px solid #E5E7EB',
              borderRadius: 4,
              outline: 'none',
              background: '#FFFFFF',
              color: '#111827',
            }}
          />
        </div>

        <textarea
          className="resource-field"
          placeholder="Descripción técnica del recurso..."
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
          required={!soloManual}
          disabled={cargando || soloManual}
          rows={3}
          style={{
            padding: 9,
            border: '1px solid #E5E7EB',
            borderRadius: 4,
            fontFamily: 'inherit',
            resize: 'vertical',
            outline: 'none',
            background: '#FFFFFF',
            color: '#111827',
          }}
        />

        <div className="custom-upload-grid">
          {/* Tarjeta 1: Instalador de software (ZIP/RAR/EXE) */}
          <div
            className={`custom-upload-card ${archivoZip ? 'has-file' : ''} ${arrastrandoZip ? 'dragging' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setArrastrandoZip(true); }}
            onDragLeave={() => setArrastrandoZip(false)}
            onDrop={(e) => {
              e.preventDefault();
              setArrastrandoZip(false);
              const file = e.dataTransfer.files?.[0];
              if (file) setArchivoZip(file);
            }}
            onClick={() => document.getElementById('archivo-zip')?.click()}
          >
            <input
              id="archivo-zip"
              type="file"
              accept=".zip,.rar,.exe"
              disabled={cargando}
              style={{ display: 'none' }}
              onChange={(e) => setArchivoZip(e.target.files?.[0] || null)}
            />

            <div className="custom-upload-icon-circle">
              {archivoZip ? <FiCheckCircle style={{ fontSize: 24 }} /> : <FiPackage style={{ fontSize: 22 }} />}
            </div>

            <div className="custom-upload-title">Instalador de software (opcional)</div>
            <div className="custom-upload-subtitle">Formatos admitidos: ZIP, RAR, EXE</div>

            {archivoZip ? (
              <div className="custom-upload-file-info" onClick={(e) => e.stopPropagation()}>
                <span className="custom-upload-file-name" title={archivoZip.name}>
                  {archivoZip.name}
                </span>
                <span className="custom-upload-file-size">
                  {formatearTamano(archivoZip.size)}
                </span>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    type="button"
                    className="custom-upload-badge"
                    onClick={() => document.getElementById('archivo-zip')?.click()}
                  >
                    <FiEdit3 /> Cambiar
                  </button>
                  <button
                    type="button"
                    className="custom-upload-remove-btn"
                    onClick={limpiarZip}
                  >
                    <FiTrash2 /> Quitar
                  </button>
                </div>
              </div>
            ) : (
              <span className="custom-upload-badge">
                <FiPlus /> Seleccionar instalador
              </span>
            )}
          </div>

          {/* Tarjeta 2: Manual Técnico (PDF) */}
          <div
            className={`custom-upload-card ${archivoPdf ? 'has-file' : ''} ${arrastrandoPdf ? 'dragging' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setArrastrandoPdf(true); }}
            onDragLeave={() => setArrastrandoPdf(false)}
            onDrop={(e) => {
              e.preventDefault();
              setArrastrandoPdf(false);
              const file = e.dataTransfer.files?.[0];
              if (file) setArchivoPdf(file);
            }}
            onClick={() => document.getElementById('archivo-pdf')?.click()}
          >
            <input
              id="archivo-pdf"
              type="file"
              accept=".pdf,application/pdf"
              disabled={cargando}
              style={{ display: 'none' }}
              onChange={(e) => setArchivoPdf(e.target.files?.[0] || null)}
            />

            <div className="custom-upload-icon-circle">
              {archivoPdf ? <FiCheckCircle style={{ fontSize: 24 }} /> : <FiFileText style={{ fontSize: 22 }} />}
            </div>

            <div className="custom-upload-title">Manual Técnico para IA</div>
            <div className="custom-upload-subtitle">Documento PDF (Indexación RAG)</div>

            {archivoPdf ? (
              <div className="custom-upload-file-info" onClick={(e) => e.stopPropagation()}>
                <span className="custom-upload-file-name" title={archivoPdf.name}>
                  {archivoPdf.name}
                </span>
                <span className="custom-upload-file-size">
                  {formatearTamano(archivoPdf.size)}
                </span>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    type="button"
                    className="custom-upload-badge"
                    onClick={() => document.getElementById('archivo-pdf')?.click()}
                  >
                    <FiEdit3 /> Cambiar
                  </button>
                  <button
                    type="button"
                    className="custom-upload-remove-btn"
                    onClick={limpiarPdf}
                  >
                    <FiTrash2 /> Quitar
                  </button>
                </div>
              </div>
            ) : (
              <span className="custom-upload-badge">
                <FiPlus /> Seleccionar manual PDF
              </span>
            )}
          </div>
        </div>

        {cargando && (
          <div style={{ marginTop: 5 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 12,
                color: '#6B7280',
                marginBottom: 5,
              }}
            >
              <span>{fase}</span>
              <span>{progreso}%</span>
            </div>

            <div
              style={{
                width: '100%',
                background: '#E5E7EB',
                height: 8,
                borderRadius: 4,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${progreso}%`,
                  background: '#DD2226',
                  height: '100%',
                  transition: 'width 0.2s ease',
                }}
              />
            </div>

            {archivoPdf && progreso >= 100 && (
              <div
                style={{
                  marginTop: 7,
                  fontSize: 11,
                  color: '#6B7280',
                }}
              >
                El archivo ya fue enviado. El servidor
                ahora está extrayendo el texto, generando
                embeddings y guardando los vectores en
                MongoDB Atlas.
              </div>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={cargando}
          style={{
            padding: 11,
            background: cargando
              ? '#9CA3AF'
              : '#DD2226',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: cargando
              ? 'not-allowed'
              : 'pointer',
            fontWeight: 'bold',
            marginTop: 5,
            transition: 'background 0.2s',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            fontSize: 14,
          }}
        >
          {cargando ? (
            'Procesando Recurso...'
          ) : (
            <>
              <FiUploadCloud aria-hidden="true" style={{ fontSize: 18 }} />
              Publicar Recurso Unificado
            </>
          )}
        </button>
      </form>
    </div>
  );
}