import React, { useState } from 'react';
import { API_URL } from '../services/api';

export default function SubirRecursos({ token, alCompletar }) {
  const [nombre, setNombre] = useState('');
  const [version, setVersion] = useState('v1.0');
  const [descripcion, setDescripcion] = useState('');

  const [archivoZip, setArchivoZip] = useState(null);
  const [archivoPdf, setArchivoPdf] = useState(null);

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
        }}
      >
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

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 15,
            background: '#FFFFFF',
            padding: 12,
            borderRadius: 6,
            border: '1px solid #E5E7EB',
          }}
        >
          <div>
            <label
              style={{
                display: 'block',
                fontSize: 12,
                fontWeight: 'bold',
                color: '#000000',
                marginBottom: 5,
              }}
            >
              Instalador de software (opcional)
            </label>

            <div
              style={{
                fontSize: 11,
                color: '#6B7280',
                marginBottom: 6,
              }}
            >
              ZIP / RAR / EXE
            </div>

            <input
              className="resource-field"
              id="archivo-zip"
              type="file"
              accept=".zip,.rar,.exe"
              disabled={cargando}
              onChange={(e) =>
                setArchivoZip(
                  e.target.files?.[0] || null
                )
              }
              style={{
                fontSize: 12,
                width: '100%',
                background: '#FFFFFF',
                color: '#111827',
              }}
            />

            {archivoZip && (
              <div
                style={{
                  marginTop: 5,
                  fontSize: 11,
                  color: '#475569',
                  wordBreak: 'break-all',
                }}
              >
                Seleccionado: {archivoZip.name}
              </div>
            )}
          </div>

          <div>
            <label
              style={{
                display: 'block',
                fontSize: 12,
                fontWeight: 'bold',
                color: '#000000',
                marginBottom: 5,
              }}
            >
              Manual Técnico
            </label>

            <div
              style={{
                fontSize: 11,
                color: '#6B7280',
                marginBottom: 6,
              }}
            >
              PDF para el sistema RAG (puede subirse solo)
            </div>

            <input
              className="resource-field"
              id="archivo-pdf"
              type="file"
              accept=".pdf,application/pdf"
              disabled={cargando}
              onChange={(e) =>
                setArchivoPdf(
                  e.target.files?.[0] || null
                )
              }
              style={{
                fontSize: 12,
                width: '100%',
                background: '#FFFFFF',
                color: '#111827',
              }}
            />

            {archivoPdf && (
              <div
                style={{
                  marginTop: 5,
                  fontSize: 11,
                  color: '#475569',
                  wordBreak: 'break-all',
                }}
              >
                Seleccionado: {archivoPdf.name}
              </div>
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
            padding: 10,
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
          }}
        >
          {cargando
            ? 'Procesando Recurso...'
            : 'Publicar Recurso Unificado'}
        </button>
      </form>
    </div>
  );
}