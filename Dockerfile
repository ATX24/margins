FROM node:22-bookworm-slim
# poppler-utils: pdftotext/pdfinfo · wamerican: word list for de-hyphenation · pypdf: PDF outlines
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils python3 python3-pip wamerican ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages pypdf==6.10.2 \
 && apt-get purge -y python3-pip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
