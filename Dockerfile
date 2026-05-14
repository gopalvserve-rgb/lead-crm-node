FROM node:20-alpine
WORKDIR /app

# ffmpeg is required to transcode AMR/3GP call recordings to M4A so
# browsers can play them. ~25MB image bloat from Alpine repos.
RUN apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
ENV NODE_ENV=production

CMD ["sh", "-c", "node db/migrate.js && node db/seed.js && node server.js"]
