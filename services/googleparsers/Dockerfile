FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

# Install tsx as dev dep just for runtime (small, fast)
RUN npm install --no-save tsx

ENV NODE_ENV=production
EXPOSE 8001

CMD ["npx", "tsx", "src/server.ts"]
