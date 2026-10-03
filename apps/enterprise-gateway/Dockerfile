FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY apps/enterprise-gateway/package.json apps/enterprise-gateway/package.json
RUN pnpm install --filter @deepseek-ai/dsh-enterprise-gateway --prod --frozen-lockfile --ignore-scripts

COPY apps/enterprise-gateway/src apps/enterprise-gateway/src
USER node
EXPOSE 8080
CMD ["node", "apps/enterprise-gateway/src/server.mjs"]
