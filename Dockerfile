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

# Comando para iniciar la app
CMD ["npm", "start"]
