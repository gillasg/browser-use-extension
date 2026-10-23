# The job server with plain-HTTP fetching. Browser fetching needs the Browser Use Extension on
# the host: mount its data folder and set BROWSER_USE_EXTENSION_HOME to reach its bridge.
#
# browser-crawl has no sibling packages; build it from its own folder:
#   docker build -f browser-crawl/Dockerfile -t browser-crawl .
FROM node:22-slim
WORKDIR /repos
RUN corepack enable
COPY browser-crawl/package.json browser-crawl/pnpm-lock.yaml browser-crawl/pnpm-workspace.yaml browser-crawl/tsconfig.json browser-crawl/
COPY browser-crawl/src browser-crawl/src
RUN cd browser-crawl && pnpm install --frozen-lockfile && pnpm build
WORKDIR /repos/browser-crawl
ENV BROWSER_CRAWL_HOME=/data
VOLUME /data
EXPOSE 8787
CMD ["node", "dist/cli.js", "serve", "--host", "0.0.0.0", "--port", "8787"]
