FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# yt-dlp: sinemada YouTube/Twitch/Kick'i sunucudan aktarmak için (relay.ts). Python gerektirmeyen tek dosya,
# sunucunun mimarisine göre (Coolify sunucusu arm64). node kullanıcısına ait: sunucu günde bir kendini günceller.
ENV YTDLP_PATH=/app/bin/yt-dlp
RUN mkdir -p /app/bin && node -e "const a={arm64:'yt-dlp_linux_aarch64',x64:'yt-dlp_linux'}[process.arch];if(!a)process.exit(1);fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/'+a).then(r=>{if(!r.ok)throw new Error(r.status);return r.arrayBuffer()}).then(b=>require('fs').writeFileSync(process.env.YTDLP_PATH,Buffer.from(b),{mode:0o755}))" \
 && /app/bin/yt-dlp --version && chown -R node:node /app/bin
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "dist/server/index.js"]
