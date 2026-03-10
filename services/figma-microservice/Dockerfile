FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

# Install Bun runtime in Playwright base image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates unzip \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://bun.sh/install | bash \
  && ln -s /root/.bun/bin/bun /usr/local/bin/bun

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

ENV PORT=8787
EXPOSE 8787

# RUN_MODE=dev enables hot reload mode.
# PLAYWRIGHT_CHROMIUM_ARGS can be set for container-specific flags.
# Example: --no-sandbox --disable-setuid-sandbox
CMD ["sh", "-c", "if [ \"$RUN_MODE\" = \"dev\" ]; then bun --hot src/index.ts; else bun src/index.ts; fi"]
