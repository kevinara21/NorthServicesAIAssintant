# North Services AI Assistant

Plataforma interna de North Services & Rental Tools para consultar conocimiento
de la empresa, administrar documentos y recursos compartidos, y acceder a
información sincronizada de operaciones e inventarios. La aplicación combina
una interfaz React, un backend Node.js/Express, Firebase, MongoDB Atlas y
servicios externos que se habilitan mediante configuración.

> Esta documentación describe las funciones implementadas en el código. Las
> integraciones externas requieren permisos, credenciales y servicios activos;
> su disponibilidad no depende únicamente de la aplicación.

## Contenido

- [Resumen de módulos](#resumen-de-módulos)
- [Arquitectura e integraciones](#arquitectura-e-integraciones)
- [Asistente y fuentes RAG](#asistente-y-fuentes-rag)
- [Documentos, indexación y papelera](#documentos-indexación-y-papelera)
- [Inventarios MWD y Motores en cPanel](#inventarios-mwd-y-motores-en-cpanel)
- [Google Drive compartido](#google-drive-compartido)
- [Usuarios, roles y permisos](#usuarios-roles-y-permisos)
- [Contraseñas, verificación y mensajes](#contraseñas-verificación-y-mensajes)
- [Recursos de software y manuales](#recursos-de-software-y-manuales)
- [Monitoreo remoto de pozos](#monitoreo-remoto-de-pozos)
- [Administración de Starlink](#administración-de-starlink)
- [Sesión, notificaciones y accesibilidad](#sesión-notificaciones-y-accesibilidad)
- [Estructura del repositorio](#estructura-del-repositorio)
- [Configuración y ejecución local](#configuración-y-ejecución-local)
- [Límites y responsabilidades](#límites-y-responsabilidades)

## Resumen de módulos

| Módulo | Funciones principales | Acceso |
|---|---|---|
| Inicio de sesión | Registro de solicitud, acceso, aprobación y recuperación de cuenta | Usuarios; aprobación del administrador |
| Asistente IA | Respuestas en streaming con documentos permitidos, datos de inventario, información institucional y reportes operativos | Usuarios activos; fuentes limitadas por permisos |
| Archivos | Subida, búsqueda, filtros, descarga, reemplazo y envío a papelera | Usuarios activos; el propietario o un administrador puede mantener cada archivo |
| Papelera | Restauración, eliminación definitiva y plazo de retención visible | Usuarios activos; las categorías desactivadas pueden requerir reactivación |
| Recursos | Catálogo de software autorizado y sus manuales | Usuarios con permiso del módulo |
| Publicar recursos | Alta de software/archivos y manuales; indexación del manual PDF | Administradores |
| Conocimiento y permisos | Categorías, acceso RAG por rol, permisos de módulos, actualización del sitio y sincronización de inventarios | Administradores |
| Monitoreo de pozos | Publicación y administración de enlaces externos asociados a pozo y lote | Usuarios activos; publicación propia o administración |
| Starlink | Registros de equipos, pagos, sincronización para el asistente y recordatorios | Administradores o roles habilitados |
| Perfil | Datos personales, verificación del número y cambio de contraseña de la plataforma | Usuario autenticado |

## Arquitectura e integraciones

### Aplicación

- **Frontend:** React y Vite, dentro de `frontend/`.
- **API:** Node.js y Express, dentro de `backend/`; las rutas principales están
  implementadas en `backend/src/server.js`.
- **Autenticación y datos de cuenta:** Firebase Authentication y Firestore.
- **Metadatos de documentos, permisos RAG y datos vectoriales:** MongoDB Atlas.
- **Modelos de IA:** Gemini para chat, embeddings, extracción estructurada de
  PDFs y otras operaciones que así lo requieren. Puede configurarse Ollama como
  proveedor alternativo del chat.
- **Fuentes conectadas:** carpeta compartida de Google Drive, sitio público de
  North Services, bases MySQL/MariaDB alojadas fuera de la aplicación e
  Infobip/correo SMTP para mensajes de verificación y notificación.

### Bases y datos

- Firebase Authentication administra la identidad y las credenciales de
  acceso.
- Firestore guarda usuarios, recursos publicados, enlaces de monitoreo, datos
  administrativos de Starlink, códigos OTP y estados asociados.
- MongoDB usa `north_services_db` para documentos, categorías, permisos,
  colecciones vectoriales de conocimiento y estados de algunas sincronizaciones.
- Los vectores de inventario se guardan separadamente en las bases `mwd` y
  `motores`, en las colecciones `inventario_mwd` e `inventario_motores`.
- La aplicación no sustituye las fuentes originales de los inventarios: recibe
  una copia para búsqueda y consulta del asistente.

Las credenciales se configuran fuera del código y no deben incluirse en el
repositorio. No copies claves, contraseñas, tokens, archivos de cuentas de
servicio ni configuraciones privadas en este README.

## Asistente y fuentes RAG

### Cómo responde

1. El backend valida la sesión y el estado de la cuenta.
2. Para una pregunta informativa genera una representación de búsqueda y
   consulta las fuentes autorizadas para el rol.
3. Según la pregunta puede consultar también fuentes especializadas: inventario
   MWD/Motores, datos propios de Starlink, reportes PDF de Drive o información
   institucional de la web.
4. El modelo redacta una respuesta a partir del contexto recuperado y la
   transmite progresivamente al navegador mediante SSE.
5. Cuando hay referencias disponibles, la interfaz las muestra para que se
   pueda revisar el origen de la respuesta.

La búsqueda RAG de documentos utiliza embeddings y los índices vectoriales
configurados en MongoDB Atlas. Los umbrales y límites principales pueden
ajustarse desde variables de entorno; sus valores de reserva están en el
backend. Los saludos breves y agradecimientos reconocidos por el backend, como
“Hola”, “¿Qué tal?” o “Gracias”, reciben una respuesta breve sin consultar RAG
ni llamar a Gemini.

El chat usa Gemini en streaming y contempla modelos y claves alternativos. Si
la generación de embeddings no está disponible, el backend puede intentar
búsqueda textual y un proveedor local de chat Ollama si está configurado. Esto
no garantiza que todas las preguntas puedan contestarse cuando las fuentes o
los proveedores fallan.

El asistente está restringido a información recuperada de North Services. El
backend aplica cierres deterministas para solicitudes de código o temas
detectados fuera de alcance; el prompt del modelo también exige no inventar
datos ni responder con conocimiento externo. El usuario puede descargar la
conversación como archivo de texto y revisar o descargar referencias cuando
están disponibles.

### Fuentes disponibles

- Categorías documentales activas autorizadas para el rol.
- Manuales PDF de recursos publicados e indexados.
- Datos sincronizados de inventario MWD/Motores.
- Información empresarial extraída del sitio institucional, compartida para
  los roles. Un administrador puede iniciar manualmente el rastreo del sitio
  configurado; el panel presenta su última actualización y la cantidad de
  fragmentos indexados. El rastreador limita las páginas y fragmentos y no
  sigue enlaces a otros dominios.
- PDFs de reportes operativos en la carpeta compartida de Drive, cuando la
  consulta se clasifica como una pregunta de reportes.
- Información propia de equipos Starlink, cuando el usuario y su rol tienen
  acceso al módulo.

Las fuentes no se cruzan como si fueran equivalentes: los reportes de Drive,
los documentos subidos, los registros de inventario y los datos de Starlink
siguen flujos de recuperación distintos. Las respuestas deben limitarse a los
datos recuperados, sin completar cifras ausentes con suposiciones.

### Sonido de respuesta

El chat puede reproducir un aviso breve de dos tonos al completar correctamente
una respuesta. Se puede activar o desactivar desde la barra del chat; la
preferencia se conserva en el almacenamiento local del navegador. La
reproducción está sujeta a las políticas de audio del navegador y del
dispositivo.

## Documentos, indexación y papelera

### Biblioteca de archivos

Los usuarios activos pueden subir documentación a una categoría permitida,
buscarla, filtrar por categoría, descargar uno o varios archivos y seleccionar
varios elementos. Entre los formatos admitidos por la interfaz están PDF,
Word, Excel, PowerPoint, Visio, texto, CSV y algunas imágenes: `.pdf`, `.doc`,
`.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.vsdx`, `.txt`, `.rtf`, `.odt`,
`.ods`, `.odp`, `.csv`, `.jpg`, `.jpeg`, `.png`, `.gif`, `.bmp` y `.webp`. Se
rechazan ejecutables y scripts; el servidor vuelve a validar las cargas. El
límite de subida de Multer es de 50 MB por archivo.

El propietario puede reemplazar o enviar su archivo a la papelera; el
administrador puede mantener los archivos de todos. El reemplazo conserva los
metadatos existentes y vuelve a procesar e indexar el documento.

### Extracción e indexación

- Los PDFs pasan primero por un parser estructurado basado en Gemini que
  intenta conservar jerarquía, tablas y contenido técnico. Si no está
  disponible o el archivo no puede enviarse por ese método, el backend usa
  `pdf2json` como alternativa. La alternativa puede extraer el texto con menos
  estructura.
- El parser estructurado tiene un límite propio de tamaño para enviar un PDF a
  Gemini; su configuración y modelos se controlan desde el backend.
- Los documentos se dividen en fragmentos, se convierten en embeddings y se
  almacenan con la categoría y metadatos que permiten localizar la fuente.
- En hojas de cálculo se conservan los valores guardados y las fórmulas que
  pueden extraerse; la aplicación no ejecuta ni recalcula fórmulas.
- Que un archivo se haya subido no implica que todo su contenido sea legible.
  PDFs escaneados, imágenes de baja calidad y formatos complejos pueden limitar
  la extracción.

### Borrador y estados de operación

La subida informa de los procesos en curso mediante notificaciones persistentes
con progreso o etapa. El formulario conserva un borrador local, incluido el
archivo seleccionado, en IndexedDB del navegador y asociado al usuario. Al
volver a **Archivos** no se abre automáticamente: se reanuda al pulsar el botón
de la nube. Al cerrar con contenido pendiente se ofrece guardar el borrador;
un formulario vacío no debe pedir confirmación de borrador. El almacenamiento
del borrador es local al navegador y no sincroniza entre dispositivos.

### Papelera y movimientos de archivos

Enviar un documento a la papelera lo retira de las fuentes activas de RAG, pero
permite restaurarlo durante 30 días. La pantalla muestra el tiempo restante y
admite restauraciones y eliminaciones definitivas individuales o por lote.
Restaurar devuelve los vectores a la colección activa; una categoría
desactivada debe reactivarse antes de recuperar sus archivos. El borrado
definitivo elimina metadatos y contenido indexado. Las colecciones MongoDB de
papelera se limpian cuando quedan vacías.

La papelera no es una papelera general del hosting ni un control de versiones:
la retención y las operaciones descritas se aplican a los documentos que
administra la biblioteca.

## Inventarios MWD y Motores en cPanel

### Flujo de datos

1. Los inventarios operativos permanecen en sus sistemas del hosting cPanel.
2. El archivo PHP `backend/inventory-bridge.php` expone una lectura JSON
   autenticada de tipo `mwd` o `motores`. La integración usa consultas de solo
   lectura a la tabla `tools` de MWD o a `equipos` junto con la vista
   `vista_inventario_completo` de Motores.
3. El backend solicita el puente mediante HTTPS fuera del entorno local,
   valida el token y el formato de la respuesta, y limita cada respuesta a
   10.000 registros.
4. Los registros se normalizan, se convierten en texto para búsqueda y se
   guardan con embeddings en la base MongoDB correspondiente.
5. Al finalizar correctamente, se eliminan del índice los registros que ya no
   están en el origen. Si la fuente tiene códigos faltantes o duplicados, la
   sincronización se detiene para proteger el índice anterior.

El puente requiere una configuración privada en el hosting con token y
conexiones de base de datos. El archivo `backend/inventory-bridge.php` está
excluido del control de versiones por `.gitignore`; debe instalarse por
separado en el hosting y no debe publicarse junto a sus credenciales. En el
backend se configuran la URL HTTPS del puente y el token correspondiente.

### Sincronización y consultas

Desde **Conocimiento y permisos por rol**, un administrador puede iniciar la
sincronización MWD o Motores y revisar estado, porcentaje, cantidad procesada,
errores y última sincronización. Solo se permite ejecutar una sincronización
de inventario a la vez. Los embeddings de registros cuyo contenido no cambió
pueden reutilizarse; los registros modificados se vuelven a calcular.
La sincronización de estos inventarios se inicia desde el panel y no sustituye
las aplicaciones operativas del hosting.

El asistente puede consultar campos disponibles del origen, entre ellos
identificadores y tipo de herramienta, ubicación, estado, inspección,
mantenimiento, horas, porcentajes, conexiones, unidades, observaciones,
secciones, series y fechas. También resuelve algunas consultas estructuradas
de conteo, listado, equipo operativo, porcentaje, inspecciones y fechas. El
contenido y precisión dependen de los datos existentes en el sistema fuente y
de la última sincronización completada.

La interfaz ofrece además enlaces para abrir los sistemas operativos originales
de Inventario MWD/LWD e Inventario Motors. La aplicación no cambia registros en
esos sistemas ni reemplaza sus pantallas.

## Google Drive compartido

La integración de Drive se ejecuta desde el backend con acceso de solo lectura
(`drive.readonly`) a la carpeta compartida de Operaciones y sus subcarpetas. El
dashboard ofrece un enlace para abrir Drive directamente; el chat puede
localizar PDFs de reportes, recorrer carpetas, descargar el contenido al
servidor y aportar el documento o texto extraído a la generación de respuestas.

La selección puede usar el año, palabras clave o carpeta detectada en la
pregunta y dispone de límites, timeouts y caché del árbol de archivos. En caso
de error al extraer PDF, puede usar texto de respaldo si está disponible. Drive
es una fuente separada del repositorio documental MongoDB: subir un PDF a
**Archivos** no lo sube a Drive, y Drive no se utiliza como destino de escritura
de la aplicación.

La integración necesita que la cuenta de servicio o credencial de aplicación
configurada tenga acceso a la carpeta compartida. El identificador de carpeta
puede configurarse en el backend sin colocar credenciales en el código.

## Usuarios, roles y permisos

### Registro y ciclo de cuenta

- El registro crea una solicitud con nombre, apellido, área y rol solicitado.
  El correo de la plataforma se forma con el nombre y apellido bajo el dominio
  corporativo.
- Una cuenta nueva queda en estado **pendiente** y no puede iniciar una sesión
  operativa hasta que un administrador la habilite.
- El panel administrativo permite revisar usuarios, actualizar su estado,
  área y rol.
- Los nombres de rol y áreas pueden surgir de los registros existentes; el
  sistema también incluye roles base para el formulario.
- Un administrador conserva privilegios administrativos; el panel ofrece
  gestión de usuarios y permisos además de los módulos correspondientes.

### Acceso por rol

El administrador mantiene desde **Conocimiento y permisos por rol** una matriz
de acceso a categorías y módulos. Los permisos se guardan en MongoDB y se
verifican también desde el backend; ocultar una opción en la interfaz no es el
mecanismo de seguridad.

- El administrador puede consultar todas las categorías activas.
- Los demás roles consultan únicamente las categorías asignadas, además de las
  fuentes compartidas del sistema.
- Para roles nuevos sin matriz guardada, **Software y Manuales** se habilita
  inicialmente y Starlink permanece deshabilitado; el administrador puede
  cambiar los permisos desde el panel.
- Un usuario activo puede crear una categoría al subir un archivo; el backend
  asigna esa categoría al rol creador.
- Las categorías se pueden renombrar, editar, desactivar, reactivar o eliminar.
  Desactivar una categoría retira temporalmente sus archivos del RAG y los
  envía al flujo de papelera.
- Starlink y **Software y Manuales** son módulos con permiso separado de las
  categorías documentales. El administrador tiene acceso total; los demás
  roles reciben el acceso de acuerdo con la matriz configurada.
- El acceso a la página de empresa y al conocimiento compartido de Drive no se
  restringe por la matriz de categorías.

## Contraseñas, verificación y mensajes

### Contraseña de la plataforma

En **Perfil**, el usuario puede cambiar la contraseña de su cuenta de la
plataforma después de volver a autenticarse con su contraseña actual. La
recuperación solicita un código de verificación y actualiza la contraseña en
Firebase Authentication.

**Esto no cambia la contraseña de cPanel, del hosting ni de una cuenta de
correo.** La integración con correo cPanel que usa la aplicación es transporte
SMTP para enviar mensajes; sus credenciales son configuración del servidor.
El campo de contraseña dentro de la administración Starlink, si se usa, es
información del registro de acceso a ese servicio y tampoco es la contraseña de
cPanel.

### OTP, SMS, WhatsApp y correo

- El servicio de correo corporativo usa Nodemailer y SMTP del hosting/cPanel
  para enviar códigos de recuperación y mensajes de la plataforma.
- Infobip puede enviar OTP por SMS o por WhatsApp si el proveedor y sus
  remitentes están configurados.
- Los OTP se guardan como hashes, expiran a los 10 minutos y admiten hasta
  cinco intentos de validación.
- El perfil incluye flujo para verificar un número mediante código y para
  actualizar los datos personales; el correo corporativo se deriva del nombre
  y apellido.
- Los canales dependen de su configuración externa y de la disponibilidad del
  proveedor.

La plataforma también muestra notificaciones dentro de la interfaz para
operaciones exitosas, errores, advertencias e información. Los estados de
operaciones largas —por ejemplo, subida, restauración, sincronización o
publicación— pueden permanecer visibles hasta que la acción termine. No existe
un módulo general de mensajería entre usuarios en tiempo real; los mensajes
descritos aquí son avisos de interfaz, OTP y correos automáticos.

## Recursos de software y manuales

El catálogo agrupa cada recurso en una ficha con nombre, descripción y versión.
Un administrador puede publicar un archivo de software comprimido, su manual
PDF o ambos. El usuario autorizado puede buscar en el catálogo y descargar por
separado el software y el manual.

Cuando se publica un manual PDF, el backend extrae su contenido, lo fragmenta
y lo indexa en la fuente de **Software y Manuales** para que pueda consultarlo
el asistente. Al eliminar un recurso se eliminan su software, manual y
fragmentos indexados; esta operación es permanente. El acceso al catálogo y a
las descargas se controla mediante el permiso del módulo correspondiente.

## Monitoreo remoto de pozos

Los usuarios activos pueden compartir un enlace de monitoreo indicando pozo,
lote, descripción opcional y URL. Las publicaciones se listan con su autor y
fecha; al abrir una se visita el servicio externo en otra pestaña. El autor
puede mantener sus enlaces y un administrador puede mantener todos.

El módulo solo organiza enlaces. No crea la transmisión, no inicia sesión en el
servicio de monitoreo, no graba video ni almacena telemetría.

## Administración de Starlink

El módulo administrativo permite registrar y editar información asociada a
equipos, ubicación/pozo, código KIT, serie de antena, contacto y período de
pago. También incluye estado de pago, monto, estado activo, comentarios y un
campo opcional de acceso asociado al registro.

El día de pago se deriva del día de inicio del período: normalmente corresponde
al día anterior; si el inicio es el 29, 30 o 31 se ajusta al día 28. Los datos
se guardan en Firestore y se reflejan en `starlink_bot` en MongoDB para las
consultas del asistente. El administrador también puede iniciar una
sincronización manual de esos registros.

Un proceso del backend revisa los vencimientos cada 30 minutos y puede enviar
un correo a los administradores activos el día anterior al vencimiento. El
envío requiere SMTP configurado y el registro de entrega evita repetir avisos
del mismo vencimiento.

El acceso a este módulo se puede conceder por rol desde la matriz de permisos.
La existencia de un registro de Starlink no implica acceso público a sus datos
ni que el asistente deba revelar credenciales.

## Sesión, notificaciones y accesibilidad

- La sesión se restaura en el mismo navegador después de una recarga y se
  valida contra el backend.
- La sesión tiene una duración máxima de 60 minutos. Tras 15 minutos sin
  interacción aparece un aviso de inactividad y el cierre automático ocurre
  tras otros 5 minutos si el usuario no vuelve a interactuar.
- La interfaz detecta cuando el navegador pierde conectividad y muestra un
  aviso de que las funciones remotas están pausadas.
- El historial del chat se conserva en el almacenamiento local del navegador,
  separado por usuario.
- Las cargas de archivos, reemplazos, restauraciones, eliminaciones,
  publicaciones y otros trabajos largos usan notificaciones de progreso.
- El frontend adapta el menú a pantallas pequeñas, ofrece controles accesibles
  y mantiene estados legibles para tecnologías de asistencia.

## Estructura del repositorio

```text
backend/
  src/
    server.js                    API Express, chat SSE y rutas de negocio
    db/mongodb.js                Conexiones a MongoDB Atlas
    firebaseAdmin.js             Firebase Admin SDK
    middleware/verifyToken.js    Validación de sesión y carga del perfil
    services/
      documentParser.service.js  Parsing PDF estructurado con alternativa
      ingesta.service.js         Extracción y fragmentación de documentos
      googleDrive.js             Lectura de PDFs de Drive
      inventorySync.service.js   Sincronización y consultas de inventario
      ragCategorias.service.js   Categorías, colecciones y permisos RAG
      webEmpresa.service.js      Rastreo/indexación de la web corporativa
      corporateEmail.service.js SMTP y códigos por correo
      starlinkReminders.service.js Recordatorios de pago
  storage/                       Archivos publicados (no versionados)
  inventory-bridge.php           Puente de lectura del hosting (instalar aparte)
frontend/
  src/
    App.jsx                       Sesión, conectividad y composición
    components/Dashboard.jsx      Navegación y módulos del dashboard
    components/Archivos.jsx       Biblioteca, subida y borradores
    components/MonitoreoPozos.jsx Enlaces de monitoreo
    components/Perfil.jsx         Perfil, OTP y contraseña de plataforma
    components/Recursos.jsx       Catálogo y descargas
    components/SubirRecursos.jsx  Publicación administrativa de recursos
    pages/Chatbot.jsx             Chat SSE, fuentes y sonido de fin
    pages/GestionConocimiento.jsx Categorías, RAG y sincronizaciones
    pages/GestionFacturacion.jsx  Administración Starlink
    pages/GestionUsuarios.jsx     Administración de usuarios
    pages/Papelera.jsx            Restauración y eliminación
```

## Configuración y ejecución local

### Requisitos externos

Antes de ejecutar el sistema se deben provisionar Firebase Authentication y
Firestore, MongoDB Atlas, las APIs/modelos configurados y, para las funciones
que se quieran habilitar, Google Drive, el puente PHP del hosting, SMTP e
Infobip. El backend usa credenciales administrativas de Firebase y Google
Application Default Credentials según el entorno.

### Variables de entorno

Configura las variables en archivos locales ignorados por Git o en el gestor
seguro de secretos del entorno de despliegue. No guardes los valores en el
repositorio.

**Frontend**

- `VITE_API_URL`: origen del backend; vacío utiliza rutas relativas al mismo
  origen.
- `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
  `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`,
  `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID` y, si aplica,
  `VITE_FIREBASE_MEASUREMENT_ID`: configuración del cliente Firebase.

**Backend: servicios esenciales y opcionales**

- `MONGODB_URI`: conexión de MongoDB Atlas.
- `GOOGLE_APPLICATION_CREDENTIALS`: credenciales administradas de Google
  cuando el entorno las requiera.
- `GEMINI_API_KEY` y opcionalmente `GEMINI_API_KEY_FALLBACK`: claves disponibles
  para generación, embeddings y parsing.
- `GEMINI_CHAT_MODEL`, `GEMINI_PARSER_MODELOS`,
  `PARSER_ESTRUCTURADO` y variables `GEMINI_PARSER_*`: selección y límites de
  los modelos de chat y parsing.
- `OLLAMA_BASE_URL`, `OLLAMA_API_KEY`, `OLLAMA_MODEL`,
  `OLLAMA_TIMEOUT_MS`, `OLLAMA_MAX_TOKENS`: proveedor alternativo Ollama.
- `RAG_SCORE_THRESHOLD`, `RAG_LIMIT`, `RAG_NUM_CANDIDATES` y
  `EMBEDDING_CONCURRENCY`: controles de búsqueda e indexación RAG.
- `DRIVE_FOLDER_OPERACIONES`, `DRIVE_MAX_ARCHIVOS`, `DRIVE_INLINE_MAX_BYTES`,
  `DRIVE_TEXTO_MAX_CHARS`, `DRIVE_TIMEOUT_MS`, `DRIVE_TIMEOUT_PDF_MS` y
  `DRIVE_CACHE_TTL_MS`: lectura de reportes de Drive.
- `INVENTORY_BRIDGE_URL` e `INVENTORY_BRIDGE_TOKEN`: acceso al puente del
  hosting. El puente requiere su propia configuración privada de conexión a
  las bases MySQL/MariaDB de origen.
- `CPANEL_MAIL_HOST`, `CPANEL_MAIL_PORT`, `CPANEL_MAIL_SECURE`,
  `CPANEL_MAIL_USER`, `CPANEL_MAIL_PASS`, `CPANEL_MAIL_FROM_NAME` y
  `CPANEL_MAIL_FROM_EMAIL`: salida de correo SMTP.
- `INFOBIP_API_KEY`, `INFOBIP_BASE_URL`, `INFOBIP_SMS_SENDER`,
  `INFOBIP_WHATSAPP_SENDER` y variables de plantilla/idioma de WhatsApp:
  proveedor de OTP por SMS/WhatsApp.
- `OTP_DESTINATION`: configuración del destino de verificación del backend.
- `WEB_EMPRESA_URL`, `WEB_EMPRESA_MAX_PAGINAS`, `WEB_EMPRESA_MAX_FRAGMENTOS`
  y `WEB_EMPRESA_UMBRAL`: rastreo del sitio institucional.
- `PORT`, `HOST` y `NODE_ENV`: servidor y entorno.

Consulta el código de cada servicio para otros límites opcionales o valores por
defecto. No publiques archivos privados de cuentas de servicio, `.env`, tokens
del puente, contraseñas SMTP ni claves de API.

### Instalar y ejecutar

En terminales separadas:

```sh
cd backend
npm install
npm run dev
```

```sh
cd frontend
npm install
npm run dev
```

Para compilar y revisar el frontend:

```sh
cd frontend
npm run build
npm run lint
```

El backend se inicia con `npm start` en producción. El script `npm test` del
backend es actualmente un marcador sin suite de pruebas configurada.

### Puente PHP del hosting

Instala `backend/inventory-bridge.php` en el hosting cPanel con PHP y extensión
MySQLi disponibles. Configura su token y las dos conexiones a las bases de
origen en un archivo privado no accesible desde Git ni desde el directorio
público web. El puente admite únicamente `GET`, requiere token, permite solo
los tipos `mwd` y `motores`, usa HTTPS fuera de localhost y rechaza fuentes con
más de 10.000 filas por consulta.

Después configura en el backend la URL HTTPS instalada y el mismo token.
Prueba cada tipo y valida la respuesta JSON antes de iniciar la sincronización
desde el panel. No coloques credenciales MySQL en el archivo PHP público.

## API del backend: grupos principales

La API se encuentra en `backend/src/server.js`. Las rutas protegidas esperan el
token de Firebase en `Authorization: Bearer <token>`; los endpoints
administrativos comprueban el rol desde el backend.

| Grupo | Rutas representativas | Uso |
|---|---|---|
| Perfil y cuenta | `GET/PUT /api/perfil`, `POST /api/password/solicitar`, `POST /api/password/restablecer`, `PUT /api/password/cambiar` | Validar sesión, actualizar perfil y credenciales |
| Verificación | `POST /api/otp/solicitar`, `POST /api/otp/verificar` | Enviar y validar códigos |
| Chat | `POST /api/chat` | Respuesta SSE del asistente |
| Documentos | `POST/GET /api/archivos`, `GET /api/archivos/:id/download`, `POST /api/archivos/lote/eliminar` | Biblioteca, descargas y papelera |
| Categorías | `GET/POST /api/rag/categorias`, `/api/admin/rag/categorias`, `/api/admin/rag/permisos` | Consulta y administración de fuentes y permisos |
| Papelera | `GET /api/papelera`, `/api/papelera/lote/restaurar`, `/api/papelera/lote/definitivo` | Restauración y borrado |
| Inventarios | `/api/admin/sync/inventario-mwd`, `/api/admin/sync/inventario-motores`, `/api/admin/sync/inventarios/estado` | Sincronización y estado |
| Web institucional | `/api/admin/web-empresa/actualizar`, `/api/admin/web-empresa/estado` | Actualización de contenido institucional |
| Recursos | `GET /api/recursos`, `/api/admin/upload-recurso-unificado` | Catálogo y publicación |
| Monitoreo | `GET/POST /api/monitoreo`, `PUT/DELETE /api/monitoreo/:id` | Enlaces compartidos |
| Starlink | `/api/admin/starlink` y `/api/admin/starlink/sync-mongodb` | Registros, actualización y sincronización |
| Usuarios | `/api/admin/usuarios`, `PUT /api/admin/usuarios/:uid` | Administración de cuenta, rol y estado |

La lista es una guía de grupos funcionales, no sustituye el contrato de cada
ruta ni documenta todos sus parámetros.

## Límites y responsabilidades

- El asistente consulta las fuentes disponibles; no reemplaza los sistemas de
  operación ni garantiza que un documento o inventario esté actualizado.
- La actualización de inventarios y de la web institucional es una acción
  administrativa; los inventarios no se escriben de vuelta desde esta
  aplicación.
- La integración de Drive es de lectura; el enlace del dashboard permite
  acceso directo según permisos de Google del usuario.
- El uso y disponibilidad de Gemini, Google Drive, Firebase, Atlas, Infobip,
  SMTP, Ollama y cPanel dependen de cuotas, permisos, configuración y red.
- El sistema no cambia contraseñas de cPanel ni credenciales de bases de datos
  del hosting desde el perfil de usuario.
- El módulo de Starlink administra los datos que la empresa registra; no
  inicia sesión en el portal del proveedor ni consulta facturas externas.
- La papelera de la aplicación retiene archivos por 30 días; no es un respaldo
  independiente del servidor.
- La implementación no incluye clasificación automática de PDFs al subirlos.
