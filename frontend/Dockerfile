FROM node:20-alpine
WORKDIR /app

ARG NEXT_PUBLIC_API_URL=/api/v1
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

ARG BUILD_ENV=development
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY

# Production Build Guard: Reject missing or Cloudflare test/dummy site keys in production mode
RUN if [ "$BUILD_ENV" = "production" ]; then \
      if [ -z "$NEXT_PUBLIC_TURNSTILE_SITE_KEY" ] || \
         echo "$NEXT_PUBLIC_TURNSTILE_SITE_KEY" | grep -qE '^([123]x0000000000|0000000000)'; then \
         echo "================================================================================" >&2 && \
         echo "FATAL [Turnstile Production Build Guard]: Production build requires a real Turnstile site key!" >&2 && \
         echo "NEXT_PUBLIC_TURNSTILE_SITE_KEY is empty or contains a Cloudflare test dummy key." >&2 && \
         echo "Build aborted to prevent test key leak into production." >&2 && \
         echo "================================================================================" >&2 && \
         exit 1; \
      fi; \
    fi

COPY package*.json ./
RUN npm install
COPY . .
RUN rm -f vitest.config.ts
RUN npm run build

# Post-Build Artifact Guard: Scan static chunks for any test site key in production mode
RUN if [ "$BUILD_ENV" = "production" ]; then \
      if grep -rnE '[123]x0000000000' .next/static; then \
         echo "================================================================================" >&2 && \
         echo "FATAL [Turnstile Post-Build Guard]: Cloudflare test site key found in .next/static!" >&2 && \
         echo "Build aborted to prevent test key deployment." >&2 && \
         echo "================================================================================" >&2 && \
         exit 1; \
      fi; \
    fi

EXPOSE 3000
CMD ["npm", "run", "start"]

