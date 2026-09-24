# Beast WhatsApp Bot

Bot local para precalificar consultas recibidas por WhatsApp Business, recolectar datos mediante formularios versionados y derivar cada conversación a uno de dos vendedores.

## Arquitectura

- API y panel: Fastify, React y Vite.
- Worker: `whatsapp-web.js`, Puppeteer y Chrome headless.
- Persistencia y cola: MySQL 8.4 LTS.
- IA: Ollama nativo en Windows, consumido desde Docker.
- Despliegue: Docker Desktop con backend WSL2 sobre Windows 11.

## Prerrequisitos

- Windows 11 con virtualización habilitada.
- WSL2 actualizado.
- Docker Desktop con contenedores Linux.
- Ollama para Windows.
- Node.js 24 LTS y npm 11 para desarrollo local.

## Inicio rápido

1. Copiar `.env.example` como `.env`.
2. Reemplazar todas las contraseñas y secretos de ejemplo. Generar
   `DATA_ENCRYPTION_KEY` con
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
   Definir también `PANEL_ADMIN_USERNAME` y una contraseña de panel de al menos
   12 caracteres en `PANEL_ADMIN_PASSWORD`.
3. Instalar y abrir Ollama en Windows.
4. Descargar el modelo: `ollama pull qwen3:4b`.
5. Iniciar los servicios: `docker compose up --build -d`.
6. Consultar los logs del QR: `docker compose logs -f worker`.
7. Abrir `http://localhost:3000`.

## Seguridad

- No confirmar `.env`, perfiles de Chrome, sesiones de WhatsApp ni respaldos.
- Los identificadores buscables se guardan como HMAC-SHA-256; los números y mensajes
  se cifran con AES-256-GCM mediante `DATA_ENCRYPTION_KEY`.
- Conservar una copia protegida de `DATA_ENCRYPTION_KEY`: perderla impide recuperar
  los datos cifrados existentes.
- El panel exige una sesión firmada, usa una cookie `HttpOnly` y rechaza escrituras
  originadas desde otro host.
- Restringir el puerto del panel a la red privada mediante el Firewall de Windows.
- Utilizar un número de WhatsApp Business dedicado cuando sea posible.
- Mantener una copia de seguridad lógica de MySQL y del volumen de autenticación.

## Estado

El worker persiste de forma cifrada y deduplicada los mensajes de texto directos
entrantes y salientes. El panel permite consultar conversaciones, administrar formularios
mediante borradores versionados y publicación explícita, mantener los vendedores y editar
el calendario comercial.

La asignación manual desde la bandeja usa bloques de cinco conversaciones y guarda el
vendedor elegido en MySQL dentro de la misma transacción que avanza la rotación. El
worker clasifica los mensajes como horario comercial o fuera de horario, reactiva las
conversaciones cuando abre el negocio y controla seguimiento y cierre mediante horas
hábiles, excluyendo los feriados configurados en el panel.

Los plazos predeterminados son 24 horas hábiles para marcar una conversación como
pendiente de seguimiento y 72 para cerrarla. Una nueva actividad del cliente o del
vendedor reinicia la inactividad. Los valores editados en el panel se guardan en MySQL;
las variables de entorno se usan solamente como respaldo cuando todavía no existe una
configuración persistida.

El motor conversacional usa la salida JSON estructurada de Ollama para detectar el
servicio, extraer valores del formulario publicado y calcular la confianza. Los valores
propuestos por el modelo se validan nuevamente en código; una duda, un pedido humano o
la falta de confianza deriva la conversación a un vendedor. Cada conversación conserva
la versión de formulario con la que comenzó, aunque después se publique otra.

Los mensajes salientes y las transferencias se procesan mediante la cola persistente de
MySQL. La cola deduplica por mensaje de origen, limita la frecuencia, reintenta con espera
exponencial y muestra en **Estado** los trabajos que agotaron sus intentos. Desde allí se
pueden reintentar manualmente. Los mensajes del propio bot se identifican para que no
vuelvan a entrar como respuestas del vendedor.

La transferencia crea un resumen cifrado y selecciona al vendedor en bloques de cinco.
La etiqueta y el resumen se procesan mediante trabajos independientes, de modo que un
fallo de etiquetado no impide notificar al vendedor. La asignación, el resumen y los
trabajos de entrega se guardan en una sola transacción de MySQL. El panel muestra el
servicio, las respuestas extraídas, su confianza y el último resumen.

Las respuestas automáticas se controlan con `BOT_REPLY_ENABLED`. Debe mantenerse en
`false` durante la configuración inicial y cambiarse a `true` sólo después de completar
la lista de comprobación siguiente.

## Activación del bot

1. Crear manualmente en WhatsApp Business las etiquetas `NUEVO`, `BOT`,
   `FUERA_DE_HORARIO` y `CERRADO`.
2. Crear también una etiqueta por vendedor y escribir exactamente ese nombre en la
   sección **Vendedores**, por ejemplo `VENDEDOR_1` y `VENDEDOR_2`.
3. Publicar al menos un formulario para cada servicio que vaya a atender el bot.
4. Confirmar en **Estado** que MySQL, Ollama, WhatsApp y la cola estén disponibles.
5. Probar con un número interno y revisar la extracción y el resumen en la bandeja.
6. Cambiar `BOT_REPLY_ENABLED=true` en `.env` y reconstruir únicamente `worker`.

El worker revisa periódicamente las etiquetas modificadas desde WhatsApp. `CERRADO`
tiene prioridad y actualiza MySQL; un mensaje nuevo del cliente abre nuevamente la
conversación y reemplaza la etiqueta. Las etiquetas manuales de vendedor también cambian
el responsable sin avanzar la rotación automática. Si un chat tiene dos etiquetas de
vendedor, el sistema registra el conflicto y no elige una arbitrariamente.

## Panel interno

- **Conversaciones:** filtra por estado, muestra el historial, asigna por rotación y
  permite cerrar o reabrir manualmente. También muestra servicio, datos extraídos,
  confianza y resumen.
- **Formularios:** crea borradores, edita campos y publica versiones sin modificar las
  versiones ya publicadas.
- **Vendedores:** crea, edita, activa o desactiva integrantes y define su orden de
  rotación. Al menos un vendedor debe permanecer activo.
- **Reglas comerciales:** configura los siete días de la semana, feriados y plazos de
  seguimiento/cierre. La zona horaria operativa es `America/Argentina/Buenos_Aires`.
- **Estado:** muestra la salud de MySQL, Ollama, WhatsApp y la cola, y permite reintentar
  trabajos que agotaron sus intentos automáticos.

Después de cambiar horarios, feriados o plazos, el worker puede tardar hasta un minuto
en tomar la nueva configuración debido a su caché local.
