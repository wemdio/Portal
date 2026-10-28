# Build from the repository root: docker build -f deploy/eng-browser/Dockerfile --target runner .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm install --include=optional --ignore-scripts
COPY app/ ./
RUN node_modules/.bin/esbuild worker/engBrowserBroker.ts worker/engBrowserRunner.ts --bundle --platform=node --target=node22 --outdir=/build --tsconfig=tsconfig.json --conditions=react-server --external:playwright --log-level=info

FROM node:22-bookworm-slim AS broker
WORKDIR /app
COPY --from=build /build/engBrowserBroker.js ./broker.js
USER 10001:10001
CMD ["node", "/app/broker.js"]

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Exact version follows app/package-lock.json. Update together when Playwright changes.
RUN npm install --omit=dev --ignore-scripts playwright@1.59.1 && npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright && rm -rf /root/.npm /var/lib/apt/lists/* \
    && groupadd --gid 10001 browser && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin browser
COPY --from=build /build/engBrowserRunner.js ./runner.js
USER browser
ENV HOME=/tmp
CMD ["node", "/app/runner.js"]
