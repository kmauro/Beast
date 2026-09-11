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
2. Reemplazar todas las contraseñas y secretos de ejemplo.
3. Instalar y abrir Ollama en Windows.
4. Descargar el modelo: `ollama pull qwen3:4b`.
5. Iniciar los servicios: `docker compose up --build -d`.
6. Consultar los logs del QR: `docker compose logs -f worker`.
7. Abrir `http://localhost:3000`.

## Seguridad

- No confirmar `.env`, perfiles de Chrome, sesiones de WhatsApp ni respaldos.
- Restringir el puerto del panel a la red privada mediante el Firewall de Windows.
- Utilizar un número de WhatsApp Business dedicado cuando sea posible.
- Mantener una copia de seguridad lógica de MySQL y del volumen de autenticación.

## Estado

El proyecto se encuentra en su etapa inicial. El esqueleto incluye servicios, esquema de datos y comprobaciones de salud; el motor conversacional completo se incorporará de forma incremental y con pruebas.

