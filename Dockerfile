FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY knowledge ./knowledge
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/server.js"]
