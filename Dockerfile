# ════════════════════════════════════════════════════════════════
# Plansal Playlist Backend Dockerfile (Render.com)
# ────────────────────────────────────────────────────────────────
# Node.js 20 + yt-dlp + ffmpeg.
# ────────────────────────────────────────────────────────────────
FROM node:20-slim

# Sistem paketleri: python3 (yt-dlp için), ffmpeg, curl (yt-dlp indirme), ca-certificates
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp'yi sistem geneline kur (en güncel sürüm)
# youtube-dl-exec aslında kendi yt-dlp binary'sini paketinde getiriyor ama
# güvende olmak için sistemde de bulunsun (YouTube formatları sık değişiyor)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Önce sadece package.json kopyala (Docker cache layer optimizasyonu)
COPY package*.json ./

# Bağımlılıkları kur (production modu)
RUN npm ci --omit=dev || npm install --omit=dev

# Sonra uygulama kodunu kopyala
COPY server.js ./

# Render PORT env var'ı geçer, ama default 3000
ENV PORT=3000
EXPOSE 3000

# Sağlık kontrolü (Render bunu opsiyonel olarak kullanır)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

CMD ["node", "server.js"]
