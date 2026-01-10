# Usa una imagen base de Node.js
FROM node:20

# Establece el directorio de trabajo
WORKDIR /app

# Copia archivos necesarios
COPY package*.json ./

# Instala las dependencias
RUN npm install

# Copia archivos restantes
COPY . .

# Crea carpeta para credenciales
RUN mkdir -p ./auth

# Exponer el puerto del servidor web
EXPOSE 3000

# Variable de entorno del proyecto GCP (ajusta con tu ID real)
ENV GCP_PROJECT_ID=ia-whatsapp-baileys
ENV WEB_PORT=3000
ENV WEB_HOST=35.202.165.75
ENV ORQUESTADOR_HTTP=https://orquestador-http-577166035685.us-central1.run.app
ENV WEB_USER=admin
ENV WEB_PASS=admin123

# Comando para iniciar la app
CMD ["npm", "start"]
