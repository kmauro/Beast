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

Las respuestas automáticas permanecen desactivadas. La asignación actual tampoco aplica
todavía etiquetas en WhatsApp ni envía el resumen al vendedor: esas acciones formarán
parte del motor conversacional y del flujo de entrega posteriores.

## Panel interno

- **Conversaciones:** filtra por estado, muestra el historial, asigna por rotación y
  permite cerrar o reabrir manualmente.
- **Formularios:** crea borradores, edita campos y publica versiones sin modificar las
  versiones ya publicadas.
- **Vendedores:** crea, edita, activa o desactiva integrantes y define su orden de
  rotación. Al menos un vendedor debe permanecer activo.
- **Reglas comerciales:** configura los siete días de la semana, feriados y plazos de
  seguimiento/cierre. La zona horaria operativa es `America/Argentina/Buenos_Aires`.

Después de cambiar horarios, feriados o plazos, el worker puede tardar hasta un minuto
en tomar la nueva configuración debido a su caché local.
